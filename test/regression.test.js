'use strict';
/**
 * 回归测试套件：锁定「屏蔽系统短板归因与修复方案」中的 R-001..R-006，
 * 并落实方法论要求（原值泄漏断言 / 正负例成对 / 跨文档不可关联 /
 * knownNames 哈希缓存 / 声明注入 / 残留门禁 / 交叉一致性）。
 *
 * fixtures 全部为合成值（test/fixtures/），真实案卷由 test/real-files.test.js 门控。
 */

const { test, assert, tempDir, rmDir, makeDocx, truncValue, assertNoLeak, CODE_BRACKET_RE } = require('./helpers');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { detect, hashName } = require('../src/core/detector');
const { collectEntities } = require('../src/core/entities');
const { Vault, maskText, restoreText, buildMasked } = require('../src/core/masker');
const {
  maskFile, restoreFile, residualCheck, loadKnownNameHashes, saveKnownNameHashes,
  KNOWN_NAMES_FILE, caseDirKey,
} = require('../src/core/fileproc');
const { checkConsistency } = require('../src/core/consistency');

const vals = (text, type, options) =>
  detect(text, options).items.filter((i) => i.type === type).map((i) => i.value);

/* ================= R-001 地名漏检（PLACE_FORBIDDEN 移除 和/同） ================= */

test('R-001 地名漏检：北和镇/石牌垌村（无引导词链路）应检出', () => {
  const t = '雷州市北和镇石牌垌村祠堂侧';
  const addrs = vals(t, 'address');
  assert.ok(addrs.some((v) => v.includes('北和镇') && v.includes('石牌垌村')),
    `应检出完整地址: ${JSON.stringify(addrs)}`);
  // 正例成对：「和」作地名字（政和县）与「同」（会同县）也应是可检出地名
  assert.ok(vals('政和县人民法院受理', 'address').length === 0,
    '政和县应整体按机构处理，不拆出残缺地址');
  // 负例成对：普通叙述仍不当地址（禁用表保留其余功能字）
  const neg = detect('我今天要向组织我分别收受雷阳中学南校区食堂负责人李四14万元现金');
  assert.strictEqual(neg.items.filter((i) => i.type === 'address').length, 0,
    '普通叙述不应被当成地址');
});

test('R-001 链首叙述不吞入地址值，纯行政区划不屏蔽', () => {
  assert.strictEqual(vals('被告住雷州市北和镇。', 'address').length, 0);
  const t = '被告住雷州市北和镇石牌垌村18号。';
  const addrs = vals(t, 'address');
  assert.ok(addrs.every((v) => !/^[告住]/.test(v)), `链首叙述被吞入: ${JSON.stringify(addrs)}`);
  assert.ok(addrs.some((v) => v === '雷州市北和镇石牌垌村18号'), JSON.stringify(addrs));
});

/* ================= R-002 地址-机构复合体（村+村民委员会） ================= */

test('R-002 复合体：石牌垌村村民委员会整体识别为机构', () => {
  const t = '石牌垌村村民委员会出具证明。';
  const orgs = vals(t, 'org');
  assert.ok(orgs.includes('石牌垌村村民委员会'), JSON.stringify(orgs));
  const v = new Vault();
  const m = maskText(t, v);
  assertNoLeak(m.masked, '石牌垌村村民委员会', 'R-002');
  assert.ok(m.masked.includes('某村……村民委员会〔机构·'), m.masked);
  assert.strictEqual(restoreText(m.masked, v).text, t, '复合体往返应逐字一致');
});

test('R-002 复合体：公权力机关与基层站所不再类别排除，带层级即屏蔽', () => {
  assert.ok(vals('线索移交给北和镇派出所', 'org').includes('北和镇派出所'), '北和镇派出所');
  assert.ok(vals('材料已交北和镇司法所备案', 'org').includes('北和镇司法所'),
    '北和镇司法所: ' + JSON.stringify(vals('材料已交北和镇司法所备案', 'org')));
  assert.ok(vals('临江市清河区人民法院刑事审判法庭', 'org').some((v) => v.includes('人民法院')),
    '人民法院: ' + JSON.stringify(vals('临江市清河区人民法院刑事审判法庭', 'org')));
  // 众人皆知的大型银行无层级信息，自然不屏蔽；动词字「交」仍不得作为字号断点，
  // 否则同类字号（交投集团）会被截断。
  assert.strictEqual(vals('该公司向交通银行申请贷款', 'org').length, 0, '交通银行');
  assert.ok(vals('武汉交投集团承接项目', 'org').includes('武汉交投集团'), '交投集团');
});

/* ================= R-003 误屏蔽负例（张贴 / 笔录 / 原告方） ================= */

