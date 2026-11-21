'use strict';
/** 批量结果摘要：仅胶囊轮播文案；面板保持原有 toast。 */

const { test, assert } = require('./helpers');
const { buildBatchSummary, TONE } = require('../src/renderer/batch-summary');

/** 显示宽度估算（与 pill.js clampText 同口径）：全角 1、半角 0.5 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) >= 0x80 ? 1 : 0.5;
  return w;
}

// 胶囊文字区实测约 18 个全角字；轮播行预算 16 字位，超出会被截断丢信息，
// 所以文案本身必须写短 —— 这里做统一回归防护。
function assertWithinBudget(s) {
  for (const l of s.lines) {
    assert.ok(dispWidth(l.text) <= 16,
      `行超宽（${dispWidth(l.text)} 字位）：${l.text}`);
  }
}

function assertEndsWithDone(s) {
  const last = s.lines[s.lines.length - 1];
  assert.strictEqual(last.text, '处理完成');
  assert.strictEqual(last.tone, TONE.OK);
}

test('批量摘要：只有 ok / err 两档（两色方案，运行中绿色在胶囊 busy 态）', () => {
  assert.deepStrictEqual(Object.keys(TONE).sort(), ['ERR', 'OK']);
  assert.ok(!('detail' in buildBatchSummary({ total: 1 })));
});

test('批量摘要：单文件成功为绿色已完成，最后一条是处理完成', () => {
  const s = buildBatchSummary({ total: 1, masked: 1, totalPII: 3 });
  assert.strictEqual(s.lines[0].text, '已完成：屏蔽 1 份');
  assert.strictEqual(s.lines[0].tone, TONE.OK);
  assert.strictEqual(s.lines.length, 2);
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：成功与未完成并存时，绿色在前、红色带说明、处理完成收尾', () => {
  const s = buildBatchSummary({
    total: 6, masked: 3, overwritten: 1,
    pdfNoText: 2, convertFailed: 1, skipped: 3,
  });
  assert.strictEqual(s.lines[0].tone, TONE.OK);
  assert.strictEqual(s.lines[0].text, '已完成：屏蔽 3 份 · 覆盖 1 份');
  assert.ok(s.lines.some((l) => l.text === '副本已生成 · 覆盖 1 份' && l.tone === TONE.OK));
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：扫描件 2 份（无文本层）' && l.tone === TONE.ERR));
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：.doc 转换失败 1 份' && l.tone === TONE.ERR));
  assert.ok(s.lines.every((l) => l.tone === TONE.OK || l.tone === TONE.ERR));
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：编码无法识别红字带原因，无 title 明细', () => {
  const s = buildBatchSummary({ total: 2, restored: 1, restoreMissing: 4 });
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：编码无法识别 4 个' && l.tone === TONE.ERR));
  assert.ok(!('detail' in s));
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：otherSkipped 附首条原因，按宽度分块跨行轮播', () => {
  const s = buildBatchSummary({
    total: 1, overwritten: 1, skipped: 1,
    firstSkipReason: 'No "GlobalWorkerOptions.workerSrc" specified.',
  });
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：1 份不支持或过大' && l.tone === TONE.ERR), JSON.stringify(s.lines));
  const reasonLines = s.lines.filter((l) => l.tone === TONE.ERR
    && !l.text.startsWith('未完成：'));
  assert.ok(reasonLines.length >= 2, `长原因应分块多行：${JSON.stringify(s.lines)}`);
  assert.ok(reasonLines[0].text.startsWith('原因：No "Global'), '首块带「原因：」前缀');
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：处理失败时 overwritten 不进绿色行（先覆盖后未完成的矛盾修复）', () => {
  // 同名策略选了覆盖但处理失败：overwritten 不计数（importer 只在真实写盘成功时计），
  // 轮播只有红色未完成，不再出现自相矛盾的「已完成：覆盖 1 份」
  const s = buildBatchSummary({ total: 1, skipped: 1 });
  assert.ok(!s.lines.some((l) => l.text.includes('覆盖')), JSON.stringify(s.lines));
  assert.strictEqual(s.hasSuccess, false);
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：无 firstSkipReason 时原因行不出现', () => {
  const s = buildBatchSummary({ total: 1, skipped: 1 });
  assert.ok(!s.lines.some((l) => l.text.startsWith('原因：')));
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：1 份不支持或过大' && l.tone === TONE.ERR));
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：其他提示为绿色；空结果也以处理完成收尾', () => {
  const s = buildBatchSummary({ total: 1, noPii: 1 });
  assert.strictEqual(s.lines[0].text, '未检出敏感信息 1 份');
  assert.strictEqual(s.lines[0].tone, TONE.OK);
  assertEndsWithDone(s);
  assertWithinBudget(s);

  const empty = buildBatchSummary({ total: 0 });
  assert.strictEqual(empty.lines[0].text, '未生成新副本');
  assert.strictEqual(empty.lines[0].tone, TONE.OK);
  assertEndsWithDone(empty);
  assertWithinBudget(empty);
});

test('批量摘要：文件被占用单独红行，不再混入「无法处理」', () => {
  const s = buildBatchSummary({ total: 1, locked: 1, skipped: 1 });
  assert.ok(s.lines.some((l) =>
    l.text === '未完成：1 份被占用（关闭后重试）' && l.tone === TONE.ERR));
  assert.ok(!s.lines.some((l) => l.text.includes('无法处理')));
  assertEndsWithDone(s);
  assertWithinBudget(s);
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
  assert.ok(errLines.every((l) => l.text.startsWith('未完成：')));
  assert.ok(okLines.some((l) => l.text === '已是屏蔽 1 份'));
  assert.ok(okLines.some((l) => l.text === '未检出敏感信息 1 份'));
  assert.ok(s.lines.every((l) => l.tone === TONE.OK || l.tone === TONE.ERR));
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：不可逆遮盖提示为绿色且在 16 字位内（截图截断回归）', () => {
  const s = buildBatchSummary({ total: 4, irreversible: 4 });
  assert.ok(s.lines.some((l) =>
    l.text === 'PDF/图片 遮盖 4 份（不可还原）' && l.tone === TONE.OK));
  assertEndsWithDone(s);
  assertWithinBudget(s);
});

test('批量摘要：产物多行逐条展开，不与已完成行挤在一行', () => {
  const s = buildBatchSummary({
    total: 5, masked: 2, overwritten: 2, trashed: 1,
  });
  assert.ok(s.lines.some((l) => l.text === '已完成：屏蔽 2 份 · 覆盖 2 份'));
  assert.ok(s.lines.some((l) => l.text === '副本已生成 · 覆盖 2 份'));
  assert.ok(s.lines.some((l) => l.text === '副本已生成 · 回收站 1 份'));
  assertEndsWithDone(s);
  assertWithinBudget(s);
});
