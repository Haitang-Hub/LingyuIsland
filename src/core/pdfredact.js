'use strict';
/**
 * PDF 不可逆遮盖（redaction）
 *
 * 设计要点：
 *  - 不复用 maskText 的可还原编码，也不写 vault：PDF 分支一次性涂黑，无法还原。
 *  - 文本 PDF：pdfjs 取文本层与字形坐标，detect() 命中后映射到页面矩形。
 *  - 图片 / 扫描 PDF：pdfjs 渲染成位图，调用 RapidOCR-json 得到文字块与像素框，
 *    再用同一套 detect() 定位敏感块。OCR 引擎随应用分发（resources/engine），按需启动。
 *  - 遮盖方式：在渲染后的画布上画不透明黑框，再把整页作为图片嵌入新 PDF。
 *    输出没有文本层、没有注释、没有元数据，是真正意义上的不可逆屏蔽。
 *  - 不做重复检测：每次拖入都重新执行遮盖。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { detect } = require('./detector');

// 命名与全项目统一：屏蔽产物一律 _屏蔽，还原产物一律 _还原（PDF/图片不可还原）
const REDACTED_SUFFIX = '_屏蔽';
const REDACTED_SUFFIX_RE = new RegExp(`${REDACTED_SUFFIX}(?:_\\d{1,3})?$`);
const READY_MARK = 'OCR init completed.';
const OCR_ARGS = [
  '--models=models',
  '--det=ch_PP-OCRv4_det_infer.onnx',
  '--cls=ch_ppocr_mobile_v2.0_cls_infer.onnx',
  '--rec=rec_ch_PP-OCRv4_infer.onnx',
  '--keys=dict_chinese.txt',
  '--numThread=2',
  '--maxSideLen=2880',
  '--doAngle=0',
  '--mostAngle=0',
  '--ensureAscii=0',
];

let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) {
    if (!Promise.withResolvers) {
      Promise.withResolvers = function () {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      };
    }
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjsPromise;
}

function standardFontDataUrl() {
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    const dir = path.join(path.dirname(pkg), 'standard_fonts');
    if (fs.existsSync(dir)) return pathToFileURL(dir + path.sep).href;
  } catch { /* ignore */ }
  return undefined;
}

async function openPdf(data) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
    isEvalSupported: false,
    standardFontDataUrl: standardFontDataUrl(),
  }).promise;
}

/** PDF 不可逆遮盖结果路径：xxx_屏蔽.pdf（命名与全项目统一） */
function redactedPathOf(p) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext).replace(REDACTED_SUFFIX_RE, '');
  return path.join(dir, `${base}${REDACTED_SUFFIX}${ext}`);
}

/* ---------------- 文本层定位 ---------------- */

function itemBox(item) {
  const t = item.transform || [1, 0, 0, 1, 0, 0];
  // pdfjs 的 width/height 已是应用字体变换后的尺寸（PDF 用户空间），
  // 不能再乘 transform[0]/transform[3]，否则框会被字体缩放倍数（如 14 倍）放大。
  const w = Number(item.width) || 0;
  const h = Number(item.height) || Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 12;
  const sx = Math.hypot(t[0], t[1]) || 1;
  const sy = Math.hypot(t[2], t[3]) || 1;
  // 基线方向的单位向量（含旋转），高度方向取字体矩阵另一轴
  const ux = t[0] / sx, uy = t[1] / sx;
  const vx = t[2] / sy, vy = t[3] / sy;
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => [
    t[4] + ux * x + vx * y,
    t[5] + uy * x + vy * y,
  ]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    x1: Math.min(...xs), y1: Math.min(...ys),
    x2: Math.max(...xs), y2: Math.max(...ys),
  };
}

/** 把 pdfjs 文本项按基线聚合成页级文本，并保留「字符 → 字形框」映射 */
async function pageTextWithBoxes(page) {
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const t = it.transform || [0, 0, 0, 0, 0, 0];
    items.push({ str: it.str, x: t[4], y: t[5], box: itemBox(it) });
  }
  const buckets = [];
  for (const it of items) {
    let bucket = buckets.find((b) => Math.abs(b.y - it.y) <= 2);
    if (!bucket) { bucket = { y: it.y, items: [] }; buckets.push(bucket); }
    bucket.items.push(it);
  }
  buckets.sort((a, b) => b.y - a.y);
  let text = '';
  const chars = [];
  for (const bucket of buckets) {
    bucket.items.sort((a, b) => a.x - b.x);
    for (const it of bucket.items) {
      for (const ch of it.str) { text += ch; chars.push({ ch, box: it.box }); }
    }
    text += '\n';
    chars.push({ ch: '\n', box: null });
  }
  return { text, chars };
}