test('R-003 负例：「被告二张贴」「调查笔录」「原告方」不得屏蔽', () => {
  const negs = [
    '问：被告二张贴了公告。',
    '本次庭审制作调查笔录一份。',
    '原告方表示不同意。',
    '笔录经双方核对，均已记载无误。',
    '答：以上笔录我看过，和我说的相符。',
  ];
  for (const t of negs) {
    const names = vals(t, 'name');
    assert.strictEqual(names.length, 0, `${t} → 误屏蔽: ${JSON.stringify(names)}`);
  }
});

/* ================= R-003b 误屏蔽负例（知名机构 / 县级地名 / 普通词 / 泛指主体） ================= */

test('R-003b 负例：众人皆知的机构、单级地名、常用词、泛指主体不得屏蔽', () => {
  for (const t of ['中国建设银行', '中国农业银行', '中国移动']) {
    assert.strictEqual(vals(t, 'org').length, 0, `${t} 不应作为敏感主体: ${JSON.stringify(vals(t, 'org'))}`);
  }
  assert.strictEqual(vals('在涟水县教师培训后勤服务', 'address').length, 0,
    JSON.stringify(vals('在涟水县教师培训后勤服务', 'address')));
  assert.strictEqual(vals('在南京市一家宾馆', 'org').length, 0,
    JSON.stringify(vals('在南京市一家宾馆', 'org')));
  assert.strictEqual(vals('在南京市一家宾馆', 'address').length, 0,
    JSON.stringify(vals('在南京市一家宾馆', 'address')));
  // 纯行政区划籍贯（省 + 县/市）属于公开信息，不按地址屏蔽
  assert.strictEqual(vals('江苏涟水人', 'address').length, 0,
    JSON.stringify(vals('江苏涟水人', 'address')));
  // 「张罗」由明确身份字段确认；单句不猜，传播时只命中姓名，不命中「商议」。
  assert.strictEqual(vals('食堂负责人张罗商议', 'name').length, 0);
  const known = collectEntities(['证人：张罗。', '食堂负责人张罗商议', '我跟张罗说', '将张罗微信也删除了']);
  assert.deepStrictEqual(vals('食堂负责人张罗商议', 'name', { knownEntities: known }), ['张罗']);
  // 正例成对：具体支行仍按机构处理，具体道路门牌仍识别。
  assert.ok(vals('该公司向中国工商银行深圳支行贷款', 'org').includes('中国工商银行深圳支行'), '具体支行');
  assert.strictEqual(vals('案发地合肥市，另一现场在颍上县城关镇', 'address').length, 0, '纯行政区划');
  assert.ok(vals('案发地合肥市西湖大道138号', 'address').includes('合肥市西湖大道138号'), '具体地址');
  assert.ok(vals('被告系杭州金源商务宾馆员工', 'org').includes('杭州金源商务宾馆'), '具体宾馆');
  // 机构简称（<6 字）不单独屏蔽，且不得把前面主体与支付动词一起吞进字号
  assert.deepStrictEqual(vals('涟水县师资培训中心支付九洲公司', 'org'), ['涟水县师资培训中心'],
    JSON.stringify(vals('涟水县师资培训中心支付九洲公司', 'org')));
  assert.deepStrictEqual(
    vals('江西九洲书社教育科技有限公司（以下简称九洲公司），后面九洲公司继续履约', 'org'),
    ['江西九洲书社教育科技有限公司'],
    JSON.stringify(vals('江西九洲书社教育科技有限公司（以下简称九洲公司），后面九洲公司继续履约', 'org')),
  );
  assert.strictEqual(vals('九洲公司继续履约', 'org').length, 0, '简称不屏蔽');
  // 字号含「也」的酒店品牌：不能被机构断点截断成「纳」，也不能只剩地址前缀
  assert.deepStrictEqual(vals('涟水县经开区维也纳酒店', 'org'), ['涟水县经开区维也纳酒店'],
    JSON.stringify(vals('涟水县经开区维也纳酒店', 'org')));
  assert.strictEqual(vals('涟水县经开区维也纳酒店', 'address').length, 0,
    JSON.stringify(vals('涟水县经开区维也纳酒店', 'address')));
});

/* ================= R-004 新角色标签与问答体 ================= */

