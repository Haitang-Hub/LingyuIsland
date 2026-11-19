'use strict';
/**
 * 用 docs/检测项测试文档.md 全量自检屏蔽效果：
 *  1. 解析文档中各分类的测试项（剥除行尾「（…）」预期注释）；
 *  2. 按真实应用的「两遍式」流程先 collectEntities 收集案卷实体，再逐条屏蔽；
 *  3. 对被屏蔽项做「屏蔽→还原」往返校验（原文已含〔编码〕的项跳过往返）；
 *  4. 输出逐条对照与汇总。用法：node scripts/check-masking-doc.js [docPath]
 */
const fs = require('fs');
const path = require('path');
const { maskText, restoreText, Vault, hasCodes } = require('../src/core/masker');
const { collectEntities } = require('../src/core/entities');

const docPath = process.argv[2] || path.join(__dirname, '..', 'docs', '检测项测试文档.md');

const sections = [];
let current = null;
for (const raw of fs.readFileSync(docPath, 'utf8').split(/\r?\n/)) {
  const head = /^##\s+(.+)$/.exec(raw.trim());
  if (head) { current = { title: head[1], items: [] }; sections.push(current); continue; }
  const bullet = /^-\s+(.+)$/.exec(raw.trim());
  if (bullet && current) current.items.push(bullet[1].replace(/（[^）]*）\s*$/, '').trim());
}
const all = sections.flatMap((s) => s.items);

// 两遍式：先全量收集实体（模拟同一案卷多文件/多行），再逐条屏蔽
const known = collectEntities(all);
const vault = new Vault();

let maskedCount = 0, unchanged = 0, roundtripFail = 0;
const lines = [];
for (const sec of sections) {
  lines.push(`### ${sec.title}`, '');
  for (const item of sec.items) {
    const { masked, counts } = maskText(item, vault, { knownEntities: known });
    const changed = masked !== item;
    if (changed) {
      maskedCount++;
      lines.push(`- ${item}`);
      lines.push(`  → ${masked}`);
    } else {
      unchanged++;
      lines.push(`- （未变化）${item}`);
    }
    // 往返校验：原文本身含〔编码〕的项属于还原侧用例，不在屏蔽往返范围
    if (changed && !hasCodes(item)) {
      const back = restoreText(masked, vault).text;
      if (back !== item) {
        roundtripFail++;
        lines.push(`  ✗ 往返不一致: ${back}`);
      }
    }
    if (changed && Object.keys(counts).length) {
      lines.push(`  （${Object.entries(counts).map(([t, n]) => `${t}×${n}`).join('，')}）`);
    }
  }
  lines.push('');
}

lines.push('---', '');
lines.push(`- 测试项 ${all.length} 条：屏蔽 ${maskedCount} 条，未变化 ${unchanged} 条（多为负例/边界项）`);
lines.push(`- 映射编码 ${vault.size} 条`);
lines.push(`- 屏蔽→还原往返${roundtripFail ? `失败 ${roundtripFail} 条 ✗` : '全部逐字一致 ✓'}`);

const report = lines.join('\n');
const outPath = path.join(__dirname, '..', 'docs', '屏蔽效果自检.md');
fs.writeFileSync(outPath, report, 'utf8');
console.log(report.split('\n').slice(-4).join('\n'));
console.log(`完整对照: ${outPath}`);
