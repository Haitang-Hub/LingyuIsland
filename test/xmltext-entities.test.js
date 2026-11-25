'use strict';
/**
 * Office XML 字符实体回归：有些上游导出器把整篇中文写成 &#24320;&#24237;...
 * 检测规则建立在汉字 Unicode 区间上，必须先在文本节点层解码，再按偏移映射写回，
 * 否则姓名/地址/机构/案号全部漏检，且残留复检同样看不见中文。
 *
 * 所有样本均为虚构值（helpers.makeIdCard 生成的测试号码）。
 */

const AdmZip = require('adm-zip');
const path = require('path');
const { test, assert, ID1, tempDir, rmDir } = require('./helpers');
const { xmlBlockTexts, transformXmlText } = require('../src/core/xmltext');
const { Vault, maskEdits, restoreEdits, cleanEdits } = require('../src/core/masker');
const { maskFile, restoreFile } = require('../src/core/fileproc');

/** 把非 ASCII 字符写成十进制数字字符引用，模拟实体编码导出器 */
function numeric(s) {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    out += cp > 0x7f ? `&#${cp};` : ch;
  }
  return out;
}

const ADDR = '浙江省杭州市西湖区文三路138号3幢201室';
const BODY = `姓名：张三，身份证号：${ID1}，住址：${ADDR}。`;

function maskXml(xml, vault) {
  return transformXmlText(xml, (text, boundaries) => {
    const { edits, items } = maskEdits(text, vault, { boundaries });
    return { edits, count: items.length };
  }).xml;
}

function restoreXml(xml, vault) {
  return transformXmlText(xml, (text) => {
    const x = restoreEdits(text, vault);
    return { edits: cleanEdits(x.edits), count: x.restored.length };
  }).xml;
}

function makeEntityDocx(filePath, bodyText) {
  const zip = new AdmZip();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>${numeric(bodyText)}</w:t></w:r></w:p>
</w:body></w:document>`;
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>', 'utf8'));
  zip.writeZip(filePath);
  return documentXml;
}

test('Office 实体：数字/十六进制/命名字符引用在检测前解码', () => {
  const xml = '<w:p><w:r><w:t>&#22995;&#21517;&#65306;&#24352;&#19977;&lt;&#x4f60;&#x597d;&amp;</w:t></w:r></w:p>';
  assert.strictEqual(xmlBlockTexts(xml)[0], '姓名：张三<你好&');
});

test('Office 实体：中文全实体文档能检出姓名/身份证/住址', () => {
  const xml = `<w:p><w:r><w:t>${numeric(BODY)}</w:t></w:r></w:p>`;
  const v = new Vault();
  const masked = xmlBlockTexts(maskXml(xml, v)).join('');
  assert.ok(!masked.includes('张三'), `姓名应被屏蔽: ${masked}`);
  assert.ok(!masked.includes(ID1), `身份证应被屏蔽: ${masked}`);
  assert.ok(!masked.includes('文三路'), `住址应被屏蔽: ${masked}`);
  assert.ok(/〔姓名·[0-9a-f]{6}〕/.test(masked), '应有姓名编码');
});

test('Office 实体：屏蔽→还原逐字节一致（含跨 run 实体）', () => {
  // 把正文拆进多个 run，每个 run 里中文全是实体；地址横跨三个节点
  const runs = [numeric('姓名：'), numeric('张三'), numeric('，住址：'),
    numeric('浙江省杭州市'), numeric('西湖区文三路'), numeric('138号3幢201室'), numeric('。')];
  const xml = `<w:p>${runs.map((s) => `<w:r><w:t>${s}</w:t></w:r>`).join('')}</w:p>`;
  const v = new Vault();
  const maskedXml = maskXml(xml, v);
  assert.ok(!xmlBlockTexts(maskedXml).join('').includes('张三'));
  assert.strictEqual(restoreXml(maskedXml, v), xml, '还原后 XML 应与原文逐字节一致');
});

test('Office 实体：文件路径管道屏蔽后不泄漏，还原后文档字节一致', () => {
  const dir = tempDir('lingyu-entity-xml-');
  try {
    const src = path.join(dir, '样本.docx');
    const out = path.join(dir, '样本_屏蔽.docx');
    const back = path.join(dir, '样本_还原.docx');
    const originalXml = makeEntityDocx(src, BODY);
    const v = new Vault();
    const toggles = {
      phone: true, idCard: true, bank: true, email: true, name: true,
      address: true, passport: true, plate: true, caseNo: true, license: true,
      org: true, landline: true, im: false, native: true, uscc: true,
    };
    const r = maskFile(src, v, toggles, out);
    assert.ok(r.ok && r.count > 0, `屏蔽应命中: ${JSON.stringify(r)}`);
    const maskedText = xmlBlockTexts(new AdmZip(out).readAsText('word/document.xml')).join('');
    assert.ok(!maskedText.includes('张三') && !maskedText.includes(ID1)
      && !maskedText.includes('文三路'), `产物不应泄漏原值: ${maskedText}`);

    const rr = restoreFile(out, v, back);
    assert.ok(rr.ok, `还原应成功: ${JSON.stringify(rr)}`);
    assert.strictEqual(new AdmZip(back).readAsText('word/document.xml'), originalXml,
      '还原后 document.xml 应逐字节一致');
  } finally {
    rmDir(dir);
  }
});