test('R-004 角色标签：主持调解人/记录人/调查人/在场人 命中', () => {
  const cases = [
    ['主持调解人：陈阿满。', '陈阿满'],
    ['记录人：周济民', '周济民'],
    ['调查人：梁月华', '梁月华'],
    ['在场人：邓小满', '邓小满'],
  ];
  for (const [text, name] of cases) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('R-004 问答体：问/答 + 冒号语境命中姓名', () => {
  assert.ok(vals('答：陈阿满，男，2003年出生', 'name').includes('陈阿满'), '答：应提供语境');
  assert.ok(vals('问：证人：张三。', 'name').includes('张三'), '人称字段应提供语境');
  // 普通答复不是姓名（「答：明白。」曾被切成「明*」）
  assert.strictEqual(vals('问：你是否明白？答：明白。', 'name').length, 0, '明白');
  assert.strictEqual(vals('审：明白吗', 'name').length, 0, '明白吗');
  // 负例成对：无冒号的单字「问/答」不再充当标签
  const negs = ['问卷调查姓名栏', '审问笔录记载', '问答环节结束'];
  for (const t of negs) {
    assert.strictEqual(vals(t, 'name').length, 0, `${t} 不应命中姓名`);
  }
});

/* ================= R-005 后置职业括注 ================= */

test('R-005 职业词和括注不单独确认，人称字段明确确认', () => {
  assert.strictEqual(vals('陈阿满（村医）赶到现场。', 'name').length, 0);
  assert.strictEqual(vals('村医陈阿满赶到现场。', 'name').length, 0);
  assert.ok(vals('证人：陈阿满。', 'name').includes('陈阿满'));
  assert.ok(vals('辩护人：周济民。', 'name').includes('周济民'));
  assert.strictEqual(vals('张三（之父）到庭', 'name').length, 0);
});

/* ================= R-006 盐值随机化（跨文档不可关联） ================= */

test('R-006 盐值：不同批次同值不同码，同批次同值同码', () => {
  const v1 = new Vault();
  const v2 = new Vault();
  const c1 = v1.ensureCode('name', '陈阿满');
  const c2 = v2.ensureCode('name', '陈阿满');
  assert.notStrictEqual(c1, c2, '不同 Vault 实例（跨批次）同值应不同码');
  assert.strictEqual(v1.ensureCode('name', '陈阿满'), c1, '同批次内同值应同码');
  const v3 = new Vault(v1.toJSON().salt);
  assert.strictEqual(v3.ensureCode('name', '陈阿满'), c1, '同盐应复现同码');
  const revived = Vault.fromJSON(v1.toJSON());
  assert.strictEqual(revived.ensureCode('name', '陈阿满'), c1, '持久化后同值同码');
  assert.ok(revived.lookup(c1).value === '陈阿满', '编码反查不受盐值影响');
});

test('R-006 盐值：v1 映射库（无 salt / 非 v2）不再加载', () => {
  const v = Vault.fromJSON({ v: 1, codes: { ab12cd: { v: '陈阿满', t: 'name' } } });
  assert.strictEqual(v.size, 0, '旧版映射库应被丢弃');
  assert.strictEqual(v.lookup('ab12cd'), null, '历史编码不再反查');
  assert.strictEqual(Vault.fromJSON(null).size, 0);
  assert.strictEqual(Vault.fromJSON({ codes: {} }).size, 0);
});

/* ================= 保留位收紧（首尾不得同时可见） ================= */

test('保留位：收紧后不出现首尾同时可见（证件/卡/证号/信用代码）', () => {
  const id = '330106199001015670';
  const bank = '6222020200112233456';
  const lic = '14401202080123456';
  const uscc = '91330106MA27W1QX1T';
  const v = new Vault();
  const mid = buildMasked('idCard', id, v.ensureCode('idCard', id));
  const mbank = buildMasked('bank', bank, v.ensureCode('bank', bank));
  const mlic = buildMasked('license', lic, v.ensureCode('license', lic));
  const muscc = buildMasked('uscc', uscc, v.ensureCode('uscc', uscc));
  for (const [label, masked, value] of [
    ['身份证', mid, id], ['银行卡', mbank, bank],
    ['执业证号', mlic, lic], ['信用代码', muscc, uscc],
  ]) {
    const body = masked.slice(0, masked.indexOf('〔'));
    const headVisible = body.includes(value.slice(0, 2));
    const tailVisible = body.includes(value.slice(-2));
    assert.ok(!(headVisible && tailVisible), `${label} 首尾同时可见: ${masked}`);
  }
  // 收紧后的屏蔽值仍可还原
  const t = `身份证${id}，银行卡${bank}。`;
  const v2 = new Vault();
  const m = maskText(t, v2);
  assert.strictEqual(restoreText(m.masked, v2).text, t, '收紧保留位后应逐字还原');
});

/* ================= 原值泄漏断言（全类型，消息截断） ================= */

test('泄漏断言：全类型屏蔽后原值零残留', () => {
  const t = fs.readFileSync(path.join(__dirname, 'fixtures', 'case-a.txt'), 'utf8');
  const v = new Vault();
  const { masked, items } = maskText(t, v);
  assert.ok(items.length >= 10, `应检出足够实体: ${items.length}`);
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.value)) continue;
    seen.add(it.value);
    assertNoLeak(masked, it.value, `[${it.type}]`);
  }
  assert.ok(masked.includes('330106****〔身份证·'), '身份证应为前6位 + ****');
  assert.ok(!/622202/.test(masked), '银行卡 BIN 前段不应出现在屏蔽产物');
  // 屏蔽值形态：所有编码括号都带类型标签
  for (const b of masked.match(/〔[^〔〕]*〕/g) || []) {
    assert.ok(/^〔[\u4e00-\u9fa5]{1,6}·[0-9a-f]{6,12}〕$/.test(b), `编码应带类型标签: ${b}`);
  }
});

