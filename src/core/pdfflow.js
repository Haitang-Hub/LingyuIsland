'use strict';
/**
 * PDF 文本流规范化：给检测器一份「连续、无空白噪声」的文本，并保留每个字符的
 * 字形框逆映射（涂黑时按命中区间反查精确矩形）。
 *
 * pdfjs 文本层对检测器有两类致命噪声（不可逆遮盖漏检的两大根因，2026-11-21
 * 用开庭笔录.pdf 复现）：
 *  1. 视觉行硬换行：实体被换行拆开（「渡溪县师资培训中⏎心原工作人员」），
 *     逐行检测永远凑不齐——DOCX 走逻辑段落所以没有这个问题；
 *  2. 中西文间隙空格：Word 排版空隙被 pdfjs 输出成真实空格字符（「向阳北路 102 号」），
 *     地址连续串正则（entities.addressAt）、knownEntities 字面匹配（includes）全部失效，
 *     地址被截半或整段漏检。
 *
 * 处理：行按基线聚合并自上而下拼接成「段落流」——同一段落的行直接相连（不留 \n），
 * 空白字符不入流；段界用两个启发式判定（行距 > 中位行距 × 1.6，或行首缩进超出
 * 中位行首约半个字高），既让续行的跨行实体得以匹配，又保持字段行/段首的语义边界。
 * 流中每个字符对应一个字符级框：pdfjs 的文本项是多个字符共用一个矩形，直接用会
 * 「命中几个字涂黑一整项」，这里按字符序号在基线方向等宽内插。
 *
 * 已知边界：跨页实体不做拼接（页与页之间恒为段界）；旋转页面沿用 y 分桶的既有限制。
 */

/** 空白与零宽字符：文本层排版噪声，检测流中一律不入流 */
const WS_RE = /[\s\u3000\u200b\u200c\u200d\ufeff]/;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 去掉文本中的空白噪声字符 */
function stripWs(text) {
  let out = '';
  for (const ch of String(text || '')) if (!WS_RE.test(ch)) out += ch;
  return out;
}

/**
 * 段界判定（相邻两行，已按阅读顺序排列）：
 *  1. 行距启发式：间距 > 全页中位行距 × 1.6 → 段界（标题/表格与正文的空隙、段前距）；
 *  2. 缩进启发式：行首 x 超出全页中位行首（左边距）约半个字高 → 段首行。
 *     Word 文书的续行顶格、段首缩进两字——若把「合议庭成员：审判员李白」和下一段
 *     的「书记员：李晓」拼成一段，字段行确认的作用域会越界（李白丢确认的回归根因）。
 *     段首行必须与上一行断开；续行（顶格）才与前行拼接，跨行实体得以匹配。
 */
function flowStatsOf(recs) {
  const gaps = [];
  const xs = [];
  const hs = [];
  for (let i = 1; i < recs.length; i++) {
    const g = Math.abs(recs[i].y - recs[i - 1].y);
    if (g > 0) gaps.push(g);
  }
  for (const r of recs) {
    if (r.x > 0) xs.push(r.x);
    if (r.h > 0) hs.push(r.h);
  }
  // 左边距取第 10 百分位而非中位数：正文页续行（顶格）占多数，缩进段首是少数；
  // 若缩进行过半，中位数会漂到缩进值导致段界失效。xs 须先排序（按行序收集的）。
  xs.sort((a, b) => a - b);
  const margin = xs.length ? xs[Math.max(0, Math.floor(xs.length * 0.1))] : 0;
  return { pitch: median(gaps), margin, charH: median(hs) };
}

function paragraphBreaksBetween(prev, cur, stats) {
  const gap = Math.abs(cur.y - prev.y);
  if (!gap) return true; // 同位行/异常顺序：保守断段
  if (stats.pitch > 0 && gap > stats.pitch * 1.6) return true;
  if (stats.charH > 0 && cur.x > 0 && cur.x > stats.margin + stats.charH * 0.6) return true;
  return false;
}

/**
 * 由一段行的 {y, x, h, text}（自上而下）生成流文本。页与页之间必须分开调用或插入段界，
 * 否则末行与下页首行的 |Δy| 可能很小而被误拼。
 */
