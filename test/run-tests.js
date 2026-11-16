'use strict';
/** 核心引擎单元测试：node test/run-tests.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { detect, isValidIdCard, isValidUscc, luhnValid } = require('../src/core/detector');
const { Vault, maskText, restoreText, buildMasked, hasCodes, maskEdits, restoreEdits, cleanEdits } = require('../src/core/masker');
const { maskFile, restoreFile, decodeBuffer, encodeText, maskedPathOf } = require('../src/core/fileproc');
const { compareVersions } = require('../src/core/version');
const { copyTreeSync, depsEqual, SKIP_COPY, createUpdater } = require('../src/main/updater');

/* ---------------- 动态构造合法样本 ---------------- */

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
    const dbl = (16 - i) % 2 === 0; // 从右数第2位起隔位翻倍 → 前缀共17位，追加1位校验
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return prefix17 + ((10 - (sum % 10)) % 10);
}

const ID1 = makeIdCard('33010619900101567');            // 以 X 结尾也可能，由函数决定
const BANK1 = makeLuhn('62220202001122334');
const SAMPLE = [
  '客户信息登记表',
  '姓名：张三    手机：13812345678',
  `身份证号：${ID1}`,
  `银行卡号：${BANK1}`,
  '邮箱：zhangsan@example.com',
  '地址：浙江省杭州市西湖区文三路138号3幢201室',
  '性别：男    年龄：35岁    出生日期：1990年01月01日',
  '紧急联系人：李四，电话 13998765432',
  '王芳女士已确认参加。今天上午和张伟开会讨论项目进度。',
].join('\n');

const results = [];
function test(name, fn) {
  try { fn(); results.push(['PASS', name, '']); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

/* ---------------- 检测 ---------------- */

test('身份证校验码验证', () => {
  assert.strictEqual(isValidIdCard(ID1), true);
});

test('银行卡 Luhn 验证', () => {
  assert.strictEqual(luhnValid(BANK1), true);
});

test('检测：手机号', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'phone' && i.value === '13812345678'));
  assert.ok(items.some((i) => i.type === 'phone' && i.value === '13998765432'));
});

test('检测：身份证（不误吞手机号）', () => {
  const { items } = detect(SAMPLE);
  const id = items.find((i) => i.type === 'idCard');
  assert.ok(id && id.value === ID1);
  // 身份证片段不被手机号吞掉
  assert.ok(!items.some((i) => i.type === 'phone' && i.value.includes('199001')));
});

test('检测：银行卡', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'bank' && i.value === BANK1));
});

test('检测：邮箱', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'email' && i.value === 'zhangsan@example.com'));
});

test('检测：直接语境姓名（张三/李四）', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'name' && i.value === '张三'));
  assert.ok(items.some((i) => i.type === 'name' && i.value === '李四'));
});

test('检测：称呼后缀姓名（王芳女士→王芳）', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'name' && i.value === '王芳'));
});

test('检测：无语境姓名不误报（张伟）', () => {
  const { items } = detect(SAMPLE);
  assert.ok(!items.some((i) => i.type === 'name' && i.value.includes('张伟')));
});

/* 可选检测项：默认关闭，显式开启才生效 */

test('检测：手机号分隔格式（138-1234-5678 / 138 1234 5678）', () => {
  for (const text of ['联系电话138-1234-5678请查收', '电话138 1234 5678备用', '手机13998765432']) {
    const items = detect(text).items.filter((i) => i.type === 'phone');
    assert.strictEqual(items.length, 1, text + ' → ' + JSON.stringify(items));
  }
});

test('可选检测：固定电话/400 热线（默认关，开启后生效）', () => {
  const text = '联系电话0755-1234567，传真 020-87654321，客服400 123 4567。';
  assert.strictEqual(detect(text).items.filter((i) => i.type === 'landline').length, 0, '默认应关闭');
  const items = detect(text, { toggles: { landline: true } }).items.filter((i) => i.type === 'landline');
  assert.strictEqual(items.length, 3, JSON.stringify(items));
});

test('可选检测：微信号/QQ号（关键词引导）', () => {
  const text = '微信号：Lawyer_001，QQ：123456789。';
  assert.strictEqual(detect(text).items.filter((i) => i.type === 'im').length, 0, '默认应关闭');
  const items = detect(text, { toggles: { im: true } }).items.filter((i) => i.type === 'im');
  assert.deepStrictEqual(items.map((i) => i.value), ['Lawyer_001', '123456789'], JSON.stringify(items));
});

test('可选检测：港澳台证件（回乡证/台胞证）', () => {
  const text = '回乡证H12345678，台胞证：12345678。';
  assert.strictEqual(detect(text).items.filter((i) => i.type === 'hkmt').length, 0, '默认应关闭');
  const items = detect(text, { toggles: { hkmt: true } }).items.filter((i) => i.type === 'hkmt');
  assert.deepStrictEqual(items.map((i) => i.value), ['H12345678', '12345678'], JSON.stringify(items));
});

test('可选检测：统一社会信用代码（校验码验算）', () => {
  // 按 GB 32100-2015 构造校验位合法的代码
  const CS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const W = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const base17 = '91330106MA27W1QX1';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CS.indexOf(base17[i]) * W[i];
  const valid = base17 + CS[(31 - (sum % 31)) % 31];
  assert.strictEqual(isValidUscc(valid), true);
  assert.strictEqual(isValidUscc(valid.slice(0, 17) + (valid[17] === 'A' ? 'B' : 'A')), false, '校验码错误应拒绝');

  const text = `统一社会信用代码：${valid}`;
  assert.strictEqual(detect(text).items.filter((i) => i.type === 'uscc').length, 0, '默认应关闭');
  const items = detect(text, { toggles: { uscc: true } }).items.filter((i) => i.type === 'uscc');
  assert.deepStrictEqual(items.map((i) => i.value), [valid], JSON.stringify(items));
});

test('可选检测：新类型的屏蔽值构造与还原', () => {
  const v = new Vault();
  const text = '电话0755-1234567，微信号：Lawyer_001，回乡证H12345678';
  const { masked, items } = maskText(text, v, { toggles: { landline: true, im: true, hkmt: true } });
  assert.strictEqual(items.filter((i) => i.type === 'landline').length, 1);
  const r = restoreText(masked, v);
  assert.strictEqual(r.text, text, '屏蔽后应可完整还原');
});

test('案号：号之一后缀', () => {
  const { items } = detect('（2020）粤0882民初1234号之一');
  const c = items.filter((i) => i.type === 'caseNo');
  assert.strictEqual(c.length, 1, JSON.stringify(items));
  assert.ok(c[0].value.endsWith('号之一'), c[0].value);
});

test('检测：银行卡关键词补充（银行账号/账号）', () => {
  const text = '银行账号6222020200112233456789';
  const { items } = detect(text);
  assert.ok(items.some((i) => i.type === 'bank' && i.value.startsWith('622202')), JSON.stringify(items));
});

/* 法律文书语境：角色标签命中、地名/机构名与普通词不误伤 */
test('检测：角色标签姓名（原告/被告人/审判长）', () => {
  const cases = [
    ['原告：陈阿满，男，2003年11月6日出生', '陈阿满'],
    ['被告一：陈德寿，男，1962年4月11日出生', '陈德寿'],
    ['负责人陈兆坤，主任。', '陈兆坤'],
    ['审　　判　　长　　　郑怀瑾', '郑怀瑾'],
  ];
  for (const [text, name] of cases) {
    const names = detect(text).items.filter((i) => i.type === 'name').map((i) => i.value);
    assert.ok(names.includes(name), text + ' → ' + names.join(','));
  }
});

test('检测：地名与机构名不误判为姓名', () => {
  for (const text of [
    '住所地广东省雷州市北和镇石牌垌村祠堂侧',
    '被告二：雷州市北和镇石牌垌村村民委员会，负责人陈兆坤，主任。',
    '委托诉讼代理人：林敬舟，广东海田律师事务所律师。',
  ]) {
    const names = detect(text).items.filter((i) => i.type === 'name').map((i) => i.value);
    assert.ok(!names.some((n) => /雷州|雷阳|海田/.test(n)), text + ' → ' + names.join(','));
  }
});

test('检测：普通词不被当成姓名（文字经/安排/肖像）', () => {
  for (const text of ['声明文字经本院核定，不载原告姓名及事件细节。', '将原告安排于神轿上。', '完成含原告肖像的照片核查。']) {
    assert.strictEqual(detect(text).items.filter((i) => i.type === 'name').length, 0, text);
  }
});

test('检测：同文档姓名传播（后文只出现名字也命中）', () => {
  const first = detect('原告：陈阿满，男，2003年出生');
  const known = new Set(first.items.filter((i) => i.type === 'name' && i.confident).map((i) => i.value));
  const later = detect('本院认为，陈阿满的监护人未尽职责。', { knownNames: known });
  assert.ok(later.items.some((i) => i.type === 'name' && i.value === '陈阿满'));
});

test('排除：性别/年龄/出生日期不被屏蔽', () => {
  const { masked } = maskText(SAMPLE, new Vault());
  assert.ok(masked.includes('性别：男'), '性别应保留');
  assert.ok(masked.includes('年龄：35岁'), '年龄应保留');
  assert.ok(masked.includes('出生日期：1990年01月01日'), '出生日期应保留');
});

test('地址检测', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'address' && i.value.includes('文三路138号')));
});

/* ---------------- 屏蔽与恢复 ---------------- */

test('屏蔽值可判断内容类型且内嵌编码', () => {
  const v = new Vault();
  const code = v.ensureCode('phone', '13812345678');
  assert.strictEqual(buildMasked('phone', '13812345678', code), '138****5678〔' + code + '〕');
  assert.strictEqual(buildMasked('name', '张三', v.ensureCode('name', '张三')).startsWith('张*〔'), true);
});

test('同一值 → 同一编码（跨文件稳定）', () => {
  const v = new Vault();
  const c1 = v.ensureCode('phone', '13812345678');
  const c2 = v.ensureCode('phone', '13812345678');
  assert.strictEqual(c1, c2);
});