/* ================= knownNames 跨文件持久化（哈希缓存） ================= */

test('knownNames：分次处理第二份文件可命中无语境重名，缓存存应用数据目录且不含明文', () => {
  const dir = tempDir('lingyu-regress-');
  const storeDir = tempDir('lingyu-regress-store-');
  try {
    const a = path.join(dir, 'case-a.txt');
    const b = path.join(dir, 'case-b.txt');
    fs.writeFileSync(a, fs.readFileSync(path.join(__dirname, 'fixtures', 'case-a.txt'), 'utf8'), 'utf8');
    fs.writeFileSync(b, fs.readFileSync(path.join(__dirname, 'fixtures', 'case-b.txt'), 'utf8'), 'utf8');

    const namesFile = path.join(storeDir, KNOWN_NAMES_FILE);
    const v = new Vault();
    const ma = maskFile(a, v, undefined, undefined, undefined, { namesFile });
    assert.strictEqual(ma.ok, true);
    const mb = maskFile(b, v, undefined, undefined, undefined, { namesFile });
    assert.strictEqual(mb.ok, true);

    const maskedB = fs.readFileSync(mb.maskedPath, 'utf8');
    assertNoLeak(maskedB, '陈阿满', 'knownNames 跨文件');
    assertNoLeak(maskedB, '周济民', 'knownNames 跨文件');
    // 缓存在应用数据目录（namesFile），案卷目录内不留任何缓存文件
    assert.ok(fs.existsSync(namesFile), '应在应用数据目录生成 mask-names.json');
    assert.ok(!fs.existsSync(path.join(dir, '.mask-names.json')),
      '案卷目录内不得出现 .mask-names.json');
    const store = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
    const entry = store.dirs[caseDirKey(dir)];
    assert.ok(entry && Array.isArray(entry.hashes) && entry.hashes.length > 0, '应按案卷目录存哈希');
    for (const h of entry.hashes) assert.ok(/^[0-9a-f]{64}$/.test(h), '缓存只能是哈希');
    const raw = fs.readFileSync(namesFile, 'utf8');
    assert.ok(!raw.includes('陈阿满') && !raw.includes('周济民') && !raw.includes('梁月华'),
      '缓存不得包含明文姓名');
    assert.ok(entry.hashes.includes(hashName('陈阿满')), '确认姓名的哈希应入缓存');
    // 不传 namesFile（未注入存储路径）时跳过持久化：不产生任何缓存文件
    const otherDir = tempDir('lingyu-regress-case2-');
    try {
      const c = path.join(otherDir, 'case-c.txt');
      fs.writeFileSync(c, '原告：张三，手机 13812345678。', 'utf8');
      const mc = maskFile(c, new Vault());
      assert.strictEqual(mc.ok, true);
      assert.ok(!fs.existsSync(path.join(otherDir, '.mask-names.json')),
        '未注入 namesFile 时案卷目录不应出现缓存文件');
    } finally {
      rmDir(otherDir);
    }
  } finally {
    rmDir(dir);
    rmDir(storeDir);
  }
});

