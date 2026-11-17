'use strict';
/** 屏蔽引擎套件：编码格式 / 保留位 / 还原（含新旧格式兼容）/ Office XML 映射 */

const { test, assert, ID1, ID_BAD, BANK1, SAMPLE, CODE_BRACKET_RE, assertNoLeak } = require('./helpers');
const {
  Vault, maskText, restoreText, buildMasked, hasCodes, countCodes,
  maskEdits, restoreEdits, cleanEdits, CODE_LABEL,
} = require('../src/core/masker');
const { detect } = require('../src/core/detector');
const { transformXmlText, xmlBlockTexts } = require('../src/core/xmltext');

test('屏蔽值可判断内容类型且内嵌编码（带类型标签）', () => {
  const v = new Vault();
  const code = v.ensureCode('phone', '13812345678');
  assert.strictEqual(buildMasked('phone', '13812345678', code), '138****5678〔手机号·' + code + '〕');
  assert.strictEqual(buildMasked('name', '张三', v.ensureCode('name', '张三')).startsWith('张*〔姓名·'), true);
  // 各类型的标签齐备
  for (const t of ['phone', 'idCard', 'bank', 'email', 'name', 'address', 'org', 'caseNo']) {
    assert.ok(CODE_LABEL[t], '类型标签缺失: ' + t);
  }
});

test('同一值 → 同一编码（同批次稳定）', () => {
  const v = new Vault();
  const c1 = v.ensureCode('phone', '13812345678');
  const c2 = v.ensureCode('phone', '13812345678');
  assert.strictEqual(c1, c2);
});

test('映射库 JSON 往返持久化（含盐值）', () => {
  const v = new Vault();
  const c1 = v.ensureCode('name', '陈阿满');
  const revived = Vault.fromJSON(v.toJSON());
  assert.strictEqual(revived.ensureCode('name', '陈阿满'), c1, '持久化后同值同码');
  assert.strictEqual(revived.lookup(c1).value, '陈阿满');
});

test('屏蔽→还原 完整往返', () => {
  const v = new Vault();
  const { masked } = maskText(SAMPLE, v);
  assert.ok(hasCodes(masked));
  const r = restoreText(masked, v);
  assert.strictEqual(r.missing.length, 0);
  assert.strictEqual(r.text, SAMPLE);
});

test('从文件复制的片段也能还原（新格式）', () => {
  const v = new Vault();
  const { masked } = maskText(SAMPLE, v);
  const frag = masked.match(/138\*\*\*\*5678〔(?:[\u4e00-\u9fa5]{1,6}·)?[0-9a-f]+〕/)[0];
  const r = restoreText(frag, v);
  assert.strictEqual(r.text, '13812345678');
});

test('编码被篡改 → 明确报告无法还原', () => {
  const v = new Vault();
  const { masked } = maskText('电话：13812345678', v);
  const broken = masked.replace(CODE_BRACKET_RE, '〔ffff00〕');
  const r = restoreText(broken, v);
  assert.deepStrictEqual(r.missing, ['ffff00']);
});

test('maskText 不破坏 JSON 结构', () => {
  const v = new Vault();
  const json = JSON.stringify({ name: '张三', phone: '13812345678', age: 35, gender: '男' });
  const { masked } = maskText(json, v);
  const obj = JSON.parse(masked);
  assert.ok(obj.age === 35 && obj.gender === '男');
  assert.strictEqual(restoreText(masked, v).text, json);
});

test('可读性：编码括号带类型标签，还原剥除标签', () => {
  const v = new Vault();
  const t = '原告陈阿满，手机 13812345678，住浙江省杭州市西湖区文三路138号。';
  const { masked } = maskText(t, v);
  // 每个编码括号都带「类型·」标签
  const brackets = masked.match(/〔[^〔〕]*〕/g) || [];
  for (const b of brackets) {
    assert.ok(/^〔[\u4e00-\u9fa5]{1,6}·[0-9a-f]{6,12}〕$/.test(b), `编码应带类型标签: ${b}`);
  }
  assert.ok(masked.includes('〔姓名·'), '姓名标签');
  assert.ok(masked.includes('〔手机号·'), '手机号标签');
  assert.ok(masked.includes('〔地址·'), '地址标签');
  // 标签可读：读者能判断被屏蔽内容的类型
  assert.ok(!/〔[0-9a-f]{6,12}〕/.test(masked), '不应残留无标签的裸编码');
  assert.strictEqual(restoreText(masked, v).text, t, '标签应随编码一并剥除');
});