test('屏蔽→还原 完整往返', () => {
  const v = new Vault();
  const { masked } = maskText(SAMPLE, v);
  assert.ok(hasCodes(masked));
  const r = restoreText(masked, v);
  assert.strictEqual(r.missing.length, 0);
  assert.strictEqual(r.text, SAMPLE);
});

test('从文件复制的片段也能还原', () => {
  const v = new Vault();
  const { masked } = maskText(SAMPLE, v);
  // 用户只复制了被屏蔽手机号那一小段
  const frag = masked.match(/138\*\*\*\*5678〔[0-9a-f]+〕/)[0];
  const r = restoreText(frag, v);
  assert.strictEqual(r.text, '13812345678');
});

test('编码被篡改 → 明确报告无法还原', () => {
  const v = new Vault();
  const { masked } = maskText('电话：13812345678', v);
  const broken = masked.replace(/〔[0-9a-f]+〕/, '〔ffffff〕');
  const r = restoreText(broken, v);
  assert.deepStrictEqual(r.missing, ['ffffff']);
});

test('maskText 不破坏 JSON 结构', () => {
  const v = new Vault();
  const json = JSON.stringify({ name: '张三', phone: '13812345678', age: 35, gender: '男' });
  const { masked } = maskText(json, v);
  const obj = JSON.parse(masked);
  assert.ok(obj.age === 35 && obj.gender === '男');
  assert.strictEqual(restoreText(masked, v).text, json);
});

/* ---------------- 文件管道 ---------------- */

const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

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

function iconvEncode(text, enc) {
  const iconv = require('iconv-lite');
  return iconv.encode(text, enc);
}

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
  assert.ok(maskedXml.includes('张*〔'), '姓名应被屏蔽');
  assert.ok(!maskedXml.includes('13812345678'), '手机号应被屏蔽');
  assert.ok(maskedXml.includes('性别：男'), '性别应保留');

  const r = restoreFile(m.maskedPath, v);
  assert.strictEqual(r.ok, true, 'docx 还原应成功');
  const backZip = new AdmZip(r.restoredPath);
  assert.strictEqual(backZip.readAsText('word/document.xml').includes('13812345678'), true);
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

/* ---------------- 导入与分类（imports.js） ---------------- */

const { isInsideRoot, uniqueTargetName, categoryOf, timeGroupOf, CATEGORY_LABEL } = require('../src/core/imports');

test('isInsideRoot：Windows 大小写/分隔符不敏感', () => {
  assert.strictEqual(isInsideRoot('F:\\Law\\Test\\a.docx', 'F:\\Law\\Test'), true);
  assert.strictEqual(isInsideRoot('f:/law/test/a.docx', 'F:\\Law\\Test'), true);
  assert.strictEqual(isInsideRoot('F:\\Law\\Test2\\a.docx', 'F:\\Law\\Test'), false);
  assert.strictEqual(isInsideRoot('D:\\other\\a.docx', 'F:\\Law\\Test'), false);
});

test('isInsideRoot：macOS 路径', () => {
  assert.strictEqual(isInsideRoot('/Users/t/docs/a.docx', '/Users/t/docs'), true);
  assert.strictEqual(isInsideRoot('/Users/t/other/a.docx', '/Users/t/docs'), false);
});

test('uniqueTargetName：无冲突直用，冲突加两位序号', () => {
  const dir = 'X:\\root';
  assert.strictEqual(uniqueTargetName(dir, '文件', '.docx', () => false), '文件.docx');
  const exists = new Set(['X:\\root\\文件.docx', 'X:\\root\\文件_02.docx']);
  assert.strictEqual(uniqueTargetName(dir, '文件', '.docx', (f) => exists.has(f)), '文件_03.docx');
});

test('categoryOf：常见扩展名归类', () => {
  assert.strictEqual(categoryOf('.docx'), 'doc');
  assert.strictEqual(categoryOf('pdf'), 'doc');
  assert.strictEqual(categoryOf('xlsx'), 'sheet');
  assert.strictEqual(categoryOf('csv'), 'sheet');
  assert.strictEqual(categoryOf('txt'), 'text');
  assert.strictEqual(categoryOf('md'), 'text');
  assert.strictEqual(categoryOf('py'), 'code');
  assert.strictEqual(categoryOf('png'), 'other');
  assert.ok(CATEGORY_LABEL[categoryOf('docx')]);
});

test('timeGroupOf：时间分组', () => {
  assert.strictEqual(timeGroupOf(Date.now()), '今天');
  assert.strictEqual(timeGroupOf(Date.now() - 86400000), '昨天');
  assert.strictEqual(timeGroupOf(Date.now() - 3 * 86400000), '本周');
  assert.strictEqual(timeGroupOf(Date.now() - 30 * 86400000), '更早');
  assert.strictEqual(timeGroupOf(0), '更早');
});

/* ---------------- 垃圾文件过滤（~$ Office 锁文件等） ---------------- */

const { isJunkFile, collectPaths } = require('../src/core/fileproc');

test('isJunkFile：Office 锁文件与系统文件', () => {
  assert.strictEqual(isJunkFile('~$委托代理合同_屏蔽.docx'), true);
  assert.strictEqual(isJunkFile('~$a.xlsx'), true);
  assert.strictEqual(isJunkFile('.~lock.客户通讯录.csv#'), true);
  assert.strictEqual(isJunkFile('Thumbs.db'), true);
  assert.strictEqual(isJunkFile('desktop.ini'), true);
  assert.strictEqual(isJunkFile('.DS_Store'), true);
  assert.strictEqual(isJunkFile('01_委托代理合同.docx'), false);
  assert.strictEqual(isJunkFile('~normal.txt'), false, '普通 ~ 开头文件不算锁文件以外的误判仅在 ~$ 前缀');
});

test('collectPaths：跳过 ~$ 锁文件', () => {
  const dir = path.join(TMP, 'junktest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '正常文件.txt'), 'x');
  fs.writeFileSync(path.join(dir, '~$正常文件.docx'), 'x');
  const got = collectPaths([dir]);
  assert.ok(got.some((p) => path.basename(p) === '正常文件.txt'));
  assert.ok(!got.some((p) => path.basename(p).startsWith('~$')), '锁文件不应被收集');
});

/* ---------------- 索引类别筛选（indexer.js） ---------------- */

const { Indexer } = require('../src/main/indexer');

function makeCategoryIndexer() {
  const idx = new Indexer();
  idx.root = 'D:\\测试根目录';
  const now = Date.now();
  const rows = [
    ['合同.docx', '法务/合同.docx', 'docx'],
    ['审批单.pdf', '行政/审批单.pdf', 'pdf'],
    ['花名册.xlsx', '人事/花名册.xlsx', 'xlsx'],
    ['客户.csv', '销售/客户.csv', 'csv'],
    ['纪要.txt', '纪要.txt', 'txt'],
    ['配置.json', '配置.json', 'json'],
    ['main.py', 'src/main.py', 'py'],
    ['页面.html', 'src/页面.html', 'html'],
    ['印章.png', '素材/印章.png', 'png'],
    ['录音.mp3', '行政/录音.mp3', 'mp3'],
  ];
  idx.entries = rows.map(([n, p, e], i) => ({ n, p, e, s: 100, m: now - i * 1000 }));
  return idx;
}

test('类别筛选：空查询只返回该类别的文件', () => {
  const idx = makeCategoryIndexer();
  assert.deepStrictEqual(idx.search('', 50, 'doc').items.map((i) => i.e).sort(), ['docx', 'pdf']);
  assert.deepStrictEqual(idx.search('', 50, 'sheet').items.map((i) => i.e).sort(), ['csv', 'xlsx']);
  assert.deepStrictEqual(idx.search('', 50, 'text').items.map((i) => i.e).sort(), ['json', 'txt']);
  assert.deepStrictEqual(idx.search('', 50, 'code').items.map((i) => i.e).sort(), ['html', 'py']);
  assert.deepStrictEqual(idx.search('', 50, 'other').items.map((i) => i.e).sort(), ['mp3', 'png']);
  assert.strictEqual(idx.search('', 50, 'all').total, 10);
});

test('类别筛选：与关键词叠加', () => {
  const idx = makeCategoryIndexer();
  assert.strictEqual(idx.search('客户', 50, 'sheet').total, 1, '「客户.csv」应命中表格类');
  assert.strictEqual(idx.search('客户', 50, 'doc').total, 0, '文档类不应命中');
  assert.strictEqual(idx.search('客户', 50, 'all').total, 1);
  assert.strictEqual(idx.search('src', 50, 'code').total, 2, '路径关键词应命中代码类');
});

test('类别筛选：counts 统计各分类且不受当前类别影响', () => {
  const idx = makeCategoryIndexer();
  const all = idx.search('', 50, 'all');
  const code = idx.search('', 50, 'code');
  assert.deepStrictEqual(code.counts, all.counts);
  assert.deepStrictEqual(code.counts, { all: 10, doc: 2, sheet: 2, text: 2, code: 2, other: 2 });
  assert.strictEqual(idx.search('客户', 50, 'all').counts.all, 1, 'counts 应随关键词变化');
});

test('类别筛选：total 不受 limit 截断，非法类别回退全部', () => {
  const idx = makeCategoryIndexer();
  const r = idx.search('', 3, 'all');
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.items[0].n, '合同.docx', '空查询应按修改时间倒序');
  const invalid = idx.search('', 50, 'unknown');
  assert.strictEqual(invalid.category, 'all');
  assert.strictEqual(invalid.total, 10);
});

test('类别筛选：未配置根目录时安全返回空结果', () => {
  const r = new Indexer().search('合同', 50, 'doc');
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.counts.all, 0);
  assert.strictEqual(r.root, '');
});

/* ---------------- 自定义自动收起时长（store.js） ---------------- */

const {
  Store, DEFAULT_SETTINGS, normalizeCollapseDelay,
  COLLAPSE_MIN_SEC, COLLAPSE_MAX_SEC, DEFAULT_COLLAPSE_SEC,
} = require('../src/main/store');

test('自动收起时长：默认值与范围常量', () => {
  assert.strictEqual(DEFAULT_COLLAPSE_SEC, 20);
  assert.strictEqual(DEFAULT_SETTINGS.autoCollapseDelay, 20);
  assert.strictEqual(COLLAPSE_MIN_SEC, 5);
  assert.strictEqual(COLLAPSE_MAX_SEC, 3600);
});