test('knownNames：缓存读写幂等且损坏文件安全回退（Windows 路径大小写不敏感）', () => {
  const storeDir = tempDir('lingyu-regress-store-');
  const caseDir = tempDir('lingyu-regress-case-');
  try {
    const namesFile = path.join(storeDir, KNOWN_NAMES_FILE);
    assert.strictEqual(saveKnownNameHashes(namesFile, caseDir, ['张三']), true);
    assert.strictEqual(saveKnownNameHashes(namesFile, caseDir, ['张三']), false, '重复保存应无变化');
    assert.ok(loadKnownNameHashes(namesFile, caseDir).has(hashName('张三')));
    // Windows 下路径大小写/分隔符差异命中同一条目
    const alt = process.platform === 'win32'
      ? caseDir.toLowerCase().replace(/\\/g, '/')
      : caseDir;
    assert.ok(loadKnownNameHashes(namesFile, alt).has(hashName('张三')), '路径键应归一化');
    // 损坏存储文件安全回退
    fs.writeFileSync(namesFile, '{broken', 'utf8');
    assert.strictEqual(loadKnownNameHashes(namesFile, caseDir).size, 0, '损坏缓存应回退为空集');
    // v1/v2/v3/v4/v5 均弃用；v6 非法条目被过滤。
    fs.writeFileSync(namesFile,
      JSON.stringify({ v: 2, dirs: { [caseDirKey(caseDir)]: { hashes: [hashName('李四')] } } }), 'utf8');
    assert.strictEqual(loadKnownNameHashes(namesFile, caseDir).size, 0, 'v2 缓存不得吸收');
    fs.writeFileSync(namesFile,
      JSON.stringify({ v: 3, dirs: { [caseDirKey(caseDir)]: { hashes: [hashName('李四')] } } }), 'utf8');
    assert.strictEqual(loadKnownNameHashes(namesFile, caseDir).size, 0, 'v3 缓存不得吸收');
    fs.writeFileSync(namesFile,
      JSON.stringify({ v: 4, dirs: { [caseDirKey(caseDir)]: { hashes: [hashName('李四')] } } }), 'utf8');
    assert.strictEqual(loadKnownNameHashes(namesFile, caseDir).size, 0, 'v4 缓存不得吸收（v1.12.0 时间词毒哈希）');
    fs.writeFileSync(namesFile,
      JSON.stringify({ v: 5, dirs: { [caseDirKey(caseDir)]: { hashes: [hashName('李四')] } } }), 'utf8');
    assert.strictEqual(loadKnownNameHashes(namesFile, caseDir).size, 0, 'v5 缓存不得吸收（连词/谓语毒哈希）');
    fs.writeFileSync(namesFile,
      JSON.stringify({ v: 6, dirs: { [caseDirKey(caseDir)]: { hashes: ['bad', hashName('李四')] } } }), 'utf8');
    const set = loadKnownNameHashes(namesFile, caseDir);
    assert.strictEqual(set.size, 1);
    assert.ok(set.has(hashName('李四')));
  } finally {
    rmDir(storeDir);
    rmDir(caseDir);
  }
});

test('knownNames：旧版案卷内 .mask-names.json 直接清除（毒哈希不吸收）+ 缓存 v6', () => {
  const caseDir = tempDir('lingyu-regress-case-');
  const storeDir = tempDir('lingyu-regress-store-');
  try {
    const legacyHash = hashName('陈阿满');
    fs.writeFileSync(path.join(caseDir, '.mask-names.json'),
      JSON.stringify({ v: 1, hashes: [legacyHash] }), 'utf8');
    const src = path.join(caseDir, 'case.txt');
    fs.writeFileSync(src, '原告：张三，手机 13812345678。', 'utf8');
    const namesFile = path.join(storeDir, KNOWN_NAMES_FILE);

    const m = maskFile(src, new Vault(), undefined, undefined, undefined, { namesFile });
    assert.strictEqual(m.ok, true);
    // 旧文件被删除，案卷目录不留任何缓存
    assert.ok(!fs.existsSync(path.join(caseDir, '.mask-names.json')), '案卷目录内旧缓存应被删除');
    const store = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
    assert.strictEqual(store.v, 6, '存储格式应为 v6');
    const entry = store.dirs[caseDirKey(caseDir)];
    // v1 旧缓存出自旧版检测器（含「执行/文件」等毒哈希），不吸收
    assert.ok(!entry.hashes.includes(legacyHash), 'v1 旧哈希不得进入 v6 缓存');
    // 本批确认姓名正常入库
    assert.ok(entry.hashes.includes(hashName('张三')), '本批确认姓名应入缓存');
  } finally {
    rmDir(caseDir);
    rmDir(storeDir);
  }
});