function boxesFromHits(hits, chars) {
  const boxes = [];
  for (const hit of hits) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = Math.max(0, hit.start); i < Math.min(hit.end, chars.length); i++) {
      const b = chars[i].box;
      if (!b) continue;
      x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1);
      x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
    }
    if (Number.isFinite(x1) && x2 > x1 && y2 > y1) boxes.push({ x1, y1, x2, y2 });
  }
  return boxes;
}

/**
 * 按 padding 扩展并合并重叠框，避免重复填充和拼接缝隙。
 * 仅合并同一行的框：行距常小于扩展后的框高，若按「边缘接触即合并」会逐行
 * 连锁成整页黑块，把大量无关正文一起涂掉。判定同行的条件是两个框的垂直
 * 重叠超过较矮框的 60%，且水平方向重叠或仅隔很小的缝隙。
 */
function mergeBoxes(boxes, padding) {
  const padded = boxes.map((b) => ({
    x1: b.x1 - padding, y1: b.y1 - padding,
    x2: b.x2 + padding, y2: b.y2 + padding,
  }));
  const out = [];
  for (const b of padded) {
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const hA = a.y2 - a.y1, hB = b.y2 - b.y1;
      const yOverlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      const xOverlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const sameLine = yOverlap > Math.min(hA, hB) * 0.6;
      const nearOnX = xOverlap >= -padding * 2;
      if (sameLine && nearOnX) {
        out[i] = {
          x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
          x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2),
        };
        merged = true;
        break;
      }
    }
    if (!merged) out.push(b);
  }
  return out;
}

/* ---------------- 页面渲染 ---------------- */

async function renderPage(page, dpi) {
  const { createCanvas } = require('@napi-rs/canvas');
  const scale = dpi / 72;
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, ctx, vp, vp1, scale };
}

/** PDF 用户空间坐标（y 向上）→ 画布像素坐标（y 向下），兼容页面旋转 */
function pdfBoxesToPixels(boxes, vp) {
  return boxes.map((b) => {
    const r = vp.convertToViewportRectangle([b.x1, b.y1, b.x2, b.y2]);
    return {
      x1: Math.min(r[0], r[2]), y1: Math.min(r[1], r[3]),
      x2: Math.max(r[0], r[2]), y2: Math.max(r[1], r[3]),
    };
  });
}

/* ---------------- RapidOCR-json 子进程 ---------------- */

function resolveEngineDir(configured) {
  // 显式配置优先且不降级：配置错路径时应明确报「引擎不可用」，而不是悄悄用另一套引擎
  if (configured) {
    try {
      return fs.existsSync(path.join(configured, 'RapidOCR-json.exe')) ? configured : null;
    } catch { return null; }
  }
  const candidates = [];
  // 打包态：electron-builder 的 extraResources 把 assets/engine 放到 resources/engine。
  // 引擎是原生 exe，必须放在 asar 外，否则 spawn 无法执行。
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'engine'));
  // 开发态：项目内 assets/engine（已随仓库分发）
  candidates.push(path.join(__dirname, '..', '..', 'assets', 'engine'));
  // 兼容旧开发机：同工作区 OcrFlow 从 Umi-OCR Rapid 发行包提取的引擎
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'Umi-OCR', 'OcrFlow', 'resources', 'engine'));
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'RapidOCR-json.exe'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

/** 对一张 PNG 跑 OCR，返回带像素框的文字块 */
function runOcr(imageBuffer, opts) {
  return new Promise((resolve, reject) => {
    const dir = resolveEngineDir(opts.ocrEngineDir);
    if (!dir) {
      const err = new Error('未找到 RapidOCR-json 引擎，无法识别图片 PDF');
      err.code = 'OCR_ENGINE_NOT_FOUND';
      return reject(err);
    }
    const exe = path.join(dir, 'RapidOCR-json.exe');
    const child = spawn(exe, OCR_ARGS, {
      cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let ready = false;
    let settled = false;
    let timer = null;
    const finish = (err, blocks) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.stdin.write(JSON.stringify({ exit: '' }) + '\n'); } catch { /* ignore */ }
      setTimeout(() => { try { if (child.exitCode === null) child.kill(); } catch { /* ignore */ } }, 300);
      if (err) reject(err); else resolve(blocks);
    };
    timer = setTimeout(() => finish(new Error('OCR 引擎初始化超时')), opts.ocrInitTimeout || 30000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (!ready) {
          if (line.includes(READY_MARK)) {
            ready = true;
            clearTimeout(timer);
            child.stdin.write(JSON.stringify({ image_base64: imageBuffer.toString('base64') }) + '\n');
            timer = setTimeout(() => finish(new Error('OCR 识别超时')), opts.ocrTimeout || 120000);
          }
          continue;
        }
        try {
          const res = JSON.parse(line);
          if (res.code === 100) {
            const blocks = (Array.isArray(res.data) ? res.data : []).map((d) => {
              const pts = Array.isArray(d.box) ? d.box : [];
              const xs = pts.map((p) => Number(p[0]) || 0);
              const ys = pts.map((p) => Number(p[1]) || 0);
              return {
                text: String(d.text || ''),
                score: Number(d.score || 0),
                box: {
                  x1: Math.min(...xs), y1: Math.min(...ys),
                  x2: Math.max(...xs), y2: Math.max(...ys),
                },
              };
            }).filter((b) => b.text && b.box.x2 > b.box.x1 && b.box.y2 > b.box.y1);
            finish(null, blocks);
          } else if (res.code === 101) {
            finish(null, []);
          } else {
            finish(new Error(`OCR 引擎返回错误码 ${res.code}`));
          }
        } catch (e) { finish(e); }
      }
    });
    child.on('error', (e) => finish(e));
    child.on('exit', () => { if (!settled) finish(new Error('OCR 引擎进程提前退出')); });
  });
}

