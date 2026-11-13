'use strict';
/**
 * 生成托盘图标：黑色五瓣花/云朵小家伙 + 白色「> -」表情（终端提示符风格）
 * 零依赖：手写 PNG 编码（zlib deflate + CRC32），4x 超采样抗锯齿。
 *
 * 输出：
 *   assets/tray.png               16×16（Windows 100% DPI）
 *   assets/tray@2x.png            32×32（Windows 高 DPI）
 *   assets/tray-macTemplate.png   16×16（macOS 模板：黑色眼睛剪影）
 *   assets/tray-macTemplate@2x.png 32×32
 *
 * 用法：node scripts/gen-tray-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // 原始数据：每行前置 filter 字节 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 绘制 ---------------- */

/** 圆角矩形 SDF：返回值 < 0 表示在内部 */
function sdfRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 线段胶囊 SDF（radius = 半笔画宽）：用于画 < 形的两笔 */
function sdfSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/**
 * 渲染一张图标。
 * mode='island'：黑色五瓣花/云朵 + 白色「> -」表情（Windows 图标）
 * mode='eyes'  ：同造型黑色剪影、表情镂空（macOS 模板，系统自动适配深浅色）
 */
function render(size, mode) {
  const SS = 4; // 超采样倍数
  const N = size * SS;
  const buf = Buffer.alloc(N * N * 4);

  // 布局按 16 基准换算：五瓣花身体 + 「> -」表情
  const s = size / 16;
  const cx = size / 2;
  const cy = size / 2 + 0.2 * s;
  // 花：中心圆 + 5 个花瓣圆（union），外扩半径 6.5 → 16px 内留 1.5 边距
  const FLOWER = { R: 3.4 * s, rp: 3.1 * s, rc: 4.7 * s };
  // 表情：左「>」终端箭头 + 右「-」短横（微微下沉，像提示符）
  const chev = { vx: cx - 0.5 * s, ex: cx - 3.2 * s, ey: 2.5 * s, r: 1.15 * s };
  const dash = { x1: cx + 0.9 * s, x2: cx + 3.7 * s, y: cy + 1.3 * s, r: 1.0 * s };
  const BODY = hex('#101116');   // 黑色花瓣
  const FG = hex('#f5f7fa');     // 白色表情
  const BLACK = [0, 0, 0];

  // 有符号距离 → 覆盖率（1px 抗锯齿过渡带）
  const cover = (d) => Math.min(1, Math.max(0, 0.5 - d));

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // 像素中心坐标（映射到 16 基准逻辑坐标）
      const px = (x + 0.5) / SS;
      const py = (y + 0.5) / SS;

      // 五瓣花：中心圆与 5 个花瓣圆的并集
      let dFlower = Math.hypot(px - cx, py - cy) - FLOWER.rc;
      for (let k = 0; k < 5; k++) {
        const th = ((-90 + k * 72) * Math.PI) / 180;
        const pxx = cx + FLOWER.R * Math.cos(th);
        const pyy = cy + FLOWER.R * Math.sin(th);
        dFlower = Math.min(dFlower, Math.hypot(px - pxx, py - pyy) - FLOWER.rp);
      }
      const aFlower = cover(dFlower);

      // 表情「> -」：两笔圆头线段 + 一条短横
      const dUp = sdfSegment(px, py, chev.vx, cy, chev.ex, cy - chev.ey, chev.r);
      const dDown = sdfSegment(px, py, chev.vx, cy, chev.ex, cy + chev.ey, chev.r);
      const dDash = sdfSegment(px, py, dash.x1, dash.y, dash.x2, dash.y, dash.r);
      const aExpr = Math.max(cover(Math.min(dUp, dDown)), cover(dDash));

      let r = 0, g = 0, b = 0, a = 0;
      if (mode === 'island') {
        // 黑花底色上叠白色表情
        const bgA = aFlower * (1 - aExpr);
        r = BODY[0] * bgA + FG[0] * aExpr;
        g = BODY[1] * bgA + FG[1] * aExpr;
        b = BODY[2] * bgA + FG[2] * aExpr;
        a = bgA + aExpr;
      } else {
        // macOS 模板：黑色剪影，表情镂空成透明
        r = BLACK[0]; g = BLACK[1]; b = BLACK[2];
        a = aFlower * (1 - aExpr);
      }

      const i = (y * N + x) * 4;
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(a * 255);
    }
  }

  // 盒式降采样 SS×SS → size×size
  const out = Buffer.alloc(size * size * 4);
  const inv = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + x * SS + sx) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / inv);
      out[o + 1] = Math.round(g / inv);
      out[o + 2] = Math.round(b / inv);
      out[o + 3] = Math.round(a / inv);
    }
  }
  return encodePNG(size, size, out);
}

/* ---------------- 输出 ---------------- */

const outDir = path.join(__dirname, '..', 'assets');
const files = [
  ['tray.png', 16, 'island'],
  ['tray@2x.png', 32, 'island'],
  ['tray-macTemplate.png', 16, 'eyes'],
  ['tray-macTemplate@2x.png', 32, 'eyes'],
];
for (const [name, size, mode] of files) {
  fs.writeFileSync(path.join(outDir, name), render(size, mode));
  console.log('written', name, size + 'x' + size, mode);
}