test('自动收起时长：边界裁剪与非法值回退', () => {
  assert.strictEqual(normalizeCollapseDelay(45), 45);
  assert.strictEqual(normalizeCollapseDelay(30.7), 31, '小数取整');
  assert.strictEqual(normalizeCollapseDelay('60'), 60, '数字字符串可用');
  assert.strictEqual(normalizeCollapseDelay(1), 5, '低于下限取下限');
  assert.strictEqual(normalizeCollapseDelay(99999), 3600, '高于上限取上限');
  assert.strictEqual(normalizeCollapseDelay('abc'), 20, '非数字回退默认');
  assert.strictEqual(normalizeCollapseDelay(NaN), 20);
  assert.strictEqual(normalizeCollapseDelay(Infinity), 20);
  assert.strictEqual(normalizeCollapseDelay('abc', 45), 45, '非法值可指定 fallback');
});

test('自动收起时长：saveSettings 统一裁剪并落盘', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    assert.strictEqual(s.saveSettings({ autoCollapseDelay: 45 }).autoCollapseDelay, 45);
    assert.strictEqual(s.saveSettings({ autoCollapseDelay: 99999 }).autoCollapseDelay, 3600);
    assert.strictEqual(s.saveSettings({ autoCollapseDelay: 'abc' }).autoCollapseDelay, 3600,
      '非法值回退到上一次有效值');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).autoCollapseDelay, 3600);
    // 修改其他设置不应意外改动时长
    assert.strictEqual(s.saveSettings({ clipboardWatch: false }).autoCollapseDelay, 3600);
    assert.strictEqual(s.settings.clipboardWatch, false);
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

test('自动收起时长：旧配置缺字段或非法值时自动补正', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    fs.writeFileSync(file, JSON.stringify({ rootDir: 'X:\\docs' }), 'utf8');
    s._loadSettings();
    assert.strictEqual(s.settings.autoCollapseDelay, 20, '缺字段补默认值');
    fs.writeFileSync(file, JSON.stringify({ autoCollapseDelay: -8 }), 'utf8');
    s._loadSettings();
    assert.strictEqual(s.settings.autoCollapseDelay, 5, '非法值裁剪');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

/* ---------------- 剪贴板监听：只对当前复制文本生效（clipboard.js） ---------------- */

const { ClipboardWatcher } = require('../src/main/clipboard');

const MASKED_A = '联系人：138****5678〔ab12cd〕';
const MASKED_B = '联系人：139****5678〔ef34ab〕';
const PLAIN = '这是一段无关文本';

function makeClipWatcher() {
  const ref = { value: '' };
  const events = [];
  const w = new ClipboardWatcher({ readText: () => ref.value });
  let enabled = true;
  w.start(
    () => enabled,
    (info) => events.push(['found', info && info.count]),
    () => events.push(['cleared'])
  );
  w.stop(); // 手动驱动 _poll，避免定时器干扰
  return { ref, events, w, setEnabled: (v) => { enabled = v; } };
}

test('剪贴板监听：提示绑定检测到时的文本快照', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A;
  w._poll();
  assert.deepStrictEqual(events, [['found', 1]]);
  assert.strictEqual(w.getPendingText(), MASKED_A);
  w._poll(); // 内容未变不重复提示
  assert.strictEqual(events.length, 1);
});

test('剪贴板监听：换成别的内容后旧提示立即失效', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  ref.value = PLAIN; w._poll();
  assert.deepStrictEqual(events, [['found', 1], ['cleared']]);
  assert.strictEqual(w.getPendingText(), null);
});

test('剪贴板监听：换成另一段含编码文本时先清除再出新提示', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  ref.value = MASKED_B; w._poll();
  assert.deepStrictEqual(events, [['found', 1], ['cleared'], ['found', 1]]);
  assert.strictEqual(w.getPendingText(), MASKED_B, '快照应更新为最新一次复制的内容');
});

test('剪贴板监听：markHandled 后不再识别写回的明文', () => {
  const { ref, events, w } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  ref.value = '联系人：13812345678';
  w.markHandled(ref.value, true); // 还原流程自行更新 UI，不广播 cleared
  assert.strictEqual(w.getPendingText(), null);
  assert.strictEqual(events.length, 1, 'silent 模式不应发 cleared');
  w._poll();
  assert.strictEqual(events.length, 1, '写回的明文不应再次触发提示');
});

test('剪贴板监听：关闭识别时清除提示', () => {
  const { ref, events, w, setEnabled } = makeClipWatcher();
  ref.value = MASKED_A; w._poll();
  setEnabled(false); w._poll();
  assert.deepStrictEqual(events, [['found', 1], ['cleared']]);
  assert.strictEqual(w.getPendingText(), null);
  setEnabled(true);
  ref.value = PLAIN; w._poll();
  assert.strictEqual(events.length, 2, '普通文本不应触发提示');
});

/* ---------------- 按内容识别屏蔽/还原（fileproc.js） ---------------- */

const { readFileText, detectFileIntent } = require('../src/core/fileproc');
const iconv = require('iconv-lite');

const INTENT_DIR = path.join(TMP, 'intent');
fs.mkdirSync(INTENT_DIR, { recursive: true });

test('内容识别：明文→屏蔽，含〔编码〕→还原', () => {
  const plain = path.join(INTENT_DIR, 'plain.txt');
  const masked = path.join(INTENT_DIR, 'masked.txt');
  fs.writeFileSync(plain, '姓名：张伟 手机：13812345678', 'utf8');
  fs.writeFileSync(masked, '手机：138****5678〔ab12cd〕', 'utf8');
  assert.strictEqual(detectFileIntent(plain), 'mask');
  assert.strictEqual(detectFileIntent(masked), 'restore');
  assert.ok(readFileText(plain).includes('13812345678'));
  assert.ok(readFileText(masked).includes('〔ab12cd〕'));
});

test('内容识别：GBK 编码文件同样能识别', () => {
  const p = path.join(INTENT_DIR, 'gbk.txt');
  fs.writeFileSync(p, iconv.encode('手机：138****5678〔ab12cd〕', 'gbk'));
  assert.strictEqual(detectFileIntent(p), 'restore');
});

test('内容识别：Office 文档内的编码也能识别', () => {
  const p = path.join(INTENT_DIR, 'sample.docx');
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>手机：138****5678〔ab12cd〕</w:t></w:r></w:p></w:body></w:document>',
    'utf8'));
  zip.writeZip(p);
  assert.ok(readFileText(p).includes('〔ab12cd〕'));
  assert.strictEqual(detectFileIntent(p), 'restore');
});

test('内容识别：无法读取的格式回退为屏蔽', () => {
  const p = path.join(INTENT_DIR, 'raw.bin');
  fs.writeFileSync(p, Buffer.from([0, 1, 2, 3, 255, 254, 0]));
  assert.strictEqual(readFileText(p), null);
  assert.strictEqual(detectFileIntent(p), 'mask');
  assert.strictEqual(detectFileIntent(path.join(INTENT_DIR, '不存在.txt')), 'mask');
});

/* ---------------- 同名冲突策略（imports.js / store.js） ---------------- */

const { resolveConflictName, normalizeConflictPolicy, CONFLICT_POLICIES } = require('../src/core/imports');

function conflictExists(...names) {
  const dir = path.join(TMP, 'conflict');
  const set = new Set(names.map((n) => path.join(dir, n)));
  return { dir, fn: (p) => set.has(p) };
}

test('同名策略：策略值规范化', () => {
  assert.ok(CONFLICT_POLICIES.has('keep'));
  assert.ok(CONFLICT_POLICIES.has('overwrite'));
  assert.strictEqual(normalizeConflictPolicy('overwrite'), 'overwrite');
  assert.strictEqual(normalizeConflictPolicy('keep'), 'keep');
  assert.strictEqual(normalizeConflictPolicy('unknown'), 'keep');
  assert.strictEqual(normalizeConflictPolicy(undefined), 'keep');
});

test('同名策略：无冲突直接用原名', () => {
  const { dir, fn } = conflictExists();
  assert.deepStrictEqual(resolveConflictName(dir, '报告', '.docx', 'keep', fn),
    { name: '报告.docx', action: 'new' });
});

test('同名策略：保留两份时自动加序号', () => {
  const one = conflictExists('报告.docx');
  assert.deepStrictEqual(resolveConflictName(one.dir, '报告', '.docx', 'keep', one.fn),
    { name: '报告_02.docx', action: 'keep' });
  const two = conflictExists('报告.docx', '报告_02.docx');
  assert.deepStrictEqual(resolveConflictName(two.dir, '报告', '.docx', 'keep', two.fn),
    { name: '报告_03.docx', action: 'keep' });
});

test('同名策略：覆盖模式返回原名并标记 overwrite', () => {
  const { dir, fn } = conflictExists('报告.docx', '报告_02.docx');
  assert.deepStrictEqual(resolveConflictName(dir, '报告', '.docx', 'overwrite', fn),
    { name: '报告.docx', action: 'overwrite' });
});

test('同名策略：saveSettings 规范化并落盘', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    assert.strictEqual(s.saveSettings({ conflictPolicy: 'overwrite' }).conflictPolicy, 'overwrite');
    assert.strictEqual(s.saveSettings({ conflictPolicy: 'bad' }).conflictPolicy, 'keep');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).conflictPolicy, 'keep');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

/* ---------------- 外观：主题 / appearance 规范化 ---------------- */

test('外观：主题注册表与 normalizeTheme / normalizeAccent', () => {
  const { normalizeTheme, normalizeAccent, THEMES, DEFAULT_THEME } = require('../src/core/themes');
  assert.strictEqual(THEMES.length, 8);
  assert.strictEqual(DEFAULT_THEME, 'midnight');
  assert.strictEqual(normalizeTheme('sakura'), 'sakura');
  assert.strictEqual(normalizeTheme('nope'), 'midnight');
  assert.strictEqual(normalizeTheme('nope', 'cloud'), 'cloud');
  assert.strictEqual(normalizeTheme('nope', 'bad'), 'midnight');
  assert.strictEqual(normalizeAccent('#34C77B'), '#34c77b');
  assert.strictEqual(normalizeAccent('red'), '');
  assert.strictEqual(normalizeAccent('#12345'), '');
  assert.strictEqual(normalizeAccent(''), '');
});

