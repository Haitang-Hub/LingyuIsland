'use strict';
/** 批量结果摘要：仅胶囊轮播文案；面板保持原有 toast。 */

const { test, assert } = require('./helpers');
const { buildBatchSummary, TONE } = require('../src/renderer/batch-summary');

function assertEndsWithDone(s) {
  const last = s.lines[s.lines.length - 1];
  assert.strictEqual(last.text, '处理完成');
  assert.strictEqual(last.tone, TONE.OK);
}

test('批量摘要：只有 ok / err 两档，橙色留给 busy 态', () => {
  assert.deepStrictEqual(Object.keys(TONE).sort(), ['ERR', 'OK']);
  assert.ok(!('detail' in buildBatchSummary({ total: 1 })));
});

test('批量摘要：单文件成功为绿色已完成，最后一条是处理完成', () => {
  const s = buildBatchSummary({ total: 1, masked: 1, totalPII: 3 });
  assert.strictEqual(s.lines[0].text, '已完成：屏蔽 1 份');
  assert.strictEqual(s.lines[0].tone, TONE.OK);
  assert.strictEqual(s.lines.length, 2);
  assertEndsWithDone(s);
});

test('批量摘要：成功与未完成并存时，绿色在前、红色带说明、处理完成收尾', () => {
  const s = buildBatchSummary({
    total: 6, masked: 3, overwritten: 1,
    pdfNoText: 2, convertFailed: 1, skipped: 3,
  });
  assert.strictEqual(s.lines[0].tone, TONE.OK);
  assert.strictEqual(s.lines[0].text, '已完成：屏蔽 3 份 · 覆盖同名 1 份');
  assert.ok(s.lines.some((l) => l.text === '副本已生成 · 覆盖同名 1 份' && l.tone === TONE.OK));
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：扫描件 PDF 2 份（无可提取文本）' && l.tone === TONE.ERR));
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：.doc 转换失败 1 份（请在 Word 中另存为 .docx）' && l.tone === TONE.ERR));
  assert.ok(s.lines.every((l) => l.tone === TONE.OK || l.tone === TONE.ERR));
  assertEndsWithDone(s);
});

test('批量摘要：编码无法识别红字带原因，无 title 明细', () => {
  const s = buildBatchSummary({ total: 2, restored: 1, restoreMissing: 4 });
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：编码无法识别 4 个（可能已被修改）' && l.tone === TONE.ERR));
  assert.ok(!('detail' in s));
  assertEndsWithDone(s);
});

test('批量摘要：其他提示为绿色；空结果也以处理完成收尾', () => {
  const s = buildBatchSummary({ total: 1, noPii: 1 });
  assert.strictEqual(s.lines[0].text, '未检出敏感信息 1 份');
  assert.strictEqual(s.lines[0].tone, TONE.OK);
  assertEndsWithDone(s);

  const empty = buildBatchSummary({ total: 0 });
  assert.strictEqual(empty.lines[0].text, '未生成新副本');
  assert.strictEqual(empty.lines[0].tone, TONE.OK);
  assertEndsWithDone(empty);
});

test('批量摘要：文件被占用单独红行，不再混入「无法处理」', () => {
  const s = buildBatchSummary({ total: 1, locked: 1, skipped: 1 });
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：1 份文件被占用，无法覆盖（请关闭后重试）' && l.tone === TONE.ERR));
  assert.ok(!s.lines.some((l) => l.text.includes('无法处理')));
  assertEndsWithDone(s);
});

test('批量摘要：多类未完成逐条列出原因，其他提示保持绿色', () => {
  const s = buildBatchSummary({
    total: 8, masked: 2,
    restoreMissing: 1, alreadyMasked: 1, noPii: 1,
    pdfNoText: 1, convertFailed: 1, skipped: 2,
  });
  const errLines = s.lines.filter((l) => l.tone === TONE.ERR);
  const okLines = s.lines.filter((l) => l.tone === TONE.OK);
  assert.strictEqual(errLines.length, 3);
  assert.ok(errLines.every((l) => l.text.startsWith('未完成：') && l.text.includes('（')));
  assert.ok(okLines.some((l) => l.text.includes('已是屏蔽 1 份（未找到可还原编码）')));
  assert.ok(okLines.some((l) => l.text.includes('未检出敏感信息 1 份')));
  assert.ok(s.lines.every((l) => l.tone === TONE.OK || l.tone === TONE.ERR));
  assertEndsWithDone(s);
});