test('可读性：旧格式（无标签）屏蔽文件仍可还原', () => {
  const v = new Vault();
  const c1 = v.ensureCode('name', '陈阿满');
  const c2 = v.ensureCode('phone', '13812345678');
  const c3 = v.ensureCode('address', '石牌垌村');
  const oldText = `原告张*〔${c1}〕电话138****5678〔${c2}〕住……〔${c3}〕。`;
  const r = restoreText(oldText, v);
  assert.strictEqual(r.text, '原告陈阿满电话13812345678住石牌垌村。');
  assert.strictEqual(r.missing.length, 0);
});

test('可读性：跨节点片段为「标签+编码」占位，可读且可还原', () => {
  const v = new Vault();
  // 实体跨两个文本节点（boundaries 模拟 Office run 拆分）
  const t = '审判长：被告人陈阿满，你是否收到本庭向你送达的临江市清河区';
  const r2 = '人民检察院南检刑诉[2026]Z25号起诉书副本。';
  const blockText = t + r2;
  const { edits } = maskEdits(blockText, v, { boundaries: [t.length] });
  // 按编辑区间应用
  const sorted = edits.slice().sort((a, b) => b.start - a.start);
  let out = blockText;
  for (const e of sorted) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  // 片段占位带标签（不是裸编码）
  const brackets = out.match(/〔[^〔〕]*〕/g) || [];
  assert.ok(brackets.length >= 2, '跨节点实体应拆成两段编码');
  for (const b of brackets) {
    assert.ok(/^〔[\u4e00-\u9fa5]{1,6}·[0-9a-f]{6,12}〕$/.test(b), `片段应带类型标签: ${b}`);
  }
  // 还原逐字一致
  assert.strictEqual(restoreText(out, v).text, blockText);
});