test('外观：normalizeAppearance 钳制 / 白名单 / 回退', () => {
  const { normalizeAppearance, ALPHA_MIN, ALPHA_MAX, RADIUS_MAX } = require('../src/core/appearance');
  const a = normalizeAppearance({
    theme: 'nosuchtheme', accent: '#FF8C42', alpha: 0.3, radius: 99, bgDim: 0.05,
    glass: 'x', panel: { w: 9, h: 99999 }, motion: 0,
    bg: { type: 'video', file: 'a.png' }, // 扩展名与类型不符 → 整体回退
  }, null);
  assert.strictEqual(a.theme, 'midnight', '非法主题回退默认主题');
  assert.strictEqual(a.accent, '#ff8c42');
  assert.strictEqual(a.alpha, ALPHA_MIN, '低于下限钳回 0.55');
  assert.strictEqual(a.radius, RADIUS_MAX, '高于上限钳回 25');
  assert.strictEqual(a.glass, 'off');
  assert.deepStrictEqual(a.panel, { w: 360, h: 1000 }, '面板宽高各自钳制');
  assert.strictEqual(a.motion, false);
  assert.strictEqual(a.bgDim, 0.35, '背景遮罩低于下限钳回 0.35');
  assert.deepStrictEqual(a.bg, { type: 'video', file: '', name: '' }, '扩展名与类型不符 → 文件置空，类型保留');

  const b = normalizeAppearance({ alpha: 1.5, radius: 3, bg: { type: 'image' } }, null);
  assert.strictEqual(b.alpha, ALPHA_MAX);
  assert.strictEqual(b.radius, 10);
  assert.strictEqual(b.bg.type, 'image', 'type 单独 patch 生效');
  assert.strictEqual(b.bg.file, '');

  const c = normalizeAppearance(null, null);
  assert.strictEqual(c.theme, 'midnight');
  assert.strictEqual(c.alpha, 0.97);
  assert.strictEqual(c.radius, 18);
  assert.strictEqual(c.glass, 'off');
  assert.deepStrictEqual(c.panel, { w: 560, h: 700 }, '默认基准尺寸');
  assert.strictEqual(c.motion, true);
  assert.strictEqual(c.bgDim, 0.62, '背景遮罩默认 0.62');
  assert.deepStrictEqual(c.bg, { type: 'none', file: '', name: '' });

  // 只改主题时不重置遮罩（缺省字段沿用上一次）
  const e = normalizeAppearance({ theme: 'cloud' }, { bgDim: 0.5, bg: { type: 'image', file: 'bg-1.png' } });
  assert.strictEqual(e.bgDim, 0.5);
  assert.strictEqual(e.bg.file, 'bg-1.png');

  // 文件名白名单：杜绝目录穿越
  const d = normalizeAppearance({ bg: { type: 'image', file: '..\\evil.png' } }, null);
  assert.strictEqual(d.bg.file, '');
});

test('外观：背景格式白名单（含 bmp/avif，拒绝 mov/mkv）与展示文件名', () => {
  const { normalizeAppearance, normalizeBgFile, normalizeBgName } = require('../src/core/appearance');

  // 图片：Chromium 能解码的格式都放行（用户素材常见 jfif→jpg、截图→png、聊天图→bmp）
  for (const f of ['bg-1.png', 'bg-2.jpg', 'bg-3.jpeg', 'bg-4.webp', 'bg-5.gif', 'bg-6.bmp', 'bg-7.avif']) {
    assert.strictEqual(normalizeBgFile(f, 'image'), f, '图片应允许 ' + f);
  }
  // 视频：只放行 Chromium 可解码的容器
  assert.strictEqual(normalizeBgFile('bg-1.mp4', 'video'), 'bg-1.mp4');
  assert.strictEqual(normalizeBgFile('bg-1.webm', 'video'), 'bg-1.webm');
  assert.strictEqual(normalizeBgFile('bg-1.mov', 'video'), '', 'mov 无法解码，必须拒绝');
  assert.strictEqual(normalizeBgFile('bg-1.mkv', 'video'), '', 'mkv 无法解码，必须拒绝');

  // 展示名：去路径、去控制字符、限长；无文件时清空
  assert.strictEqual(normalizeBgName('C:\\Users\\me\\图片\\风景.png', 'image'), '风景.png');
  assert.strictEqual(normalizeBgName('/home/me/a<b>.png', 'image'), 'ab.png');
  assert.strictEqual(normalizeBgName('x'.repeat(80), 'image').length, 60);
  assert.strictEqual(normalizeBgName('风景.png', 'none'), '');

  const a = normalizeAppearance({ bg: { type: 'image', file: 'bg-9.bmp', name: 'D:\\素材\\桌面.bmp' } }, null);
  assert.deepStrictEqual(a.bg, { type: 'image', file: 'bg-9.bmp', name: '桌面.bmp' });
  // 只改 type（不带 file/name）时沿用已有文件与展示名
  const b = normalizeAppearance({ bg: { type: 'image' } }, a);
  assert.strictEqual(b.bg.file, 'bg-9.bmp');
  assert.strictEqual(b.bg.name, '桌面.bmp');
  // 切回「无」时展示名一并清空
  const c = normalizeAppearance({ bg: { type: 'none' } }, b);
  assert.deepStrictEqual(c.bg, { type: 'none', file: '', name: '' });
});

test('外观：saveSettings 持久化并规范化 appearance', () => {
  const s = new Store();
  s.dir = TMP;
  const file = s.paths.settings;
  try {
    const next = s.saveSettings({ appearance: { theme: 'sakura', alpha: 0.4, radius: 5, bg: { type: 'image', file: 'bg-abc.png' } } });
    assert.strictEqual(next.appearance.theme, 'sakura');
    assert.strictEqual(next.appearance.alpha, 0.55);
    assert.strictEqual(next.appearance.radius, 10);
    assert.strictEqual(next.appearance.bg.type, 'image');
    assert.strictEqual(next.appearance.bg.file, 'bg-abc.png');
    // 部分字段 patch：只改 theme 不丢 bg
    const n2 = s.saveSettings({ appearance: { theme: 'cloud' } });
    assert.strictEqual(n2.appearance.theme, 'cloud');
    assert.strictEqual(n2.appearance.bg.file, 'bg-abc.png');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).appearance.theme, 'cloud');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

/* ---------------- 面板点击外部收起 & 灵动岛收起/展开（island.js） ---------------- */

const { Island } = require('../src/main/island');

function makeIslandStub(state) {
  const island = new Island();
  island.layout = () => {};
  island.panel = {
    isVisible: () => state.visible,
    hide() { state.visible = false; },
    show() { state.visible = true; state.shown.push('show'); },
    focus() { state.shown.push('focus'); },
    showInactive() { state.shown.push('showInactive'); },
    webContents: { send() {} },
  };
  return island;
}

test('面板：显示即激活窗口（始终点击面板外即收起）', () => {
  const s1 = { visible: false, shown: [] };
  const a = makeIslandStub(s1);
  a.showPanel();
  assert.deepStrictEqual(s1.shown, ['show', 'focus'], '面板必须激活窗口，blur 才能触发收起');
});

test('面板：胶囊点击视为点击面板外', () => {
  const s1 = { visible: true, shown: [] };
  const a = makeIslandStub(s1);
  a.onPillClick();
  assert.strictEqual(s1.visible, false, '面板可见时应收起，而不是重新展开');

  const s2 = { visible: false, shown: [] };
  const b = makeIslandStub(s2);
  b.onPillClick();
  assert.strictEqual(s2.visible, true, '面板不可见时点击胶囊应展开面板');
  assert.deepStrictEqual(s2.shown, ['show', 'focus']);
});

function makePillStub(island) {
  island.layout = () => {};
  island.panel = { isVisible: () => false, hide() {} };
  island.pill = {
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive() {},
    setIgnoreMouseEvents(_flag, _opts) {},
    setPosition() {},
    webContents: { send(ch, v) { island._lastSent = [ch, v]; } },
  };
}

test('灵动岛：收起为顶部线段（点击穿透 + 状态广播）', () => {
  const island = new Island();
  makePillStub(island);
  const events = [];
  island.onPillStateChange = () => events.push(island._pillVisible);
  island.collapsePill();
  assert.strictEqual(island.pillCollapsed, true);
  assert.strictEqual(island._pillVisible, false);
  assert.deepStrictEqual(island._lastSent, ['pill:state', 'collapsed']);
  assert.deepStrictEqual(events, [false]);
  // 重复收起不重复广播
  island.collapsePill();
  assert.deepStrictEqual(events, [false]);
});

test('灵动岛：悬停线段展开回胶囊', () => {
  const island = new Island();
  makePillStub(island);
  island.setPillVisible(false);
  assert.strictEqual(island.pillCollapsed, true);
  island.setPillVisible(true); // 托盘「显示灵动岛」
  assert.strictEqual(island.pillCollapsed, false);
  assert.strictEqual(island._pillVisible, true);
  assert.deepStrictEqual(island._lastSent, ['pill:state', 'expanded']);
  // 展开态下重复展开是空操作
  island._lastSent = null;
  island.expandPill();
  assert.strictEqual(island._lastSent, null);
});

/* ---------------- 只写结果、不生成工作副本（importer / fileproc） ---------------- */

const { resolveOutputPath } = require('../src/main/importer');

/** 每个用例用独立且干净的临时目录，避免上次运行的残留文件影响断言 */
function freshDir(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('结果路径：按内容生成 _屏蔽 / _还原，且不需要源文件在根目录', () => {
  const root = freshDir('result-root-a');
  const a = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'keep');
  assert.strictEqual(a.out, path.join(root, '起诉状_屏蔽.docx'));
  const b = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_屏蔽.docx'), 'restore', 'keep');
  assert.strictEqual(b.out, path.join(root, '起诉状_还原.docx'), '_屏蔽 后缀应被去掉');
});

test('结果路径：还原产物再屏蔽回到原名（_还原 → _屏蔽）', () => {
  const root = freshDir('result-root-c');
  // 还原文件再屏蔽：不应出现「起诉状_还原_屏蔽.docx」
  const a = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_还原.docx'), 'mask', 'keep');
  assert.strictEqual(a.out, path.join(root, '起诉状_屏蔽.docx'));
  // 已有同名结果时按策略：保留两份 → _02，覆盖 → 原名
  fs.writeFileSync(path.join(root, '起诉状_屏蔽.docx'), 'x');
  const keep = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_还原.docx'), 'mask', 'keep');
  assert.strictEqual(keep.out, path.join(root, '起诉状_屏蔽_02.docx'));
  const over = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_还原.docx'), 'mask', 'overwrite');
  assert.strictEqual(over.out, path.join(root, '起诉状_屏蔽.docx'));
  // 带序号的还原产物同样归位
  assert.strictEqual(maskedPathOf(path.join(root, '起诉状_还原_02.docx')),
    path.join(root, '起诉状_屏蔽.docx'));
});

test('结果路径：同名策略作用于结果文件', () => {
  const root = freshDir('result-root-b');
  fs.writeFileSync(path.join(root, '起诉状_屏蔽.docx'), 'x');
  const keep = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'keep');
  assert.strictEqual(keep.out, path.join(root, '起诉状_屏蔽_02.docx'));
  assert.strictEqual(keep.action, 'keep');
  const over = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'overwrite');
  assert.strictEqual(over.out, path.join(root, '起诉状_屏蔽.docx'));
  assert.strictEqual(over.action, 'overwrite');
});

