'use strict';
/**
 * 中文实体检测：只使用结构，不使用具体实体黑白名单。
 *
 * 1. 姓名只由身份字段、人称前缀、人口学属性、表格相邻块确认；
 * 2. 人称候选至少复现三次，且左右上下文均不唯一，才可确认；
 * 3. 地址必须含道路、门牌、楼栋、村组等居住要素；
 * 4. 机构必须有机构后缀、至少 6 字且不超过 18 字，并含 省/市/县/区/镇/村
 *    层级信息（或命中固定省市词典）；无层级信息的机构不再屏蔽；
 *    仅排除数量泛指（一家宾馆/某公司），不再排除公权力机关等类别。
 * 5. 已确认实体按原值传播，未确认候选不猜测、不屏蔽。
 */

const crypto = require('crypto');

const ORG_SUFFIXES = [
  '律师事务所', '会计师事务所', '税务师事务所', '事务所',
  '有限责任公司', '股份有限公司', '有限公司', '股份公司', '集团公司',
  '师资培训中心', '职业培训学校', '职业技能培训学校', '技术学校',
  '人民检察院', '人民法院', '村民委员会', '居民委员会',
  '社区卫生服务中心', '服务中心', '培训中心', '人民政府',
  '检察院', '法院', '公安局', '派出所', '司法所', '法庭',
  '公司', '集团', '合作社', '学校', '中学', '小学', '大学', '幼儿园',
  '工作室', '门市部', '支行', '宾馆', '酒店', '超市', '工厂',
  '银行', '医院', '中心', '村委会', '理事会', '委员会', '工会',
  '协会', '商会', '研究院', '研究所', '管理处', '管理局',
  // 常见后缀补充：行政机关 / 文教卫生 / 生活服务 / 生产场所
  '农业农村局', '市场监管局', '管理委员会', '管委会', '办事处',
  '居委会', '村委会', '疾控中心', '服务站', '供电所',
  '卫生院', '门诊部', '诊所', '药房', '药店', '福利院', '敬老院', '养老院',
  '学院', '党校', '出版社', '报社', '书社', '书店',
  '文化馆', '图书馆', '博物馆', '纪念馆', '展览馆', '体育馆',
  '旅行社', '供销社', '信用社', '基金会', '商行', '分行',
  '农场', '林场', '牧场', '印刷厂', '汽修厂', '总厂',
  '加油站', '收费站', '车管所', '汽车站', '火车站',
  '税务局', '财政局', '教育局', '民政局', '人社局', '住建局',
  '审计局', '水务局', '烟草局', '邮政局', '海关',
  '饭店', '酒楼', '餐厅', '影院', '剧院', '设计院',
].sort((a, b) => b.length - a.length);

const ORG_SUFFIX_RE = new RegExp(ORG_SUFFIXES.join('|'), 'g');
const ORG_TAIL_RE = new RegExp(`(?:${ORG_SUFFIXES.join('|')})$`);

/* ---------------- 机构行政层级：统一「某X……后缀」屏蔽的前提 ---------------- */

// 按后缀表取最长命中（表已按长度降序），供层级判定剥出字号。
function findOrgSuffixOf(value) {
  return ORG_SUFFIXES.find((s) => value.endsWith(s)) || '';
}

// 层级字：字号里出现 省/市/县/区/镇/村 即按该层级屏蔽（取最末次出现，
// 「江苏省淮安市涟水县…」取县）；不含层级字时按固定词典兜底：
// 直辖市/省会/主要城市 → 某市（南京），省份全名 → 某省（江西）；
// 两者皆无的机构不再按机构屏蔽。
const ORG_LEVEL_SCAN_RE = /[省市县区镇村]/g;
const ORG_CITY_RE = /(?:北京|天津|上海|重庆|石家庄|太原|呼和浩特|沈阳|长春|哈尔滨|南京|杭州|合肥|福州|南昌|济南|郑州|武汉|长沙|广州|南宁|海口|成都|贵阳|昆明|拉萨|西安|兰州|西宁|银川|乌鲁木齐|深圳|苏州|青岛|大连|厦门|宁波|无锡|佛山|东莞|珠海|温州|常州|南通|烟台|潍坊|泉州|漳州|绍兴|嘉兴|金华|台州|中山|惠州|汕头|湛江|江门|湖州|洛阳|襄阳|宜昌|唐山|保定|徐州|扬州|镇江|盐城|淮安|连云港|临沂|济宁|淄博|威海|九江|赣州|宜春|衡阳|株洲|岳阳|常德)/;
const ORG_PROVINCE_RE = /(?:河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾)/;