test('Office XML：跨 run 实体按节点拆分，屏蔽→还原逐字一致', () => {
  // 号码/姓名被 Word 拆进多个 run 的典型场景
  const xml = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>联系电话</w:t></w:r><w:r><w:t>138</w:t></w:r><w:r><w:t>1234</w:t></w:r><w:r><w:t>5678，联系人张</w:t></w:r><w:r><w:t>三。</w:t></w:r></w:p>
</w:body></w:document>`;
  const v = new Vault();
  const maskedXml = transformXmlText(xml, (t, boundaries) => {
    const { edits, items } = maskEdits(t, v, { boundaries });
    return { edits, count: items.length };
  }).xml;
  assert.ok(!maskedXml.includes('13812345678'), '手机号应被屏蔽');
  assert.ok(!maskedXml.includes('张三'), '姓名应被屏蔽');
  assert.ok(/〔[\u4e00-\u9fa5]{1,6}·[0-9a-f]{6,12}〕/.test(maskedXml), '编码应带类型标签');

  const back = transformXmlText(maskedXml, (t) => {
    const x = restoreEdits(t, v);
    return { edits: cleanEdits(x.edits), count: x.restored.length };
  }).xml;
  const blockOf = (x) => xmlBlockTexts(x).filter((b) => b.trim()).join('\n');
  assert.strictEqual(blockOf(back), blockOf(xml), '还原后拼接文本应逐字一致');
});

test('扩展·屏蔽值：各类型格式与编码内嵌（带标签）', () => {
  const v = new Vault();
  const cases = {
    phone: ['13812345678', /^138\*{4}5678〔手机号·[0-9a-f]{6}〕$/],
    idCard: [ID1, new RegExp(`^……${ID1.slice(-2)}〔身份证·[0-9a-f]{6}〕$`)],
    name: ['张三', /^张\*〔姓名·[0-9a-f]{6}〕$/],
    org: ['广东雷阳律师事务所', /^广东……律师事务所〔机构·[0-9a-f]{6}〕$/],
    address: ['浙江省杭州市西湖区文三路138号', /^浙江……某区〔地址·[0-9a-f]{6}〕$/],
    license: ['14401202080123456', /^……3456〔证号·[0-9a-f]{6}〕$/],
    uscc: ['91330106MA27W1QX1T', /^……QX1T〔信用代码·[0-9a-f]{6}〕$/],
  };
  for (const [type, [value, re]] of Object.entries(cases)) {
    const masked = buildMasked(type, value, v.ensureCode(type, value));
    assert.ok(re.test(masked), `${type} 屏蔽值格式不符: ${masked}`);
  }
});

test('扩展·屏蔽值：地址用末级层级词提示类型，机构不加泛占位词', () => {
  const v = new Vault();
  const addr = buildMasked('address', '杭州市西湖区文三路138号', v.ensureCode('address', 'addr'));
  assert.ok(/^某区〔地址·/.test(addr), `地址应以层级词开头: ${addr}`);
  assert.ok(!/某某|某地/.test(addr), addr);
  const org = buildMasked('org', '雷阳会议服务有限公司', v.ensureCode('org', '雷阳会议服务有限公司'));
  assert.ok(org.startsWith('……有限公司〔机构·'), org);
  assert.ok(!/某某|某地/.test(org), org);
});

test('保留位：身份证/银行卡默认只保留尾 2 位，首段不可见', () => {
  const id = ID1;
  const bank = BANK1;
  const t = `身份证${id}，银行卡${bank}。`;
  const v2 = new Vault();
  const m = maskText(t, v2);
  const idHit = m.masked.slice(m.masked.indexOf('身份证') + 3, m.masked.indexOf('〔'));
  assert.strictEqual((idHit.match(/[0-9Xx]/g) || []).length, 2, `身份证默认只保留末尾 2 位: ${idHit}`);
  assert.ok(idHit.startsWith('……'), `身份证前段不应可见: ${idHit}`);
  assert.ok(!idHit.includes(id.slice(0, 2)), `身份证行政区划前缀不应泄露: ${idHit}`);
  assert.strictEqual(restoreText(m.masked, v2).text, t, '收紧保留位后应逐字还原');
});

test('保留位：执业证号/统一社会信用代码只保留尾段（首尾不得同时可见）', () => {
  const v = new Vault();
  const lic = buildMasked('license', '14401202080123456', v.ensureCode('license', '14401202080123456'));
  assert.ok(lic.startsWith('……'), '执业证号前段不应可见: ' + lic);
  assert.ok(lic.includes('3456'), '应保留末 4 位: ' + lic);
  const uscc = buildMasked('uscc', '91330106MA27W1QX1T', v.ensureCode('uscc', '91330106MA27W1QX1T'));
  assert.ok(uscc.startsWith('……'), '信用代码前段不应可见: ' + uscc);
  // 旧版「首尾各4位」屏蔽文件仍可还原
  const oldLic = '1440……3456〔' + v.ensureCode('license', '14401202080123456') + '〕';
  assert.strictEqual(restoreText(oldLic, v).text, '14401202080123456');
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

test('扩展·优先级：重叠区间按类型优先级保留', () => {
  const t = `身份证${ID1}系张三所有`;
  const r = detect(t);
  const id = r.items.find((i) => i.type === 'idCard');
  assert.ok(id, '身份证应命中');
  const overlap = r.items.filter((i) => i !== id && i.start < id.end && i.end > id.start);
  assert.strictEqual(overlap.length, 0, `不应有与身份证重叠的命中: ${JSON.stringify(overlap)}`);
});

test('扩展·Office：PPT 与 Excel 的文本节点拼接后识别', () => {
  const v = new Vault();
  const ppt = `<a:p><a:r><a:t>手机138</a:t></a:r><a:r><a:t>12345678</a:t></a:r></a:p>`;
  const blocks = xmlBlockTexts(ppt).filter((b) => b.trim());
  assert.ok(blocks[0].includes('13812345678'), blocks[0]);
  const masked = transformXmlText(ppt, (t, boundaries) => {
    const e = maskEdits(t, v, { boundaries });
    return { edits: e.edits, count: e.items.length };
  }).xml;
  assert.ok(!masked.includes('13812345678'), masked);
  const back = transformXmlText(masked, (t) => {
    const x = restoreEdits(t, v);
    return { edits: cleanEdits(x.edits), count: x.restored.length };
  }).xml;
  assert.strictEqual(xmlBlockTexts(back).filter((b) => b.trim()).join('\n'), blocks.join('\n'));
});

test('Office：跨 run 拼接识别身份证与完整地址，XML 结构不变且可逐字还原', () => {
  const xml = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>日出生，公民身份号码</w:t></w:r><w:r><w:t xml:space="preserve"> ${ID_BAD}</w:t></w:r><w:r><w:t>，回族，户籍所在地浙江省杭州市西湖区文三路</w:t></w:r><w:r><w:t>138</w:t></w:r><w:r><w:t>号</w:t></w:r><w:r><w:t>3</w:t></w:r><w:r><w:t>幢</w:t></w:r><w:r><w:t>201</w:t></w:r><w:r><w:t>室</w:t></w:r></w:p>
</w:body></w:document>`;
  const blocks = xmlBlockTexts(xml).filter((b) => b.trim());
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].includes(ID_BAD), blocks[0]);
  assert.ok(blocks[0].endsWith('138号3幢201室'), blocks[0]);

  const v = new Vault();
  const maskedXml = transformXmlText(xml, (t, boundaries) => {
    const { edits, items } = maskEdits(t, v, { boundaries });
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

test('规则：车牌 屏蔽→还原 往返', () => {
  const v = new Vault();
  const t = '涉案车辆为粤A12345挂，另查明京AD12345已过户。';
  const { masked } = maskText(t, v);
  assert.ok(masked.includes('粤A***挂〔车牌·') && masked.includes('京A***5〔车牌·'), masked);
  assert.strictEqual(restoreText(masked, v).text, t);
});

test('规则：机构名与地址屏蔽值不泄露字号 / 县市镇村 / 门牌', () => {
  const v = new Vault();
  const org = buildMasked('org', '雷阳会议服务有限公司', v.ensureCode('org', '雷阳会议服务有限公司'));
  assert.ok(org.startsWith('……有限公司〔机构·'), org);
  assert.ok(!org.includes('雷阳'), org);
  assert.ok(!/某某|某地/.test(org), org);
  const addr = buildMasked('address', '杭州市西湖区文三花园19栋701室', v.ensureCode('address', 'addr1'));
  assert.ok(addr.startsWith('某区〔地址·'), addr);
  assert.ok(!/文三|西湖|701/.test(addr), addr);
  const prov = buildMasked('address', '浙江省杭州市西湖区文三路138号', v.ensureCode('address', 'addr2'));
  assert.ok(prov.startsWith('浙江……某区〔地址·'), prov);
});

test('规则：地址 / 机构名 屏蔽→还原 往返', () => {
  const v = new Vault();
  const t = '户籍所在地浙江省杭州市西湖区文三路138号3幢201室，原告陈阿满是广东雷阳律师事务所负责人。';
  const { masked } = maskText(t, v);
  assert.ok(masked.includes('浙江……某区〔地址·') && masked.includes('……律师事务所〔机构·'), masked);
  assert.strictEqual(restoreText(masked, v).text, t);
});

test('优化·案号：内联文号屏蔽→还原闭环', () => {
  const v = new Vault();
  const t = '以杭检刑诉【2021】88号起诉';
  const m = maskText(t, v);
  assert.strictEqual(restoreText(m.masked, v).text, t);
});

test('优化·案号：检察院案号前缀不得被误判为姓名（屏蔽部分）', () => {
  const v = new Vault();
  const t = '公诉机关以南检刑诉[2026]Z25号起诉';
  const m = maskText(t, v);
  assert.ok(!/南\*/.test(m.masked), m.masked);
  assert.strictEqual((m.masked.match(CODE_BRACKET_RE) || []).length, 1, m.masked);
  assert.strictEqual(restoreText(m.masked, v).text, t);
});

test('优化·机构：司法机关遮蔽不影响案号独立编码，往返可逆', () => {
  const v = new Vault();
  const t = '临江市清河区人民检察院南检刑诉[2026]Z25号';
  const m = maskText(t, v);
  assert.strictEqual((m.masked.match(CODE_BRACKET_RE) || []).length, 2, m.masked);
  assert.strictEqual(restoreText(m.masked, v).text, t);
});

test('修复·地址层级词：末级层级提示 + 完整往返', () => {
  const v = new Vault();
  const cases = [
    ['石牌垌村', /^某村〔地址·[0-9a-f]{6}〕$/],
    ['浙江省杭州市西湖区文三路138号', /^浙江……某区〔地址·[0-9a-f]{6}〕$/],
    ['幸福路123号', /^某路〔地址·[0-9a-f]{6}〕$/],
  ];
  for (const [value, re] of cases) {
    const masked = buildMasked('address', value, v.ensureCode('address', value));
    assert.ok(re.test(masked), `层级词屏蔽格式不符: ${masked}`);
    assert.strictEqual(restoreText(masked, v).text, value, `往返应一致: ${masked}`);
  }
});

test('修复·地址误吞尾字：屏蔽后「村务公开栏」完整保留且可往返', () => {
  const t = '判令二被告在石牌垌村村务公开栏张贴书面致歉声明';
  const v = new Vault();
  const masked = maskText(t, v).masked;
  assert.ok(masked.includes('村务公开栏'), `村务公开栏应完整保留: ${masked}`);
  assert.strictEqual(restoreText(masked, v).text, t);
});

test('修复·旧形态兼容：历史省略号屏蔽文件仍可还原', () => {
  const v = new Vault();
  const c1 = v.ensureCode('address', '浙江省杭州市西湖区文三路138号');
  const c2 = v.ensureCode('address', '石牌垌村');
  const oldText = `原告住浙江……〔${c1}〕，被告在……〔${c2}〕村务公开栏。`;
  const r = restoreText(oldText, v);
  assert.strictEqual(r.text, '原告住浙江省杭州市西湖区文三路138号，被告在石牌垌村村务公开栏。');
  assert.strictEqual(r.missing.length, 0, '不应有未还原编码');
});

test('可读性：任何屏蔽值不得退化为纯省略号形态（……〔标签·编码〕）', () => {
  const v = new Vault();
  const cases = {
    idCard: '330106199001015670',
    bank: '6222020200112233456',
    phone: '13812345678',
    landline: '07551234567',
    name: '陈阿满',
    email: 'zhangsan@example.com',
    passport: 'E12345678',
    plate: '粤A12345',
    im: 'zhangsan2020',
    hkmt: 'H12345678',
    license: '14401202080123456',
    uscc: '91330106MA27W1QX1T',
    caseNo: '（2020）粤0882民初1234号',
    org: '雷州市北和镇卫生院',
    org2: '广东雷阳律师事务所',
    address: '浙江省杭州市西湖区文三路138号',
    address2: '人民广场',   // 此前层级词表缺「广场」，曾屏蔽成「……某」
    address3: '湖畔庭院',   // 同上「庭院」
  };
  for (const [type, value] of Object.entries(cases)) {
    const masked = buildMasked(type, value, v.ensureCode(type, value));
    const body = masked.slice(0, masked.indexOf('〔'));
    // 占位符号（省略号/星号/孤字「某」）之外必须还有可读内容：
    // 尾段数字、姓氏、类型词、层级词或机构后缀至少其一
    const bad = body === '……' || body === '……某' || body === '某' || body === '******';
    assert.ok(!bad, `${type} 屏蔽值退化为纯占位形态: ${masked}`);
  }
  // 「广场/庭院」类地址应给出层级词
  assert.strictEqual(buildMasked('address', '人民广场', 'x0').startsWith('某广场〔地址·'), true);
  assert.strictEqual(restoreText(buildMasked('address', '湖畔庭院', v.ensureCode('address', '湖畔庭院')), v).text, '湖畔庭院');
});

test('泄漏断言：全类型屏蔽后原值零残留（消息截断）', () => {
  const t = '原告陈阿满，手机 13812345678，身份证 330106199001015670，卡号 6222020200112233456，'
    + '护照E12345678，车牌粤A12345，执业证号 14401202080123456，案号（2020）粤0882民初1234号。';
  const v = new Vault();
  const { masked, items } = maskText(t, v);
  assert.ok(items.length >= 8, `应检出足够实体: ${items.length}`);
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.value)) continue;
    seen.add(it.value);
    assertNoLeak(masked, it.value, `[${it.type}]`);
  }
});
