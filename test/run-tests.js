'use strict';
/** 核心引擎单元测试：node test/run-tests.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { detect, isValidIdCard, luhnValid } = require('../src/core/detector');
const { Vault, maskText, restoreText, buildMasked, hasCodes } = require('../src/core/masker');
const { maskFile, restoreFile, decodeBuffer, encodeText, maskedPathOf } = require('../src/core/fileproc');

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

test('排除：性别/年龄/出生日期不被脱敏', () => {
  const { masked } = maskText(SAMPLE, new Vault());
  assert.ok(masked.includes('性别：男'), '性别应保留');
  assert.ok(masked.includes('年龄：35岁'), '年龄应保留');
  assert.ok(masked.includes('出生日期：1990年01月01日'), '出生日期应保留');
});

test('地址检测', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'address' && i.value.includes('文三路138号')));
});

/* ---------------- 脱敏与恢复 ---------------- */

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

test('脱敏→还原 完整往返', () => {
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

test('GBK 文本文件 脱敏→还原（编码保持）', () => {
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

test('UTF-8 文本文件 脱敏→还原', () => {
  const p = path.join(TMP, 'utf8-sample.txt');
  fs.writeFileSync(p, SAMPLE, 'utf8');
  const v = new Vault();
  const m = maskFile(p, v);
  assert.strictEqual(m.ok, true);
  assert.ok(fs.readFileSync(m.maskedPath, 'utf8').includes('性别：男'));
  const r = restoreFile(m.maskedPath, v);
  assert.strictEqual(fs.readFileSync(r.restoredPath, 'utf8'), SAMPLE);
});

test('docx 脱敏→还原', () => {
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
  assert.strictEqual(m.ok, true, 'docx 脱敏应成功');
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
  assert.strictEqual(isJunkFile('~$委托代理合同_脱敏.docx'), true);
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

/* ---------------- 按内容识别脱敏/还原（fileproc.js） ---------------- */

const { readFileText, detectFileIntent } = require('../src/core/fileproc');
const iconv = require('iconv-lite');

const INTENT_DIR = path.join(TMP, 'intent');
fs.mkdirSync(INTENT_DIR, { recursive: true });

test('内容识别：明文→脱敏，含〔编码〕→还原', () => {
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

test('内容识别：无法读取的格式回退为脱敏', () => {
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

test('结果路径：按内容生成 _脱敏 / _还原，且不需要源文件在根目录', () => {
  const root = freshDir('result-root-a');
  const a = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'keep');
  assert.strictEqual(a.out, path.join(root, '起诉状_脱敏.docx'));
  const b = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_脱敏.docx'), 'restore', 'keep');
  assert.strictEqual(b.out, path.join(root, '起诉状_还原.docx'), '_脱敏 后缀应被去掉');
});

test('结果路径：还原产物再脱敏回到原名（_还原 → _脱敏）', () => {
  const root = freshDir('result-root-c');
  // 还原文件再脱敏：不应出现「起诉状_还原_脱敏.docx」
  const a = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_还原.docx'), 'mask', 'keep');
  assert.strictEqual(a.out, path.join(root, '起诉状_脱敏.docx'));
  // 已有同名结果时按策略：保留两份 → _02，覆盖 → 原名
  fs.writeFileSync(path.join(root, '起诉状_脱敏.docx'), 'x');
  const keep = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_还原.docx'), 'mask', 'keep');
  assert.strictEqual(keep.out, path.join(root, '起诉状_脱敏_02.docx'));
  const over = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状_还原.docx'), 'mask', 'overwrite');
  assert.strictEqual(over.out, path.join(root, '起诉状_脱敏.docx'));
  // 带序号的还原产物同样归位
  assert.strictEqual(maskedPathOf(path.join(root, '起诉状_还原_02.docx')),
    path.join(root, '起诉状_脱敏.docx'));
});

test('结果路径：同名策略作用于结果文件', () => {
  const root = freshDir('result-root-b');
  fs.writeFileSync(path.join(root, '起诉状_脱敏.docx'), 'x');
  const keep = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'keep');
  assert.strictEqual(keep.out, path.join(root, '起诉状_脱敏_02.docx'));
  assert.strictEqual(keep.action, 'keep');
  const over = resolveOutputPath(root, path.join(TMP, '任意位置', '起诉状.docx'), 'mask', 'overwrite');
  assert.strictEqual(over.out, path.join(root, '起诉状_脱敏.docx'));
  assert.strictEqual(over.action, 'overwrite');
});

test('脱敏/还原可写到指定路径，不传时行为不变', () => {
  const dir = freshDir('outpath');
  const nested = path.join(dir, '结果目录');
  fs.mkdirSync(nested, { recursive: true });
  const src = path.join(dir, '源.txt');
  const out = path.join(nested, '脱敏结果.txt');
  fs.writeFileSync(src, '手机13812345678', 'utf8');
  const v = new Vault();

  const r = maskFile(src, v, undefined, out);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.maskedPath, out);
  assert.ok(fs.readFileSync(out, 'utf8').includes('138****5678'));
  assert.ok(!fs.existsSync(path.join(dir, '源_脱敏.txt')), '指定路径后不应再写默认副本');

  const restoredOut = path.join(nested, '还原结果.txt');
  const rr = restoreFile(out, v, restoredOut);
  assert.strictEqual(rr.ok, true);
  assert.strictEqual(rr.restoredPath, restoredOut);
  assert.ok(fs.readFileSync(restoredOut, 'utf8').includes('13812345678'));

  const r2 = maskFile(src, v);
  assert.strictEqual(r2.maskedPath, path.join(dir, '源_脱敏.txt'), '不传 outPath 应保持原行为');
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
