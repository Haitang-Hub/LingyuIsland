'use strict';
/**
 * PDF 文本层处理（纯 Node，依赖 pdfjs-dist 提取 + pdf-lib 生成）
 *
 * 设计取舍（按需求「文本层提取优先于 OCR」）：
 *  - 只处理「可复制文字」的 PDF：pdfjs 提取文本层；扫描件（无文本层）明确跳过，
 *    提示后续再考虑 OCR；
 *  - 遮蔽 / 还原后「重新生成 PDF」：按基线 y 把文本项聚合成逻辑行，对每行文本
 *    跑与纯文本完全相同的 maskText / restoreText，再把结果行用嵌入的中文字体
 *    重绘到新 PDF（保留页尺寸与行位置）。原版式中的图片 / 矢量 / 精确字体不保留
 *    ——这是「重新生成 PDF」的必然取舍，往返不保证字节一致，但文本层 100% 可逆。
 *  - 字体：优先内置字体（assets/fonts/），其次探测系统中文 TTF；pdf-lib+fontkit
 *    会自动做字形子集，产物体积很小。
 */

const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');

let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) {
    // pdfjs v4 是 ESM；Node 18 缺 Promise.withResolvers，补一个
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

/** 探测可用的中文 TTF 字体路径 */
function findFontPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Regular.ttf'),
    path.join(__dirname, '..', '..', 'assets', 'fonts', 'simhei.ttf'),
  ];
  if (process.platform === 'win32') {
    const w = process.env.WINDIR || 'C:/Windows';
    // 优先单文件 TTF：TTC 集合字体在 fontkit 子集化时可能报 createSubset 缺失
    candidates.push(
      path.join(w, 'Fonts', 'simhei.ttf'),
      path.join(w, 'Fonts', 'simsunb.ttf'),
      path.join(w, 'Fonts', 'simfang.ttf'),
      path.join(w, 'Fonts', 'simkai.ttf'),
      path.join(w, 'Fonts', 'msyh.ttc'),
      path.join(w, 'Fonts', 'simsun.ttc')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/System/Library/Fonts/PingFang.ttc', '/Library/Fonts/Arial Unicode.ttf');
  } else {
    candidates.push('/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc');
  }
  for (const p of candidates) { try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

/**
 * 提取 PDF 文本层，按基线 y 聚合成逻辑行。
 * @returns {{pages:Array, text:string, hasText:boolean}}
 */
async function extractPdf(data) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false });
  const pdf = await task.promise;
  const pages = [];
  const allText = [];
  for (let pn = 1; pn <= pdf.numPages; pn++) {
    const page = await pdf.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    // 按 y（基线，容差 2pt）分行，行内按 x 排序
    const buckets = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str) continue;
      const t = it.transform || [0, 0, 0, 0, 0, 0];
      const y = t[5], x = t[4], size = Math.abs(t[0]) || 12;
      let bucket = buckets.find((b) => Math.abs(b.y - y) <= 2);
      if (!bucket) { bucket = { y, items: [] }; buckets.push(bucket); }
      bucket.items.push({ str: it.str, x, size });
    }
    buckets.sort((a, b) => b.y - a.y); // PDF 坐标 y 自下而上
    const lines = buckets.map((b) => {
      b.items.sort((a, c) => a.x - c.x);
      return {
        y: b.y,
        x: b.items.length ? Math.min(...b.items.map((i) => i.x)) : 0,
        size: b.items.length ? Math.max(...b.items.map((i) => i.size)) : 12,
        text: b.items.map((i) => i.str).join(''),
      };
    }).filter((l) => l.text.trim());
    pages.push({ width: vp.width, height: vp.height, lines });
    allText.push(lines.map((l) => l.text).join('\n'));
  }
  await pdf.destroy();
  return { pages, text: allText.join('\n'), hasText: allText.some((s) => s.trim().length > 0) };
}

/**
 * 把（已遮蔽/还原的）逻辑行重绘成新 PDF。
 * @param {{pages:Array}} extracted 原始提取结构（提供页尺寸 + 行坐标）
 * @param {string[][]} perPageLines 每页遮蔽后的行文本数组（与 extracted.pages 对应）
 */
async function renderPdf(extracted, perPageLines, fontPath) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const fp = fontPath || findFontPath();
  if (!fp) {
    const err = new Error('未找到可用的中文字体，无法重新生成 PDF');
    err.code = 'NO_FONT';
    throw err;
  }
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(fp);
  // 优先字形子集（产物小）；TTC 或老旧 fontkit 可能不支持子集，降级为全量嵌入
  let font;
  try { font = await doc.embedFont(fontBytes, { subset: true }); }
  catch { font = await doc.embedFont(fontBytes); }
  for (let pi = 0; pi < extracted.pages.length; pi++) {
    const src = extracted.pages[pi];
    const lines = perPageLines[pi] || [];
    const page = doc.addPage([src.width, src.height]);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const meta = src.lines[li] || { x: 40, y: src.height - 60, size: 12 };
      const size = Math.max(6, Math.min(72, meta.size || 12));
      // 若该行文本过长，按页宽粗略折行
      const maxWidth = src.width - meta.x - 40;
      let text = line;
      const pieces = [];
      while (font.widthOfTextAtSize(text, size) > maxWidth && text.length > 1) {
        let cut = Math.max(1, Math.floor(text.length * maxWidth / font.widthOfTextAtSize(text, size)));
        pieces.push(text.slice(0, cut));
        text = text.slice(cut);
      }
      pieces.push(text);
      pieces.forEach((piece, k) => {
        page.drawText(piece, {
          x: meta.x,
          y: meta.y - k * (size * 1.4),
          size,
          font,
          color: rgb(0, 0, 0),
        });
      });
    }
  }
  return Buffer.from(await doc.save());
}

module.exports = { loadPdfjs, extractPdf, renderPdf, findFontPath };
