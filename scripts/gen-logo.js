'use strict';
/**
 * 从 assets/logo-source.jpg 生成全套图标：
 *   icon.png(256) / tray.png(16) / tray@2x.png(32)
 *   tray-macTemplate.png(16) / tray-macTemplate@2x.png(32)（黑色剪影+透明底）
 * 用法：node scripts/gen-logo.js   （依赖 jimp）
 *
 * 处理：从四边 flood-fill 抠除近白背景（含浅灰棋盘纹），保留内部白色眼睛；
 * 边缘残留的白色锯齿再做邻接清除；裁剪 bbox 后缩放输出。
 */

const path = require('path');
const fs = require('fs');

let Jimp;
try { ({ Jimp } = require('jimp')); } catch { Jimp = require('jimp'); }

const SRC = path.join(__dirname, '..', 'assets', 'logo-source.jpg');
const OUT = path.join(__dirname, '..', 'assets');

const isLight = (r, g, b) => Math.min(r, g, b) > 215 && (Math.max(r, g, b) - Math.min(r, g, b)) < 22;

async function main() {
  const img = await Jimp.read(SRC);
  const { width: w, height: h, data } = img.bitmap;
  console.log(`源图 ${w}x${h}`);

  // —— flood fill：从边界出发清除近白背景 ——
  const bg = new Uint8Array(w * h); // 1 = 背景
  const stack = [];
  const idx = (x, y) => y * w + x;
  for (let x = 0; x < w; x++) { stack.push([x, 0], [x, h - 1]); }
  for (let y = 0; y < h; y++) { stack.push([0, y], [w - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = idx(x, y);
    if (bg[i]) continue;
    const o = i * 4;
    if (!isLight(data[o], data[o + 1], data[o + 2])) continue;
    bg[i] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  // —— 边缘残留白边清除：透明邻居 + 近白 → 透明（两轮） ——
  for (let pass = 0; pass < 2; pass++) {
    const extra = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = idx(x, y);
        if (bg[i]) continue;
        const o = i * 4;
        if (!isLight(data[o], data[o + 1], data[o + 2])) continue;
        const nearTransparent = bg[idx(x + 1, y)] || bg[idx(x - 1, y)] || bg[idx(x, y + 1)] || bg[idx(x, y - 1)];
        if (nearTransparent) extra.push(i);
      }
    }
    for (const i of extra) bg[i] = 1;
  }

  // —— 应用透明度 + 裁剪 bbox ——
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) data[i * 4 + 3] = 0;
  }
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[idx(x, y) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('背景抠除失败：没有剩余不透明像素（阈值过严）');
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  console.log(`主体 bbox ${cw}x${ch} @(${minX},${minY})`);
  img.crop({ x: minX, y: minY, w: cw, h: ch });

  // —— 输出各尺寸 ——
  const outIcon = img.clone().resize({ w: 256, h: 256 });
  await outIcon.write(path.join(OUT, 'icon.png'));

  for (const [file, size] of [['tray.png', 16], ['tray@2x.png', 32]]) {
    await img.clone().resize({ w: size, h: size }).write(path.join(OUT, file));
  }

  // mac 模板图：形状剪影填黑 + 透明底
  for (const [file, size] of [['tray-macTemplate.png', 16], ['tray-macTemplate@2x.png', 32]]) {
    const t = img.clone().resize({ w: size, h: size });
    const td = t.bitmap.data;
    for (let i = 0; i < td.length; i += 4) {
      if (td[i + 3] > 0) { td[i] = 0; td[i + 1] = 0; td[i + 2] = 0; }
    }
    await t.write(path.join(OUT, file));
  }
  console.log('已输出 icon.png / tray.png / tray@2x.png / tray-macTemplate.png / tray-macTemplate@2x.png');
  void fs;
}

main().catch((e) => { console.error(e); process.exit(1); });