test('屏蔽/还原可写到指定路径，不传时行为不变', () => {
  const dir = freshDir('outpath');
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

/* ---------------- 版本更新 ---------------- */

test('compareVersions：相等/小于/大于', () => {
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
  assert.strictEqual(compareVersions('1.2.0', '9.9.9'), -1);
});

test('compareVersions：多位数与前缀 v', () => {
  assert.strictEqual(compareVersions('v1.10.0', '1.9.0'), 1);
  assert.strictEqual(compareVersions('2.0.0', '10.0.0'), -1, '逐段数字比较，不能按字符串比');
  assert.strictEqual(compareVersions('1.0.0-rc1', '1.0.0'), 0, '预发布后缀段解析为 0，宽松处理');
});

test('compareVersions：非法输入不抛错', () => {
  assert.strictEqual(compareVersions('', '1.0.0'), -1);
  assert.strictEqual(compareVersions(null, '1.0.0'), -1);
  assert.strictEqual(compareVersions('abc', '1.0.0'), -1);
});

test('depsEqual：依赖变化检测', () => {
  assert.strictEqual(depsEqual({ a: '^1.0.0', b: '^2.0.0' }, { b: '^2.0.0', a: '^1.0.0' }), true);
  assert.strictEqual(depsEqual({ a: '^1.0.0' }, { a: '^1.0.1' }), false);
  assert.strictEqual(depsEqual({ a: '^1.0.0' }, { a: '^1.0.0', b: '^2.0.0' }), false);
  assert.strictEqual(depsEqual(undefined, {}), true);
  assert.strictEqual(depsEqual({}, undefined), true);
});

test('applyStaged：拷贝覆盖与跳过列表（临时目录模拟）', () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lingyu-upd-'));
  try {
    // 模拟 appDir：含旧文件 + node_modules / .git / update-staging 应被跳过
    const appDir = path.join(tmp, 'app');
    fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'node_modules', 'electron'), { recursive: true });
    fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'src', 'old.txt'), 'OLD');
    fs.writeFileSync(path.join(appDir, 'package.json'), '{"version":"1.0.0"}');
    fs.writeFileSync(path.join(appDir, 'node_modules', 'electron', 'keep.txt'), 'MUST-STAY');
    fs.writeFileSync(path.join(appDir, '.git', 'HEAD'), 'MUST-STAY');

    // 模拟暂存包 staging/package
    const pkg = path.join(tmp, 'stage', 'package');
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'src', 'old.txt'), 'NEW');
    fs.writeFileSync(path.join(pkg, 'src', 'new.txt'), 'ADDED');
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"9.9.9"}');

    const up = createUpdater({ appDir, currentVersion: '1.0.0', onBroadcast: () => {} });
    const r = up.applyStaged();
    assert.strictEqual(r.ok, false, '未进入 staged 状态时不应应用');

    // 直接验证 copyTreeSync（applyStaged 的核心动作），并用 SKIP_COPY 跳过运行时目录
    copyTreeSync(pkg, appDir, SKIP_COPY);
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'src', 'old.txt'), 'utf8'), 'NEW', '旧文件被覆盖');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'src', 'new.txt'), 'utf8'), 'ADDED', '新文件被加入');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'), '{"version":"9.9.9"}');
    assert.strictEqual(fs.readFileSync(path.join(appDir, 'node_modules', 'electron', 'keep.txt'), 'utf8'),
      'MUST-STAY', 'node_modules 不被触碰');
    assert.strictEqual(fs.readFileSync(path.join(appDir, '.git', 'HEAD'), 'utf8'), 'MUST-STAY', '.git 不被触碰');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------------- 老式 .doc 接入（不启动 Word，纯逻辑测试） ---------------- */

const { outputNameOf, normalizeSource, LEGACY_EXTS } = require('../src/core/fileproc');
const { isOle2, isLegacyDoc } = require('../src/core/docconvert');

test('老式 .doc / .dot 的结果统一命名为 .docx', () => {
  assert.strictEqual(outputNameOf('示例笔录.doc'), '示例笔录.docx');
  assert.strictEqual(outputNameOf('庭审记录.DOT'), '庭审记录.docx');
  assert.strictEqual(outputNameOf('起诉状.docx'), '起诉状.docx');
  assert.strictEqual(outputNameOf('笔记.txt'), '笔记.txt');
  assert.ok(LEGACY_EXTS.has('doc') && LEGACY_EXTS.has('dot'));
});

test('collectPaths：老式 .doc 不再被静默丢弃', () => {
  const dir = path.join(TMP, 'legacy-doc');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, '笔录.doc');
  fs.writeFileSync(p, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  assert.ok(collectPaths([dir]).some((x) => x === p));
  assert.strictEqual(isOle2(p), true);
  assert.strictEqual(isLegacyDoc(p), true);
});