function ocrTextWithBoxes(blocks) {
  let text = '';
  const chars = [];
  for (const b of blocks) {
    for (const ch of b.text) { text += ch; chars.push({ ch, box: b.box }); }
    text += '\n';
    chars.push({ ch: '\n', box: null });
  }
  return { text, chars };
}

/* ---------------- 主流程 ---------------- */

/**
 * PDF 不可逆遮盖。
 * @returns {Promise<object>} 与 maskFile 同风格的结果对象
 */
async function redactPdfFile(filePath, toggles, outPath, opts = {}) {
  try {
    const bytes = fs.readFileSync(filePath);

    const dpi = Math.max(96, Math.min(400, Number(opts.dpi) || 200));
    const pdf = await openPdf(bytes);
    const { PDFDocument } = require('pdf-lib');
    const outDoc = await PDFDocument.create();
    let count = 0;
    const counts = {};
    let usedOcr = false;

    for (let pn = 1; pn <= pdf.numPages; pn++) {
      const page = await pdf.getPage(pn);
      const { canvas, ctx, vp, vp1, scale } = await renderPage(page, dpi);
      let boxes = [];

      const info = await pageTextWithBoxes(page);
      if (info.text.trim()) {
        const res = detect(info.text, {
          toggles,
          knownEntities: opts.knownEntities,
          knownNameHashes: opts.knownNameHashes,
        });
        boxes = pdfBoxesToPixels(boxesFromHits(res.items, info.chars), vp);
        count += res.items.length;
        for (const it of res.items) counts[it.type] = (counts[it.type] || 0) + 1;
      } else {
        // 无文本层：渲染后的位图交给 OCR
        const pngForOcr = canvas.toBuffer('image/png');
        let blocks;
        try { blocks = await runOcr(pngForOcr, opts); }
        catch (err) {
          await pdf.destroy();
          if (err.code === 'OCR_ENGINE_NOT_FOUND') {
            return { ok: false, path: filePath, skipped: 'pdf-no-text', reason: err.message };
          }
          throw err;
        }
        usedOcr = true;
        if (blocks.length) {
          const ocrInfo = ocrTextWithBoxes(blocks);
          const res = detect(ocrInfo.text, { toggles, knownEntities: opts.knownEntities });
          boxes = boxesFromHits(res.items, ocrInfo.chars);
          count += res.items.length;
          for (const it of res.items) counts[it.type] = (counts[it.type] || 0) + 1;
        }
      }

      for (const b of mergeBoxes(boxes, (Number(opts.padding) || 2) * scale)) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      }

      const png = canvas.toBuffer('image/png');
      const img = await outDoc.embedPng(png);
      const outPage = outDoc.addPage([vp1.width, vp1.height]);
      outPage.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }
    await pdf.destroy();

    if (count === 0) return { ok: true, path: filePath, count: 0, skipped: 'no-pii' };

    // 清掉元数据：产物里不留作者 / 主题 / 关键词 / XMP 线索
    try {
      outDoc.setTitle(''); outDoc.setAuthor(''); outDoc.setSubject('');
      outDoc.setKeywords(['']); outDoc.setCreator(''); outDoc.setProducer('');
    } catch { /* ignore */ }

    const outBytes = Buffer.from(await outDoc.save());
    const out = outPath || redactedPathOf(filePath);
    fs.writeFileSync(out, outBytes);
    return {
      ok: true, path: filePath, redactedPath: out, count, counts,
      irreversible: true, ocr: usedOcr,
    };
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      skipped: err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' ? 'locked' : 'error',
      reason: String((err && err.message) || err),
    };
  }
}

module.exports = {
  redactedPathOf, resolveEngineDir, runOcr, redactPdfFile,
  REDACTED_SUFFIX, REDACTED_SUFFIX_RE,
};
