'use strict';
/**
 * 中文实体检测：只使用结构，不使用具体实体黑白名单。
 *
 * 1. 姓名只由身份字段、人称前缀、人口学属性、表格相邻块确认；
 * 2. 人称候选至少复现三次，且左右上下文均不唯一，才可确认；
 * 3. 地址必须含道路、门牌、楼栋、村组等居住要素；
 * 4. 机构必须有机构后缀、至少 6 字，并排除数量泛指和国家总部形态；
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
].sort((a, b) => b.length - a.length);

const ORG_SUFFIX_RE = new RegExp(ORG_SUFFIXES.join('|'), 'g');
const ORG_TAIL_RE = new RegExp(`(?:${ORG_SUFFIXES.join('|')})$`);
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
          && (PHYSICAL_END_RE.test(after) || !after);
        const candidate = { start, end, value, raw };
        if (listClosed || physicallyClosed || demographicClosed || crimeClosed) confirmed.push(candidate);
        else if (!colon && len === 3 && personMarked) ambiguous.push(candidate);
      }
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

/* ---------------- 地址：居住要素是必要条件 ---------------- */

const ADDRESS_GUIDE_RE = /(?:户籍所在地及住址|户籍所在地|经常居住地|户籍地址|户籍地|住所地|居住地|暂住地|现住址|通讯地址|联系地址|家庭住址|详细地址|办公地址|家庭地址|注册地|所在地|住址|地址|籍贯|原籍|祖籍|出生地|户籍|现住|暂住|居住|家住|住于|住在|位于|坐落于|住|案发地点|案发地|发案地|现场位于|前往|途经|到达|抵达)\s*[:：]?\s*/g;
const GENERIC_ADDRESS_RE = /(?:^|[\s，,。；;、：:（）()【】\[\]在到从于往至去回])((?![在到从于往至去回])[\u4e00-\u9fa5]{2,12}(?:省|自治区|市|县|区|镇|乡|街道|村)[\u4e00-\u9fa5A-Za-z0-9#-]{0,50})/g;
// 门牌、房间等单位必须与数字连用，避免「括号、办公室」被当成居住要素。
const RESIDENTIAL_RE = /(?:大道|大街|街道|小区|花园|公寓|大厦|广场|家园|庭院|山庄|宿舍|大院|新村|车库|号楼|单元|路|街|巷|弄|村|组|队|\d+(?:号|楼|栋|幢|座|室|层|户))/g;
const ADDRESS_START_RE = /^(?:[\u4e00-\u9fa5]{2,8}(?:省|自治区|市|县|区|旗|盟|镇|乡|街道|村)|[\u4e00-\u9fa5]{2,20}(?:大道|大街|路|街|巷|弄|小区|花园|公寓|大厦|广场|家园|庭院|山庄|宿舍|大院|新村|车库))/;
const ADDRESS_PLACEHOLDER_RE = /[A-Za-z](?:省|市|县|区|镇|乡|街道|村)/;
const PURE_ADMIN_ADDRESS_RE = /^(?:[\u4e00-\u9fa5]{1,8}(?:省|自治区|市|县|区|旗|盟|镇|乡|街道))+$/;
const ADDRESS_BAD_CHAR_RE = /[的了吗呢吧啊呀嘛了着过]/;

function addressAt(text, start) {
  const match = /^[\u4e00-\u9fa5A-Za-z0-9#-]+/.exec(text.slice(start));
  if (!match) return null;
  let raw = match[0];
  const bad = ADDRESS_BAD_CHAR_RE.exec(raw);
  if (bad) raw = raw.slice(0, bad.index);
  if (!ADDRESS_START_RE.test(raw) || ADDRESS_PLACEHOLDER_RE.test(raw)) return null;

  RESIDENTIAL_RE.lastIndex = 0;
  let m;
  let end = -1;
  while ((m = RESIDENTIAL_RE.exec(raw)) !== null) end = m.index + m[0].length;
  if (end < 0) return null;
  let value = raw.slice(0, end);
  // 「石牌垌村村务」中的第二个「村」属于后词，不属于地名。
  const doubledVillage = /村村/.exec(value);
  if (doubledVillage) value = value.slice(0, doubledVillage.index + 1);
  if (value.length < 3 || PURE_ADMIN_ADDRESS_RE.test(value)) return null;
  return item('address', start, start + value.length, value, true);
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
    const admin = /(?:省|自治区|市|县|区|镇|乡|街道|村)/.exec(value);
    if (admin) {
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
// 「经/和」既可能是介词/连接词，也可能是字号（经纬/和平县），只在前方已是一个
// 完整主体、或右侧带行政区划时才当断点；否则保留在字号里，避免把机构切坏。
const PROVINCE_HEAD_RE = /北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾/;
const ORG_SUFFIX_TEST = new RegExp(ORG_SUFFIXES.join('|'));
const GENERIC_ORG_RE = /(?:[一二两三四五六七八九十几数多每各某这那该]家|[某该这那])$/;
const NATIONAL_HEADQUARTERS_RE = /^(?:中国[\u4e00-\u9fa5]{0,8}|最高)(?:银行|人民检察院|人民法院|人民政府)$/;
const ADMIN_UNIT_RE = /(?:自治区|省|市|县|区|旗|盟|镇|乡|街道|村|社区)/;

// 职务动词紧跟机构名是案卷高频句式（「仍实际负责涟水县师资培训中心」），
// 动词不切断就会吞进字号；单字断点表覆盖不了双字动词，这里按结尾窗口判断。
const ORG_ROLE_VERB_RE = /(?:负责|担任|主管|分管|兼任|任职|调任|主持|主抓)$/;
// 角色人称词的「人」同样不能吞进字号（「负责人李太白银行转账」曾得「人李太白银行」，
// 还会在重叠消解时盖掉真姓名）。「人民银行/人民医院」的「人」前面是机构专名而非角色词，不受影响。
const ORG_ROLE_PERSON_RE = /(?:被会见|会见|受援|委托诉讼代理|委托代理|法定代表|实际负责|委托|辩护|代理|被上诉|上诉|申诉|申请执行|被执行|申请|复议|被处罚|违法行为|行为|行贿|受贿|报案|被侵害|被害|被侵权|当事|同案|涉案|在场|主持|记录|调查|陪同|到庭|公诉|见证|负责|第三|证)人$/;

/** 机构左边界断点：介词「经」、连接词「和」需额外语境，不能一律吞掉或一律截断 */
function isOrgLeftBreak(text, ch, start, brandEnd, suffixEnd) {
  if (ORG_ROLE_VERB_RE.test(text.slice(Math.max(0, start - 4), start))) return true;
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
  if (ch === '和') {
    // 「A公司和B公司」是连接词；「和平/和顺/和县/北和镇」是地名或字号，不能断。
    if (/^[平县顺田]/.test(rightBrand)) return false;
    const left = text.slice(Math.max(0, start - 14), start);
    if (/[\u4e00-\u9fa5]$/.test(left) && !ORG_SUFFIX_TEST.test(left)) return false;
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

// 字号段整体由泛称学校字组成（「中小学」是并列泛称，指一类学校而非具体主体）
// 不作为机构屏蔽；真实机构字号必然含专名用字，不会全落在这个字符集内。
const GENERIC_SCHOOL_BRAND_RE = /^[中小初高学园幼]{1,8}$/;

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
    // 并列泛称（中小学幼儿园等）不识别为具体机构
    if (GENERIC_SCHOOL_BRAND_RE.test(brand)) continue;
    if (value.length < 6 || brand.length < 2) continue;
    // 短后缀机构的独立字号应简洁；长叙述只有带行政区划或上层机构时才保留。
    const anchored = ADMIN_UNIT_RE.test(brand) || ORG_SUFFIXES.some((s) => brand.includes(s));
    if (suffix.length <= 3 && brand.length > 4 && !anchored) continue;
    if (GENERIC_ORG_RE.test(brand) || NATIONAL_HEADQUARTERS_RE.test(value)) continue;
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
    it.type === 'org' && /^[和经]/.test(it.value) && PROVINCE_HEAD_RE.test(it.value.slice(1))
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
  createEntities,
  mergeEntities,
  detectEntities,
  collectEntities,
  hashName,
  validName,
};