test('时间词不得成为姓名种子：「被告人：现在，…」不毒化「检察院现在给你做不起诉」', () => {
  const { collectEntities } = require('../src/core/entities');
  // 冒号字段 + 逗号边界的笔录句式曾把「现在」确认为姓名，经原值/哈希传播后
  // 「检察院现在给你做不起诉」被遮成「现*〔姓名·…〕」。
  for (const t of [
    '被告人：现在，你可以走了。',
    '审判长：现在核对被告人身份。',
    '现在，男，30岁。',
    '合议庭成员：现在',
  ]) {
    assert.strictEqual([...collectEntities([t]).name].filter((v) => v === '现在').length, 0,
      `${t} → 「现在」不得入 known 集合`);
  }
  const transcript = [
    '问：鉴于你们都已经赔偿到位且被害人已经出具谅解书了，检察院现在给你做不起诉。',
    '答：好的，我接受。',
    '被告人：现在，你可以走了。',
  ].join('\n');
  const m = maskText(transcript, new Vault());
  assert.ok(!m.masked.includes('〔姓名·'), `时间词不应被遮: ${m.masked}`);
  assert.ok(m.masked.includes('检察院现在给你做不起诉'), '目标句不应改动');
});

test('姓名形状门槛：虚词开头的 2 字候选不得成为种子（有权/现在/应当），冷僻姓不受影响', () => {
  // 「即你有权为自己辩护」曾被遮成「你有*〔姓名·…〕」：冒号字段/人口学位
  // 把「有权」确认成姓名后经哈希传播全卷。旧实现用「常见姓氏白名单」拦截，
  // 结果裴/邝/冼 等不在表内的真姓全被漏掉（「被会见人：裴钱」不遮）；
  // 现改为「语法功能字」黑名单：只拦虚词首字，不判姓氏。
  for (const t of [
    '犯罪嫌疑人：有权，请记录在案。',
    '被告人：有权委托辩护人。',
    '有权，男，45岁。',
    ['诉讼权利', '有权'],
    '被告人：应当，请核对。',
    '被害人：包括本案共三人。',
    '被害人：查明事实后另行处理。',
    '被害人：尚未到案。',
  ]) {
    const blocks = Array.isArray(t) ? t : [t];
    const bad = [...collectEntities(blocks).name].filter((v) => /^(?:有权|应当|包括|查明|尚未)$/.test(v));
    assert.deepStrictEqual(bad, [], `${JSON.stringify(blocks)} → 虚词不得入 known 集合`);
  }
  // 冷僻姓 / 首字为姓的 2 字真名必须照常确认
  for (const [blocks, who] of [
    [['被会见人：裴钱'], '裴钱'],
    [['被害人：邝丽，女，1987年出生。'], '邝丽'],
    [['证人：冼芳'], '冼芳'],
    [['被害人：包拯'], '包拯'],
    [['被害人：尚伟'], '尚伟'],
    [['原告：于洋'], '于洋'],
  ]) {
    assert.ok(collectEntities(blocks).name.has(who), `${JSON.stringify(blocks)} → ${who} 应确认`);
  }
  // 告知书目标句不再被遮
  const m = maskText('（三）辩护及获得法律援助、法律帮助的权利：即你有权为自己辩护，也可以委托辩护人为你辩护；你有权约见值班律师；', new Vault());
  assert.ok(!m.masked.includes('〔姓名·'), `「有权」不应被遮: ${m.masked}`);
  assert.ok(m.masked.includes('即你有权为自己辩护'), '目标句不应改动');
});

test('传播校验：毒哈希不得复活字段词（日出生/出生），真名传播不受影响', () => {
  const t = '2010年02月08日出生';
  for (const poison of ['出生', '日出生']) {
    const r = maskText(t, new Vault(), { knownNameHashes: new Set([hashName(poison)]) });
    assert.ok(!r.masked.includes('〔姓名·'), `缓存种子「${poison}」不应再遮日期: ${r.masked}`);
    assert.strictEqual(r.masked, t);
  }
  // 字段词也不得成为种子
  for (const blocks of [['出生日期', '日出生'], ['姓名：日出生'], ['日出生，男，2010年02月08日。']]) {
    const hit = [...collectEntities(blocks).name].filter((v) => /出生/.test(v));
    assert.deepStrictEqual(hit, [], `${JSON.stringify(blocks)} → 字段词不得入 known 集合`);
  }
  // 真名经哈希传播仍正常
  const ok = maskText('陈阿满到场。', new Vault(), { knownNameHashes: new Set([hashName('陈阿满')]) });
  assert.ok(ok.masked.includes('〔姓名·'), '真名传播应保留');
});

