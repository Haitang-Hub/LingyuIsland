'use strict';
/**
 * 真实法律文书全量测试（F:\Law\output\Chuanjianling 样本，已复制到 test/realtest）
 *  - 原文件 SHA-256 前后必须一致（永不改动原件）
 *  - 屏蔽文件不得残留原始身份证号/手机号
 *  - 还原文件必须与原文件逐字节一致（docx 比较 zip 内各条目）
 *  - 性别/年龄/出生日期（依法不屏蔽）必须原样保留
 *
 * 运行：node test/real-files.test.js   （隐私保护：输出仅含统计，不打印原文敏感值）
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { maskFile, restoreFile } = require('../src/core/fileproc');
const { Vault, restoreText } = require('../src/core/masker');

const DIR = path.join(__dirname, 'realtest');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const DOCX_TEXT_PARTS = [
  /^word\/document\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/, /^word\/endnotes\.xml$/, /^word\/comments\.xml$/,
];

function docxTexts(file) {
  const zip = new AdmZip(file);
  const parts = {};
  for (const e of zip.getEntries()) {
    if (DOCX_TEXT_PARTS.some((re) => re.test(e.entryName))) {
      parts[e.entryName] = e.getData().toString('utf8');
    }
  }
  return parts;
}

function xmlToText(xml) {
  return xml.replace(/>([^<>]+)</g, (w, s) => s + '\n');
}

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name, '']); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

const vault = new Vault();

/**
 * 样本同步：优先从样本目录（环境变量 LINGYU_SAMPLES 或默认的 Law 案卷路径）复制到
 * test/realtest；样本目录不存在时直接使用 test/realtest 中已有文件。
 * 跨平台：Windows 用 F:\Law\output\Chuanjianling，macOS 可 export LINGYU_SAMPLES=... 指定。
 */
const SRC = process.env.LINGYU_SAMPLES || 'F:\\Law\\output\\Chuanjianling';
try {
  if (fs.existsSync(SRC)) {
    for (const f of fs.readdirSync(DIR)) {
      if (f.includes('_屏蔽') || f.includes('_还原')) fs.rmSync(path.join(DIR, f), { force: true });
    }
    for (const f of fs.readdirSync(SRC)) {
      if (/\.(docx|md)$/i.test(f)) fs.copyFileSync(path.join(SRC, f), path.join(DIR, f));
    }
    console.log(`已从样本目录同步: ${SRC}`);
  }
} catch (e) {
  console.log('样本同步失败，使用 test/realtest 现有文件:', e.message);
}

// 输入排除上轮测试产物（_屏蔽/_还原）
const files = fs.readdirSync(DIR)
  .filter((f) => /\.(docx|md)$/i.test(f))
  .filter((f) => !f.includes('_屏蔽') && !f.includes('_还原'))
  .sort();
let origHashes = {};      // 原文件哈希（测试前）
let totalPII = 0;
let typeCounts = {};
let piiSamples = {};      // type -> Set(原始值)，用于泄露检查
const filesWithPII = [];
const filesNoPII = [];

/* ---------- 第一轮：屏蔽 + 完整性 ---------- */

for (const f of files) {
  const p = path.join(DIR, f);
  const before = sha256(fs.readFileSync(p));

  const m = maskFile(p, vault, {});
  if (!m.ok || !m.maskedPath) { filesNoPII.push(f); continue; }
  filesWithPII.push(f);
  totalPII += m.count;
  for (const [t, n] of Object.entries(m.counts || {})) typeCounts[t] = (typeCounts[t] || 0) + n;

  // 原件不变
  check(`原件不变: ${f}`, () => {
    assert.strictEqual(sha256(fs.readFileSync(p)), before);
  });

  if (/\.docx$/i.test(f)) {
    // 屏蔽 docx 不得残留原文中的身份证号/手机号
    check(`屏蔽无泄露: ${f}`, () => {
      const origParts = docxTexts(p);
      const maskedParts = docxTexts(m.maskedPath);
      const origText = Object.values(origParts).map(xmlToText).join('\n');
      const maskedText = Object.values(maskedParts).map(xmlToText).join('\n');
      const ids = origText.match(/[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g) || [];
      const phones = origText.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) || [];
      for (const v of [...ids, ...phones]) {
        (piiSamples[ids.includes(v) ? 'idCard' : 'phone'] ||= new Set()).add(v);
        assert.ok(!maskedText.includes(v), `敏感值仍残留: ${v.slice(0, 4)}****`);
      }
      for (const t of ['性别', '岁']) { /* 占位：保留断言在下方单独做 */ }
    });

    // 还原后与原件逐条目一致
    check(`还原一致: ${f}`, () => {
      const r = restoreFile(m.maskedPath, vault);
      assert.strictEqual(r.ok, true, '还原应成功: ' + JSON.stringify(r).slice(0, 120));
      const a = docxTexts(p), b = docxTexts(r.restoredPath);
      assert.deepStrictEqual(Object.keys(b).sort(), Object.keys(a).sort(), 'zip 条目应一致');
      for (const k of Object.keys(a)) {
        assert.strictEqual(sha256(b[k]), sha256(a[k]), `条目 ${k} 应逐字节一致`);
      }
    });
  } else {
    // 文本文件：字节级往返
    check(`屏蔽无泄露: ${f}`, () => {
      const orig = fs.readFileSync(p, 'utf8');
      const masked = fs.readFileSync(m.maskedPath, 'utf8');
      const phones = orig.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) || [];
      for (const v of phones) assert.ok(!masked.includes(v));
    });
    check(`还原一致: ${f}`, () => {
      const r = restoreFile(m.maskedPath, vault);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(
        sha256(fs.readFileSync(r.restoredPath)),
        sha256(fs.readFileSync(p))
      );
    });
  }
}