function flowTextFromLines(lines) {
  const segs = (lines || [])
    .filter((l) => l && l.text && String(l.text).trim())
    .map((l) => ({ y: l.y, x: l.x, h: l.size, text: String(l.text) }));
  const stats = flowStatsOf(segs);
  let text = '';
  for (let i = 0; i < segs.length; i++) {
    if (i > 0 && paragraphBreaksBetween(segs[i - 1], segs[i], stats)) text += '\n';
    text += stripWs(segs[i].text);
  }
  return text;
}

/**
 * pdfjs 文本项 → 字符级框：在基线方向按字符序号等宽内插，高度方向沿用字体矩阵。
 * 与 itemBox 同一坐标系（PDF 用户空间，y 向上，兼容旋转）。
 */
function charBoxesOf(item) {
  const t = item.transform || [1, 0, 0, 1, 0, 0];
  const str = String(item.str || '');
  const h = Number(item.height) || Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 12;
  // 宽度缺失时按 CJK 方块字兜底（h），避免字符框退化为零宽而被 boxesFromHits 丢弃
  const w = Number(item.width) || h;
  const sx = Math.hypot(t[0], t[1]) || 1;
  const sy = Math.hypot(t[2], t[3]) || 1;
  const ux = t[0] / sx, uy = t[1] / sx; // 基线方向单位向量
  const vx = t[2] / sy, vy = t[3] / sy; // 高度方向单位向量
  const boxOf = (x1, x2) => {
    const pts = [[x1, 0], [x2, 0], [x2, h], [x1, h]].map(([px, py]) => [
      t[4] + ux * px + vx * py,
      t[5] + uy * px + vy * py,
    ]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return {
      x1: Math.min(...xs), y1: Math.min(...ys),
      x2: Math.max(...xs), y2: Math.max(...ys),
    };
  };
  if (!str) return [];
  const n = str.length;
  const step = w / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ ch: str[i], box: boxOf(step * i, step * (i + 1)) });
  return out;
}

/**
 * 把一页的 pdfjs 文本项规范化为「检测流」：{ text, chars }。
 * chars 与 text 按索引对齐（'\n' 的 box 为 null），boxesFromHits 可直接消费。
 * @param {Array<{str:string, transform:number[], width:number, height:number}>} items
 */
function buildFlowFromItems(items) {
  const withBoxes = [];
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string' || !it.str) continue;
    const t = it.transform || [0, 0, 0, 0, 0, 0];
    withBoxes.push({ str: it.str, y: t[5], boxes: charBoxesOf(it) });
  }
  // 按基线 y 聚合成视觉行（容差 2pt），行内按 x 排序——与原 pageTextWithBoxes 一致
  const buckets = [];
  for (const it of withBoxes) {
    let bucket = buckets.find((b) => Math.abs(b.y - it.y) <= 2);
    if (!bucket) { bucket = { y: it.y, items: [] }; buckets.push(bucket); }
    bucket.items.push(it);
  }
  buckets.sort((a, b) => b.y - a.y);
  const recs = buckets.map((b) => {
    b.items.sort((a, c) => {
      const ax = a.boxes.length ? a.boxes[0].box.x1 : 0;
      const cx = c.boxes.length ? c.boxes[0].box.x1 : 0;
      return ax - cx;
    });
    const first = b.items[0] && b.items[0].boxes[0];
    return {
      y: b.y,
      x: first ? first.box.x1 : 0,
      h: first ? first.box.y2 - first.box.y1 : 0,
    };
  });
  const stats = flowStatsOf(recs);
  let text = '';
  const chars = [];
  for (let i = 0; i < buckets.length; i++) {
    if (i > 0 && paragraphBreaksBetween(recs[i - 1], recs[i], stats)) {
      text += '\n';
      chars.push({ ch: '\n', box: null });
    }
    for (const it of buckets[i].items) {
      for (const { ch, box } of it.boxes) {
        if (WS_RE.test(ch)) continue; // 空白噪声不入流，也不占映射位
        text += ch;
        chars.push({ ch, box });
      }
    }
  }
  return { text, chars };
}