test('角色词尾同形虚词与动作谓语：不得确认「差错」「作最后」为姓名', () => {
  // 「对记载有遗漏或者差错提出补充或改正」里「或者」的「者」曾是角色词尾，
  // 「差错」被叙述动词「提出」闭合后确认成姓名，并经哈希传播把会见笔录里所有
  // 「有差错的」「如无差错」都遮掉。
  const errorSentences = [
    '三、核对听证笔录、对记载有遗漏或者差错提出补充或改正的权利。',
    '如果记载有遗漏或者差错，你有权要求补充或改正。',
    '以上的会见笔录，请你详细阅读，有差错的，可以要求进行更正。',
    '如无差错，请签名或者按印。',
  ];
  for (const t of errorSentences) {
    const names = vals(t, 'name');
    assert.deepStrictEqual(names, [], `${t} → 不得检出姓名（实际 ${JSON.stringify(names)}）`);
    assert.ok(!collectEntities([t]).name.has('差错'), `${t} → 「差错」不得入 known 集合`);
  }

  // 角色词后直接跟「作/进行/参与/予以…」这类只带动作宾语的谓语：宾语位是行为而非人。
  for (const t of [
    '法庭辩论结束，现在由被告人作最后陈述。',
    '（4）被告人可以在法庭辩论终结后作最后陈述。',
    '被告人作最后陈述',
    '辩护人参与整个审查过程，现附条件不起诉决定书',
  ]) {
    const names = vals(t, 'name');
    assert.deepStrictEqual(names, [], `${t} → 不得检出姓名（实际 ${JSON.stringify(names)}）`);
  }

  // 角色词 + 单字虚词（「受援人因涉嫌」）与文书对象名词（案件/案卷）不是姓名
  for (const t of [
    '承办过程：受援人因涉嫌犯盗窃罪被某县公安局移送审查起诉。',
    '文书用于承办人记载向受援人通报和向法律援助机构报告案件办理进展情况。',
    '辩护人详细查阅本案卷宗材料。',
  ]) {
    const names = vals(t, 'name');
    assert.deepStrictEqual(names, [], `${t} → 不得检出姓名（实际 ${JSON.stringify(names)}）`);
  }

  const transcript = [
    '审：法庭辩论结束，现在由被告人作最后陈述。',
    '审：以上的会见笔录，请你详细阅读，有差错的，可以要求进行更正。如无差错，请签名或者按印。',
    '三、核对听证笔录、对记载有遗漏或者差错提出补充或改正的权利。',
  ].join('\n');
  const m = maskText(transcript, new Vault());
  assert.strictEqual(m.masked, transcript, `整段不应有任何改动: ${m.masked}`);

  // 负例成对：真正的角色锚点 + 姓名 + 叙述动词仍应确认
  for (const [t, who] of [
    ['审判长张三宣布开庭。', '张三'],
    ['被告人欧阳明盗窃他人财物，数额较大。', '欧阳明'],
    ['被会见人：裴钱', '裴钱'],
    ['被告人张三提出异议，法庭予以支持。', '张三'],
    ['本律师担任裴钱涉嫌盗窃罪一案。', '裴钱'],
    // 「姓名 + 因 + 涉嫌」与「角色词 + 姓名 + 冒号」都要照常确认
    ['承办过程：受援人王芳因涉嫌犯盗窃罪被移送审查起诉。', '王芳'],
    ['审判长张三：现在核对身份。', '张三'],
    ['被告人李四作最后陈述。', '李四'],
  ]) {
    assert.ok(vals(t, 'name').includes(who), `${t} → ${who} 应确认`);
  }
});

test('身份锚点补强：头衔/关系名词、弱字段、被字句（校长沙悟净、总经理刘星、学生王东）', () => {
  // 真实笔录里反复出现却始终没被标注的三类姓名：
  // ① 头衔尾字不在「人/员/者/师/长/告/象」（总经理/学生）；
  // ② 姓名字段没有冒号（「姓名为王东」「客户名称为“王东”」）；
  // ③ 「姓名 + 被 + 谓语」（「原校长沙悟净被组织留置」）。
  for (const [t, who] of [
    ['涟水实验中学原校长沙悟净被组织留置后，我约人见面。', '沙悟净'],
    ['某省某某有限公司总经理刘星贿赂2万元', '刘星'],
    ['这份姓名为王东的中国建设银行银行卡', '王东'],
    ['依法调取的客户名称为“王东”、交易卡号为“6217001730012324565”的流水', '王东'],
    ['我就将我学生王东的建行卡号及其姓名告诉他', '王东'],
  ]) {
    assert.ok(vals(t, 'name').includes(who), `${t} → ${who} 应确认（实际 ${JSON.stringify(vals(t, 'name'))}）`);
  }
  // 弱字段不得把后续定语吞进姓名
  const loose = vals('这份姓名为王东的中国建设银行银行卡', 'name');
  assert.ok(!loose.some((v) => v.length > 3), `弱字段只取姓名本身: ${JSON.stringify(loose)}`);

  // 负例成对：告尾动词与头衔泛称不得借锚点确认后续普通词
  for (const t of [
    '应当宣告缓刑：',
    '下面我把相关的权利义务告知你：',
    '该公司总经理负责食堂运营。',
    '被告人当庭被带出法庭。',
    '学生的家长到庭旁听。',
  ]) {
    assert.deepStrictEqual(vals(t, 'name'), [], `${t} → 不得检出姓名（实际 ${JSON.stringify(vals(t, 'name'))}）`);
  }
});

