'use strict';
/** 两遍式：先确认全案卷实体，再把原值传播到无语境位置。 */

const fs = require('fs');
const path = require('path');
const { test, assert, tempDir, rmDir } = require('./helpers');
const { detect } = require('../src/core/detector');
const { collectEntities } = require('../src/core/entities');
const { Vault } = require('../src/core/masker');
const { maskFile, restoreFile } = require('../src/core/fileproc');

const names = (text, known) => detect(text, known ? { knownEntities: known } : {})
  .items.filter((i) => i.type === 'name').map((i) => i.value);

test('两遍式：人称候选须复现三次且左右上下文不唯一', () => {
  const blocks = ['被害人陈阿满到场', '我跟陈阿满说', '将陈阿满微信也删除了'];
  const known = collectEntities(blocks);
  assert.ok(known.name.has('陈阿满'), JSON.stringify([...known.name]));
  assert.ok(!known.name.has('陈阿满到场'));
  assert.deepStrictEqual(names('食堂负责人陈阿满商议'), []);
  assert.deepStrictEqual(names('食堂负责人陈阿满商议', known), ['陈阿满']);
  assert.deepStrictEqual(names('我跟陈阿满说', known), ['陈阿满']);
});

test('两遍式：单一语境的长候选不猜测', () => {
  const known = collectEntities(['食堂负责人陈阿满商议']);
  assert.strictEqual(known.name.size, 0, JSON.stringify([...known.name]));
  assert.deepStrictEqual(names('食堂负责人陈阿满商议', known), []);
});

test('两遍式：文件分隔块不会拼接表格身份', () => {
  const known = collectEntities(['受援人', '\u0000', '张三']);
  assert.strictEqual(known.name.size, 0);
});

test('两遍式：文本文件先收集再屏蔽，还原逐字一致', () => {
  const dir = tempDir('lingyu-two-pass-');
  try {
    const src = path.join(dir, 'case.txt');
    const original = ['被会见人：张三', '问：明白。', '答：明白。', '我跟张三说。'].join('\n');
    fs.writeFileSync(src, original, 'utf8');
    const vault = new Vault();
    const masked = maskFile(src, vault);
    assert.strictEqual(masked.ok, true);
    const output = fs.readFileSync(masked.maskedPath, 'utf8');
    assert.ok(!output.includes('张三'), output);
    assert.ok(output.includes('答：明白。'), output);
    const restored = restoreFile(masked.maskedPath, vault);
    assert.strictEqual(fs.readFileSync(restored.restoredPath, 'utf8'), original);
  } finally {
    rmDir(dir);
  }
});
