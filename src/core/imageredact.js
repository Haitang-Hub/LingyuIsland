'use strict';
/**
 * 图片不可逆遮盖（redaction）
 *
 * 与 PDF 扫描件共用同一套 OCR 与定位逻辑：
 *  - 用内置 RapidOCR-json 识别图片文字与像素框
 *  - detect() 命中敏感信息后映射到像素框，画不透明黑框
 *  - 通过 canvas 重新编码输出，原始 EXIF / 元数据全部丢失，不可逆、不写 vault
 *  - 不做重复检测：每次拖入都重新执行遮盖
 */

const fs = require('fs');
const path = require('path');
const {
  redactedPathOf, resolveEngineDir, runOcr, REDACTED_SUFFIX_RE,
} = require('./pdfredact');
const { detect } = require('./detector');

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff']);

function isImage(filePath) {
  return IMAGE_EXTS.has(path.extname(String(filePath)).slice(1).toLowerCase());
}

/** OCR 文本 + 每字符对应的像素框（与 pdfredact.ocrTextWithBoxes 一致） */
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

/** 命中区间 → 像素框并集 */
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

/** padding 扩展并合并重叠框 */
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

/** 依据原图后缀选择输出编码：照片类统一 JPEG（去元数据且体积小），PNG 保真 */
function outputEncoding(filePath) {
  const ext = path.extname(String(filePath)).slice(1).toLowerCase();
  if (ext === 'png') return { ext: 'png', type: 'image/png', quality: undefined };
  return { ext: ext === 'jpeg' ? 'jpeg' : 'jpg', type: 'image/jpeg', quality: 0.92 };
}

const ICC_MARKER = 'ICC_PROFILE';

/**
 * 提取 JPEG 内嵌的 ICC 色彩配置（APP2，支持多段拼接）。
 * 扫描仪 ICC 决定查看器的色彩基调（灰底扫描件尤其明显），
 * 重编码若不透传，产物会在查看器里整体偏色。无 ICC 返回 null。
 */
function extractJpegIcc(buf) {
  if (!buf || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  const chunks = [];
  let count = -1;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD9 || m === 0xDA) break; // EOI / SOS 之后不再有头部段
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m === 0xE2 && len >= 31 && buf.slice(i + 4, i + 4 + 11).toString('latin1') === ICC_MARKER) {
      // 段数据布局：ICC_PROFILE\0(12B) + 段序号(1B) + 总段数(1B) + 数据
      const idx = buf[i + 16];
      const cnt = buf[i + 17];
      if (cnt > 0 && idx >= 1 && idx <= cnt) {
        if (count < 0) count = cnt;
        chunks[idx - 1] = buf.slice(i + 18, i + 2 + len);
      }
    }
    i += 2 + len;
  }
  if (count > 0 && chunks.length === count && chunks.every(Boolean)) return Buffer.concat(chunks);
  return null;
}

/** 每个 APP2 ICC 段的最大数据长度（段长上限 65535，扣除长度字段与段头） */
const ICC_CHUNK_MAX = 65535 - 2 - (2 + ICC_MARKER.length + 2);

/**
 * 把 ICC 以 APP2 段写入 JPEG：置于 APP0 之后，并去掉编码器自带的通用 ICC。
 * 源像素未经色彩变换，沿用源 ICC 才能在支持 ICC 的查看器里呈现与原图一致的基调。
 */
