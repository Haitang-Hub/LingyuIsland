'use strict';
/** 文件管道套件：编码识别 / txt-docx 读写 / 意图判断 / 老式 .doc / PDF / 输出路径 */

const { test, assert, ID1, BANK1, SAMPLE, tempDir, rmDir, makeDocx, iconvEncode } = require('./helpers');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const { Vault, maskText, restoreText, countCodes, maskEdits, restoreEdits, cleanEdits } = require('../src/core/masker');
const {
  maskFile, restoreFile, decodeBuffer, encodeText, maskedPathOf,
  readFileText, detectFileIntent, isJunkFile, collectPaths,
  outputNameOf, normalizeSource, LEGACY_EXTS, skipReasonForError,
} = require('../src/core/fileproc');
const { resolveOutputPath } = require('../src/main/importer');

const TMP = tempDir('lingyu-fileproc-');
fs.mkdirSync(TMP, { recursive: true });

/* ---------------- 编码识别 ---------------- */

test('decodeBuffer/encodeText：GBK 往返', () => {
  const text = '客户姓名：张三，手机 13812345678。';
  const buf = iconvEncode(text, 'gbk');
  const dec = decodeBuffer(buf);
  assert.strictEqual(dec.encoding, 'gbk');
  assert.strictEqual(dec.text, text);
  const back = encodeText(dec.text, dec.encoding, dec.bom);
  assert.ok(Buffer.compare(back, buf) === 0 || decodeBuffer(back).text === text);
});

test('decodeBuffer：UTF-8 BOM / 二进制识别', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('手机13812345678', 'utf8')]);
  const dec = decodeBuffer(withBom);
  assert.strictEqual(dec.encoding, 'utf8');
  assert.strictEqual(dec.bom, true);
  // 非法 UTF-8 且 GBK 乱码率超阈值（含 NUL）应判定为二进制
  assert.strictEqual(decodeBuffer(Buffer.from([0, 1, 2, 3, 255, 254, 0])), null, '二进制应返回 null');
});

test('写入异常分类：文件被占用/无权限归 locked，其余归 error', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    assert.strictEqual(skipReasonForError(Object.assign(new Error('busy'), { code })), 'locked');
  }
  assert.strictEqual(skipReasonForError(Object.assign(new Error('nope'), { code: 'ENOENT' })), 'error');
  assert.strictEqual(skipReasonForError(new Error('plain')), 'error');
});

/* ---------------- 文本文件管道 ---------------- */

test('GBK 文本文件 屏蔽→还原（编码保持）', () => {
  const gbk = iconvEncode(SAMPLE, 'gbk');
  const p = path.join(TMP, 'gbk-sample.txt');
  fs.writeFileSync(p, gbk);
  const v = new Vault();
  const m = maskFile(p, v);
  assert.strictEqual(m.ok, true);
  assert.ok(m.count > 0, '应检出敏感信息');
  const dec = decodeBuffer(fs.readFileSync(m.maskedPath));
  assert.strictEqual(dec.encoding, 'gbk');
  const r = restoreFile(m.maskedPath, v);
  assert.strictEqual(r.ok, true);
  const back = decodeBuffer(fs.readFileSync(r.restoredPath));
  assert.strictEqual(back.encoding, 'gbk');
  assert.strictEqual(back.text, SAMPLE);
});

test('UTF-8 文本文件 屏蔽→还原', () => {
  const p = path.join(TMP, 'utf8-sample.txt');
  fs.writeFileSync(p, SAMPLE, 'utf8');
  const v = new Vault();
  const m = maskFile(p, v);
  assert.strictEqual(m.ok, true);
  assert.ok(fs.readFileSync(m.maskedPath, 'utf8').includes('性别：男'));
  const r = restoreFile(m.maskedPath, v);
  assert.strictEqual(fs.readFileSync(r.restoredPath, 'utf8'), SAMPLE);
});