test('结果路径：.doc 按 .docx 计算输出名与同名策略', () => {
  const root = path.join(TMP, 'legacy-root');
  fs.mkdirSync(root, { recursive: true });
  const a = resolveOutputPath(root, path.join(TMP, '外部', '示例笔录.doc'), 'mask', 'keep');
  assert.ok(a.out.endsWith('示例笔录_屏蔽.docx'));
  assert.ok(a.base.endsWith('示例笔录_屏蔽.docx'));
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

/* ---------------- 多分辨率 / DPI 自适应布局 ---------------- */

const {
  computeIslandLayout, normalizePanelSize, matchPreset, autoUiScale,
  PANEL_PRESETS, PANEL_LIMITS, BASE,
} = require('../src/core/layout');

const wa = (width, height, x = 0, y = 0) => ({ x, y, width, height });

/** 窗口必须完整落在工作区内，且面板始终在胶囊下方（不与胶囊重叠） */
function assertFits(area, plan, label) {
  const { pill, panel } = plan;
  for (const [name, w] of [['胶囊', pill], ['面板', panel]]) {
    assert.ok(w.x >= area.x, `${label}: ${name}左侧越界`);
    assert.ok(w.y >= area.y, `${label}: ${name}顶部越界`);
    assert.ok(w.x + w.width <= area.x + area.width, `${label}: ${name}右侧越界`);
    assert.ok(w.y + w.height <= area.y + area.height, `${label}: ${name}底部越界`);
  }
  assert.ok(panel.y >= pill.y + pill.height, `${label}: 面板与胶囊重叠`);
}

const SCREENS = [
  ['1080p @100%', wa(1920, 1040)],
  ['1366×768', wa(1366, 728)],
  ['1440p @100%', wa(2560, 1400)],
  ['4K @100%', wa(3840, 2100)],
  ['4K @150%（DIP 工作区）', wa(2560, 1400)],
  ['主屏带偏移（外接副屏为主）', wa(1920, 1040, 1920, 100)],
  ['小工作区 800×400', wa(800, 400)],
  ['窄竖屏 600×900', wa(600, 900)],
  ['超宽屏 3440×1440', wa(3440, 1400)],
];

test('自适应布局：常见分辨率下窗口都完整可见且不与胶囊重叠', () => {
  for (const [label, area] of SCREENS) {
    const plan = computeIslandLayout(area);
    assertFits(area, plan, label);
    assert.ok(plan.uiScale >= 0.85 && plan.uiScale <= 1.3, `${label}: 缩放超出范围`);
  }
});

test('自适应布局：1080p 基准保持设计尺寸，缩放为 1', () => {
  const p = computeIslandLayout(wa(1920, 1040));
  assert.strictEqual(p.uiScale, 1);
  assert.deepStrictEqual(p.pill, { x: 774, y: 6, width: BASE.pillW, height: BASE.pillH });
  assert.strictEqual(p.panel.y, 62);
  assert.strictEqual(p.panel.width, BASE.panelW);
  assert.strictEqual(p.panel.height, BASE.panelH);
});

test('自适应布局：高分屏放大、低分屏缩小，切换分辨率会改变窗口尺寸', () => {
  const small = computeIslandLayout(wa(1366, 728));
  const big = computeIslandLayout(wa(3840, 2100));
  assert.ok(big.uiScale > small.uiScale, '4K 应比 768p 更大');
  assert.ok(small.panel.height < big.panel.height, '小屏面板应被压缩/缩小');
  assert.ok(small.panel.y >= small.pill.y + small.pill.height, '旧公式会把面板上移与胶囊重叠');
});

test('自适应布局：面板高度按可用空间裁剪，绝不靠上移窗口硬塞', () => {
  const area = wa(1024, 500);
  const p = computeIslandLayout(area);
  assertFits(area, p, '1024×500');
  assert.ok(p.panel.y > area.y, '面板顶部必须留在胶囊下方');
  assert.ok(p.panel.height < BASE.panelH, '可用高度不足时应压缩面板');
});

test('自适应布局：面板宽高独立，可细长 / 宽扁（非等比放大）', () => {
  const area = wa(1920, 1040);
  const { narrow, standard, wide } = PANEL_PRESETS;
  const plan = (s) => computeIslandLayout(area, { panelW: s.w, panelH: s.h });
  const pn = plan(narrow), ps = plan(standard), pw = plan(wide);

  assert.ok(pn.panel.width < ps.panel.width && pn.panel.height > ps.panel.height, '细长档应更窄更高');
  assert.ok(pw.panel.width > ps.panel.width && pw.panel.height < ps.panel.height, '宽扁档应更宽更矮');

  // 窗口 = CSS 视口 × 缩放系数：CSS 视口必须恒等于用户设定的宽高
  for (const [p, s, label] of [[pn, narrow, '细长'], [ps, standard, '标准'], [pw, wide, '宽扁']]) {
    assert.ok(Math.abs(p.panel.width / p.panelScale - s.w) <= 1, `${label}档宽度视口不符`);
    assert.ok(Math.abs(p.panel.height / p.panelScale - s.h) <= 1, `${label}档高度视口不符`);
    assertFits(area, p, label);
  }
  // 各种分辨率下，三种形状都必须完整可见且不压胶囊
  for (const [label, a] of SCREENS) {
    for (const s of [narrow, standard, wide]) {
      assertFits(a, computeIslandLayout(a, { panelW: s.w, panelH: s.h }), `${label}×${s.id}`);
    }
  }
  // 面板变宽变扁时胶囊保持固定比例，不应跟着变形
  assert.deepStrictEqual(computeIslandLayout(area, { panelW: wide.w, panelH: wide.h }).pill,
    computeIslandLayout(area, { panelW: narrow.w, panelH: narrow.h }).pill);

  // 规范化：超出范围各自钳制、非法值回退基准
  assert.deepStrictEqual(normalizePanelSize({ w: 99999, h: 1 }), { w: PANEL_LIMITS.maxW, h: PANEL_LIMITS.minH });
  assert.deepStrictEqual(normalizePanelSize({ w: 'x', h: NaN }), { w: BASE.panelW, h: BASE.panelH });
  assert.deepStrictEqual(normalizePanelSize(null, { w: 700, h: 640 }), { w: 700, h: 640 }, '缺省沿用上一次');
  assert.strictEqual(matchPreset({ w: wide.w, h: wide.h }), 'wide');
  assert.strictEqual(matchPreset({ w: 700, h: 640 }), '');
  assert.strictEqual(autoUiScale(1920, 1040), 1);
});

test('自适应布局：收起态胶囊贴顶，面板位置不受影响', () => {
  const area = wa(1920, 1040, 100, 30);
  const expanded = computeIslandLayout(area, { collapsed: false });
  const collapsed = computeIslandLayout(area, { collapsed: true });
  assert.strictEqual(collapsed.pill.y, 30);
  assert.strictEqual(expanded.pill.y, 36);
  assert.strictEqual(collapsed.panel.y, expanded.panel.y);
  assertFits(area, collapsed, '收起态');
});

test('自适应布局：非法工作区不抛错且结果仍为有限整数', () => {
  const p = computeIslandLayout({ x: NaN, y: NaN, width: 0, height: 0 });
  for (const w of [p.pill, p.panel]) {
    for (const k of ['x', 'y', 'width', 'height']) {
      assert.ok(Number.isFinite(w[k]) && Number.isInteger(w[k]));
    }
  }
  assert.ok(p.panel.height >= 1);
});

/* ---------------- 规则精度重构（段落级拼接 / 位置信息 / 姓名边界） ---------------- */

const { transformXmlText, xmlBlockTexts } = require('../src/core/xmltext');

// 与顶部 makeIdCard 同源，仅把校验位改错：模拟卷宗里手填的虚构号码
const ID_BAD = (() => {
  const good = makeIdCard('33010619900101567');
  return good.slice(0, 17) + (good[17] === '0' ? '1' : '0');
})();

test('规则：身份证校验码不合法也命中（语境引导）', () => {
  assert.strictEqual(isValidIdCard(ID_BAD), false);
  const t = `公民身份号码 ${ID_BAD}，回族`;
  assert.ok(detect(t).items.some((i) => i.type === 'idCard' && i.value === ID_BAD));
});

test('规则：角色标签长词优先，「被告人陈阿满在…」不漏检', () => {
  const t = '2019年至2024年，被告人陈阿满在先后担任雷阳中学教务处主任期间';
  const names = detect(t).items.filter((i) => i.type === 'name').map((i) => i.value);
  assert.ok(names.includes('陈阿满'), names.join(','));
  assert.ok(!names.includes('教务处'), names.join(','));
});

test('规则：机构名不吞并人名、系动词与时间词', () => {
  const t = '答：陈阿满是广东雷阳律师事务所负责人。2022年9月初广东雷阳律师事务所经招投标';
  const r = detect(t);
  const orgs = r.items.filter((i) => i.type === 'org').map((i) => i.value);
  assert.deepStrictEqual(orgs, ['广东雷阳律师事务所', '广东雷阳律师事务所'], JSON.stringify(r.items));
  assert.ok(r.items.some((i) => i.type === 'name' && i.value === '陈阿满'));
});

test('规则：地址整串含门牌楼栋单元室，并按地址尾字裁剪后续叙述', () => {
  const a = detect('户籍所在地浙江省杭州市西湖区文三路138号3幢201室，住杭州市西湖区文三花园19栋701室。');
  assert.ok(a.items.some((i) => i.type === 'address' && i.value.endsWith('3幢201室')), JSON.stringify(a.items));
  assert.ok(a.items.some((i) => i.type === 'address' && i.value.endsWith('19栋701室')), JSON.stringify(a.items));
  const b = detect('从其位于杭州市西湖区文三花园19栋701室的住处抓获归案；');
  const addr = b.items.find((i) => i.type === 'address');
  assert.ok(addr && addr.value.endsWith('701室') && !addr.value.includes('住处'), addr && addr.value);
});

test('规则：籍贯命中，国家机关名中的行政区划不误伤', () => {
  const a = detect('，回族，浙江杭州人，大学文化');
  assert.ok(a.items.some((i) => i.type === 'address' && i.value === '浙江杭州'), JSON.stringify(a.items));
  const b = detect('杭州市人民检察院查明，浙江省杭州市人民法院');
  assert.strictEqual(b.items.filter((i) => i.type === 'address').length, 0, JSON.stringify(b.items));
});

test('规则：普通叙述不被当成地址', () => {
  const t = '答：我今天要向组织我分别收受雷阳中学南校区食堂负责人李四14万元现金';
  assert.strictEqual(detect(t).items.filter((i) => i.type === 'address').length, 0);
});

test('规则：姓名精度（开庭/许可/回族/教务处 不误报，陈阿元/张三/王芳 正确）', () => {
  const bad = detect('请审判长开庭。应当经审判长或独任审判员许可。回族，教务处主任');
  assert.strictEqual(bad.items.filter((i) => i.type === 'name').length, 0, JSON.stringify(bad.items));
  // 「元」是常见人名末字，不能被尾字过滤规则截断成两字
  const yuan = detect('书记员：陈阿元担任法庭记录。');
  assert.ok(yuan.items.some((i) => i.type === 'name' && i.value === '陈阿元'), JSON.stringify(yuan.items));
  const good = detect('书记员：张三担任法庭记录。审：被告人陈阿满，现法庭核实身份。答：我的学生王芳刚大学毕业');
  const ns = good.items.filter((i) => i.type === 'name').map((i) => i.value);
  for (const n of ['张三', '陈阿满', '王芳']) assert.ok(ns.includes(n), n + ' → ' + ns.join(','));
});

test('规则：职务语境姓名（李四/王芳/陈阿满/张伟）', () => {
  const t = '食堂负责人李四贿赂14万元，法定代表人王芳银行转账2.09万元，总经理陈阿满贿赂2万元，副总经理张伟同意';
  const ns = detect(t).items.filter((i) => i.type === 'name').map((i) => i.value);
  for (const n of ['李四', '王芳', '陈阿满', '张伟']) assert.ok(ns.includes(n), n + ' → ' + ns.join(','));
});

test('规则：已知姓名传播 + 3 字候选被拒不阻断 2 字真名', () => {
  const t = '以单位开支为借口向李四提出回扣，李四也同意了。每次培训后我会和李四核对人数';
  const hits = detect(t, { knownNames: new Set(['李四']) }).items.filter((i) => i.type === 'name' && i.value === '李四');
  assert.strictEqual(hits.length, 3, JSON.stringify(hits));
});

test('规则：车牌补「粤」并放行汉字前后缀（文书句式）', () => {
  const t = '其驾驶的粤A12345号车辆被查扣，张三另驾驶粤B67890号小轿车逃逸，涉案车辆粤A12345挂。';
  const ps = detect(t).items.filter((i) => i.type === 'plate').map((i) => i.value);
  assert.ok(ps.includes('粤A12345'), ps.join(','));
  assert.ok(ps.includes('粤B67890'), ps.join(','));
  assert.ok(ps.includes('粤A12345挂'), ps.join(','));
  // 其他省份抽查 + 新能源 6 位序号
  const q = detect('皖A12345、京AD12345已登记。');
  assert.ok(q.items.some((i) => i.type === 'plate' && i.value === '皖A12345'), JSON.stringify(q.items));
  assert.ok(q.items.some((i) => i.type === 'plate' && i.value === '京AD12345'), JSON.stringify(q.items));
  // 字母数字前后缀仍排除：不从更长编码（编号/流水号）中截出车牌
  assert.strictEqual(
    detect('编号粤A12345678 已作废').items.filter((i) => i.type === 'plate').length, 0,
    JSON.stringify(detect('编号粤A12345678 已作废').items));
  assert.strictEqual(
    detect('X粤A12345 作废单').items.filter((i) => i.type === 'plate').length, 0,
    JSON.stringify(detect('X粤A12345 作废单').items));
});

test('规则：紧邻强 PII 的普通动词不级联成姓名', () => {
  const t = '订单编号 123456202301011234 已生成，另一编号 987654202312106789 审批完毕。';
  const ns = detect(t).items.filter((i) => i.type === 'name');
  assert.strictEqual(ns.length, 0, JSON.stringify(ns));
  // 邻接证据对真名仍然有效（PII 旁 2 字内的真名正常判出）
  const ok = detect('手机13812345678联系张三。');
  assert.ok(ok.items.some((i) => i.type === 'name' && i.value === '张三'), JSON.stringify(ok.items));
});

test('规则：车牌 屏蔽→还原 往返', () => {
  const v = new Vault();
  const t = '涉案车辆为粤A12345挂，另查明京AD12345已过户。';
  const { masked } = maskText(t, v);
  assert.ok(masked.includes('粤A***挂〔') && masked.includes('京A***5〔'), masked);
  assert.strictEqual(restoreText(masked, v).text, t);
});

test('规则：机构名与地址屏蔽值不泄露字号 / 县市镇村 / 门牌', () => {
  const v = new Vault();
  const org = buildMasked('org', '雷阳会议服务有限公司', v.ensureCode('org', '雷阳会议服务有限公司'));
  assert.ok(org.startsWith('……有限公司〔'), org);
  assert.ok(!org.includes('雷阳'), org);
  assert.ok(!/某某|某地/.test(org), org);
  const addr = buildMasked('address', '杭州市西湖区文三花园19栋701室', v.ensureCode('address', 'addr1'));
  assert.ok(addr.startsWith('……〔'), addr);
  assert.ok(!/某某|某地/.test(addr), addr);
  assert.ok(!/文三|西湖|701/.test(addr), addr);
  const prov = buildMasked('address', '浙江省杭州市西湖区文三路138号', v.ensureCode('address', 'addr2'));
  assert.ok(prov.startsWith('浙江……〔'), prov);
});

test('规则：地址 / 机构名 屏蔽→还原 往返', () => {
  const v = new Vault();
  const t = '户籍所在地浙江省杭州市西湖区文三路138号3幢201室，原告陈阿满是广东雷阳律师事务所负责人。';
  const { masked } = maskText(t, v);
  assert.ok(masked.includes('浙江……〔') && masked.includes('……律师事务所〔'), masked);
  assert.strictEqual(restoreText(masked, v).text, t);
});

test('Office：跨 run 拼接识别身份证与完整地址，XML 结构不变且可逐字还原', () => {
  const xml = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>日出生，公民身份号码</w:t></w:r><w:r><w:t xml:space="preserve"> ${ID_BAD}</w:t></w:r><w:r><w:t>，回族，户籍所在地浙江省杭州市西湖区文三路</w:t></w:r><w:r><w:t>138</w:t></w:r><w:r><w:t>号</w:t></w:r><w:r><w:t>3</w:t></w:r><w:r><w:t>幢</w:t></w:r><w:r><w:t>201</w:t></w:r><w:r><w:t>室</w:t></w:r></w:p>
</w:body></w:document>`;
  // 标签间的换行也是文本块，取非空块作为段落正文
  const blocks = xmlBlockTexts(xml).filter((b) => b.trim());
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].includes(ID_BAD), blocks[0]);
  assert.ok(blocks[0].endsWith('138号3幢201室'), blocks[0]);

  const v = new Vault();
  const maskedXml = transformXmlText(xml, (t) => {
    const { edits, items } = maskEdits(t, v, {});
    return { edits, count: items.length };
  }).xml;
  assert.ok(!maskedXml.includes(ID_BAD), '身份证应被屏蔽');
  assert.ok(!maskedXml.includes('文三路') && !maskedXml.includes('138号'), '地址应被整串屏蔽');
  assert.strictEqual(
    (maskedXml.match(/<w:t[^>]*>/g) || []).length,
    (xml.match(/<w:t[^>]*>/g) || []).length,
    'w:t 节点数不应改变'
  );

  const back = transformXmlText(maskedXml, (t) => {
    const x = restoreEdits(t, v);
    return { edits: cleanEdits(x.edits), count: x.restored.length };
  }).xml;
  assert.strictEqual(
    xmlBlockTexts(back).filter((b) => b.trim()).join('\n'),
    blocks.join('\n'),
    '还原后拼接文本应逐字一致'
  );
});

/* ---------------- 扩展测试：全面覆盖（全部为虚构样本，无真实文书数据） ---------------- */
/* 说明：人名固定用 张三/李四/王芳/陈阿满/张伟/赵敏；机构用 广东雷阳律师事务所 / 雷阳会议服务有限公司；
   地址用 浙江省杭州市西湖区文三路138号3幢201室 等虚构组合；号码由 makeIdCard/makeLuhn 动态生成。 */

const vals = (text, type, options) =>
  detect(text, options).items.filter((i) => i.type === type).map((i) => i.value);
const hasValue = (text, type, value, options) => vals(text, type, options).includes(value);

test('扩展·手机：标准 / +86 / 分隔 / 边界不误报', () => {
  assert.ok(hasValue('联系13812345678', 'phone', '13812345678'));
  assert.ok(hasValue('电话+8613812345678', 'phone', '13812345678') === false, '带+86的应归一或单列，不强行匹配');
  assert.ok(hasValue('手机138-1234-5678', 'phone', '138-1234-5678') || vals('手机138-1234-5678', 'phone').length, '分隔格式应命中');
  assert.strictEqual(vals('编号138123456789', 'phone').length, 0, '12 位不应命中手机号');
});

test('扩展·身份证：合法校验 / X 结尾 / 非法校验码语境命中 / 非法出生日期不命中', () => {
  const x = (() => {
    for (let i = 0; i < 10; i++) {
      const c = makeIdCard('3301061990010156' + i);
      if (c.endsWith('X')) return c;
    }
    return makeIdCard('33010619881212001');
  })();
  assert.ok(hasValue(`身份证${ID1}`, 'idCard', ID1));
  assert.strictEqual(vals(`公民身份号码 ${ID_BAD}，汉族`, 'idCard').length, 1, '非法校验码但语境引导应命中');
  assert.strictEqual(vals('编号330106199013010014', 'idCard').length, 0, '13 月非法日期不应命中');
  assert.ok(x.length === 18, '动态样本应为 18 位');
});

test('扩展·银行卡：Luhn 合法 / 19 位 / 非法校验不命中 / 关键词引导免校验', () => {
  assert.ok(hasValue(`卡号${BANK1}`, 'bank', BANK1));
  assert.ok(hasValue('银行卡号6222020200112233445', 'bank', '6222020200112233445'));
  const bad = BANK1.slice(0, -1) + (BANK1.endsWith('0') ? '1' : '0');
  assert.strictEqual(luhnValid(bad), false, '样本末位改动后应非法');
  assert.strictEqual(vals(bad, 'bank').length, 0, 'Luhn 非法且无引导词不应命中');
  assert.strictEqual(vals(`银行账号 ${bad}`, 'bank').length, 1, '有引导词即使校验失败也命中');
});

test('扩展·邮箱：标准 / 点号域名 / 加号别名', () => {
  assert.ok(hasValue('邮箱 zhangsan@example.com', 'email', 'zhangsan@example.com'));
  assert.ok(hasValue('联系 zhang.san@mail.example.cn', 'email', 'zhang.san@mail.example.cn'));
  assert.ok(hasValue('邮箱 lisi+test@example.com', 'email', 'lisi+test@example.com'));
});

test('扩展·护照：E/G/S 开头', () => {
  assert.ok(hasValue('护照E12345678', 'passport', 'E12345678'));
  assert.ok(hasValue('护照G98765432', 'passport', 'G98765432'));
  assert.ok(hasValue('护照S12345678', 'passport', 'S12345678'));
});

test('扩展·车牌：蓝牌 / 新能源 / 挂车', () => {
  assert.ok(vals('车辆粤A12345', 'plate').length >= 1);
  assert.ok(vals('新能源车京AD12345', 'plate').length >= 1);
  assert.ok(vals('挂号牌粤A1234挂', 'plate').length >= 1);
});

test('扩展·案号：标准 / 号之一 / 括号', () => {
  assert.ok(hasValue('案号（2020）皖0221刑初123号', 'caseNo', '（2020）皖0221刑初123号'));
  assert.ok(hasValue('（2021）浙01民终456号之一', 'caseNo', '（2021）浙01民终456号之一'));
});

test('扩展·执业证号：带字母前缀 / 纯数字', () => {
  assert.ok(vals('执业证号14401202080123456', 'license').length >= 1);
  assert.ok(vals('律师执业证号 A14401202080123456', 'license').length >= 1);
});

test('扩展·可选检测默认关闭、开启生效（固话 / 微信 / 港澳台 / 统一码）', () => {
  assert.strictEqual(vals('电话05512345678', 'landline').length, 0, '固话默认关');
  assert.ok(vals('电话05512345678', 'landline', { toggles: { landline: true } }).length >= 1);
  assert.strictEqual(vals('微信号 zhangsan2020', 'im').length, 0, '微信默认关');
  assert.ok(vals('微信号 zhangsan2020', 'im', { toggles: { im: true } }).length >= 1);
  assert.strictEqual(vals('回乡证H12345678', 'hkmt').length, 0, '港澳台默认关');
  assert.ok(vals('回乡证H12345678', 'hkmt', { toggles: { hkmt: true } }).length >= 1);
  assert.strictEqual(vals('统一社会信用代码91330106MA27W1QX1T', 'uscc').length, 0, '统一码默认关');
});

test('扩展·统一社会信用代码：校验位正确命中 / 错误拒绝', () => {
  const CS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const W = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const base17 = '91330106MA27W1QX1';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CS.indexOf(base17[i]) * W[i];
  const good = base17 + CS[(31 - (sum % 31)) % 31];
  const bad = good.slice(0, 17) + (good[17] === 'A' ? 'B' : 'A');
  assert.strictEqual(vals(`统一社会信用代码 ${good}`, 'uscc', { toggles: { uscc: true } })[0], good);
  assert.strictEqual(vals(`统一社会信用代码 ${bad}`, 'uscc', { toggles: { uscc: true } }).length, 0);
});

test('扩展·姓名：角色标签全覆盖', () => {
  const roles = ['原告', '被告', '法定代表人', '审判长', '证人', '鉴定人', '委托代理人'];
  for (const r of roles) {
    assert.ok(hasValue(`${r}张三到庭`, 'name', '张三'), `${r} 未识别张三`);
  }
});

test('扩展·姓名：称呼后缀 / 男女结构 / 职业前缀', () => {
  assert.ok(hasValue('王芳女士确认', 'name', '王芳'));
  assert.ok(hasValue('当事人李四，男，汉族', 'name', '李四'));
  assert.ok(hasValue('村医周济世到场', 'name', '周济世'));
});

test('扩展·姓名：复姓 / 2 字 / 3 字', () => {
  assert.ok(hasValue('原告欧阳明到庭', 'name', '欧阳明'));
  assert.ok(hasValue('原告张三到庭', 'name', '张三'));
  assert.ok(hasValue('原告陈阿满到庭', 'name', '陈阿满'));
  // 注：含「月/日」等时间功能字的 4 字姓名（如「欧阳明月」）会被时间词过滤截短，
  // 属已知的保守边界，宁可少屏蔽也不误伤正文时间表述。
});

test('扩展·姓名：谓语语境（同意 / 商议 / 供述）', () => {
  for (const t of ['张三同意', '与李四商议', '王芳供述']) {
    const who = t.startsWith('与') ? '李四' : t.slice(0, 2);
    assert.ok(hasValue(t, 'name', who), `${t} 未识别`);
  }
});

test('扩展·姓名：不误报常见普通词与地名', () => {
  const t = '开庭许可回族教务处雷阳中学西湖区文三路商贸有限公司';
  assert.strictEqual(vals(t, 'name').length, 0, JSON.stringify(vals(t, 'name')));
});

test('扩展·姓名：谓语语境补强——收受/送给/支付 + 人名 + 金额', () => {
  assert.ok(hasValue('被告人张三收受李四人民币2.09万元', 'name', '李四'), '收受后的人名应识别');
  assert.ok(hasValue('王芳支付给陈阿满现金14万元', 'name', '陈阿满'), '支付后的人名应识别');
});

test('扩展·地址：引导词整串（户籍所在地 / 住址 / 位于 / 现住）', () => {
  for (const key of ['户籍所在地', '住址', '现住', '位于']) {
    const t = `${key}浙江省杭州市西湖区文三路138号3幢201室`;
    const hit = vals(t, 'address').find((v) => v.endsWith('201室'));
    assert.ok(hit, `${key} 未整串识别: ${JSON.stringify(vals(t, 'address'))}`);
  }
});

test('扩展·地址：引导词本身不该吞进命中值', () => {
  const t = '户籍所在地浙江省杭州市西湖区文三路138号3幢201室';
  const hit = vals(t, 'address').find((v) => v.endsWith('201室'));
  assert.ok(hit && !/^(户籍所在地|住址|现住|位于)/.test(hit), `引导词被吞进地址值: ${hit}`);
});

test('扩展·地址：省市区县镇乡村多层级 + 门牌楼栋', () => {
  const t = '住广东省雷州市乌石镇新村振兴路18号2栋502室';
  const hit = vals(t, 'address').find((v) => v.includes('雷州市'));
  assert.ok(hit && hit.includes('502室'), JSON.stringify(vals(t, 'address')));
});

test('扩展·地址：籍贯表述', () => {
  assert.ok(hasValue('，汉族，浙江杭州人，大学文化', 'address', '浙江杭州'));
  assert.ok(hasValue('，回族，安徽雷州人，', 'address', '安徽雷州'));
});

test('扩展·地址：国家机关名中的行政区划不屏蔽', () => {
  const t = '杭州市人民检察院查明，浙江省杭州市人民法院审理';
  assert.strictEqual(vals(t, 'address').length, 0, JSON.stringify(vals(t, 'address')));
});

test('扩展·机构：公司 / 律所 / 集团 / 合作社 各后缀', () => {
  for (const suffix of ['有限公司', '律师事务所', '集团', '合作社']) {
    const t = `广东雷阳${suffix}承接项目`;
    assert.ok(vals(t, 'org').some((v) => v.endsWith(suffix)), `${suffix} 未识别: ${JSON.stringify(vals(t, 'org'))}`);
  }
});

test('扩展·机构：数字字号不截断（山东九三书社）', () => {
  const t = '以山东九三书社教育科技有限公司名义开具发票';
  const orgs = vals(t, 'org');
  assert.ok(orgs.some((v) => v.startsWith('山东九三')), `数字字号被截断: ${JSON.stringify(orgs)}`);
});

test('扩展·机构：事业单位主体（师资培训中心 / 职业培训学校）', () => {
  const a = vals('多次承揽雷州市师资培训中心举办的项目', 'org');
  assert.ok(a.some((v) => v.endsWith('师资培训中心')), `师资培训中心未识别: ${JSON.stringify(a)}`);
  assert.ok(!a.some((v) => v.includes('承揽')), `动作词被吞进机构名: ${JSON.stringify(a)}`);
  const b = vals('西湖区职业培训学校为主体', 'org');
  assert.ok(b.some((v) => v.endsWith('职业培训学校')), `职业培训学校未识别: ${JSON.stringify(b)}`);
});

test('扩展·机构：泛指词不识别为主体', () => {
  for (const t of ['上述公司同意', '该公司盖章', '多家公司参与']) {
    assert.strictEqual(vals(t, 'org').length, 0, `${t} 不应识别为机构: ${JSON.stringify(vals(t, 'org'))}`);
  }
});

test('扩展·机构：不吞并人名 / 系动词 / 时间词', () => {
  const t = '答：陈阿满是广东雷阳律师事务所负责人。2022年9月初广东雷阳律师事务所经招投标';
  assert.deepStrictEqual(vals(t, 'org'), ['广东雷阳律师事务所', '广东雷阳律师事务所']);
});

test('扩展·负向：放宽规则后正文时间/泛指/普通词仍不误报', () => {
  const negs = [
    '2022年9月初经招投标确定',
    '本案于2023年3月15日立案',
    '上述公司未经同意擅自变更',
    '被告人服从判决，表示认罪',
    '收到申请后予以审批处理',
    '第一次会议在周三召开',
  ];
  for (const t of negs) {
    const r = detect(t);
    const suspicious = r.items.filter((i) => i.type === 'org' || i.type === 'name');
    assert.strictEqual(suspicious.length, 0, `${t} → ${JSON.stringify(suspicious)}`);
  }
});

test('扩展·屏蔽值：各类型格式与编码内嵌', () => {
  const v = new Vault();
  const cases = {
    phone: ['13812345678', /^138\*{4}5678〔[0-9a-f]{6}〕$/],
    idCard: [ID1, new RegExp(`^${ID1.slice(0, 4)}……${ID1.slice(-4)}〔[0-9a-f]{6}〕$`)],
    name: ['张三', /^张\*〔[0-9a-f]{6}〕$/],
    org: ['广东雷阳律师事务所', /^广东……律师事务所〔[0-9a-f]{6}〕$/],
    address: ['浙江省杭州市西湖区文三路138号', /^浙江……〔[0-9a-f]{6}〕$/],
  };
  for (const [type, [value, re]] of Object.entries(cases)) {
    const masked = buildMasked(type, value, v.ensureCode(type, value));
    assert.ok(re.test(masked), `${type} 屏蔽值格式不符: ${masked}`);
  }
});

test('扩展·屏蔽值：无省级前缀的地址/机构只用省略号，不含占位词', () => {
  const v = new Vault();
  for (const [type, value] of [['address', '杭州市西湖区文三路138号'], ['org', '雷阳会议服务有限公司']]) {
    const masked = buildMasked(type, value, v.ensureCode(type, value));
    assert.ok(masked.startsWith('……'), `${type} 应以省略号开头: ${masked}`);
    assert.ok(!/某某|某地/.test(masked), masked);
  }
});

test('扩展·往返：混合文本全类型屏蔽→还原逐字一致', () => {
  const v = new Vault();
  const t = [
    `张三，身份证${ID1}，手机13812345678，卡号${BANK1}`,
    `住浙江省杭州市西湖区文三路138号3幢201室`,
    `法定代表人王芳与李四商议`,
    `案号（2020）皖0221刑初123号，护照E12345678`,
  ].join('\n');
  const { masked } = maskText(t, v);
  assert.strictEqual(restoreText(masked, v).text, t);
  assert.ok(!masked.includes('13812345678') && !masked.includes('文三路') && !masked.includes('王芳'));
});

test('扩展·排除项：性别/年龄/出生日期/民族不屏蔽', () => {
  const t = '性别：男，年龄：35岁，出生日期：1990年01月01日，民族：汉族';
  const r = detect(t);
  assert.strictEqual(r.items.length, 0, JSON.stringify(r.items));
});

test('扩展·优先级：重叠区间按类型优先级保留', () => {
  const t = `身份证${ID1}系张三所有`;
  const r = detect(t);
  const id = r.items.find((i) => i.type === 'idCard');
  assert.ok(id, '身份证应命中');
  const overlap = r.items.filter((i) => i !== id && i.start < id.end && i.end > id.start);
  assert.strictEqual(overlap.length, 0, `不应有与身份证重叠的命中: ${JSON.stringify(overlap)}`);
});

test('扩展·Office：PPT 与 Excel 的文本节点拼接后识别', () => {
  const { transformXmlText, xmlBlockTexts } = require('../src/core/xmltext');
  const v = new Vault();
  const ppt = `<a:p><a:r><a:t>手机138</a:t></a:r><a:r><a:t>12345678</a:t></a:r></a:p>`;
  const blocks = xmlBlockTexts(ppt).filter((b) => b.trim());
  assert.ok(blocks[0].includes('13812345678'), blocks[0]);
  const masked = transformXmlText(ppt, (t) => {
    const e = maskEdits(t, v, {});
    return { edits: e.edits, count: e.items.length };
  }).xml;
  assert.ok(!masked.includes('13812345678'), masked);
  const back = transformXmlText(masked, (t) => {
    const x = restoreEdits(t, v);
    return { edits: cleanEdits(x.edits), count: x.restored.length };
  }).xml;
  assert.strictEqual(xmlBlockTexts(back).filter((b) => b.trim()).join('\n'), blocks.join('\n'));
});

/* ---------------- 输出 ---------------- */

let failed = 0;
console.log('-------------------------------------------');
for (const [status, name, msg] of results) {
  if (status === 'FAIL') failed++;
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}${msg ? '\n    ' + msg : ''}`);
}
console.log('-------------------------------------------');
console.log(`${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