function embedJpegIcc(jpeg, icc) {
  if (!icc || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return jpeg;
  const segs = [];
  for (let off = 0; off < icc.length; off += ICC_CHUNK_MAX) {
    const data = icc.slice(off, off + ICC_CHUNK_MAX);
    const head = Buffer.from(ICC_MARKER + '\0', 'latin1');
    const seg = Buffer.alloc(2 + 2 + head.length + 2 + data.length);
    seg[0] = 0xFF; seg[1] = 0xE2;
    seg.writeUInt16BE(seg.length - 2, 2);
    head.copy(seg, 4);
    seg[4 + head.length] = off / ICC_CHUNK_MAX + 1;
    seg[5 + head.length] = Math.ceil(icc.length / ICC_CHUNK_MAX);
    data.copy(seg, 6 + head.length);
    segs.push(seg);
  }
  const out = [jpeg.slice(0, 2)]; // SOI
  let i = 2;
  let inserted = false;
  while (i + 3 < jpeg.length) {
    if (jpeg[i] !== 0xFF) { i++; continue; }
    const m = jpeg[i + 1];
    if (m === 0xD9 || m === 0xDA) { out.push(jpeg.slice(i)); break; } // EOI/SOS 及其后原样保留
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { out.push(jpeg.slice(i, i + 2)); i += 2; continue; }
    const len = jpeg.readUInt16BE(i + 2);
    // 丢掉编码器自带的通用 ICC 段，避免与源 ICC 冲突
    if (m === 0xE2 && jpeg.slice(i + 4, i + 4 + 11).toString('latin1') === ICC_MARKER) {
      i += 2 + len;
      continue;
    }
    out.push(jpeg.slice(i, i + 2 + len));
    i += 2 + len;
    // APP0 之后插入源 ICC
    if (!inserted && m === 0xE0) {
      inserted = true;
      out.push(...segs);
    }
  }
  if (!inserted) out.splice(1, 0, ...segs);
  return Buffer.concat(out);
}

/**
 * 图片不可逆遮盖。
 * @returns {Promise<object>} 与 maskFile 同风格的结果对象
 */
async function redactImageFile(filePath, toggles, outPath, opts = {}) {
  try {
    const bytes = fs.readFileSync(filePath);

    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    let img;
    try {
      img = await loadImage(bytes);
    } catch (err) {
      return { ok: false, path: filePath, skipped: 'image-decode-failed', reason: String(err && err.message || err) };
    }

    let blocks;
    try {
      blocks = await runOcr(bytes, opts);
    } catch (err) {
      if (err.code === 'OCR_ENGINE_NOT_FOUND') {
        return { ok: false, path: filePath, skipped: 'image-ocr-unavailable', reason: err.message };
      }
      throw err;
    }

    const count = 0;
    const counts = {};
    let boxes = [];
    if (blocks.length) {
      const info = ocrTextWithBoxes(blocks);
      const res = detect(info.text, {
        toggles,
        knownEntities: opts.knownEntities,
        knownNameHashes: opts.knownNameHashes,
      });
      boxes = boxesFromHits(res.items, info.chars);
      for (const it of res.items) counts[it.type] = (counts[it.type] || 0) + 1;
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return { ok: true, path: filePath, count: 0, skipped: 'no-pii' };

    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const padding = Math.max(1, Number(opts.padding) || 3);
    for (const b of mergeBoxes(boxes, padding)) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
    }

    const enc = outputEncoding(filePath);
    let outBytes;
    if (enc.type === 'image/jpeg') {
      // canvas 的 JPEG 编码固定 4:2:0，文字扫描件的灰底会被色度抽样搅出斑驳色块、
      // 背景整体漂移——改用 jpeg-js 全分辨率（4:4:4）编码，保证观感与原图一致
      const jpegjs = require('jpeg-js');
      const raw = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const q = Math.round(Math.max(0.5, Math.min(1, Number(enc.quality) || 0.92)) * 100);
      outBytes = Buffer.from(jpegjs.encode({ data: raw.data, width: raw.width, height: raw.height }, q).data);
      // 透传源 ICC，保持查看器中的色彩基调与原图一致
      const icc = extractJpegIcc(bytes);
      if (icc) outBytes = embedJpegIcc(outBytes, icc);
    } else {
      outBytes = enc.quality
        ? canvas.toBuffer(enc.type, enc.quality)
        : canvas.toBuffer(enc.type);
    }
    let out = outPath || redactedPathOf(filePath);
    // 后缀要与输出编码一致（如 .tif → .jpg）
    if (path.extname(out).slice(1).toLowerCase() !== enc.ext) {
      out = path.join(path.dirname(out), path.basename(out, path.extname(out)) + '.' + enc.ext);
    }
    fs.writeFileSync(out, outBytes);
    return {
      ok: true, path: filePath, redactedPath: out, count: total, counts,
      irreversible: true, ocr: true,
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
  IMAGE_EXTS, isImage, redactImageFile, extractJpegIcc, embedJpegIcc,
};