/**
 * OCR 文字块 → 检测流。手机照片普遍带数度倾斜，块的 bbox 会膨胀数倍
 * （实测代理词照片：单行块 bbox 高跨 2~3 行，顶边/中心随行长交交错位），
 * 按 bbox 直接排序/聚类都会打乱阅读序。有四点 quad 时：
 *  - 基线斜率取各块顶边方向的中位数，块坐标按全局斜率「去斜」后再聚类排序；
 *  - 字符框沿基线方向内插（每字符得到贴合原文字的小框，而非整块 bbox）。
 * 无 quad 时退化为 bbox y 中心聚类。行间沿用行距 + 缩进启发式拼段，
 * 块内剥空格。
 * @param {Array<{text:string, box:{x1,y1,x2,y2}, pts?:number[][]}>} blocks
 */
function buildFlowFromBlocks(blocks) {
  const items = (blocks || [])
    .filter((b) => b && b.text && String(b.text).trim() && b.box && b.box.x2 > b.box.x1)
    .map((b, idx) => {
      const it = {
        text: String(b.text),
        box: b.box,
        pts: Array.isArray(b.pts) && b.pts.length === 4 ? b.pts : null,
        yc: (b.box.y1 + b.box.y2) / 2,
        xc: (b.box.x1 + b.box.x2) / 2,
        h: b.box.y2 - b.box.y1,
        idx,
      };
      if (it.pts) {
        // 顶边方向（左上→右上）即基线方向；垂直文字罕见，|dx| 太小时不参与斜率统计
        const [p0, p1] = it.pts;
        if (Math.abs(p1[0] - p0[0]) > 10) it.slope = (p1[1] - p0[1]) / (p1[0] - p0[0]);
      }
      return it;
    });
  // 全局斜率：各块基线斜率的中位数（个别块识别歪了不影响整体）
  const slopes = items.filter((it) => it.slope != null).map((it) => it.slope);
  const slope = slopes.length ? median(slopes) : 0;
  // 去斜后的行坐标（y 减去 slope×x，倾斜直线变成水平），聚类/排序/行距都用它
  for (const it of items) {
    it.ly = it.yc - slope * it.xc;
    if (it.pts) {
      // 去斜高度：quad 左右边长在去斜意义下的高度，比 bbox 高度更贴近真实行高
      const [, p1, p2, p3] = it.pts;
      const top = Math.hypot(p1[0] - it.pts[0][0], p1[1] - it.pts[0][1]);
      const side = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      it.h = Math.max(1, Math.min(side, top * 1.2));
    }
  }
  // 去斜 y 聚类成视觉行（同行判定：行距 ≤ 较矮块高的 60%）
  const clusters = [];
  for (const it of items) {
    const c = clusters.find((c) => Math.abs(c.ly - it.ly) <= Math.min(c.h, it.h) * 0.6);
    if (c) {
      c.items.push(it);
    } else {
      clusters.push({ ly: it.ly, h: it.h, items: [it] });
    }
  }
  clusters.sort((a, b) => a.ly - b.ly);
  for (const c of clusters) {
    c.items.sort((a, b) => a.box.x1 - b.box.x1);
    c.ly = c.items.reduce((acc, it) => acc + it.ly, 0) / c.items.length;
  }
  const recs = clusters.map((c) => ({
    y: c.ly,
    x: c.items[0].box.x1,
    h: c.items[0].h,
  }));
  const stats = flowStatsOf(recs);
  let text = '';
  const chars = [];
  for (let ci = 0; ci < clusters.length; ci++) {
    if (ci > 0 && paragraphBreaksBetween(recs[ci - 1], recs[ci], stats)) {
      text += '\n';
      chars.push({ ch: '\n', box: null });
    }
    for (const blk of clusters[ci].items) {
      // 按码元迭代（与 detect 的索引口径一致），代理对拆成两半框即可，命中对齐不乱
      const raw = blk.text;
      const kept = [];
      for (let i2 = 0; i2 < raw.length; i2++) {
        if (!WS_RE.test(raw[i2])) kept.push(raw[i2]);
      }
      const n = Math.max(1, kept.length);
      let charBox;
      if (blk.pts) {
        // 沿基线内插：左上→右上为文字推进方向，左上→左下为字高方向。
        // 同时保留字符级 quad（扫掠四边形用），倾斜行的涂黑才能贴合原文字。
        const [tl, tr, br, bl] = blk.pts;
        charBox = (k) => {
          const t0 = k / n, t1 = (k + 1) / n;
          const p = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const q = [p(tl, tr, t0), p(tl, tr, t1), p(bl, br, t1), p(bl, br, t0)];
          const xs = q.map((v) => v[0]);
          const ys = q.map((v) => v[1]);
          return {
            box: {
              x1: Math.min(...xs), y1: Math.min(...ys),
              x2: Math.max(...xs), y2: Math.max(...ys),
            },
            quad: q,
          };
        };
      } else {
        const b = blk.box;
        const step = (b.x2 - b.x1) / n;
        charBox = (k) => ({
          box: {
            x1: b.x1 + step * k, y1: b.y1,
            x2: b.x1 + step * (k + 1), y2: b.y2,
          },
        });
      }
      kept.forEach((ch, k) => {
        const cb = charBox(k);
        text += ch;
        chars.push({ ch, box: cb.box, quad: cb.quad, src: blk.idx });
      });
    }
  }
  return { text, chars };
}