/* ================= 残留自检（质量门禁） ================= */

test('残留自检：正常屏蔽无 warning，残留敏感值标记 residual-pii', () => {
  const dir = tempDir('lingyu-regress-');
  try {
    const src = path.join(dir, '正常.txt');
    fs.writeFileSync(src, '原告：陈阿满，手机 13812345678。', 'utf8');
    const m = maskFile(src, new Vault());
    assert.strictEqual(m.ok, true);
    assert.strictEqual(m.warning, undefined, '正常屏蔽不应有 warning');
    assert.ok(!fs.readFileSync(m.maskedPath, 'utf8').includes('13812345678'), '原值不应残留');

    assert.strictEqual(residualCheck('电话13812345678', {}, new Set()), 'residual-pii');
    assert.strictEqual(residualCheck('电话138****5678〔手机号·ab12cd〕', {}, new Set()), undefined);
  } finally {
    rmDir(dir);
  }
});

/* ================= 交叉一致性检查（consistency.js） ================= */

test('一致性：同案卷两份文件均屏蔽干净 → ok', () => {
  const origA = fs.readFileSync(path.join(__dirname, 'fixtures', 'case-a.txt'), 'utf8');
  const origB = fs.readFileSync(path.join(__dirname, 'fixtures', 'case-b.txt'), 'utf8');
  const v = new Vault();
  const mA = maskText(origA, v);
  const mB = maskText(origB, v, { knownNames: new Set(['陈阿满', '周济民', '梁月华', '邓小满']) });
  const r = checkConsistency([
    { file: 'case-a.txt', original: origA, masked: mA.masked },
    { file: 'case-b.txt', original: origB, masked: mB.masked },
  ]);
  assert.deepStrictEqual(r.leaks, [], `不应有泄漏: ${JSON.stringify(r.leaks)}`);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('一致性：任一文件漏检 → 泄漏定位且样本截断', () => {
  const origA = fs.readFileSync(path.join(__dirname, 'fixtures', 'case-a.txt'), 'utf8');
  const v = new Vault();
  const mA = maskText(origA, v);
  const r = checkConsistency([
    { file: 'case-a.txt', original: origA, masked: mA.masked },
    // 模拟 case-b 漏检：屏蔽产物里残留了另一份文档确认的实体
    { file: 'case-b.txt', original: '原告陈阿满到场。', masked: '原告陈阿满到场。' },
  ]);
  assert.strictEqual(r.ok, false, '存在泄漏应判不通过');
  const leak = r.leaks.find((l) => l.files.includes('case-b.txt'));
  assert.ok(leak, JSON.stringify(r.leaks));
  assert.ok(leak.sample.endsWith('****'), `样本应截断: ${leak.sample}`);
  assert.ok(!JSON.stringify(r).includes('陈阿满'), '报告不得回显完整原值');
});

test('一致性：屏蔽产物编码与案卷映射库一致（同值同码，统一带标签）', () => {
  const origA = fs.readFileSync(path.join(__dirname, 'fixtures', 'case-a.txt'), 'utf8');
  const origB = fs.readFileSync(path.join(__dirname, 'fixtures', 'case-b.txt'), 'utf8');
  const v = new Vault();
  const mA = maskText(origA, v);
  const mB = maskText(origB, v, { knownNames: new Set(['陈阿满']) });
  const r = checkConsistency([
    { file: 'case-a.txt', original: origA, masked: mA.masked },
    { file: 'case-b.txt', original: origB, masked: mB.masked },
  ], { vault: v });
  assert.deepStrictEqual(r.codeMismatches, [], JSON.stringify(r.codeMismatches));
});

/* ================= 文件往返（防声明/缓存破坏往返） ================= */

test('往返：txt 屏蔽→还原逐字一致', () => {
  const dir = tempDir('lingyu-regress-');
  try {
    const src = path.join(dir, 'case-b.txt');
    const orig = fs.readFileSync(path.join(__dirname, 'fixtures', 'case-b.txt'), 'utf8');
    fs.writeFileSync(src, orig, 'utf8');
    const v = new Vault();
    const m = maskFile(src, v);
    const r = restoreFile(m.maskedPath, v);
    assert.strictEqual(fs.readFileSync(r.restoredPath, 'utf8'), orig, 'txt 往返应逐字一致');
  } finally {
    rmDir(dir);
  }
});
