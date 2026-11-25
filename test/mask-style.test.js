'use strict';
/**
 * 屏蔽方式回归：三种模式括号里一律写具体类型标签，区别只在是否保留原文残片：
 *  - labeled：李*〔姓名·编码〕（默认，可还原）
 *  - generic：〔姓名·编码〕    （无残片，可还原）
 *  - plain：  〔已屏蔽〕        （无残片、无编码，不可从产物还原）
 * 样本全部为虚构值（helpers.ID1 为测试生成的号码）。
 */

const fs = require('fs');
const path = require('path');
const { test, assert, ID1, tempDir, rmDir } = require('./helpers');
const {
  Vault, maskText, restoreText,
  codeBracket, normalizeMaskStyle, MASK_STYLES, PLAIN_MARK, hasPlainMark, CODE_RE,
} = require('../src/core/masker');
const { maskFile: maskFileFromProc } = require('../src/core/fileproc');

const TOGGLES_ALL = {
  phone: true, idCard: true, bank: true, email: true, name: true,
  address: true, passport: true, plate: true, caseNo: true, license: true,
  org: true, landline: true, im: false, native: true, uscc: true,
};

test('屏蔽方式：三种标签形态与设置值规范化', () => {
  assert.deepStrictEqual(MASK_STYLES, ['labeled', 'generic', 'plain']);
  assert.strictEqual(PLAIN_MARK, '〔已屏蔽〕');
  assert.strictEqual(codeBracket('name', 'ab12cd', 'labeled'), '〔姓名·ab12cd〕');
  assert.strictEqual(codeBracket('name', 'ab12cd', 'generic'), '〔姓名·ab12cd〕', 'generic 也用具体类型标签');
  assert.strictEqual(codeBracket('org', 'ab12cd', 'generic'), '〔机构·ab12cd〕');
  assert.strictEqual(codeBracket('name', 'ab12cd', 'plain'), '〔已屏蔽〕');
  assert.strictEqual(codeBracket('name', 'ab12cd'), '〔姓名·ab12cd〕', '缺省仍为 labeled');
  assert.strictEqual(normalizeMaskStyle('generic'), 'generic');
  assert.strictEqual(normalizeMaskStyle('plain'), 'plain');
  assert.strictEqual(normalizeMaskStyle('bogus'), 'labeled');
  assert.strictEqual(normalizeMaskStyle(undefined), 'labeled');
  assert.strictEqual(hasPlainMark('〔已屏蔽〕'), true);
  assert.strictEqual(hasPlainMark('〔姓名·ab12cd〕'), false);
});

test('屏蔽方式：labeled / generic 可还原，plain 不含编码且不可还原', () => {
  const text = `姓名：张三，身份证号：${ID1}`;
  for (const style of ['labeled', 'generic', 'plain']) {
    const v = new Vault();
    const { masked } = maskText(text, v, { maskStyle: style });
    if (style === 'plain') {
      assert.ok(masked.includes('〔已屏蔽〕'), masked);
      assert.ok(!/〔[^〕]*·[0-9a-f]{6}〕/.test(masked), 'plain 不应含编码');
      assert.strictEqual(restoreText(masked, v).resolved, 0, 'plain 不可从产物还原');
    } else {
      assert.ok(masked.includes('〔姓名·'), masked);
      assert.strictEqual(restoreText(masked, v).text, text, `${style} 应逐字还原`);
    }
  }
});

test('屏蔽方式：generic / plain 不保留原文残片', () => {
  const text = `姓名：张三，身份证号：${ID1}`;
  const labeled = maskText(text, new Vault(), { maskStyle: 'labeled' }).masked;
  const generic = maskText(text, new Vault(), { maskStyle: 'generic' }).masked;
  const plain = maskText(text, new Vault(), { maskStyle: 'plain' }).masked;
  assert.ok(labeled.includes('张*'), 'labeled 保留姓名残片');
  assert.ok(labeled.includes('****'), 'labeled 保留身份证残片');
  assert.ok(!generic.includes('张*'), `generic 不应有姓名残片: ${generic}`);
  assert.ok(!generic.includes('****'), `generic 不应有身份证残片: ${generic}`);
  assert.ok(!plain.includes('张*'), `plain 不应有姓名残片: ${plain}`);
  assert.ok(!plain.includes('****'), `plain 不应有身份证残片: ${plain}`);
});

test('屏蔽方式：generic 的具体类型标签仍能被编码识别并查回映射库', () => {
  const v = new Vault();
  const { masked } = maskText('姓名：张三', v, { maskStyle: 'generic' });
  CODE_RE.lastIndex = 0;
  const m = CODE_RE.exec(masked);
  assert.ok(m, `类型标签应匹配编码正则: ${masked}`);
  assert.strictEqual(m[1], '姓名', 'generic 标签写具体类型');
  const hit = v.lookup(m[2]);
  assert.ok(hit && hit.value === '张三', '应能查回原文');
});

test('屏蔽方式：plain 产物二次处理被跳过，不生成 _屏蔽_屏蔽', () => {
  const dir = tempDir('lingyu-mask-style-');
  try {
    const src = path.join(dir, '样本.txt');
    const out = path.join(dir, '样本_屏蔽.txt');
    fs.writeFileSync(src, '姓名：张三', 'utf8');
    const v = new Vault();
    const r = maskFileFromProc(src, v, TOGGLES_ALL, out, undefined, { maskStyle: 'plain' });
    assert.ok(r.ok && r.count > 0, `首次屏蔽应命中: ${JSON.stringify(r)}`);
    assert.ok(fs.readFileSync(out, 'utf8').includes('〔已屏蔽〕'));
    const again = maskFileFromProc(out, v, TOGGLES_ALL, path.join(dir, '样本_屏蔽_屏蔽.txt'));
    assert.strictEqual(again.skipped, 'already-masked', '已屏蔽产物不应二次处理');
  } finally {
    rmDir(dir);
  }
});