function orgLevelOf(value) {
  const s = String(value || '');
  const suffix = findOrgSuffixOf(s);
  const brand = suffix ? s.slice(0, s.length - suffix.length) : s;
  ORG_LEVEL_SCAN_RE.lastIndex = 0;
  let m;
  let level = '';
  while ((m = ORG_LEVEL_SCAN_RE.exec(brand)) !== null) level = m[0];
  if (level) return level;
  if (ORG_CITY_RE.test(brand)) return '市';
  if (ORG_PROVINCE_RE.test(brand)) return '省';
  return '';
}
const HAN_RE = /^[\u4e00-\u9fa5]+$/;
const NAME_RE = /^[\u4e00-\u9fa5]{2,4}$/;
const NAME_BAD_CHAR_RE = /[的了吗呢吧啊呀嘛了着过不没]/;
const NAME_ROLE_TAIL_RE = /[人员者师长犯告象方罪]$/;
const ADMIN_TAIL_RE = /(?:省|自治区|自治州|地区|市|区|县|旗|盟|镇|乡|街道|苏木|村|社区)$/;
const ADMIN_FOLLOW_RE = /^(?:省|自治区|自治州|地区|市|区|县|旗|盟|镇|乡|街道|苏木|村|社区)/;
const PHYSICAL_END_RE = /[，,。；;、：:（）()\s]/;
const VERB_USE_AFTER_RE = /[了着过]/;

function validName(value) {
  return NAME_RE.test(value)
    && !NAME_BAD_CHAR_RE.test(value)
    && !NAME_ROLE_TAIL_RE.test(value)
    && !ADMIN_TAIL_RE.test(value)
    && !ORG_TAIL_RE.test(value);
}

function item(type, start, end, value, confident) {
  return { type, start, end, value, confident: confident !== false };
}

function createEntities() {
  return { name: new Set(), org: new Set(), address: new Set() };
}

function copyInto(target, source) {
  for (const type of ['name', 'org', 'address']) {
    const values = source && source[type];
    if (!values) continue;
    for (const value of values) if (value) target[type].add(value);
  }
  return target;
}

function mergeEntities(...sources) {
  const out = createEntities();
  for (const source of sources) copyInto(out, source);
  return out;
}

function knownFromOptions(options = {}) {
  const known = mergeEntities(options.knownEntities);
  if (options.knownNames) for (const v of options.knownNames) known.name.add(v);
  if (options.knownPlaces) for (const v of options.knownPlaces) known.address.add(v);
  return known;
}

function hashName(name) {
  return crypto.createHash('sha256').update('maskname\x00' + String(name || '')).digest('hex');
}

/* ---------------- 姓名：三种身份结构位 ---------------- */

// 人称前缀只按词尾形态识别，不枚举具体角色。前缀内部允许空白，
// 以兼容「审　判　长　张三」这类排版；角色后的序号和括注不属于姓名。
const ROLE_PREFIX_RE = /[\u4e00-\u9fa5](?:[\t \u3000]*[\u4e00-\u9fa5]){0,10}[\t \u3000]*(?:人|员|者|师|长|告|象)[\t \u3000]*(?:[一二三四五六七八九十\d]{1,2})?[\t \u3000]*(?:[（(][^）)\n]{0,10}[）)])?[\t \u3000]*[:：]?[\t \u3000]*/g;
const NAME_FIELD_RE = /(?:姓名|名字)\s*[:：]\s*/g;
const DEMOGRAPHIC_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]])([\u4e00-\u9fa5]{2,4})(?=\s*[，,]\s*(?:男|女|\d{1,3}\s*岁|\d{2,4}\s*年[^，,。]{0,20}出生|公民身份号码|居民身份号码|身份号码|身份证号码))/g;
const CLOSED_NAME_LIST_RE = /^、[\u4e00-\u9fa5]{2,3}(?:、[\u4e00-\u9fa5]{2,3})*(?:等人|[二两三四五六七八九十\d]{1,2}人)/;
// 受贿类犯罪动词紧跟人称候选：legal 案卷里「负责人张罗贿赂14万元」的
// 「张罗」只能是姓名（动词「张罗」不可能带「贿赂」宾语+金额），直接确认。
const CRIME_FOLLOW_RE = /^(?:贿赂|受贿|行贿|索贿|贪污|挪用|侵占|私分|诈骗)/;

/* ---------------- 字段行嵌套角色词：「合议庭成员：审判员李舟」 ---------------- */

// 冒号字段行内、嵌套角色词后的短姓名与主扫描共用一组防误遮守卫：
// 审判员出庭/书记员记录/证人：到庭是动词短语，附：证人名单是名册短语，
// 在记录/已到庭以句首功能字开头——它们与「角色词+姓名」结构同形，一律不确认。
const PHRASE_HEAD_BAD_RE = /^[在已正将要该各均皆无每某]/;
const PHRASE_VERB_BAD_RE = /(?:出庭|到庭|记录|回避|缺席|签名|告知|会见|述职|值庭|阅卷|参与|参加|陪同|陈述|答辩|举证|质证|宣读|讯问|发问|作证|签字|盖章|捺印|到场|到案|在逃|出示|出具|展示|提供|提交|调取|负责|担任|主管|分管|兼任|任职|调任|主持|主抓|名单|名册|花名|登记|签到)$/;
const PHRASE_TAIL_BAD_RE = /[册表簿单页栏]$/;

