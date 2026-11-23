'use strict';
/**
 * 测试共享工具：套件注册 / 断言助手 / 合成样本构造。
 *
 * 套件文件（test/*.test.js）require 本模块并调用 test(name, fn) 注册用例，
 * 由 test/run-tests.js 编排器统一执行（fn 可返回 Promise，异步用例按序 await）。
 *
 * 方法论约定（与 test/regression.test.js 一致）：
 *  - 断言用原值而非计数，泄漏断言消息只回显截断值（不泄隐私）；
 *  - 词表项正例 + 负例成对；
 *  - fixtures 全部为合成值，真实案卷由 test/real-files.test.js 门控；
 *  - 临时目录 mkdtemp + finally rmSync，测试产物隔离。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------- 套件注册与执行 ---------------- */

const registry = [];

/**
 * 注册一个用例。fn 返回 Promise 时自动 await。
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 */
function test(name, fn) {
  registry.push({ name, fn });
}

/** 顺序执行全部注册用例，返回结果列表 [status, name, message] */
async function runAll() {
  const results = [];
  for (const { name, fn } of registry) {
    try {
      await fn();
      results.push(['PASS', name, '']);
    } catch (e) {
      results.push(['FAIL', name, (e && e.message) || String(e)]);
    }
  }
  return results;
}

/** 打印结果并返回失败数 */
function report(results) {
  let failed = 0;
  console.log('-------------------------------------------');
  for (const [status, name, msg] of results) {
    if (status === 'FAIL') failed++;
    console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? '\n    ' + msg : ''}`);
  }
  console.log('-------------------------------------------');
  console.log(`${results.length - failed}/${results.length} 通过`);
  return failed;
}

/* ---------------- 合成样本（全部为虚构值） ---------------- */

function makeIdCard(base17) {
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const C = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(base17[i]) * W[i];
  return base17 + C[sum % 11];
}

function makeLuhn(prefix17) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    let d = Number(prefix17[i]);
    const dbl = (16 - i) % 2 === 0; // 从右数第2位起隔位翻倍
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return prefix17 + ((10 - (sum % 10)) % 10);
}

const ID1 = makeIdCard('33010619900101567');
const BANK1 = makeLuhn('62220202001122334');
// 与 makeIdCard 同源，仅校验位改错：模拟卷宗里手填的虚构号码
const ID_BAD = (() => {
  const good = makeIdCard('33010619900101567');
  return good.slice(0, 17) + (good[17] === '0' ? '1' : '0');
})();

const SAMPLE = [
  '客户信息登记表',
  '姓名：张三    手机：13812345678',
  `身份证号：${ID1}`,
  `银行卡号：${BANK1}`,
  '邮箱：zhangsan@example.com',
  '地址：汉东省临江市云溪区滨湖路138号3幢201室',
  '性别：男    年龄：35岁    出生日期：1990年01月01日',
  '紧急联系人：李四，电话 13998765432',
  '王芳女士已确认参加。今天上午和张伟开会讨论项目进度。',
].join('\n');

function iconvEncode(text, enc) {
  const iconv = require('iconv-lite');
  return iconv.encode(text, enc);
}

/** 生成最小 docx（单段正文），供屏蔽/还原管道测试 */
function makeDocx(filePath, bodyText) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p>
</w:body></w:document>`;
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>', 'utf8'));
  zip.writeZip(filePath);
  return documentXml;
}

/* ---------------- 临时目录 ---------------- */

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'lingyu-test-'));
}
function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 断言助手 ---------------- */

// 屏蔽编码：〔类型·十六进制〕
const CODE_BRACKET_RE = /〔[\u4e00-\u9fa5]{1,6}·[0-9a-f]{6,12}〕/g;

/** 泄漏消息用截断值；短值（姓名等 ≤4 字）截得更短，避免原样回显 */
function truncValue(v) {
  const s = String(v || '');
  return s.length <= 4 ? s.slice(0, 1) + '****' : s.slice(0, 4) + '****';
}

/** 原值泄漏断言：消息只回显截断值，不泄隐私 */
function assertNoLeak(masked, value, label) {
  // 地址/机构采用「某X……尾字/后缀」形态，尾段会原样保留；
  // 当尾段恰好等于另一个检出实体的完整值时，不能用裸 includes 判泄漏。
  // 规则：出现在 4 个 * 之后的原值属于可见尾段，不算泄漏。
  const s = String(masked || '');
  let from = 0;
  let leaked = false;
  while (from <= s.length) {
    const idx = s.indexOf(value, from);
    if (idx < 0) break;
    let stars = 0;
    while (idx - stars - 1 >= 0 && s[idx - stars - 1] === '*') stars++;
    if (stars !== 4) { leaked = true; break; }
    from = idx + value.length;
  }
  assert.ok(!leaked,
    `${label} 原值泄漏: ${truncValue(value)} 不应出现在屏蔽产物中`);
}

module.exports = {
  test, runAll, report, registry,
  assert,
  makeIdCard, makeLuhn, ID1, ID_BAD, BANK1, SAMPLE,
  iconvEncode, makeDocx,
  tempDir, rmDir,
  CODE_BRACKET_RE, truncValue, assertNoLeak,
};
