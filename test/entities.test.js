'use strict';
/** 中文实体结构规则：身份锚点、居住要素、机构后缀与传播边界。 */

const { test, assert } = require('./helpers');
const { detect } = require('../src/core/detector');
const { collectEntities, hashName } = require('../src/core/entities');
const { Vault, maskText, restoreText } = require('../src/core/masker');

const vals = (text, type, options) =>
  detect(text, options).items.filter((i) => i.type === type).map((i) => i.value);

test('实体结构：姓名由身份字段、人称前缀和人口学属性确认', () => {
  for (const [text, name] of [
    ['被会见人：张三。', '张三'],
    ['辩护人：李四。', '李四'],
    ['张三，男，2010年02月08日出生', '张三'],
    ['答：李四，2010年出生', '李四'],
  ]) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('实体结构：表格相邻块与并列结构确认姓名', () => {
  const table = collectEntities(['受援人', '张三']);
  assert.ok(table.name.has('张三'));
  const coordinated = collectEntities(['在场人：张三、李四。']);
  assert.ok(coordinated.name.has('张三') && coordinated.name.has('李四'));
});

test('实体结构：句末谓语、集合指代和联系方式不成姓名', () => {
  for (const text of [
    '请审判长开庭。',
    '审判员许可。',
    '被告人服从判决，表示认罪。',
    '双方核对后签字。',
    '联系人电话 13998765432',
    '问：你是否明白？答：明白。',
    '参加人：不申请',
    '辩护人：没有意见',
    '教师培训项目，2020年10月启动',
    '第五检察部检察官助理\n人大代表：张三',
  ]) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('实体结构：地址保留完整居住要素且不吞引导词', () => {
  const text = '户籍所在地及住址浙江省杭州市西湖区文三路138号3幢201室，住广东省雷州市乌石镇新村振兴路18号2栋502室。';
  const addrs = vals(text, 'address');
  assert.ok(addrs.includes('浙江省杭州市西湖区文三路138号3幢201室'), JSON.stringify(addrs));
  assert.ok(!addrs.some((v) => v.includes('住址')), JSON.stringify(addrs));
  assert.ok(addrs.includes('广东省雷州市乌石镇新村振兴路18号2栋502室'), JSON.stringify(addrs));
});

test('实体结构：纯行政区划、泛指地点和占位地址不屏蔽', () => {
  for (const text of [
    '江苏涟水人',
    '籍贯：广东雷州雷城街道人',
    '案发地合肥市',
    '在南京市一家宾馆',
    '地址嵌在括号中：（广东省A市B镇C村）',
  ]) {
    assert.strictEqual(vals(text, 'address').length, 0, `${text} → ${JSON.stringify(vals(text, 'address'))}`);
  }
});

test('实体结构：机构后缀、长度、行政区划边界共同确定机构', () => {
  assert.deepStrictEqual(vals('多次承揽雷州市师资培训中心举办的项目', 'org'), ['雷州市师资培训中心']);
  assert.deepStrictEqual(vals('被告系杭州友好医院职工', 'org'), ['杭州友好医院']);
  assert.deepStrictEqual(vals('该公司向中国工商银行深圳支行贷款', 'org'), ['中国工商银行深圳支行']);
  assert.deepStrictEqual(vals('涟水县师资培训中心支付九洲公司', 'org'), ['涟水县师资培训中心']);
});

test('实体结构：国家总部、数量泛指和短简称不屏蔽', () => {
  for (const text of ['中国建设银行', '在南京市一家宾馆', '九洲公司继续履约', '约我汇报公司', '中午你们公安局']) {
    assert.strictEqual(vals(text, 'org').length, 0, `${text} → ${JSON.stringify(vals(text, 'org'))}`);
  }
});

test('实体结构：旧地名兼容传播要求左边界，新实体表按完整值传播', () => {
  assert.strictEqual(vals('里石牌垌子无关', 'address', { knownPlaces: new Set(['石牌垌']) }).length, 0);
  const known = collectEntities(['住所地浙江省杭州市西湖区文三路138号']);
  assert.ok(vals('其在浙江省杭州市西湖区文三路138号出现', 'address', { knownEntities: known }).length >= 1);
});

// ---- 姓名规则重构 Golden Test（锚点+后边界、误判守卫、传播最长优先） ----

test('姓名·后边界：角色词+姓名+案卷叙述动词/罪名可确认（无需标点）', () => {
  for (const [text, name] of [
    ['审判长张三宣布开庭。', '张三'],
    ['被告人欧阳明盗窃他人财物。', '欧阳明'],
    ['被告人司马相如盗窃他人财物。', '司马相如'],
    ['证人李四作证时表示情况属实。', '李四'],
    ['原告赵六提起诉讼。', '赵六'],
    ['代理人钱七提出异议。', '钱七'],
  ]) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('姓名·形状：少数民族长名与间隔号姓名可确认，往返逐字一致', () => {
  for (const [text, name] of [
    ['阿依古丽买买提，男，30岁。', '阿依古丽买买提'],
    ['阿依古丽·买买提，男，30岁。', '阿依古丽·买买提'],
  ]) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
    const v = new Vault();
    const masked = maskText(text, v).masked;
    assert.ok(masked.includes('〔姓名·'), masked);
    assert.strictEqual(restoreText(masked, v).text, text);
  }
});

test('姓名·误判守卫：庭审动作词与普通名词/泛称不确认为姓名', () => {
  for (const text of [
    '原告到庭', '食堂负责人张罗商议', '审判长：宣布被告人身份。',
    '王芳女士已确认参加。', '婴儿，男，2岁，身体健康。', '负责人：经理',
    '审判长：法官', '证人：证言', '鉴定人：意见', '负责人：情况', '原告：主张',
  ]) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
  const table = collectEntities(['姓名', '张三', '证人', '证言', '审判长', '宣布']);
  assert.deepStrictEqual([...table.name], ['张三'], JSON.stringify([...table.name]));
});

test('姓名·传播：源头误判不入表，哈希命中遵循最长优先', () => {
  const known = collectEntities(['婴儿，男，2岁。', '负责人：经理', '张三，男。']);
  assert.deepStrictEqual([...known.name], ['张三'], JSON.stringify([...known.name]));
  const hashes = new Set([hashName('张三')]);
  const hit = detect('张三丰到场。', { knownNameHashes: hashes }).items.filter((i) => i.type === 'name');
  assert.ok(hit.length >= 1 && hit.every((i) => i.value === '张三'), JSON.stringify(hit));
  const v = new Vault();
  const masked = maskText('审判长张三宣布开庭。', v).masked;
  assert.strictEqual(restoreText(masked, v).text, '审判长张三宣布开庭。');
});

test('姓名·冷僻姓：裴/邝/冼 等非高频姓不得因形状门槛漏遮，虚词不得误遮', () => {
  // 旧实现用「常见姓氏白名单」做 2 字准入门槛，表外的真姓（裴钱）直接漏遮。
  for (const [text, name] of [
    ['被会见人：裴钱', '裴钱'],
    ['被害人：邝丽，女，1987年出生。', '邝丽'],
    ['证人：冼芳', '冼芳'],
    ['被害人：岑伟', '岑伟'],
    ['原告：于洋', '于洋'],
  ]) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
    const v = new Vault();
    const masked = maskText(text, v).masked;
    assert.ok(masked.includes('〔姓名·'), `${text} 应被屏蔽: ${masked}`);
    assert.strictEqual(restoreText(masked, v).text, text, `${text} 往返应逐字一致`);
  }
  // 虚词首字仍不得确认为姓名
  for (const text of ['被告人：现在，你可以走了。', '被害人：有权，请记录在案。',
    '被告人：应当', '被害人：尚未', '被害人：包括', '被害人：查明']) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('姓名·冒号语境：字段值确认，冒号引出的话语不确认', () => {
  // 判据是「冒号后是字段值还是一句话」，与姓氏/姓名表无关：
  // 句子含人称代词、情态助动词、请求语时，冒号处的字词不是姓名。
  for (const text of [
    '被告人：现在，你可以走了。',
    '审判长：现在核对被告人身份。',
    '被害人：有权，请记录在案。',
    '被告人：有权委托辩护人。',
    '被告人：如实供述',
    '被害人：自愿认罪',
    '被害人：同意赔偿',
    '被告人：是否听清',
  ]) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
  for (const [text, name] of [
    ['被会见人：裴钱', '裴钱'],
    ['负责人：陈兆坤，主任。', '陈兆坤'],
    ['书记员：张三，担任法庭记录。', '张三'],
    ['原告：张三，南检刑诉[2026]Z25号', '张三'],
  ]) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('姓名·字段行：嵌套角色词不遮角色词片段，间隔号长名整体确认', () => {
  // 「姓名：审判员李长顺」曾把「审判」当姓名（字段前缀全命中）。
  assert.deepStrictEqual(vals('姓名：审判员李长顺', 'name'), ['李长顺']);
  assert.deepStrictEqual(vals('姓名：审判员', 'name'), []);
  // 姓名：字段 + 间隔号长名应整体确认，不能退化成前缀「阿依」「阿依古」
  assert.deepStrictEqual(vals('姓名：阿依古丽·买买提', 'name'), ['阿依古丽·买买提']);
  assert.deepStrictEqual(vals('被害人阿依古丽·买买提陈述。', 'name'), ['阿依古丽·买买提']);
});

test('姓名·谓语与罪名边界：不吞谓语、不越过动词吞罪名', () => {
  // 「本律师担任裴钱涉嫌盗窃罪一案」曾被遮成「裴*嫌」：候选「裴钱涉嫌」
  // 被后随「盗窃」触发叙述闭合，把谓语「涉嫌」吞进了姓名。
  for (const [text, name] of [
    ['本律师担任裴钱涉嫌盗窃罪一案', '裴钱'],
    ['本律师担任裴钱涉嫌盗窃罪一案，现依法会见。', '裴钱'],
    ['被会见人：裴钱涉嫌盗窃罪一案', '裴钱'],
    ['姓名：裴钱涉嫌盗窃罪', '裴钱'],
    ['裴钱涉嫌盗窃罪', '裴钱'],
    ['被告人裴钱涉嫌盗窃罪，现羁押于雷州市看守所。', '裴钱'],
  ]) {
    assert.deepStrictEqual(vals(text, 'name'), [name], `${text} → ${JSON.stringify(vals(text, 'name'))}`);
    const v = new Vault();
    const masked = maskText(text, v).masked;
    assert.ok(masked.includes('裴*〔姓名·'), `${text} 应遮成 2 字形态: ${masked}`);
    assert.ok(!masked.includes('裴*嫌'), `${text} 不应吞谓语: ${masked}`);
    assert.strictEqual(restoreText(masked, v).text, text, `${text} 往返应逐字一致`);
  }
  // 间隔号姓名在「涉嫌」锚点下要整体确认，不能只遮「买买提」。
  assert.deepStrictEqual(vals('阿依古丽·买买提涉嫌盗窃罪', 'name'), ['阿依古丽·买买提']);
  // 指代/否定语素开头、方位收尾都不是姓名
  for (const text of ['该公司涉嫌走私。', '上述人员涉嫌犯罪。', '同案人涉嫌共同犯罪。',
    '犯罪嫌疑人涉嫌盗窃罪。', '对方涉嫌违约。', '以上涉嫌虚构。', '其涉嫌盗窃罪。',
    '本案涉嫌金额巨大。', '我们涉嫌违规操作。', '非法集资涉嫌犯罪。']) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
  // 庭审指令仍不得因「后随动词」被确认
  for (const text of ['合议庭成员：审判长开庭审理本案', '审判长：开庭。', '书记员：请审判长开庭。']) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('姓名·律师表述：连续谓语后取宾语，所有格结构取姓名', () => {
  // 角色词与姓名之间隔着一到多个身份谓语时，锚点仍要命中
  for (const [text, name] of [
    ['本律师接受指派担任裴钱涉嫌盗窃罪一案辩护人', '裴钱'],
    ['辩护人接受委托担任裴钱盗窃案一审辩护人', '裴钱'],
    ['本律师会见裴钱，了解案件情况。', '裴钱'],
    ['本律师担任张三的辩护人。', '张三'],
    ['法官助理李四担任张三的辩护人。', '张三'],
  ]) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
  // 「指派律师王五担任张三的辩护人」两个姓名都要遮
  const both = vals('指派律师王五担任张三的辩护人', 'name');
  assert.ok(both.includes('王五') && both.includes('张三'), JSON.stringify(both));
  // 所有格/涉嫌锚点不得把普通名词、机构、指代词当姓名
  for (const text of ['完成含原告肖像的照片核查。', '公司的意见。', '该公司的委托代理人。',
    '被告人的辩护人。', '经办人的意见。', '上述材料的复印件。', '以上涉嫌虚构。']) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
});

test('姓名·委托所有格：代理词/委托书高频句式（申请人X的委托）', () => {
  for (const [text, name] of [
    ['本案申请人（劳动者）杨素侠的委托，担任其与某公司劳动争议一案的仲裁代理人', '杨素侠'],
    ['律师接受杨素侠的委托', '杨素侠'],
    ['受王东的委托出具法律意见书', '王东'],
    ['杨素侠的委托诉讼代理人', '杨素侠'],
  ]) {
    assert.ok(vals(text, 'name').includes(name), `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
  // 委托主体是非人名词时不得确认
  for (const text of ['接受公司的委托后立即开展工作。', '受单位的委托出庭。', '该公司的委托代理人。']) {
    assert.strictEqual(vals(text, 'name').length, 0, `${text} → ${JSON.stringify(vals(text, 'name'))}`);
  }
  // 「X与被Y」并列结构：连词尾候选不得借 passiveClosed 闭合
  assert.strictEqual(vals('申请人杨素侠与被申请人阜南华文针织服饰有限公司', 'name').join(','), '',
    '杨素侠与 不应被确认为姓名');
  // 否定副词开头（被申请人未足额支付…）不得经两遍式候选误确认
  const corpus = [
    '根据申请人提交的证据银行流水及劳动合同，银行流水显示，被申请人自2025年9月起，未足额、按时向申请人发放工资，至今累计拖欠5852元。',
    '综上所述，被申请人未足额支付加班工资的行为已违反法律强制性规定。',
  ];
  assert.strictEqual(collectEntities(corpus, { toggles: {} }).name.has('未足额'), false,
    '未足额 不应进入案卷实体表');
});