// 字段作用域止于句末标点/换行；段间以顿号、逗号、空白分隔
//（「审判员李舟、人民陪审员王五」「审判员李舟 审判员王五」）。
const NEST_SCOPE_END = '。？！；\n\r';
const NEST_SEG_BREAK = new Set(['、', '，', ',', ' ', '\t', '\u3000']);

/** 在冒号字段作用域内按「嵌套角色词（≥2 字）+ 2~3 字整段姓名」成对解析 */
function scanNestedPairs(text, from, confirmed) {
  let end = from;
  while (end < text.length && !NEST_SCOPE_END.includes(text[end])) end++;
  let i = from;
  while (i < end) {
    while (i < end && NEST_SEG_BREAK.has(text[i])) i++;
    const segStart = i;
    while (i < end && !NEST_SEG_BREAK.has(text[i])) i++;
    // 角色词=段内以尾字结束的前缀（≥2 字）；余段 2~3 字整段为姓名候选。
    // 「王告石」类姓名在尾字后余段不足 2 字，不会被拆错。
    for (let j = i - 1; j >= segStart + 2; j--) {
      if (!/[人员者师长告象]/.test(text[j - 1])) continue;
      const value = text.slice(j, i);
      if (value.length < 2 || value.length > 3) continue;
      if (!validName(value) || value === '姓名' || value === '名字') continue;
      if (PHRASE_HEAD_BAD_RE.test(value)) continue;
      if (value.length === 2 && PHRASE_VERB_BAD_RE.test(value)) continue;
      if (value.length === 3 && PHRASE_TAIL_BAD_RE.test(value)) continue;
      confirmed.push({ start: j, end: i, value, raw: value });
      break;
    }
  }
}

function roleCandidates(text) {
  const confirmed = [];
  const ambiguous = [];
  const scan = (re, field) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const prefix = m[0];
      const compact = prefix.replace(/[\s：:（）()]/g, '');
      // 「原告方 / 被告方」是集合指代，不是等待填写姓名的字段。
      if (/(?:告|人|犯|象|双|各|一|二|两|三|四|五|六|七|八|九|十|多)方(?:[一二三四五六七八九十\d]{1,2})?$/.test(compact)) continue;
      const start = m.index + prefix.length;
      const run = /^[\u4e00-\u9fa5]+/.exec(text.slice(start));
      if (!run) continue;
      const raw = run[0];
      const colon = field || /[:：]/.test(prefix);
      const formatted = /[\t \u3000]/.test(prefix.replace(/[:：]/g, ''));
      const personMarked = /被[\u4e00-\u9fa5]{0,4}人$/.test(compact);
      for (let len = 2; len <= Math.min(4, raw.length); len++) {
        const value = raw.slice(0, len);
        if (!validName(value) || value === '姓名' || value === '名字') continue;
        const end = start + len;
        const after = text[end] || '';
        if (VERB_USE_AFTER_RE.test(after) || ADMIN_FOLLOW_RE.test(text.slice(end))) continue;
        const wholeRun = len === raw.length;
        const demographicClosed = wholeRun && /^\s*[，,]\s*(?:男|女|\d{1,3}\s*岁|\d{2,4}\s*年[^，,。]{0,20}出生|公民身份号码|居民身份号码|身份号码|身份证号码)/.test(text.slice(end));
        // 紧跟犯罪动词视为案卷叙述中的行为人姓名，长短候选均可确认。
        const crimeClosed = CRIME_FOLLOW_RE.test(text.slice(end));
        // 普通角色字段只直接确认 2–3 字；四字姓名须由「姓名」字段或人口学属性确认。
        const lengthClosed = len <= 3 || field || demographicClosed;
        const listClosed = lengthClosed && wholeRun && after === '、'
          && (colon || CLOSED_NAME_LIST_RE.test(text.slice(end)));
        const physicallyClosed = lengthClosed && wholeRun && (colon || formatted)
          && (PHYSICAL_END_RE.test(after) || !after)
          && !PHRASE_HEAD_BAD_RE.test(value)
          && !(value.length === 2 && PHRASE_VERB_BAD_RE.test(value))
          && !(value.length === 3 && PHRASE_TAIL_BAD_RE.test(value));
        const candidate = { start, end, value, raw };
        if (listClosed || physicallyClosed || demographicClosed || crimeClosed) confirmed.push(candidate);
        else if (!colon && len === 3 && personMarked) ambiguous.push(candidate);
      }
      // 冒号字段行的嵌套角色词（「合议庭成员：审判员李舟」）：嵌套处无排版边界，
      // 主扫描候选被角色尾字拒绝；在字段作用域内按「角色词+短姓名」成对解析。
      if (colon) scanNestedPairs(text, m.index + prefix.length, confirmed);
    }
  };
  scan(ROLE_PREFIX_RE, false);
  scan(NAME_FIELD_RE, true);
  return { confirmed, ambiguous };
}