/* ---------- 第二轮：依法不屏蔽字段保留 ---------- */

for (const f of filesWithPII.filter((x) => /\.docx$/i.test(x))) {
  const p = path.join(DIR, f);
  const maskedPath = path.join(DIR, path.basename(p, '.docx') + '_屏蔽.docx');
  if (!fs.existsSync(maskedPath)) continue;
  check(`性别/年龄/出生日期保留: ${f}`, () => {
    const origText = Object.values(docxTexts(p)).map(xmlToText).join('\n');
    const maskedText = Object.values(docxTexts(maskedPath)).map(xmlToText).join('\n');
    // 独立出生日期（带“年月日”字样，与身份证内嵌日期不冲突）
    const dates = origText.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g) || [];
    for (const d of dates) {
      assert.ok(maskedText.includes(d), `出生日期被误屏蔽: ${d}`);
    }
    // 性别字样数量不减
    const gOrig = (origText.match(/[男女](性|别[::][男女])/g) || []).length;
    const gMask = (maskedText.match(/[男女](性|别[::][男女])/g) || []).length;
    assert.ok(gMask >= gOrig, `性别字样被误屏蔽 (${gOrig}→${gMask})`);
    // 岁数数量不减
    const aOrig = (origText.match(/\d{1,3}\s*岁/g) || []).length;
    const aMask = (maskedText.match(/\d{1,3}\s*岁/g) || []).length;
    assert.ok(aMask >= aOrig, `年龄被误屏蔽 (${aOrig}→${aMask})`);
  });
}

/* ---------- 第三轮：跨文件编码稳定 + 片段还原 ---------- */

check('同一身份证号跨文件编码一致', () => {
  const ids = [...(piiSamples.idCard || [])];
  assert.ok(ids.length > 0, '样本中应有身份证号');
  const code = vault.ensureCode('idCard', ids[0]);
  const again = vault.ensureCode('idCard', ids[0]);
  assert.strictEqual(code, again);
});

check('从屏蔽文书复制的片段可还原', () => {
  // 遍历所有屏蔽 docx，找到含手机号或身份证遮罩的样本
  let phoneMasked = null, idMasked = null;
  for (const x of filesWithPII.filter((x) => /\.docx$/i.test(x))) {
    const maskedPath = path.join(DIR, path.basename(x, '.docx') + '_屏蔽.docx');
    if (!fs.existsSync(maskedPath)) continue;
    const maskedText = Object.values(docxTexts(maskedPath)).map(xmlToText).join('\n');
    phoneMasked ||= maskedText.match(/\d{3}\*{4}\d{4}〔[0-9a-f]{6,12}〕/);
    idMasked ||= maskedText.match(/[0-9Xx]{4}……[0-9Xx]{4}〔[0-9a-f]{6,12}〕/);
    if (phoneMasked && idMasked) break;
  }
  assert.ok(phoneMasked || idMasked, '应存在被屏蔽的手机号或身份证');
  if (phoneMasked) {
    const r = restoreText(phoneMasked[0], vault);
    assert.strictEqual(r.resolved, 1, '手机号片段应可还原');
  }
  if (idMasked) {
    const r = restoreText(idMasked[0], vault);
    assert.strictEqual(r.resolved, 1, '身份证片段应可还原');
  }
});

/* ---------- 输出 ---------- */

const fails = results.filter((r) => r[0] === 'FAIL');
console.log('=============== 真实法律文书测试 ===============');
console.log(`样本: ${files.length} 个文件（${filesWithPII.length} 份检出敏感信息）`);
console.log(`检出: 共 ${totalPII} 处 →`, JSON.stringify(typeCounts, null, 0));
console.log('映射库:', vault.size, '条编码');
console.log('-----------------------------------------------');
for (const [s, n, m] of results) {
  if (s === 'FAIL') console.log(`✗ ${n}\n    ${m}`);
}
console.log(`通过 ${results.length - fails.length}/${results.length} 项检查`);
process.exit(fails.length ? 1 : 0);