test('docx 屏蔽→还原', () => {
  const docxPath = path.join(TMP, 'sample.docx');
  const zip = new AdmZip();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>客户姓名：张三，手机 13812345678。</w:t></w:r></w:p>
<w:p><w:r><w:t>性别：男 年龄：30岁</w:t></w:r></w:p>
</w:body></w:document>`;
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>', 'utf8'));
  zip.writeZip(docxPath);

  const v = new Vault();
  const m = maskFile(docxPath, v);
  assert.strictEqual(m.ok, true, 'docx 屏蔽应成功');
  assert.ok(m.count > 0, 'docx 应检出敏感信息');

  const maskedZip = new AdmZip(m.maskedPath);
  const maskedXml = maskedZip.readAsText('word/document.xml');
  assert.ok(maskedXml.includes('张*〔姓名·'), '姓名应被屏蔽（带标签）');
  assert.ok(!maskedXml.includes('13812345678'), '手机号应被屏蔽');
  assert.ok(maskedXml.includes('性别：男'), '性别应保留');

  const r = restoreFile(m.maskedPath, v);
  assert.strictEqual(r.ok, true, 'docx 还原应成功');
  const backZip = new AdmZip(r.restoredPath);
  const backXml = backZip.readAsText('word/document.xml');
  assert.ok(backXml.includes('13812345678'), true);
  assert.ok(!backXml.includes('〔'), '还原产物不应残留编码');
});

test('不受支持的格式被明确跳过', () => {
  const p = path.join(TMP, 'blob.bin');
  fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  const v = new Vault();
  const m = maskFile(p, v);
  assert.strictEqual(m.skipped, 'unsupported');
});

test('原文件永不被覆盖', () => {
  const p = path.join(TMP, 'keep.txt');
  fs.writeFileSync(p, '电话13812345678', 'utf8');
  const before = fs.readFileSync(p, 'utf8');
  const v = new Vault();
  maskFile(p, v);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

test('屏蔽/还原可写到指定路径，不传时行为不变', () => {
  const dir = path.join(TMP, 'outpath');
  fs.mkdirSync(dir, { recursive: true });
  const nested = path.join(dir, '结果目录');
  fs.mkdirSync(nested, { recursive: true });
  const src = path.join(dir, '源.txt');
  const out = path.join(nested, '屏蔽结果.txt');
  fs.writeFileSync(src, '手机13812345678', 'utf8');
  const v = new Vault();

  const r = maskFile(src, v, undefined, out);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.maskedPath, out);
  assert.ok(fs.readFileSync(out, 'utf8').includes('138****5678'));
  assert.ok(!fs.existsSync(path.join(dir, '源_屏蔽.txt')), '指定路径后不应再写默认副本');

  const restoredOut = path.join(nested, '还原结果.txt');
  const rr = restoreFile(out, v, restoredOut);
  assert.strictEqual(rr.ok, true);
  assert.strictEqual(rr.restoredPath, restoredOut);
  assert.ok(fs.readFileSync(restoredOut, 'utf8').includes('13812345678'));

  const r2 = maskFile(src, v);
  assert.strictEqual(r2.maskedPath, path.join(dir, '源_屏蔽.txt'), '不传 outPath 应保持原行为');
});

test('结果路径：_还原 / _屏蔽 后缀剥离与序号', () => {
  assert.strictEqual(maskedPathOf(path.join(TMP, '起诉状_还原_02.docx')),
    path.join(TMP, '起诉状_屏蔽.docx'));
});

test('结果路径：resolveOutputPath 按内容与同名策略', () => {
  const root = path.join(TMP, 'result-root');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const a = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'keep');
  assert.strictEqual(a.out, path.join(root, '起诉状_屏蔽.docx'));
  const b = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_屏蔽.docx'), 'restore', 'keep');
  assert.strictEqual(b.out, path.join(root, '起诉状_还原.docx'), '_屏蔽 后缀应被去掉');
  fs.writeFileSync(path.join(root, '起诉状_屏蔽.docx'), 'x');
  const keep = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'keep');
  assert.strictEqual(keep.out, path.join(root, '起诉状_屏蔽_02.docx'));
  const over = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'overwrite');
  assert.strictEqual(over.out, path.join(root, '起诉状_屏蔽.docx'));
});

/* ---------------- 内容识别 ---------------- */

test('内容识别：明文→屏蔽，编码可还原→还原，编码外观但库里没有→屏蔽', () => {
  const plain = path.join(TMP, 'intent-plain.txt');
  const masked = path.join(TMP, 'intent-masked.txt');
  const fake = path.join(TMP, 'intent-fake.txt');
  const vault = new Vault('intent-test-salt');
  const code = vault.ensureCode('phone', '13812345678');
  fs.writeFileSync(plain, '姓名：张伟 手机：13812345678', 'utf8');
  fs.writeFileSync(masked, `手机：138****5678〔手机号·${code}〕`, 'utf8');
  fs.writeFileSync(fake, '姓名：〔姓名·abcdef〕', 'utf8');
  assert.strictEqual(detectFileIntent(plain, vault), 'mask');
  assert.strictEqual(detectFileIntent(masked, vault), 'restore');
  // 回归：abcdef 符合编码格式，但映射库无记录，不能让整份明文走还原
  assert.strictEqual(detectFileIntent(fake, vault), 'mask');
  assert.strictEqual(detectFileIntent(fake, new Vault()), 'mask');
  assert.ok(readFileText(plain).includes('13812345678'));
  assert.ok(readFileText(masked).includes(`〔手机号·${code}〕`));
});

test('内容识别：GBK / docx / 无法读取 / 产物文件名兜底', () => {
  const vault = new Vault('gbk-test-salt');
  const code = vault.ensureCode('phone', '13812345678');
  const gbk = path.join(TMP, 'intent-gbk.txt');
  fs.writeFileSync(gbk, iconv.encode(`手机：138****5678〔手机号·${code}〕`, 'gbk'));
  assert.strictEqual(detectFileIntent(gbk, vault), 'restore');
  assert.strictEqual(detectFileIntent(gbk, new Vault()), 'mask');

  const p = path.join(TMP, 'intent.docx');
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(
    `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>手机：138****5678〔手机号·${code}〕</w:t></w:r></w:p></w:body></w:document>`,
    'utf8'));
  zip.writeZip(p);
  assert.ok(readFileText(p).includes(`〔手机号·${code}〕`));
  assert.strictEqual(detectFileIntent(p, vault), 'restore');

  // 文件名明确是产物：即使映射库缺失也走还原，由 restoreFile 提示无法还原
  const named = path.join(TMP, '阅卷笔录_屏蔽.txt');
  fs.writeFileSync(named, '姓名：〔姓名·abcdef〕', 'utf8');
  assert.strictEqual(detectFileIntent(named, new Vault()), 'restore');
  const namedRestored = path.join(TMP, '阅卷笔录_还原.txt');
  fs.writeFileSync(namedRestored, '姓名：〔姓名·abcdef〕', 'utf8');
  assert.strictEqual(detectFileIntent(namedRestored, new Vault()), 'restore');
  // 兜底只认 _屏蔽 / _还原 两种产物后缀
  const namedLegacy = path.join(TMP, '阅卷笔录_脱敏.txt');
  fs.writeFileSync(namedLegacy, '姓名：〔姓名·abcdef〕', 'utf8');
  assert.strictEqual(detectFileIntent(namedLegacy, new Vault()), 'mask');

  const raw = path.join(TMP, 'raw.bin');
  fs.writeFileSync(raw, Buffer.from([0, 1, 2, 3, 255, 254, 0]));
  assert.strictEqual(readFileText(raw), null);
  assert.strictEqual(detectFileIntent(raw, vault), 'mask');
  assert.strictEqual(detectFileIntent(path.join(TMP, '不存在.txt'), vault), 'mask');
});

/* ---------------- 垃圾文件 / 收集 ---------------- */

test('isJunkFile：Office 锁文件与系统文件', () => {
  assert.strictEqual(isJunkFile('~$委托代理合同_屏蔽.docx'), true);
  assert.strictEqual(isJunkFile('~$a.xlsx'), true);
  assert.strictEqual(isJunkFile('.~lock.客户通讯录.csv#'), true);
  assert.strictEqual(isJunkFile('Thumbs.db'), true);
  assert.strictEqual(isJunkFile('desktop.ini'), true);
  assert.strictEqual(isJunkFile('.DS_Store'), true);
  assert.strictEqual(isJunkFile('01_委托代理合同.docx'), false);
});

test('collectPaths：跳过 ~$ 锁文件，老式 .doc 不被静默丢弃', () => {
  const dir = path.join(TMP, 'collect');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '正常文件.txt'), 'x');
  fs.writeFileSync(path.join(dir, '~$正常文件.docx'), 'x');
  const legacy = path.join(dir, '笔录.doc');
  fs.writeFileSync(legacy, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const got = collectPaths([dir]);
  assert.ok(got.some((p) => path.basename(p) === '正常文件.txt'));
  assert.ok(!got.some((p) => path.basename(p).startsWith('~$')), '锁文件不应被收集');
  assert.ok(got.some((p) => p === legacy), '.doc 应被收集');
  assert.strictEqual(LEGACY_EXTS.has('doc') && LEGACY_EXTS.has('dot'), true);
});

test('collectPaths：图片文件必须被收集（曾经漏掉导致拖图无反应）', () => {
  const dir = path.join(TMP, 'collect-img');
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, '扫描件.jpg');
  fs.writeFileSync(img, 'x');
  const png = path.join(dir, '截图.PNG');
  fs.writeFileSync(png, 'x');
  const got = collectPaths([dir]);
  assert.ok(got.some((p) => p === img), '.jpg 应被收集');
  assert.ok(got.some((p) => path.basename(p) === '截图.PNG'), '大写后缀 .PNG 应被收集');
});

/* ---------------- 老式 .doc ---------------- */

test('老式 .doc / .dot 的结果统一命名为 .docx', () => {
  assert.strictEqual(outputNameOf('示例笔录.doc'), '示例笔录.docx');
  assert.strictEqual(outputNameOf('庭审记录.DOT'), '庭审记录.docx');
  assert.strictEqual(outputNameOf('起诉状.docx'), '起诉状.docx');
  assert.strictEqual(outputNameOf('笔记.txt'), '笔记.txt');
});

test('后缀是 .doc 但内容其实是 OOXML → 直接按 docx 处理', () => {
  const p = path.join(TMP, '改后缀.doc');
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>手机13812345678</w:t></w:r></w:p></w:body></w:document>', 'utf8'));
  zip.writeZip(p);
  const n = normalizeSource(p);
  assert.strictEqual(n.ext, 'docx');
  assert.strictEqual(n.src, p);
  const r = maskFile(p, new Vault(), {});
  assert.strictEqual(r.ok, true);
  assert.ok(r.count > 0);
  assert.ok(r.maskedPath.endsWith('改后缀_屏蔽.docx'));
});

test('无法转换的 .doc 明确失败，不静默丢弃也不改写原件', () => {
  const p = path.join(TMP, '非OLE2.doc');
  fs.writeFileSync(p, '纯文本，不是 Word 二进制');
  const r = maskFile(p, new Vault(), {});
  assert.strictEqual(r.skipped, 'legacy-convert');
  assert.ok(r.reason && r.reason.length > 0);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '纯文本，不是 Word 二进制');
});

/* ---------------- PDF（异步管道） ---------------- */

async function pdfSuite() {
  const { PDFDocument } = require('pdf-lib');
  const fontkit = require('@pdf-lib/fontkit');
  const pdfproc = require('../src/core/pdfproc');
  const pdfredact = require('../src/core/pdfredact');
  const { readPdfText, redactPdfFile, restorePdfFile } = require('../src/core/fileproc');
  const dir = path.join(TMP, 'pdf');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'pdf-unit.pdf');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fp = pdfproc.findFontPath();
  assert.ok(fp, '需有可用中文字体');
  const font = await doc.embedFont(fs.readFileSync(fp), { subset: true });
  const page = doc.addPage([595, 842]);
  const lines = [
    '客户信息登记表',
    '姓名：张三  手机：13812345678',
    '身份证号：330106199001015670',
    '地址：浙江省杭州市西湖区文三路138号3幢201室',
  ];
  lines.forEach((t, i) => page.drawText(t, { x: 50, y: 780 - i * 30, size: 14, font }));
  fs.writeFileSync(src, await doc.save());

  const text0 = await readPdfText(src);
  test('PDF·文本层提取', () => {
    assert.ok(text0 && text0.includes('13812345678'), '应提取到手机号文本层');
  });

  const v = new Vault();
  const m = await redactPdfFile(src, v, {}, null, { dpi: 120 });
  test('PDF·不可逆遮盖生成新文件且不写 vault', () => {
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.ok(m.redactedPath && m.count > 0);
    assert.strictEqual(m.irreversible, true);
    assert.strictEqual(v.size, 0, 'PDF 遮盖不应写入可还原映射库');
    assert.ok(/_屏蔽\.pdf$/.test(m.redactedPath), '结果名应为 _屏蔽');
  });
  const text1 = await readPdfText(m.ok ? m.redactedPath : src);
  test('PDF·遮盖产物为纯图像，无文本层', () => {
    assert.strictEqual(text1, null, '不应残留可复制文本层');
  });

  // 回归守卫：坐标映射曾把 pdfjs 已缩放的 width 再乘字体缩放（约 14 倍），
  // 且 mergeBoxes 逐行连锁合并，导致整页被涂黑。这里直接统计渲染后的黑色像素占比。
  if (m.ok) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = require('@napi-rs/canvas');
    const redDoc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(m.redactedPath)) }).promise;
    const redPage = await redDoc.getPage(1);
    const vp = redPage.getViewport({ scale: 1 });
    const cv = createCanvas(Math.round(vp.width), Math.round(vp.height));
    await redPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    const pixels = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 32 && pixels[i + 1] < 32 && pixels[i + 2] < 32) dark++;
    }
    const blackRatio = dark / (cv.width * cv.height);
    test('PDF·遮盖只覆盖敏感区而非整页涂黑', () => {
      assert.ok(blackRatio < 0.25, `黑框占比应远小于整页，实际 ${(blackRatio * 100).toFixed(1)}%`);
    });
  }

  const again = await redactPdfFile(src, v, {}, null, { dpi: 120 });
  test('PDF·重复拖入不跳过，始终重新处理', () => {
    assert.notStrictEqual(again.skipped, 'already-redacted', JSON.stringify(again));
    assert.strictEqual(again.ok, true, JSON.stringify(again));
  });

  const rr = await restorePdfFile(m.ok ? m.redactedPath : src, v, null);
  test('PDF·还原入口被禁用', () => {
    assert.strictEqual(rr.skipped, 'pdf-restore-disabled');
  });

  const blankDoc = await PDFDocument.create();
  blankDoc.addPage([200, 200]);
  const blank = path.join(dir, 'pdf-blank.pdf');
  fs.writeFileSync(blank, await blankDoc.save());
  const bm = await redactPdfFile(blank, new Vault(), {}, null, {
    dpi: 120, ocrEngineDir: path.join(dir, '__no_engine__'),
  });
  test('PDF·无文本层且无 OCR 引擎返回 pdf-no-text', () => {
    assert.strictEqual(bm.skipped, 'pdf-no-text', JSON.stringify(bm));
  });

  // 有 RapidOCR-json 引擎时，验证「图片 PDF → OCR → 定位 → 遮盖」完整链路
  const engineDir = pdfredact.resolveEngineDir();
  if (engineDir) {
    const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
    GlobalFonts.registerFromPath(fp, 'LingyuTestCJK');
    const canvas = createCanvas(900, 240);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 240);
    ctx.fillStyle = '#000000';
    ctx.font = '34px LingyuTestCJK';
    ctx.fillText('手机：13812345678', 30, 90);
    ctx.fillText('姓名：张三', 30, 160);
    const imgDoc = await PDFDocument.create();
    const img = await imgDoc.embedPng(canvas.toBuffer('image/png'));
    const imgPage = imgDoc.addPage([450, 120]);
    imgPage.drawImage(img, { x: 0, y: 0, width: 450, height: 120 });
    const scanned = path.join(dir, 'pdf-scanned.pdf');
    fs.writeFileSync(scanned, await imgDoc.save());
    const sm = await redactPdfFile(scanned, new Vault(), {}, null, {
      dpi: 200, ocrEngineDir: engineDir,
    });
    test('PDF·图片 PDF 经 OCR 定位后遮盖', () => {
      assert.strictEqual(sm.ok, true, JSON.stringify(sm));
      assert.strictEqual(sm.ocr, true, '应走 OCR 分支');
      assert.ok(sm.count > 0, '应检出敏感信息');
      assert.ok(fs.existsSync(sm.redactedPath), '应生成遮盖产物');
    });
  }
}

/* ---------------- 输出 ---------------- */

module.exports = pdfSuite;
