'use strict';
/** 图片 OCR 不可逆遮盖套件（异步注册，由 run-tests.js 统一执行） */

const { test, assert, tempDir } = require('./helpers');
const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const pdfproc = require('../src/core/pdfproc');
const pdfredact = require('../src/core/pdfredact');
const imageredact = require('../src/core/imageredact');
const { redactImageFile, restoreImageFile, detectImageIntent } = require('../src/core/fileproc');

module.exports = async function imageSuite() {
  const dir = tempDir('lingyu-image-');
  fs.mkdirSync(dir, { recursive: true });

  const fp = pdfproc.findFontPath();
  const regOk = fp && GlobalFonts.registerFromPath(fp, 'ImageTestCJK');
  if (!regOk) {
    test('图片·需要可用中文字体', () => { assert.ok(false, '未找到可注册的中文字体'); });
    return;
  }

  // 生成一张含敏感信息的图片
  const canvas = createCanvas(900, 240);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 240);
  ctx.fillStyle = '#000000';
  ctx.font = '34px ImageTestCJK';
  ctx.fillText('手机：13812345678', 30, 90);
  ctx.fillText('姓名：张三', 30, 160);
  const src = path.join(dir, 'pii.png');
  fs.writeFileSync(src, canvas.toBuffer('image/png'));

  const engineDir = pdfredact.resolveEngineDir();
  const opts = { ocrEngineDir: engineDir || undefined };

  const r = await imageredact.redactImageFile(src, {}, null, opts);
  test('图片·OCR 识别并命中敏感信息', () => {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.ocr, true, '应走 OCR 分支');
    assert.ok(r.count > 0, '应检出敏感信息');
    assert.ok(fs.existsSync(r.redactedPath), '应生成遮盖产物');
  });

  test('图片·产物命名与不可逆标记', () => {
    assert.ok(/_屏蔽\.png$/.test(r.redactedPath), '后缀应为 _屏蔽');
    assert.strictEqual(r.irreversible, true);
  });

  // 重新对产物跑 OCR，敏感文字应已被涂黑而不可识别
  if (r.redactedPath) {
    const blocks = await pdfredact.runOcr(fs.readFileSync(r.redactedPath), { ocrEngineDir: engineDir || undefined });
    let outText = '';
    for (const b of blocks) outText += b.text + '\n';
    test('图片·遮盖后敏感文字不可被 OCR 复现', () => {
      assert.ok(!outText.includes('13812345678'), '手机号不应被 OCR 复现');
      assert.ok(!outText.includes('张三'), '姓名不应被 OCR 复现');
    });
  }

  const again = await imageredact.redactImageFile(src, {}, null, opts);
  test('图片·重复拖入不跳过，始终重新处理', () => {
    assert.notStrictEqual(again.skipped, 'already-redacted', JSON.stringify(again));
    assert.strictEqual(again.ok, true, JSON.stringify(again));
  });

  // JPEG ICC 透传：扫描仪 ICC 决定查看器的色彩基调，重编码必须原样保留，
  // 否则产物在支持 ICC 的查看器里整体偏色（曾经把白底扫描件变成灰蒙蒙）
  {
    const jpg = canvas.toBuffer('image/jpeg', 0.92);
    const icc = imageredact.extractJpegIcc(jpg);
    test('图片·canvas JPEG 自带 ICC 可提取', () => {
      assert.ok(icc && icc.length > 0, 'canvas 输出应含 ICC');
    });
    // 构造一个自定义 ICC，嵌入后必须原样可读回
    const fake = Buffer.concat([
      Buffer.from([0, 0, 0, 0x7c]),
      Buffer.from('mnitRGB ', 'latin1'),
      Buffer.alloc(100, 0xab),
    ]);
    const embedded = imageredact.embedJpegIcc(jpg, fake);
    test('图片·嵌入的 ICC 原样读回', () => {
      const back = imageredact.extractJpegIcc(embedded);
      assert.ok(back && back.equals(fake), '嵌入 ICC 应与源完全一致');
      // 嵌入不得破坏 JPEG 结构：仍以 SOI 开头且段序合法（SOI→APP0/APP2→…）
      assert.strictEqual(embedded[0], 0xFF);
      assert.strictEqual(embedded[1], 0xD8);
    });
    const noIcc = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xD9])]);
    test('图片·无 ICC 返回 null', () => {
      assert.strictEqual(imageredact.extractJpegIcc(noIcc), null);
    });
  }

  // 无敏感信息的图片
  const clean = createCanvas(300, 80);
  const cctx = clean.getContext('2d');
  cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, 300, 80);
  cctx.fillStyle = '#000'; cctx.font = '24px ImageTestCJK';
  cctx.fillText('今日天气晴', 10, 45);
  const cleanPath = path.join(dir, 'clean.png');
  fs.writeFileSync(cleanPath, clean.toBuffer('image/png'));
  const cr = await imageredact.redactImageFile(cleanPath, {}, null, opts);
  test('图片·无敏感信息跳过且不产出', () => {
    assert.strictEqual(cr.ok, true);
    assert.strictEqual(cr.skipped, 'no-pii');
    assert.ok(!cr.redactedPath, '不应生成产物');
  });

  test('图片·处理意图恒为 mask', () => {
    assert.strictEqual(detectImageIntent(src, {}), 'mask');
  });

  const rr = await restoreImageFile(src, new (require('../src/core/masker').Vault)(), null);
  test('图片·还原入口被禁用', () => {
    assert.strictEqual(rr.ok, false);
    assert.strictEqual(rr.skipped, 'image-restore-disabled');
  });

  // 经 fileproc 入口（含大小/类型判断）也应正常
  const fr = await redactImageFile(src, new (require('../src/core/masker').Vault)(), {}, null,
    { ocrEngineDir: engineDir || undefined });
  test('图片·fileproc 入口正常调用', () => {
    assert.strictEqual(fr.ok, true, JSON.stringify(fr));
    assert.ok(fr.count > 0);
  });

  // 可选：真实测试图（存在时验证，不作硬性断言以免环境差异）
  const realDir = 'C:/Users/Haitang/Desktop/测';
  if (fs.existsSync(path.join(realDir, '测试图1.jpg'))) {
    const real = await imageredact.redactImageFile(path.join(realDir, '测试图1.jpg'), {}, null,
      { ocrEngineDir: engineDir || undefined });
    test('图片·真实扫描图可遮盖', () => {
      assert.strictEqual(real.ok, true, JSON.stringify(real));
      assert.ok(real.count > 0, '代理词扫描图应命中机构名');
    });
  }
};
