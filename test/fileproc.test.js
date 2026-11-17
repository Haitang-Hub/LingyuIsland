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
  outputNameOf, normalizeSource, LEGACY_EXTS,
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

test('docx 屏蔽→还原（含声明注入，还原剥离）', () => {
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

test('内容识别：明文→屏蔽，含〔编码〕→还原', () => {
  const plain = path.join(TMP, 'intent-plain.txt');
  const masked = path.join(TMP, 'intent-masked.txt');
  fs.writeFileSync(plain, '姓名：张伟 手机：13812345678', 'utf8');
  fs.writeFileSync(masked, '手机：138****5678〔ab12cd〕', 'utf8');
  assert.strictEqual(detectFileIntent(plain), 'mask');
  assert.strictEqual(detectFileIntent(masked), 'restore');
  assert.ok(readFileText(plain).includes('13812345678'));
  assert.ok(readFileText(masked).includes('〔ab12cd〕'));
});

test('内容识别：GBK / docx / 无法读取回退', () => {
  const gbk = path.join(TMP, 'intent-gbk.txt');
  fs.writeFileSync(gbk, iconv.encode('手机：138****5678〔ab12cd〕', 'gbk'));
  assert.strictEqual(detectFileIntent(gbk), 'restore');

  const p = path.join(TMP, 'intent.docx');
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>手机：138****5678〔ab12cd〕</w:t></w:r></w:p></w:body></w:document>',
    'utf8'));
  zip.writeZip(p);
  assert.ok(readFileText(p).includes('〔ab12cd〕'));
  assert.strictEqual(detectFileIntent(p), 'restore');

  const raw = path.join(TMP, 'raw.bin');
  fs.writeFileSync(raw, Buffer.from([0, 1, 2, 3, 255, 254, 0]));
  assert.strictEqual(readFileText(raw), null);
  assert.strictEqual(detectFileIntent(raw), 'mask');
  assert.strictEqual(detectFileIntent(path.join(TMP, '不存在.txt')), 'mask');
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
  const { readPdfText, maskPdfFile, restorePdfFile } = require('../src/core/fileproc');
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
  const m = await maskPdfFile(src, v, {}, null, {});
  test('PDF·遮蔽生成新 PDF 且无敏感值残留', () => {
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.ok(m.maskedPath && m.count > 0);
  });
  const text1 = await readPdfText(m.ok ? m.maskedPath : src);
  test('PDF·遮蔽后文本层不含原号码，含带标签编码', () => {
    assert.ok(!text1.includes('13812345678'));
    assert.ok(/〔[\u4e00-\u9fa5]{1,6}·[0-9a-f]{6,12}〕/.test(text1), '应含类型标签还原编码');
    assert.ok(text1.includes('〔灵屿岛脱敏声明〕'), '应注入虚构声明');
  });

  const r = await restorePdfFile(m.maskedPath, v, null);
  const text2 = await readPdfText(r.restoredPath);
  test('PDF·还原后文本层逐字一致（声明行剥除）', () => {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(text2, text0);
  });

  const blankDoc = await PDFDocument.create();
  blankDoc.addPage([200, 200]);
  const blank = path.join(dir, 'pdf-blank.pdf');
  fs.writeFileSync(blank, await blankDoc.save());
  const bm = await maskPdfFile(blank, new Vault(), {}, null, {});
  test('PDF·扫描件/无文本层返回 pdf-no-text', () => {
    assert.strictEqual(bm.skipped, 'pdf-no-text', JSON.stringify(bm));
  });
}

/* ---------------- 输出 ---------------- */

module.exports = pdfSuite;