/**
 * 整份文档的流文本（供预扫/实体收集）：页内按行距拼段，页与页之间恒为段界
 * （不同页的 y 坐标系互不相干，跨页拼距没有意义）。
 * @param {Array<{lines:Array<{y:number, text:string}>}>} pages extractPdf 的 pages
 */
function flowTextFromPages(pages) {
  const parts = [];
  for (const p of pages || []) {
    const t = p && flowTextFromLines(p.lines);
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

/**
 * 命中区间 → 涂黑区域。关键规则：
 *  1. **跨行命中按行拆分**，不取整段字符框的并集——并集矩形会横向覆盖两行
 *     全部宽度（开庭笔录复现：整页大黑条）；
 *  2. **倾斜文字按「扫掠四边形」输出**（quad）：OCR 块带 quad 时，字符框沿基线
 *     内插，同组字符的首字左上→末字右上→末字右下→首字左下构成贴合原文字的
 *     斜四边形——轴对齐并集会在倾斜行的低端向上/高端向下吃进相邻行。
 *     分组判据：与当前组 y 范围重叠超自身高 60% 且同一来源块视为同行。
 * 返回元素：矩形组为 {x1,y1,x2,y2}（可继续 mergeBoxes）；quad 组为
 * {bbox, quad:[4点]}（调用方直接按多边形填充，不做轴对齐合并）。
 * @param {Array<{start:number, end:number}>} hits detect() 的命中区间（流索引）
 * @param {Array<{box:{x1,y1,x2,y2}|null, quad?:number[][]}>} chars 字符映射
 */
function boxesFromHits(hits, chars) {
  const out = [];
  for (const hit of hits || []) {
    let cur = null;
    const flush = () => {
      if (!cur) return;
      if (cur.quad0) {
        out.push({
          bbox: { ...cur.bbox },
          quad: [cur.quad0[0], cur.quad1[1], cur.quad1[2], cur.quad0[3]],
        });
      } else {
        out.push({ ...cur.bbox });
      }
      cur = null;
    };
    for (let i = Math.max(0, hit.start); i < Math.min(hit.end, chars.length); i++) {
      const c = chars[i];
      const b = c && c.box;
      if (!b || b.x2 <= b.x1 || b.y2 <= b.y1) continue;
      const q = Array.isArray(c.quad) ? c.quad : null;
      if (cur) {
        const h = b.y2 - b.y1;
        const overlap = Math.min(cur.bbox.y2, b.y2) - Math.max(cur.bbox.y1, b.y1);
        const sameLine = overlap > h * 0.6;
        const sameRun = cur.src === c.src && !!cur.quad0 === !!q;
        if (sameLine && sameRun) {
          cur.bbox.x1 = Math.min(cur.bbox.x1, b.x1); cur.bbox.y1 = Math.min(cur.bbox.y1, b.y1);
          cur.bbox.x2 = Math.max(cur.bbox.x2, b.x2); cur.bbox.y2 = Math.max(cur.bbox.y2, b.y2);
          if (q) cur.quad1 = q;
          continue;
        }
        flush();
      }
      cur = {
        bbox: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 },
        quad0: q,
        quad1: q,
        src: c.src,
      };
    }
    flush();
  }
  return out;
}

/**
 * 四边形按边外扩 padding 像素（角点取相邻两边外移方向的合成）。
 * 用于倾斜文字的涂黑边距：轴对齐 padding 会放大倾斜误差。
 */
function expandQuad(quad, pad) {
  const cx = (quad[0][0] + quad[2][0]) / 2;
  const cy = (quad[0][1] + quad[2][1]) / 2;
  const normals = quad.map((p, i) => {
    const a = p;
    const b = quad[(i + 1) % 4];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    let nx = dy / len;
    let ny = -dx / len;
    const mx = (a[0] + b[0]) / 2 - cx;
    const my = (a[1] + b[1]) / 2 - cy;
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  });
  return quad.map((p, i) => {
    const nPrev = normals[(i + 3) % 4];
    const nCur = normals[i];
    return [p[0] + (nPrev[0] + nCur[0]) * pad, p[1] + (nPrev[1] + nCur[1]) * pad];
  });
}

/**
 * 补齐 pdfjs 渲染所需的画布全局（DOMMatrix/ImageData/Path2D）。
 * pdfjs 只在 isNodeJS 时自补这三个全局（legacy 构建从 @napi-rs/canvas 取），
 * 而 utility 进程被 isNodeJS 检查排除 → 渲染扫描页（图像 XObject 需要
 * Path2D/ImageData）即抛「ImageData is not defined」。这里照抄 pdfjs 的
 * polyfill 行为，但只补缺失项，任何进程类型下幂等。
 */
function ensurePdfjsCanvasGlobals() {
  if (globalThis.DOMMatrix && globalThis.ImageData && globalThis.Path2D) return;
  try {
    const canvas = require('@napi-rs/canvas');
    if (!globalThis.DOMMatrix && canvas.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
    if (!globalThis.ImageData && canvas.ImageData) globalThis.ImageData = canvas.ImageData;
    if (!globalThis.Path2D && canvas.Path2D) globalThis.Path2D = canvas.Path2D;
  } catch { /* 与 pdfjs 行为一致：缺 polyfill 时渲染可能受损，但不阻塞加载 */ }
}

/**
 * pdfjs 画布工厂：显式提供 @napi-rs/canvas 实现，不再依赖 pdfjs 的环境判定。
 * pdfjs legacy 构建的 isNodeJS 检查会显式排除 Electron 非 browser 进程
 * （pdf.mjs：`!(process.versions.electron && process.type !== "browser")`），
 * 遮盖任务池的 utility 进程因此被当成「浏览器环境」而选择 DOMCanvasFactory，
 * 渲染扫描页时调 document.createElement 直接抛错（无 DOM）。
 * getDocument 传 CanvasFactory: NapiCanvasFactory（传类，pdfjs 自行实例化）。
 * 注意构造器要接收并忽略 pdfjs 传入的 { ownerDocument, enableHWA }。
 */
class NapiCanvasFactory {
  constructor(_opts) {}

  create(width, height) {
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.max(1, width);
    canvasAndContext.canvas.height = Math.max(1, height);
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

/**
 * pdfjs 过滤器工厂：与 bundle 内 NodeFilterFactory 同构——BaseFilterFactory
 * 的全部方法本就是无 DOM 的 no-op（返回 "none"），这里照抄其形状。
 * 若不提供，utility 进程会选中 DOMFilterFactory（createElementNS，无 DOM 即崩）。
 */
class NapiFilterFactory {
  constructor(_opts) {}
  addFilter(_maps) { return 'none'; }
  addHCMFilter(_fg, _bg) { return 'none'; }
  addAlphaFilter(_map) { return 'none'; }
  addLuminosityFilter(_map) { return 'none'; }
  addHighlightHCMFilter(_n, _fg, _bg, _nfg, _nbg) { return 'none'; }
  destroy(_keepHCM = false) {}
}

module.exports = {
  buildFlowFromItems, buildFlowFromBlocks, flowTextFromLines, flowTextFromPages,
  boxesFromHits, expandQuad, stripWs, charBoxesOf,
  NapiCanvasFactory, NapiFilterFactory, ensurePdfjsCanvasGlobals,
};