function demographicNames(text) {
  const out = [];
  DEMOGRAPHIC_RE.lastIndex = 0;
  let m;
  while ((m = DEMOGRAPHIC_RE.exec(text)) !== null) {
    const value = m[1];
    if (!validName(value)) continue;
    const start = m.index + m[0].length - value.length;
    out.push({ start, end: start + value.length, value });
  }
  return out;
}

function detectLocalNames(text) {
  const role = roleCandidates(text);
  const items = [...role.confirmed, ...demographicNames(text)]
    .map((c) => item('name', c.start, c.end, c.value, true));
  return { items, ambiguous: role.ambiguous };
}

function isPersonTableLabel(value) {
  const compact = String(value || '').replace(/[\s：:（）()]/g, '')
    .replace(/[一二三四五六七八九十\d]{1,2}$/, '');
  return compact === '姓名' || compact === '名字'
    || (/^[\u4e00-\u9fa5]{2,16}(?:人|员|者|师|长|犯|告|象|方)$/.test(compact)
      && !/(?:告|人|犯|象)方$/.test(compact));
}

/* ---------------- 地址：居民身份证格式（行政区划链 + 落点要素） ---------------- */

const ADDRESS_GUIDE_RE = /(?:户籍所在地及住址|户籍所在地|经常居住地|户籍地址|户籍地|住所地|居住地|暂住地|现住址|通讯地址|联系地址|家庭住址|详细地址|办公地址|家庭地址|注册地|所在地|住址|地址|籍贯|原籍|祖籍|出生地|户籍|现住|暂住|居住|家住|住于|住在|位于|坐落于|住|案发地点|案发地|发案地|现场位于|前往|途经|到达|抵达)\s*[:：]?\s*/g;

