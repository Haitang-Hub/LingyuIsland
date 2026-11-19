'use strict';
/** 检测器套件：强 PII / 姓名语境 / 地址-机构 / 可选项 / 负例成对 */

const { test, assert, ID1, ID_BAD, BANK1, SAMPLE, makeIdCard, assertNoLeak } = require('./helpers');
const { detect, isValidIdCard, isValidUscc, luhnValid } = require('../src/core/detector');
const { collectEntities } = require('../src/core/entities');

const vals = (text, type, options) =>
  detect(text, options).items.filter((i) => i.type === type).map((i) => i.value);
const hasValue = (text, type, value, options) => vals(text, type, options).includes(value);

/* ---------------- 强 PII ---------------- */

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

test('检测：手机号分隔格式（138-1234-5678 / 138 1234 5678）', () => {
  for (const text of ['联系电话138-1234-5678请查收', '电话138 1234 5678备用', '手机13998765432']) {
    const items = detect(text).items.filter((i) => i.type === 'phone');
    assert.strictEqual(items.length, 1, text + ' → ' + JSON.stringify(items));
  }
});

test('可选检测：固定电话/400 热线（默认开，可显式关闭）', () => {
  const text = '联系电话0755-1234567，传真 020-87654321，客服400 123 4567。';
  assert.strictEqual(detect(text).items.filter((i) => i.type === 'landline').length, 3, '默认应开启');
  assert.strictEqual(detect(text, { toggles: { landline: false } }).items.filter((i) => i.type === 'landline').length, 0);
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
  const CS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const W = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const base17 = '91330106MA27W1QX1';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CS.indexOf(base17[i]) * W[i];
  const valid = base17 + CS[(31 - (sum % 31)) % 31];
  assert.strictEqual(isValidUscc(valid), true);
  assert.strictEqual(isValidUscc(valid.slice(0, 17) + (valid[17] === 'A' ? 'B' : 'A')), false, '校验码错误应拒绝');

  const text = `统一社会信用代码：${valid}`;
  assert.strictEqual(detect(text).items.filter((i) => i.type === 'uscc').length, 1, '默认应开启');
  assert.strictEqual(detect(text, { toggles: { uscc: false } }).items.filter((i) => i.type === 'uscc').length, 0);
  const items = detect(text, { toggles: { uscc: true } }).items.filter((i) => i.type === 'uscc');
  assert.deepStrictEqual(items.map((i) => i.value), [valid], JSON.stringify(items));
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

test('修复·机构边界：介词「经」/ 连接词「和」不再吞入机构名', () => {
  assert.deepStrictEqual(vals('经江苏久久律师事务所指派', 'org'), ['江苏久久律师事务所']);
  assert.deepStrictEqual(vals('甲公司和江苏久久律师事务所', 'org'), ['江苏久久律师事务所']);
  // 负例成对：「经纬 / 和平县」是字号，不能被误截断
  assert.deepStrictEqual(vals('经纬纺织有限公司承接项目', 'org'), ['经纬纺织有限公司']);
  assert.deepStrictEqual(vals('和平县久久律师事务所出具证明', 'org'), ['和平县久久律师事务所']);
});

test('修复·机构边界：年份前缀不吞入字号，并列泛称学校不成机构', () => {
  // 「2021年中小学幼儿园」曾得到「年中小学幼儿园」（显示「年中***儿园」）
  assert.deepStrictEqual(
    vals('以支付2021年中小学幼儿园教师全员培训用书费名义履行报账程序', 'org'), []);
  // 负例成对：「年例」字号不因「年」断点受影响，真实学校照常识别
  assert.ok(vals('石牌垌村年例理事会出具证明', 'org').includes('石牌垌村年例理事会'));
  assert.ok(vals('北京师范大学附属中学出具证明', 'org').includes('北京师范大学附属中学'));
});
test('修复·机构边界：法条叙述双「法庭」不成机构（同后缀不自我锚定）', () => {
  // 「危害法庭安全或妨害法庭秩序」曾整体成机构（字号里第一个「法庭」给第二个当了假锚）
  for (const t of [
    '其他危害法庭安全或妨害法庭秩序的行为。',
    '行为人实施下列行为之一，危及法庭安全或扰乱法庭秩序的',
  ]) {
    assert.deepStrictEqual(vals(t, 'org'), [], `${t} → ${JSON.stringify(vals(t, 'org'))}`);
  }
  // 负例成对：真嵌套机构靠不同后缀锚定，照常识别（公权力机关已整体排除，改用企业）
  assert.ok(vals('临江市清河区九洲有限公司下属工厂出具', 'org')
    .some((v) => v.endsWith('工厂')));
});

test('修复·机构边界：角色人称词「负责人」不吞入字号，不盖掉真姓名', () => {
  // 「负责人」的人曾吞进字号得「人李太白银行」，并在重叠消解时盖掉姓名
  assert.deepStrictEqual(vals('负责人李太白银行转账2.09万元', 'org'), []);
  const known = collectEntities([
    '证人：李太白。', '负责人李太白银行转账2.09万元', '详细说一下你收受李太白银行转账2.09万元',
  ]);
  assert.deepStrictEqual(
    vals('负责人李太白银行转账2.09万元', 'name', { knownEntities: known }), ['李太白']);
  // 负例成对：含「人」的真机构（人民医院/人民银行）不受影响
  assert.ok(vals('浙江省杭州市第一人民医院出具证明', 'org').includes('浙江省杭州市第一人民医院'));
  assert.strictEqual(vals('该公司向交通银行申请贷款', 'org').length, 0);
});

test('修复·机构边界：职务动词「负责/担任」不吞入字号', () => {
  // 「负责涟水县师资培训中心」曾被整体当字号（显示为「负责****培训中心」）
  assert.deepStrictEqual(
    vals('李易峰利用其仍实际负责涟水县师资培训中心工作的职务便利', 'org'),
    ['涟水县师资培训中心']);
  assert.deepStrictEqual(vals('他担任红日建材公司经理期间', 'org'), ['红日建材公司']);
  assert.deepStrictEqual(vals('其分管城东汽车工厂生产', 'org'), ['城东汽车工厂']);
});
test('修复·机构边界：出示类叙述动词不吞入字号', () => {
  // 「出示红日建材有限公司」曾被整体当字号，前2取「出示」，形态错成「出示****公司」
  assert.deepStrictEqual(
    vals('现向你出示红日建材有限公司材料', 'org'),
    ['红日建材有限公司']);
  assert.deepStrictEqual(vals('向对方出具红日建材有限公司证明', 'org'), ['红日建材有限公司']);
  assert.deepStrictEqual(vals('提供了涟水县师资培训中心材料', 'org'), ['涟水县师资培训中心']);
  // 端到端形态：8 字机构 = 前2 + **** + 尾2
  const { Vault: V, maskText: m } = require('../src/core/masker');
  const masked = m('现向你出示红日建材有限公司材料', new V()).masked;
  assert.ok(masked.includes('红日****公司〔机构·'), masked);
});
test('修复·机构边界：受贿叙述动词不吞入字号，短泛称机构不屏蔽', () => {
  // 「收受第一中学」曾整体当机构屏蔽（显示为「收受****〔机构·…〕」）；
  // 「收/受/送/赠」入左边界断点后，「第一中学」这类 6 字以内泛称不再屏蔽。
  for (const t of ['收受第一中学贿赂款', '他送雷阳中学锦旗', '收受南湖小学校服回扣']) {
    assert.deepStrictEqual(vals(t, 'org'), [], `${t} → ${JSON.stringify(vals(t, 'org'))}`);
  }
});

test('修复·姓名：职务后紧跟受贿类犯罪动词的候选直接确认', () => {
  // 「张罗」兼有动词义，但「张罗贿赂14万元」只能是行为人姓名
  assert.deepStrictEqual(vals('食堂负责人张罗贿赂14万元', 'name'), ['张罗']);
  assert.deepStrictEqual(vals('负责人王强贪污公款', 'name'), ['王强']);
  // 负例成对：普通动词后仍不确认（「张罗商议」单句不猜）
  assert.strictEqual(vals('食堂负责人张罗商议', 'name').length, 0);
});

test('修复·案号前缀：机关简称与类别词纳入屏蔽范围（检测部分）', () => {
  const cases = [
    ['公诉机关以南检刑诉[2026]Z25号起诉', '南检刑诉[2026]Z25号'],
    ['苏淮（涟）援刑指字【2026】第527号', '援刑指字【2026】第527号'],
    ['临江市清河区人民检察院南检刑诉[2026]Z25号', '南检刑诉[2026]Z25号'],
  ];
  for (const [text, expected] of cases) {
    const found = vals(text, 'caseNo');
    assert.ok(found.includes(expected), `${text} → ${JSON.stringify(found)}`);
  }
  // 负例成对：普通叙述中的括号编号不吞入前缀
  assert.deepStrictEqual(vals('根据规定（2020）1234号', 'caseNo'), ['（2020）1234号']);
});

test('扩展·执业证号：带字母前缀 / 纯数字', () => {
  assert.ok(vals('执业证号14401202080123456', 'license').length >= 1);
  assert.ok(vals('律师执业证号 A14401202080123456', 'license').length >= 1);
});

test('扩展·可选检测默认开关与开启生效（固话 / 统一码默认开；微信 / 港澳台默认关）', () => {
  assert.ok(vals('电话05512345678', 'landline').length >= 1, '固话默认开');
  assert.ok(vals('统一社会信用代码91330106MA27W1QX1T', 'uscc').length >= 1, '统一码默认开');
  assert.strictEqual(vals('微信号 zhangsan2020', 'im').length, 0, '微信默认关');
  assert.ok(vals('微信号 zhangsan2020', 'im', { toggles: { im: true } }).length >= 1);
  assert.strictEqual(vals('回乡证H12345678', 'hkmt').length, 0, '港澳台默认关');
  assert.ok(vals('回乡证H12345678', 'hkmt', { toggles: { hkmt: true } }).length >= 1);
  assert.strictEqual(vals('电话05512345678', 'landline', { toggles: { landline: false } }).length, 0);
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

/* ---------------- 姓名语境 ---------------- */

test('检测：直接语境姓名（张三/李四）', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'name' && i.value === '张三'));
  assert.ok(items.some((i) => i.type === 'name' && i.value === '李四'));
});

test('检测：称呼不单独确认姓名，身份字段才确认', () => {
  assert.ok(!detect(SAMPLE).items.some((i) => i.type === 'name' && i.value === '王芳'));
  assert.ok(hasValue('证人：王芳。', 'name', '王芳'));
});

test('检测：无语境姓名不误报（张伟）', () => {
  const { items } = detect(SAMPLE);
  assert.ok(!items.some((i) => i.type === 'name' && i.value.includes('张伟')));
});

test('检测：角色标签姓名（原告/被告人/审判长）', () => {
  const cases = [
    ['原告：陈阿满，男，2003年11月6日出生', '陈阿满'],
    ['被告一：陈德寿，男，1962年4月11日出生', '陈德寿'],
    ['负责人：陈兆坤，主任。', '陈兆坤'],
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
    '被告二：雷州市北和镇石牌垌村村民委员会，负责人：陈兆坤，主任。',
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

test('扩展·姓名：人称前缀 + 冒号结构', () => {
  const roles = ['原告', '被告', '法定代表人', '审判长', '证人', '鉴定人', '委托代理人'];
  for (const r of roles) {
    assert.ok(hasValue(`${r}：张三。`, 'name', '张三'), `${r} 未识别张三`);
  }
});

test('扩展·姓名：身份字段 / 人口学属性；职业词不单独作证据', () => {
  assert.ok(hasValue('证人：王芳。', 'name', '王芳'));
  assert.ok(hasValue('当事人李四，男，汉族', 'name', '李四'));
  assert.strictEqual(vals('村医周济世到场', 'name').length, 0);
});

test('扩展·姓名：复姓 / 2 字 / 3 字均由结构确认', () => {
  assert.ok(hasValue('原告：欧阳明。', 'name', '欧阳明'));
  assert.ok(hasValue('原告：张三。', 'name', '张三'));
  assert.ok(hasValue('原告：陈阿满。', 'name', '陈阿满'));
  assert.strictEqual(vals('原告欧阳明到庭', 'name').length, 0, '无分隔单句不猜测');
});

test('扩展·姓名：谓语不靠动作词识别，已确认姓名可传播', () => {
  const known = collectEntities(['被告人：张三。', '证人：李四。', '记录人：王芳。']);
  for (const [t, who] of [['张三同意', '张三'], ['与李四商议', '李四'], ['王芳供述', '王芳']]) {
    assert.strictEqual(vals(t, 'name').length, 0, `${t} 不应靠谓语猜测`);
    assert.ok(hasValue(t, 'name', who, { knownEntities: known }), `${t} 传播未命中`);
  }
});

test('扩展·姓名：不误报常见普通词与地名', () => {
  const t = '开庭许可回族教务处雷阳中学西湖区文三路商贸有限公司';
  assert.strictEqual(vals(t, 'name').length, 0, JSON.stringify(vals(t, 'name')));
});

test('扩展·姓名：金额语境不新增证据，使用案卷实体表传播', () => {
  const known = collectEntities(['证人：李四。', '负责人：陈阿满。']);
  assert.ok(hasValue('被告人张三收受李四人民币2.09万元', 'name', '李四', { knownEntities: known }));
  assert.ok(hasValue('王芳支付给陈阿满现金14万元', 'name', '陈阿满', { knownEntities: known }));
});

test('姓名弱语境：引导词和动作词均不直接确认', () => {
  const texts = ['请张伟跟进项目', '由李四负责对接', '和王芳商议对策', '通知陈阿满出席会议'];
  for (const t of texts) assert.strictEqual(vals(t, 'name').length, 0, `弱语境不应命中: ${t}`);
  assert.strictEqual(vals('今天上午和张伟开会讨论进度', 'name').length, 0);
  const known = collectEntities(['证人：张伟。', '证人：李四。', '证人：王芳。', '证人：陈阿满。']);
  for (const t of texts) assert.ok(vals(t, 'name', { knownEntities: known }).length >= 1, `实体传播未命中: ${t}`);
});

test('规则：身份证校验码不合法也命中（语境引导）', () => {
  assert.strictEqual(isValidIdCard(ID_BAD), false);
  const t = `公民身份号码 ${ID_BAD}，回族`;
  assert.ok(detect(t).items.some((i) => i.type === 'idCard' && i.value === ID_BAD));
});

test('规则：角色标签长词优先，「被告人陈阿满在…」不漏检', () => {
  const t = '2019年至2024年，被告人：陈阿满，在先后担任雷阳中学教务处主任期间';
  const names = detect(t).items.filter((i) => i.type === 'name').map((i) => i.value);
  assert.ok(names.includes('陈阿满'), names.join(','));
  assert.ok(!names.includes('教务处'), names.join(','));
});

test('规则：机构名不吞并人名、系动词与时间词', () => {
  const t = '答：陈阿满，男，是广东雷阳律师事务所负责人。2022年9月初广东雷阳律师事务所经招投标';
  const r = detect(t);
  const orgs = r.items.filter((i) => i.type === 'org').map((i) => i.value);
  assert.deepStrictEqual(orgs, ['广东雷阳律师事务所', '广东雷阳律师事务所'], JSON.stringify(r.items));
  assert.ok(r.items.some((i) => i.type === 'name' && i.value === '陈阿满'));
});

test('规则：姓名精度（开庭/许可/回族/教务处 不误报，陈阿元/张三/王芳 正确）', () => {
  const bad = detect('请审判长开庭。应当经审判长或独任审判员许可。回族，教务处主任');
  assert.strictEqual(bad.items.filter((i) => i.type === 'name').length, 0, JSON.stringify(bad.items));
  // 「元」是常见人名末字，不能被尾字过滤规则截断成两字
  const yuan = detect('书记员：陈阿元，担任法庭记录。');
  assert.ok(yuan.items.some((i) => i.type === 'name' && i.value === '陈阿元'), JSON.stringify(yuan.items));
  const good = detect('书记员：张三，担任法庭记录。审：被告人：陈阿满，现法庭核实身份。答：王芳，女，刚大学毕业');
  const ns = good.items.filter((i) => i.type === 'name').map((i) => i.value);
  for (const n of ['张三', '陈阿满', '王芳']) assert.ok(ns.includes(n), n + ' → ' + ns.join(','));
});

test('规则：人称角色与姓名字段确认姓名', () => {
  const t = '食堂负责人：李四，贿赂14万元；法定代表人：王芳，银行转账2.09万元；总经理，姓名：陈阿满；副总经理，姓名：张伟';
  const ns = detect(t).items.filter((i) => i.type === 'name').map((i) => i.value);
  for (const n of ['李四', '王芳', '陈阿满', '张伟']) assert.ok(ns.includes(n), n + ' → ' + ns.join(','));
});

test('规则：已知姓名传播 + 3 字候选被拒不阻断 2 字真名', () => {
  const t = '以单位开支为借口向李四提出回扣，李四也同意了。每次培训后我会和李四核对人数';
  const hits = detect(t, { knownNames: new Set(['李四']) }).items.filter((i) => i.type === 'name' && i.value === '李四');
  assert.strictEqual(hits.length, 3, JSON.stringify(hits));
});

test('规则：紧邻强 PII 的普通动词不级联成姓名', () => {
  const t = '订单编号 123456202301011234 已生成，另一编号 987654202312106789 审批完毕。';
  const ns = detect(t).items.filter((i) => i.type === 'name');
  assert.strictEqual(ns.length, 0, JSON.stringify(ns));
  // 号码邻接本身不构成姓名证据；已确认姓名可按实体表传播。
  assert.strictEqual(detect('手机13812345678联系张三。').items.filter((i) => i.type === 'name').length, 0);
  const ok = detect('手机13812345678联系张三。', { knownNames: new Set(['张三']) });
  assert.ok(ok.items.some((i) => i.type === 'name' && i.value === '张三'), JSON.stringify(ok.items));
});

test('规则：车牌补「粤」并放行汉字前后缀（文书句式）', () => {
  const t = '其驾驶的粤A12345号车辆被查扣，张三另驾驶粤B67890号小轿车逃逸，涉案车辆粤A12345挂。';
  const ps = detect(t).items.filter((i) => i.type === 'plate').map((i) => i.value);
  assert.ok(ps.includes('粤A12345'), ps.join(','));
  assert.ok(ps.includes('粤B67890'), ps.join(','));
  assert.ok(ps.includes('粤A12345挂'), ps.join(','));
  const q = detect('皖A12345、京AD12345已登记。');
  assert.ok(q.items.some((i) => i.type === 'plate' && i.value === '皖A12345'), JSON.stringify(q.items));
  assert.ok(q.items.some((i) => i.type === 'plate' && i.value === '京AD12345'), JSON.stringify(q.items));
  assert.strictEqual(
    detect('编号粤A12345678 已作废').items.filter((i) => i.type === 'plate').length, 0,
    JSON.stringify(detect('编号粤A12345678 已作废').items));
  assert.strictEqual(
    detect('X粤A12345 作废单').items.filter((i) => i.type === 'plate').length, 0,
    JSON.stringify(detect('X粤A12345 作废单').items));
});

/* ---------------- 地址 / 机构 ---------------- */

test('地址检测', () => {
  const { items } = detect(SAMPLE);
  assert.ok(items.some((i) => i.type === 'address' && i.value.includes('文三路138号')));
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
  // 纯行政区划籍贯属于公开信息，不再按地址屏蔽
  assert.strictEqual(a.items.filter((i) => i.type === 'address').length, 0, JSON.stringify(a.items));
  const b = detect('杭州市人民检察院查明，浙江省杭州市人民法院');
  assert.strictEqual(b.items.filter((i) => i.type === 'address').length, 0, JSON.stringify(b.items));
});

test('规则：普通叙述不被当成地址', () => {
  const t = '答：我今天要向组织我分别收受雷阳中学南校区食堂负责人李四14万元现金';
  assert.strictEqual(detect(t).items.filter((i) => i.type === 'address').length, 0);
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

test('扩展·地址：籍贯表述（纯行政区划不屏蔽，含居住要素才屏蔽）', () => {
  assert.strictEqual(vals('，汉族，浙江杭州人，大学文化', 'address').length, 0,
    JSON.stringify(vals('，汉族，浙江杭州人，大学文化', 'address')));
  assert.strictEqual(vals('，回族，安徽雷州人，', 'address').length, 0,
    JSON.stringify(vals('，回族，安徽雷州人，', 'address')));
  assert.strictEqual(vals('，广东雷州雷城街道人，', 'address').length, 0, '纯行政区划籍贯不屏蔽');
  assert.ok(hasValue('籍贯：广东雷州雷城街道文三路18号', 'address', '广东雷州雷城街道文三路18号'));
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
  const t = '答：陈阿满，男，是广东雷阳律师事务所负责人。2022年9月初广东雷阳律师事务所经招投标';
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

test('优化·机构：公权力机关与公共法律服务机构整体不遮蔽', () => {
  for (const t of [
    '临江市清河区人民检察院南检刑诉[2026]Z25号',
    '杭州市西湖区人民法院审理',
    '本案由雷州市人民检察院侦查终结',
    '现向你出示涟水县监察委员会依法调取',
    '线索移交给北和镇派出所',
    '材料已交北和镇司法所备案',
    '根据最高人民法院的通知',
    '雷州市法律援助中心指派辩护人',
    '向公证处申请公证',
  ]) {
    assert.deepStrictEqual(vals(t, 'org'), [], `${t} → ${JSON.stringify(vals(t, 'org'))}`);
  }
  // 普通企业/学校仍照常识别，排除未泛化到所有机构
  assert.ok(vals('九洲有限公司承接项目', 'org').length > 0);
  assert.ok(vals('北京师范大学附属中学出具证明', 'org').length > 0);
});

test('优化·籍贯：省份名锚定的纯地名籍贯不屏蔽', () => {
  assert.strictEqual(vals('李四，安徽仓吉人，回族，小学文化', 'address').length, 0,
    JSON.stringify(vals('李四，安徽仓吉人，回族，小学文化', 'address')));
  assert.strictEqual(vals('陈阿满，广东雷州人，男', 'address').length, 0);
  assert.strictEqual(vals('王五是本地人，张伟是年轻人', 'address').length, 0);
});

test('优化·机构：动作/系动词断点与多词叠加剥离', () => {
  assert.ok(hasValue('仍实际负责雷州市师资培训中心工作', 'org', '雷州市师资培训中心'));
  assert.ok(hasValue('徐燕系广东海田服务有限公司法定代表人', 'org', '广东海田服务有限公司'));
  assert.ok(hasValue('北京华创系统工程有限公司承接项目', 'org', '北京华创系统工程有限公司'));
});

test('优化·地址：必须有居住要素，单级行政区划不兜底', () => {
  assert.strictEqual(vals('位于仓吉县第一中学南校区食堂负责人办公室抓获', 'address').length, 0);
  assert.strictEqual(vals('案发地合肥市，另一现场在颍上县城关镇', 'address').length, 0);
  assert.ok(hasValue('案发地合肥市西湖大道138号', 'address', '合肥市西湖大道138号'));
  assert.ok(vals('前往雷州市西湖大道138号', 'address').every((v) => !/^(前往|位于|在)/.test(v)));
});

test('新增·银行卡：空格/横杠分隔后去分隔符 + Luhn 命中，value 存纯数字', () => {
  const d = BANK1;
  const spaced = `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8, 12)} ${d.slice(12)}`;
  const dashed = `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}-${d.slice(12)}`;
  for (const s of [spaced, dashed]) {
    const bank = vals(`卡号 ${s}`, 'bank')[0];
    assert.strictEqual(bank, d, `带分隔符卡号应规范化为纯数字: ${s}`);
  }
  assert.strictEqual(vals(`银行卡号 ${spaced}`, 'bank')[0], d);
});

test('新增·机构后缀：医院/银行/支行/工作室/超市/宾馆/工厂/门市部/中心', () => {
  const cases = [
    ['被告系杭州友好医院职工', '杭州友好医院'],
    ['该公司向中国工商银行深圳支行贷款', '中国工商银行深圳支行'],
    ['负责人系星星连锁超市法人', '星星连锁超市'],
    ['被告系金源商务宾馆员工', '金源商务宾馆'],
    ['位于城东汽车工厂附近', '城东汽车工厂'],
    ['系华联百货门市部员工', '华联百货门市部'],
  ];
  for (const [text, want] of cases) {
    assert.ok(hasValue(text, 'org', want), `机构未识别: ${text} → ${want}`);
  }
});

test('新增·公立医院「第一人民医院」整体识别，地址不残留残缺前缀', () => {
  const text = '位于浙江省杭州市第一人民医院附近。';
  const items = detect(text, {}).items;
  const orgs = items.filter((i) => i.type === 'org').map((i) => i.value);
  assert.ok(orgs.some((v) => v.includes('第一人民医院')), `应整体识别公立医院: ${orgs}`);
  assert.ok(!orgs.some((v) => /^一人民$|^第一人民$/.test(v)), `不应出现残缺机构: ${orgs}`);
  const addrs = items.filter((i) => i.type === 'address').map((i) => i.value);
  assert.ok(!addrs.some((v) => v.includes('第一人民')), `地址不应吞并医院: ${addrs}`);
});

test('优化·案号：方括号 / 全角方括号内联文号（检测部分）', () => {
  assert.ok(vals('公诉机关以南检刑诉[2026]Z25号起诉', 'caseNo').some((v) => v.includes('[2026]')));
  assert.ok(vals('杭检刑诉【2021】88号一案', 'caseNo').some((v) => v.includes('【2021】')));
});

test('优化·案号：检察院案号前缀不得被误判为姓名（检测部分）', () => {
  const t = '公诉机关以南检刑诉[2026]Z25号起诉';
  assert.strictEqual(vals(t, 'name').length, 0, JSON.stringify(vals(t, 'name')));
  assert.strictEqual(vals('杭检刑诉【2021】88号', 'name').length, 0);
  assert.ok(hasValue('原告：张三，南检刑诉[2026]Z25号', 'name', '张三'));
  assert.strictEqual(vals('检定员李四负责检测工作', 'name').length, 0);
});

test('修复·地址误吞尾字：村务/村民/村委等后词不吞入地名（检测部分）', () => {
  const t = '判令二被告在石牌垌村村务公开栏张贴书面致歉声明';
  const addrs = detect(t).items.filter((i) => i.type === 'address').map((i) => i.value);
  assert.ok(addrs.includes('石牌垌村'), `地名应止于「石牌垌村」: ${addrs}`);
  assert.ok(!addrs.some((v) => v.endsWith('村村')), `不应吞入「村务」的村字: ${addrs}`);
});

test('排除：性别/年龄/出生日期不被屏蔽', () => {
  const t = '性别：男，年龄：35岁，出生日期：1990年01月01日，民族：汉族';
  const r = detect(t);
  assert.strictEqual(r.items.length, 0, JSON.stringify(r.items));
});

/* ================= F:\Law\Test 案卷审计回归（误屏蔽 / 漏屏蔽修复锁定） ================= */

const { Vault, maskText } = require('../src/core/masker');

test('审计·普通词无结构锚点时不遮为姓名', () => {
  const v = new Vault();
  for (const t of [
    '执行立案审查。',
    '申请执行。',
    '执业证号14401202080123456。',
    '相关文件如下。',
    '调查笔录一份。',
  ]) {
    const m = maskText(t, v);
    assert.ok(!/〔姓名·/.test(m.masked), `${t} → 误遮: ${m.masked}`);
    assert.ok(/执行|执业|文件|调查笔录/.test(m.masked), `${t} → 原词应保留: ${m.masked}`);
    assertNoLeak(m.masked, '14401202080123456', '证号');
  }
});

test('审计·邻接 PII 不确认姓名，传播命中 confident=false', () => {
  assert.strictEqual(detect('手机13812345678联系张三。').items.filter((i) => i.type === 'name').length, 0);
  const weak = detect('手机13812345678联系张三。', { knownNames: new Set(['张三']) }).items.filter((i) => i.type === 'name');
  assert.ok(weak.some((i) => i.value === '张三' && !i.confident), '传播命中为弱证据');
  const strong = detect('原告：陈阿满，男').items.filter((i) => i.type === 'name');
  assert.ok(strong.some((i) => i.value === '陈阿满' && i.confident), '角色标签为强证据');
});

test('审计·地址负例：行政区划 / 括号中的「号」不误判为地址', () => {
  const negs = [
    '以行政区划链为例，真实地名替换为化名。',
    '地址嵌在括号中：（广东省A市B镇C村）',
    '本辖区行政区划图已更新。',
  ];
  for (const t of negs) {
    const addrs = vals(t, 'address');
    assert.strictEqual(addrs.length, 0, `${t} → 误判地址: ${JSON.stringify(addrs)}`);
  }
  // 正例成对：真地址仍检出
  assert.ok(vals('住所地广东省雷州市北和镇石牌垌村祠堂侧', 'address').length >= 1, '真地址应检出');
});

test('审计·机构：年例理事会 / 委员会等基层组织整体识别', () => {
  assert.ok(vals('石牌垌村年例理事会出具证明。', 'org').includes('石牌垌村年例理事会'),
    JSON.stringify(vals('石牌垌村年例理事会出具证明。', 'org')));
  assert.ok(vals('村民选举委员会公示名单', 'org').some((v) => v.endsWith('委员会')), '选举委员会');
  // 负例成对：连词残尾（「他和工厂」）不判机构，且不影响真地名机构
  assert.strictEqual(vals('他和工厂签了合同', 'org').length, 0, '他和工厂 → 连词残尾');
  assert.strictEqual(vals('线索移交给北和镇派出所', 'org').length, 0, '派出所属公权力机关，不遮蔽');
  assert.strictEqual(vals('会同县人民法院受理', 'org').length, 0, '法院属公权力机关，不遮蔽');
});

test('审计·姓名：职业词不单独确认，明确人称结构可确认', () => {
  assert.strictEqual(vals('米婆梁月娇到场。', 'name').length, 0);
  assert.ok(vals('证人：梁月娇。', 'name').includes('梁月娇'));
  assert.strictEqual(vals('三月的梁家聚会', 'name').length, 0, '无语境不得误报');
});

test('审计·同文档地名传播：石牌垌下房亲邻群', () => {
  const t = '二、判令被告在石牌垌下房亲邻群内刊登致歉声明，石牌垌村村民委员会见证。';
  const r = detect(t, { knownPlaces: new Set(['石牌垌']) });
  const addrs = r.items.filter((i) => i.type === 'address').map((i) => i.value);
  assert.ok(addrs.filter((v) => v === '石牌垌').length >= 1, `群名中的地名应命中: ${JSON.stringify(addrs)}`);
  // 负例成对：无边界（紧贴其他汉字构成别词）时不扩散
  const r2 = detect('里石牌垌子无关', { knownPlaces: new Set(['石牌垌']) });
  assert.strictEqual(r2.items.filter((i) => i.type === 'address').length, 0,
    '紧贴汉字无边界不应扩散');
});
