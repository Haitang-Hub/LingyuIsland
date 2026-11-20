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
    '原告欧阳明到庭', '食堂负责人张罗商议', '审判长：宣布被告人身份。',
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
