'use strict';
/**
 * 图标生成（纯 Node，无依赖）：深色圆角底 + 蓝色胶囊 + 白色元素
 * 4× 超采样抗锯齿后降采样，输出 assets/icon.png (256) 与 assets/tray.png (32)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */

// CRC32 查表法
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32b(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32b(body));
  return Buffer.concat([len, body, crc]);
}

function writePNG(file, width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`OK -> ${file} (${width}x${height})`);
}

/* ---------------- 绘制 ---------------- */

function drawIcon(size, variant = 'app') {
  const SS = 4;
  const W = size * SS;
  const buf = Buffer.alloc(W * W * 4);
  const isTemplate = variant === 'template';

  const idx = (x, y) => (y * W + x) * 4;
  const over = (x, y, r, g, b, a) => {
    const i = idx(x, y);
    const da = buf[i + 3] / 255;
    const sa = a / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / outA);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / outA);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / outA);
    buf[i + 3] = Math.round(outA * 255);
  };
  // 擦除（destination-out）：模板图中挖出透明洞
  const erase = (x, y) => {
    const i = idx(x, y);
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
  };

  const shape = (px, py, test, r, g, b, a) => {
    if (test(px, py)) { if (isTemplate && a < 255) erase(px, py); else over(px, py, r, g, b, a); }
  };

  const fillRoundedRect = (x0, y0, w, h, rad, [r, g, b, a]) => {
    const x1 = x0 + w, y1 = y0 + h;
    const cx = [x0 + rad, x1 - rad], cy = [y0 + rad, y1 - rad];
    const d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(W, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
        const px = x + 0.5, py = y + 0.5;
        let inside = true;
        if (px < cx[0]) { if (py < cy[0]) inside = dist(px, py, cx[0], cy[0]) <= rad; else if (py > cy[1]) inside = dist(px, py, cx[0], cy[1]) <= rad; }
        else if (px > cx[1]) { if (py < cy[0]) inside = dist(px, py, cx[1], cy[0]) <= rad; else if (py > cy[1]) inside = dist(px, py, cx[1], cy[1]) <= rad; }
        shape(px, py, () => inside, r, g, b, a);
      }
    }
  };

  const fillCircle = (cx, cy, rad, [r, g, b, a]) => {
    for (let y = Math.max(0, Math.floor(cy - rad)); y < Math.min(W, Math.ceil(cy + rad)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad)); x < Math.min(W, Math.ceil(cx + rad)); x++) {
        shape(x + 0.5, y + 0.5, () => dist(x + 0.5, y + 0.5, cx, cy) <= rad, r, g, b, a);
      }
    }
  };

  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  const s = W / 256;
  if (!isTemplate) {
    // 1. 深色圆角底
    fillRoundedRect(0, 0, W, W, 56 * s, [14, 16, 20, 255]);
  }
  // 2. 胶囊（应用图标蓝色 / 模板图纯黑）
  const pw = 184 * s, ph = 60 * s;
  fillRoundedRect((W - pw) / 2, (W - ph) / 2, pw, ph, ph / 2, isTemplate ? [0, 0, 0, 255] : [10, 132, 255, 255]);
  // 3. 白色圆点（模板图为透明挖洞）
  const dotR = 8.5 * s;
  const dotX = (W - pw) / 2 + 26 * s + dotR;
  fillCircle(dotX, W / 2, dotR, isTemplate ? [0, 0, 0, 0] : [255, 255, 255, 255]);
  // 4. 两段线
  const lineA = isTemplate ? [0, 0, 0, 0] : [255, 255, 255, 190];
  const h1 = 7 * s;
  const lx = dotX + dotR + 14 * s;
  fillRoundedRect(lx, W / 2 - h1 / 2 - 5 * s, 92 * s, h1, h1 / 2, lineA);
  fillRoundedRect(lx, W / 2 - h1 / 2 + 5 * s, 56 * s, h1, h1 / 2, lineA);

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = idx(x * SS + dx, y * SS + dy);
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const root = path.join(__dirname, '..');
writePNG(path.join(root, 'assets', 'icon.png'), 256, 256, drawIcon(256, 'app'));
writePNG(path.join(root, 'assets', 'tray.png'), 32, 32, drawIcon(32, 'app'));
// macOS 菜单栏模板图标（黑 + alpha，文件名以 Template 结尾 → Electron 自动按模板图处理）
writePNG(path.join(root, 'assets', 'tray-macTemplate.png'), 16, 16, drawIcon(16, 'template'));
writePNG(path.join(root, 'assets', 'tray-macTemplate@2x.png'), 32, 32, drawIcon(32, 'template'));