// 行政区划链：按 省 → 市 → 县/区 → 乡镇/街道 → 村/社区 顺序逐级可选解析。
// 名称段须为 1~8 位纯汉字且不含行政区划后缀字与泛指代词，
// 防止叙述前缀（「其在浙江」「全村共有」）被当成地名组成部分。
const ADMIN_TIERS = [
  { suffixes: ['自治区', '省'], level: '省' },
  { suffixes: ['自治州', '地区', '盟', '市'], level: '市' },
  { suffixes: ['区', '县', '旗'], level: '' },
  { suffixes: ['街道', '苏木', '镇', '乡'], level: '' },
  { suffixes: ['社区', '嘎查', '村'], level: '' },
];
const ADMIN_NAME_RE = /^[\u4e00-\u9fa5]{1,8}$/;
const ADMIN_NAME_BAD_RE = /[省市县区旗盟镇乡村全本我你该各每这那某]/;
// 落点要素：小区/道路/村组类为自由单位；门牌楼栋类须紧邻数字（防「括号、办公室」）。
const ADDR_LEAF_RE = /(?:小区|花园|公寓|大厦|广场|家园|庭院|山庄|宿舍|大院|新村|车库|胡同|大道|大街|路|街|巷|弄|组|队|单元|号楼|栋|幢|座|楼|号|室|层|户|院)/g;
const ADDR_DOOR_RE = /(?:单元|号楼|栋|幢|座|楼|号|室|层|户|院)/;
const ADMIN_SUFFIX_SEARCH_RE = /(?:自治区|自治州|街道|社区|地区|省|市|盟|县|区|旗|苏木|镇|乡|嘎查|村)/;
const ADDRESS_BAD_CHAR_RE = /[的了吗呢吧啊呀嘛了着过]/;
const GENERIC_ADDRESS_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]在到从于往至去回])((?![在到从于往至去回])[\u4e00-\u9fa5A-Za-z0-9#-]{3,60})/g;

/** 解析行政区划链：返回链尾位置、最高层级与末级所在档位；level 为空表示无层级 */
function scanAdminChain(raw) {
  let i = 0;
  let level = '';
  let lastTier = -1;
  for (let t = 0; t < ADMIN_TIERS.length; t++) {
    const tier = ADMIN_TIERS[t];
    let bestEnd = -1;
    let bestLevel = '';
    for (const suf of tier.suffixes) {
      const idx = raw.indexOf(suf, i);
      if (idx < 0 || idx - i > 8) continue;
      const name = raw.slice(i, idx);
      if (!ADMIN_NAME_RE.test(name) || ADMIN_NAME_BAD_RE.test(name)) continue;
      const end = idx + suf.length;
      if (bestEnd < 0 || end <= bestEnd) { bestEnd = end; bestLevel = tier.level || suf; }
    }
    if (bestEnd >= 0) { i = bestEnd; if (!level) level = bestLevel; lastTier = t; }
  }
  return { i, level, lastTier };
}

/** 落点要素右边界：最后一个合法落点单位（门牌类须紧邻数字）的结束位置 */
function leafEndAt(raw, from) {
  const rest = raw.slice(from);
  if (!rest) return -1;
  let end = -1;
  ADDR_LEAF_RE.lastIndex = 0;
  let m;
  while ((m = ADDR_LEAF_RE.exec(rest)) !== null) {
    if (ADDR_DOOR_RE.test(m[0]) && !/[0-9]/.test(rest[m.index - 1] || '')) continue;
    end = m.index + m[0].length;
  }
  return end;
}

/** 「地址值 → 最高行政层级」：屏蔽形态「某X……尾1」与还原修饰共用 */
function addressLevelOf(value) {
  return scanAdminChain(String(value || '')).level;
}

function addressAt(text, start) {
  const run = /^[\u4e00-\u9fa5A-Za-z0-9#-]+/.exec(text.slice(start));
  if (!run) return null;
  let raw = run[0];
  const bad = ADDRESS_BAD_CHAR_RE.exec(raw);
  if (bad) raw = raw.slice(0, bad.index);
  const chain = scanAdminChain(raw);
  if (!chain.level) return null;
  // 落点要素：链后须有道路/门牌/小区等单位；
  // 仅当链止于村/社区档位时允许以村/社区收尾（如「雷州市北和镇石牌垌村」）。
  let end = leafEndAt(raw, chain.i);
  if (end >= 0) end += chain.i;
  else if (chain.lastTier === 4) end = chain.i;
  if (end < 3) return null;
  return item('address', start, start + end, raw.slice(0, end), true);
}

function detectAddresses(text) {
  const out = [];
  const guides = [];
  ADDRESS_GUIDE_RE.lastIndex = 0;
  let m;
  while ((m = ADDRESS_GUIDE_RE.exec(text)) !== null) {
    const start = m.index + m[0].length;
    guides.push({ from: m.index, to: start });
    const hit = addressAt(text, start);
    if (hit) out.push(hit);
  }
  GENERIC_ADDRESS_RE.lastIndex = 0;
  while ((m = GENERIC_ADDRESS_RE.exec(text)) !== null) {
    let value = m[1];
    let start = m.index + m[0].length - value.length;
    // 引导路径已经识别；通用路径若包含同一引导词，跳过这个更长候选。
    if (guides.some((g) => start <= g.from && g.from < start + value.length)) continue;
    // 正则从最左侧起配时可能带入叙述；首个行政区划前的最后位置字才是左边界。
    const admin = ADMIN_SUFFIX_SEARCH_RE.exec(value);
    if (admin && admin.index > 0) {
      const prefix = value.slice(0, admin.index);
      let cut = -1;
      for (const ch of '在到从于往至去回') cut = Math.max(cut, prefix.lastIndexOf(ch));
      if (cut >= 0) { start += cut + 1; value = value.slice(cut + 1); }
    }
    const hit = addressAt(text, start);
    if (hit) out.push(hit);
  }
  return out;
}

/* ---------------- 机构：后缀 + 长度 + 非泛指 ---------------- */

// 只含功能字/介词的断点；不把「和、同、也、交」等可能属于字号的字当断点。
const ORG_LEFT_BREAK = new Set([...'的了着过是在于以由向从为即给我你他她它您咱月初底旬收受送赠']);
// 双字句首介词是结构断点，不能吞进机构字号（「根据红日建材公司」
// 应得到「红日建材公司」，介词不进字号）。
const ORG_PREP_RE = /(?:根据|依据|按照|依照)$/;
// 「经/和」既可能是介词/连接词，也可能是字号（经纬/和平县），只在前方已是一个
// 完整主体、或右侧带行政区划时才当断点；否则保留在字号里，避免把机构切坏。
const PROVINCE_HEAD_RE = /北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾/;
const ORG_SUFFIX_TEST = new RegExp(ORG_SUFFIXES.join('|'));
const GENERIC_ORG_RE = /(?:[一二两三四五六七八九十几数多每各某这那该]家|[某该这那])$/;
const ADMIN_UNIT_RE = /(?:自治区|省|市|县|区|旗|盟|镇|乡|街道|村|社区)/;

// 职务动词紧跟机构名是案卷高频句式（「仍实际负责涟水县师资培训中心」），
// 动词不切断就会吞进字号；单字断点表覆盖不了双字动词，这里按结尾窗口判断。
const ORG_ROLE_VERB_RE = /(?:负责|担任|主管|分管|兼任|任职|调任|主持|主抓)$/;
// 出示/出具类叙述动词同样不能吞进字号（「出示红日建材有限公司」曾整体入字号，
// 前2取到「出示」而显示为「出示****公司」）。这些词只作动作，不作机构字号。
const ORG_NARRATION_VERB_RE = /(?:出示|出具|展示|提供|提交|调取)$/;
// 角色人称词的「人」同样不能吞进字号（「负责人李太白银行转账」曾得「人李太白银行」，
// 还会在重叠消解时盖掉真姓名）。「人民银行/人民医院」的「人」前面是机构专名而非角色词，不受影响。
const ORG_ROLE_PERSON_RE = /(?:被会见|会见|受援|委托诉讼代理|委托代理|法定代表|实际负责|委托|辩护|代理|被上诉|上诉|申诉|申请执行|被执行|申请|复议|被处罚|违法行为|行为|行贿|受贿|报案|被侵害|被害|被侵权|当事|同案|涉案|在场|主持|记录|调查|陪同|到庭|公诉|见证|负责|第三|证)人$/;

/** 机构左边界断点：介词「经」、连接词「和」需额外语境，不能一律吞掉或一律截断 */
function isOrgLeftBreak(text, ch, start, brandEnd, suffixEnd) {
  if (ORG_ROLE_VERB_RE.test(text.slice(Math.max(0, start - 4), start))) return true;
  if (ORG_NARRATION_VERB_RE.test(text.slice(Math.max(0, start - 4), start))) return true;
  if (ORG_PREP_RE.test(text.slice(Math.max(0, start - 4), start))) return true;
  // 「负责人/辩护人/证人…」的人后紧跟的只能是姓名或叙述，不是机构字号；
  // 窗口取 14 字覆盖「委托诉讼代理人/申请执行人」等长角色词
  if (ch === '人' && ORG_ROLE_PERSON_RE.test(text.slice(Math.max(0, start - 14), start))) return true;
  // 「2021年中小学…」的年份前缀不是字号；「年例/年夜」这类字号前一字是汉字，不受影响
  if (ch === '年' && /[0-9]/.test(text[start - 2] || '')) return true;
  if (ORG_LEFT_BREAK.has(ch) || (ch === '系' && text[start] !== '统')) return true;
  const rightBrand = text.slice(start, brandEnd);
  if (ch === '经') {
    // 「经××局/经江苏…」是介词；「经纬/经济/经开区」是字号或地名缩写，不能断。
    if (/^开[发区]|^纬|^济|^贸|^技/.test(rightBrand)) return false;
    return PROVINCE_HEAD_RE.test(rightBrand) || ADMIN_UNIT_RE.test(rightBrand);
  }
  if (ch === '和' || ch === '与') {
    // 「A公司和B公司」是连接词；「和平/和顺/和县/北和镇」是地名或字号，不能断。
    if (/^[平县顺田]/.test(rightBrand)) return false;
    const left = text.slice(Math.max(0, start - 14), start);
    if (/[\u4e00-\u9fa5]$/.test(left) && !ORG_SUFFIX_TEST.test(left)) return false;
    // 右侧须是一段完整主体（≥6 字）才断开；「北和镇卫生院」的「和」只是
    // 地名用字，右侧残段（镇卫生院）过短，继续向前回溯到真正的边界。
    if (text.slice(start, suffixEnd).length < 6) return false;
    return ADMIN_UNIT_RE.test(rightBrand)
      || PROVINCE_HEAD_RE.test(rightBrand)
      || ORG_SUFFIX_TEST.test(text.slice(start + 1, suffixEnd));
  }
  return false;
}

function suffixEndingAt(text, end) {
  for (const suffix of ORG_SUFFIXES) {
    if (end >= suffix.length && text.slice(end - suffix.length, end) === suffix) return true;
  }
  return false;
}

// // 字号段整体由泛称学校字组成（「中小学」是并列泛称）——不再单独排除，
// 由「须含省/市/县/区/镇/村层级信息」这条统一前提兜住。

function detectOrgs(text) {
  const out = [];
  const shortAliases = new Set();
  const aliasRe = /[（(]\s*以下简称\s*([\u4e00-\u9fa5]{2,12})\s*[）)]/g;
  let aliasMatch;
  while ((aliasMatch = aliasRe.exec(text)) !== null) {
    const alias = aliasMatch[1];
    if (alias.length < 6 && ORG_SUFFIXES.some((s) => alias.endsWith(s))) shortAliases.add(alias);
  }
  ORG_SUFFIX_RE.lastIndex = 0;
  let m;
  while ((m = ORG_SUFFIX_RE.exec(text)) !== null) {
    const suffix = m[0];
    const brandEnd = m.index;
    let start = brandEnd;
    let adjacentToOrg = false;
    const min = Math.max(0, brandEnd - 24);
    while (start > min) {
      const ch = text[start - 1];
      // 短括注（「盛景（南京）智能装备股份有限公司」）是字号组成部分：
      // 括注内为 ≤8 字纯专名时跨过后继续回溯；「（以下简称××）」不跨。
      if (ch === '）' || ch === ')') {
        const open = ch === '）' ? '（' : '(';
        const openIdx = text.lastIndexOf(open, start - 1);
        if (openIdx >= min) {
          const inner = text.slice(openIdx + 1, start - 1);
          if (inner.length >= 1 && inner.length <= 8
            && /^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(inner)
            && !/简称|以下/.test(inner)) {
            start = openIdx;
            continue;
          }
        }
        break;
      }
      // 「系」可作系动词，但「系统」是常见字号组成部分；经/和需语境判断。
      if (!/[\u4e00-\u9fa5]/.test(ch) || isOrgLeftBreak(text, ch, start, brandEnd, m.index + suffix.length)) break;
      if (suffix === '公司' && suffixEndingAt(text, start)) { adjacentToOrg = true; break; }
      start--;
    }
    // 前一个主体后的短「公司」通常是简称；银行→支行、法院→法庭则是层级机构。
    if (adjacentToOrg && suffix === '公司') continue;
    let brand = text.slice(start, brandEnd);
    // 若首个行政区划单元前混入长叙述，只从该单元稳定的二字地名核心重新起头。
    // 正常「江苏省淮安市…」首单元已经很短，不会被裁切。
    const admin = ADMIN_UNIT_RE.exec(brand);
    if (admin && admin.index > 4) {
      start += admin.index - 2;
      brand = text.slice(start, brandEnd);
    }
    const value = brand + suffix;
    const end = m.index + suffix.length;
    // 已声明的短简称不因前面连带叙述字而扩展成新机构；带行政区划的完整名称除外。
    const narrativeAlias = [...shortAliases].some((alias) => {
      if (!alias.endsWith(suffix) || !value.endsWith(alias) || value === alias) return false;
      return !ADMIN_UNIT_RE.test(value.slice(0, -alias.length));
    });
    if (narrativeAlias) continue;
    if (value.length < 6 || brand.length < 2) continue;
    if (value.length > 18) continue; // 机构全名一般不超过 18 字
    // 数量泛指（一家宾馆/某公司）仍不是具体主体；其余类别（公权力机关、
    // 知名银行、并列泛称等）不再排除——有层级信息就按机构屏蔽。
    if (GENERIC_ORG_RE.test(brand)) continue;
    // 统一形态前提：字号须含 省/市/县/区/镇/村（或命中固定省市词典）。
    // 该前提同时兜住了「危害法庭安全」这类叙述残段——它们不含层级信息。
    if (!orgLevelOf(value)) continue;
    out.push(item('org', start, end, value, true));
  }
  return out;
}

/* ---------------- 确认实体传播 ---------------- */

function addLiteralHits(out, text, type, value) {
  if (!value || !text.includes(value)) return;
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(value, from);
    if (start < 0) break;
    out.push(item(type, start, start + value.length, value, false));
    from = start + value.length;
  }
}

function addHashNames(out, text, hashes) {
  if (!hashes || !hashes.size) return;
  for (let start = 0; start < text.length; start++) {
    if (!/[\u4e00-\u9fa5]/.test(text[start])) continue;
    for (let len = 2; len <= 4 && start + len <= text.length; len++) {
      const value = text.slice(start, start + len);
      if (!HAN_RE.test(value) || !hashes.has(hashName(value))) continue;
      out.push(item('name', start, start + len, value, false));
      break;
    }
  }
}

const LEGACY_PLACE_LEFT_BREAK = new Set([...'的在位于到从往至去回住及与和']);
function addLegacyPlaceHits(out, text, value) {
  if (!value || !text.includes(value)) return;
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(value, from);
    if (start < 0) break;
    const before = text[start - 1] || '';
    if (!before || !/[\u4e00-\u9fa5]/.test(before) || LEGACY_PLACE_LEFT_BREAK.has(before)) {
      out.push(item('address', start, start + value.length, value, false));
    }
    from = start + value.length;
  }
}

function detectEntities(text, options = {}) {
  const source = String(text || '');
  const toggles = options.toggles || {};
  const out = [];
  if (toggles.name !== false) out.push(...detectLocalNames(source).items);
  if (toggles.address !== false) out.push(...detectAddresses(source));
  if (toggles.org !== false) out.push(...detectOrgs(source));

  // 新实体表按完整原值传播；旧 knownPlaces 仅走带左边界的兼容路径。
  const known = mergeEntities(options.knownEntities);
  if (options.knownNames) for (const v of options.knownNames) known.name.add(v);
  for (const type of ['name', 'org', 'address']) {
    if (toggles[type] === false) continue;
    for (const value of known[type]) addLiteralHits(out, source, type, value);
  }
  if (toggles.address !== false && options.knownPlaces) {
    for (const value of options.knownPlaces) addLegacyPlaceHits(out, source, value);
  }
  if (toggles.name !== false) addHashNames(out, source, options.knownNameHashes);
  // 全案卷传播会放大「和江苏…公司」这类吞了连接词的伪机构：
  // 机构名以经/和开头且紧跟省级地名时，几乎必为边界错误，直接丢弃（含传播项）。
  return out.filter((it) => !(
    it.type === 'org'
      && /^[和经]/.test(it.value) && PROVINCE_HEAD_RE.test(it.value.slice(1))
  ));
}

function candidateStats(corpus, value) {
  const previous = new Set();
  const next = new Set();
  let count = 0;
  let from = 0;
  while (from <= corpus.length) {
    const index = corpus.indexOf(value, from);
    if (index < 0) break;
    count++;
    previous.add(corpus[index - 1] || '\n');
    next.add(corpus[index + value.length] || '\n');
    from = index + value.length;
  }
  return { count, previous, next };
}

function confirmCoordinatedNames(blocks, known) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      for (const name of [...known.name]) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
          new RegExp(`${escaped}[、与和]([\\u4e00-\\u9fa5]{2,3})(?=[二两三四五六七八九十\\d]{1,2}人|等(?:人)?|[，,。；;、：:\\s（）()]|$)`, 'g'),
          new RegExp(`(?:^|[\\s，,。；;、：:（）()])([\\u4e00-\\u9fa5]{2,3})[、与和]${escaped}(?=[二两三四五六七八九十\\d]{1,2}人|等(?:人)?|[，,。；;、：:\\s（）()]|$)`, 'g'),
        ];
        for (const re of patterns) {
          let m;
          while ((m = re.exec(block)) !== null) {
            const value = m[1];
            if (!validName(value) || known.name.has(value)) continue;
            known.name.add(value);
            changed = true;
          }
        }
      }
    }
  }
}

/**
 * 第一遍：从一组逻辑块（段落/单元格/文件文本）收集全案卷实体。
 * 相邻块用于「受援人」→「李贺」这类表格结构；歧义候选必须复现且
 * 右侧上下文至少两种，避免把「张罗商议」整体误当姓名。
 */
function collectEntities(input, options = {}) {
  const blocks = (Array.isArray(input) ? input : String(input || '').split(/\r?\n/))
    .map((v) => String(v || '')).filter((v) => v.trim());
  const known = knownFromOptions(options);
  const ambiguous = [];

  for (const block of blocks) {
    const local = detectLocalNames(block);
    for (const it of local.items) known.name.add(it.value);
    ambiguous.push(...local.ambiguous);
    for (const hit of detectAddresses(block)) known.address.add(hit.value);
    for (const hit of detectOrgs(block)) known.org.add(hit.value);
  }

  for (let i = 1; i < blocks.length; i++) {
    const value = blocks[i].trim();
    if (isPersonTableLabel(blocks[i - 1]) && validName(value)) known.name.add(value);
  }

  // 先展开闭合并列名单，再用已知姓名排除「李贺作」这类向右扩展的伪候选。
  confirmCoordinatedNames(blocks, known);

  const corpus = blocks.join('\n');
  const stats = new Map();
  for (const c of ambiguous) {
    if (!stats.has(c.value)) stats.set(c.value, candidateStats(corpus, c.value));
  }
  const eligible = new Set();
  for (const c of ambiguous) {
    const s = stats.get(c.value);
    // 自由语境只接受至少三次复现、左右上下文均不唯一的三字候选。
    if (c.value.length !== 3 || !s || s.count < 3 || s.previous.size < 2 || s.next.size < 2) continue;
    if ([...known.name].some((name) => name !== c.value
      && (name.startsWith(c.value) || c.value.startsWith(name)))) continue;
    eligible.add(c.value);
  }
  // 同一位置若有多个候选，保留右侧上下文最丰富者；仍并列则不猜。
  const byPosition = new Map();
  for (const c of ambiguous) {
    if (!eligible.has(c.value)) continue;
    const key = `${c.start}:${c.raw}`;
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(c.value);
  }
  for (const values of byPosition.values()) {
    const unique = [...new Set(values)].sort((a, b) => {
      const diversity = stats.get(b).next.size - stats.get(a).next.size;
      return diversity || b.length - a.length;
    });
    if (unique.length > 1) {
      const a = stats.get(unique[0]);
      const b = stats.get(unique[1]);
      if (a.next.size === b.next.size && unique[0].length === unique[1].length) continue;
    }
    known.name.add(unique[0]);
  }

  return known;
}

module.exports = {
  ORG_SUFFIXES,
  orgLevelOf,
  addressLevelOf,
  createEntities,
  mergeEntities,
  detectEntities,
  collectEntities,
  hashName,
  validName,
};
