'use strict';
/**
 * 敏感信息检测器。
 * 格式类号码使用正则与校验；姓名/地址/机构统一委托 entities.js 的结构规则。
 * 性别、年龄、出生日期、民族不属于本检测器的屏蔽对象。
 */

const {
  ORG_SUFFIXES, detectEntities, hashName, orgLevelOf, addressLevelOf,
} = require('./entities');

const RE = {
  phone: /(?<![\dXx])(?:\+?86[-\s·]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g,
  idCard: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  bank: /(?<![\d\-])(?:62|60|4\d|5[1-5]|3[47]|35(?:2[89]|[3-8]))\d(?:[\s\-—－]?\d){10,18}(?![\d\-])/g,
  email: /[\u4e00-\u9fa5A-Za-z0-9._%+-]+@[\u4e00-\u9fa5A-Za-z0-9-]+(?:\.[\u4e00-\u9fa5A-Za-z0-9-]+)+/g,
  passport: /(?<![A-Za-z0-9])[EGSPD][0-9]{8}(?![0-9A-Za-z])/g,
  // 省份简称 + 发牌机关字母 + 序号；实务排版常在字母与序号间加间隔号/空格
  //（「粤B·88888」「粤B 88888」），分隔符属号牌书写的一部分，一并遮蔽。
  plate: /(?<![A-Za-z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵青藏川宁琼使领粤][A-HJ-NP-Z][·•.．\-－\u3000 ]?[A-HJ-NP-Z0-9挂学警港澳]{5,6}(?![A-Za-z0-9])/g,
  // 案号统一从年份括号起匹配（括号后字号/序号整体捕获，{1,16} 覆盖常见文号）；
  // 括号前缀（机关简称 / 省市简称+地市括注）由 extendCasePrefixes 向左补回。
  // 括号形态须覆盖实务排版：全角（）/半角[]/方头【】/六角〔〕（公文与检察文书
  // 的标准案号括号，如「南检刑诉〔2026〕15号」）/兼容﹝﹞。
  caseNo: /[（(\[【［〔﹝]\s*(?:19|20)\d{2}\s*[）)\]】］〕﹞]\s*[\u4e00-\u9fa5A-Za-z0-9]{1,16}\s*号(?:之[一二三四五六七八九十\d]+)?/g,
  landline: /(?<!\d)0\d{2,3}[-—\s]?\d{7,8}(?!\d)/g,
  hotline: /(?<!\d)(?:400|800)[-—\s]?\d{3}[-—\s]?\d{4}(?!\d)/g,
  imWechat: /(?:微信号|微信账号|WX号|wx号|vx号|VX号|威信号|WeChat号)\s*[:：]?\s*([A-Za-z][-_A-Za-z0-9]{5,19})/g,
  // 微信原始 ID 自带「wxid_」前缀，本身就是格式标记，无需「微信号：」标签；
  // 前缀后是大小写字母/数字/下划线/短横，不可能是普通词语，误报面极小。
  imWxid: /(?<![0-9A-Za-z_-])wxid_[0-9A-Za-z_-]{4,24}/gi,
  imQQ: /(?:QQ号|QQ账号|QQ)\s*[:：]?\s*([1-9]\d{4,10})(?!\d)/g,
  hkmtPermit: /(?<![A-Za-z0-9])[HM]\d{8}(?![0-9A-Za-z])/g,
  hkmtTaiwan: /台胞证\s*[:：]?\s*([1-9]\d{7})(?!\d)/g,
  uscc: /(?<![0-9A-Z])[159Y][1239]\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/g,
};

const RE_LICENSE = /(?:律师执业证号|执业证号|执业证书号|执业证|资格证号|法律职业资格证号|公证员执业证号)\s*[:：]?\s*第?\s*([A-Za-z]?\d{15,20})/g;
// 身份证关键词路径额外接受 15 位老身份证（2013 年前签发，旧案卷常见）；
// 裸号仍只认 18 位，避免把 15 位账号/编号误当证件号。
const RE_IDCARD_LOOSE = /(?:公民身份号码|居民身份号码|身份号码|身份证号码|身份证号|身份证|证件号码|证件号)\s*[:：]?\s*((?:[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})(?!\d))/g;
// 关键词路径：文书里常见「交易卡号为“xxxx”」「账号是 xxxx」「银行账号：（xxxx）」。
// 关键词本身即语义证据，不再要求 Luhn——实务中测试号/旧卡号校验位可能不合法，
// 但写在卡号字段里就必须遮蔽。裸号仍走严格校验（另有弱语境兜底，见 scanBankWeak）。
const RE_BANK_KEYWORD = /(?:银行结算账户|交易卡号|银行卡号|银行账号|储蓄卡号|借记卡号|信用卡号|卡号|账号|账户号)\s*(?:为|是)?\s*[:：]?\s*[“"‘'（(\[]?\s*((?:\d[\s\-—－]?){12,20}\d)/g;
// 弱语境兜底：不合法校验位的长卡号，若紧跟银行/交易/转账等语义词，也按卡号处理。
// 只覆盖 16–19 位且落在常见卡组织前缀，避免把模板号/流水号误当卡号。
const BANK_CONTEXT_RE = /(?:银行卡|卡号|账号|账户|银行|交易|转账|转帐|支付|收款|付款|消费|刷卡|储蓄|借记|信用|网银|汇款|工资|流水)/;
const BANK_BIN_RE = /^(?:62|60|4\d|5[1-5]|3[47]|35(?:2[89]|[3-8]))/;

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
const USCC_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

function isValidUscc(s) {
  if (!/^[159Y][1239]\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ci = USCC_CHARSET.indexOf(s[i]);
    if (ci < 0) return false;
    sum += ci * USCC_WEIGHTS[i];
  }
  return USCC_CHARSET[(31 - (sum % 31)) % 31] === s[17];
}

function isValidIdCard(s) {
  if (!s || s.length !== 18) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === s[17].toUpperCase();
}

function luhnValid(s) {
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (Number.isNaN(d)) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const cleanBank = (s) => String(s || '').replace(/[\s\-—－]/g, '');
function isValidBank(raw) {
  const digits = cleanBank(raw);
  return /^\d{13,19}$/.test(digits) && luhnValid(digits);
}

/** 校验位不合法、但处于银行语义语境中的卡号：补足「卡号为xxx」之外的裸号场景 */
function scanBankWeak(text, out) {
  RE.bank.lastIndex = 0;
  let m;
  while ((m = RE.bank.exec(text)) !== null) {
    if (m.index === RE.bank.lastIndex) RE.bank.lastIndex++;
    const raw = m[0];
    const digits = cleanBank(raw);
    if (isValidBank(raw) || !/^\d{16,19}$/.test(digits) || !BANK_BIN_RE.test(digits)) continue;
    const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + raw.length + 24));
    if (!BANK_CONTEXT_RE.test(ctx)) continue;
    out.push({ type: 'bank', start: m.index, end: m.index + raw.length, value: digits });
  }
}

function detectStrong(text, opts) {
  const out = [];
  const scan = (re, type, validate, normalize) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      const raw = m[0];
      if (validate && !validate(raw)) continue;
      out.push({ type, start: m.index, end: m.index + raw.length, value: normalize ? normalize(raw) : raw });
    }
  };
  const scanGrouped = (re, type, normalize) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1] == null) continue;
      const start = m.index + m[0].lastIndexOf(m[1]);
      const raw = m[1];
      out.push({ type, start, end: start + raw.length, value: normalize ? normalize(raw) : raw });
    }
  };
  if (opts.idCard !== false) {
    scan(RE.idCard, 'idCard');
    scanGrouped(RE_IDCARD_LOOSE, 'idCard');
  }
  if (opts.license !== false) scanGrouped(RE_LICENSE, 'license');
  if (opts.caseNo !== false) scan(RE.caseNo, 'caseNo');
  if (opts.bank !== false) {
    scan(RE.bank, 'bank', isValidBank, cleanBank);
    scanGrouped(RE_BANK_KEYWORD, 'bank', cleanBank);
    scanBankWeak(text, out);
  }
  if (opts.phone !== false) scan(RE.phone, 'phone');
  if (opts.email !== false) scan(RE.email, 'email');
  if (opts.passport !== false) scan(RE.passport, 'passport');
  if (opts.plate !== false) scan(RE.plate, 'plate');
  if (opts.landline === true) { scan(RE.landline, 'landline'); scan(RE.hotline, 'landline'); }
  if (opts.im === true) {
    scanGrouped(RE.imWechat, 'im');
    scan(RE.imWxid, 'im');
    scanGrouped(RE.imQQ, 'im');
  }
  if (opts.hkmt === true) { scan(RE.hkmtPermit, 'hkmt'); scanGrouped(RE.hkmtTaiwan, 'hkmt'); }
  if (opts.uscc === true) scan(RE.uscc, 'uscc', isValidUscc);
  return out;
}

const EXCLUSION_RE = [
  /(?:性别|gender)\s*[:：]?\s*(?:男|女|男性|女性|其它|其他)/gi,
  /(?:年龄|age|岁数)\s*[:：]?\s*\d{1,3}(?:\.\d+)?\s*(?:岁|周岁|岁半)?/gi,
  /\d{1,3}\s*(?:周岁|岁半|岁)/g,
  /(?:出生日期|生日|出生|birth(?:day|date)?)\s*[:：]?\s*\d{2,4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/gi,
  /民族\s*[:：]?\s*[\u4e00-\u9fa5]{1,8}/g,
];

function exclusionRanges(text) {
  const out = [];
  for (const re of EXCLUSION_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

const PRIORITY = {
  caseNo: 0, idCard: 1, license: 2, uscc: 2, bank: 3, phone: 4,
  landline: 4, passport: 5, hkmt: 5, email: 6, im: 6, plate: 7,
  org: 8, address: 9, name: 10,
};

/**
 * 案号前缀补回：正则从括号年份起匹配，「南检刑诉[2026]Z25号」中机关简称会被留下，
 * 「苏淮（涟）援刑指字【2026】…」中省市简称+地市括注也会被留下。
 * 这里只对已检出的案号向左补回紧邻的「[简称+（括注）] + 类别词」，且不吞进已被识别为
 * 机构/地址/姓名的部分，避免把「临江市清河区人民检察院南检刑诉…」整体吞成案号。
 */
// 可选「省市简称 + （地市/区县括注）」段：如 苏淮（涟）
const CASE_PREFIX_LOCALITY = '(?:[\\u4e00-\\u9fa5]{0,6}[（(][\\u4e00-\\u9fa5]{1,3}[）)])?';
const CASE_PREFIX_RE = new RegExp(
  CASE_PREFIX_LOCALITY
  + '[\\u4e00-\\u9fa5]{0,2}(?:检|刑|民|行|政|执|他)(?:刑诉|民诉|行诉|刑初|民初|民终|刑终|指字|刑指|检字|政发|执字|他字)$'
);
// 机关类别字（院/局/委/所…）不属于案号简称，前缀补回遇到它们即停。
// 机关整体不脱敏后不再有 org item 充当 blocker，这里必须自己识别边界，
// 否则「人民检察院南检刑诉…」会吞成「院南检刑诉…」。
const CASE_ORG_TAIL_RE = /^(?:人民法院|检察院|委员会|监察委|公安局|公安厅|派出所|司法局|司法厅|司法所|人民政府|中心|法院|院|局|厅|处|署|庭|所|部|委|会)/;
function extendCasePrefixes(text, items) {
  for (const it of items) {
    if (it.type !== 'caseNo') continue;
    const before = text.slice(Math.max(0, it.start - 12), it.start);
    const m = CASE_PREFIX_RE.exec(before);
    if (!m) continue;
    let prefix = m[0].replace(/^[以在向由给经为与和及对从当被把了新的]+/, '');
    // 去掉吞入的机关类别字（「院南检刑诉」→「南检刑诉」）；若整段都是类别字则不补。
    const orgTail = CASE_ORG_TAIL_RE.exec(prefix);
    if (orgTail) {
      prefix = prefix.slice(orgTail[0].length);
      if (!prefix) continue;
    }
    const prefixStart = it.start - prefix.length;
    const blockers = items.filter((o) => o !== it && o.start < it.start && o.end > prefixStart);
    if (blockers.length) {
      const coverEnd = Math.max(...blockers.map((o) => o.end));
      if (coverEnd >= it.start) continue;
      it.start = coverEnd;
    } else {
      it.start = prefixStart;
    }
    it.value = text.slice(it.start, it.end);
  }
  return items;
}

function dedupe(items) {
  const sorted = items.slice().sort((a, b) => {
    const exact = (a.start - b.start) || (a.end - b.end) || (PRIORITY[a.type] - PRIORITY[b.type]);
    if (exact) return exact;
    return a.type === b.type ? 0 : a.type.localeCompare(b.type);
  });
  const unique = [];
  for (const it of sorted) {
    const prev = unique[unique.length - 1];
    if (prev && prev.start === it.start && prev.end === it.end && prev.type === it.type) continue;
    unique.push(it);
  }
  unique.sort((a, b) => (a.start - b.start) || (PRIORITY[a.type] - PRIORITY[b.type]) || ((b.end - b.start) - (a.end - a.start)));
  const out = [];
  for (const it of unique) {
    const last = out[out.length - 1];
    if (last && it.start < last.end) {
      const better = PRIORITY[it.type] < PRIORITY[last.type]
        || (PRIORITY[it.type] === PRIORITY[last.type] && (it.end - it.start) > (last.end - last.start));
      if (better) out[out.length - 1] = it;
    } else {
      out.push(it);
    }
  }
  return out;
}

/**
 * @param {string} text
 * @param {{toggles?:Record<string,boolean>, knownEntities?:{name:Set,org:Set,address:Set},
 *   knownNames?:Set<string>, knownPlaces?:Set<string>, knownNameHashes?:Set<string>}} [options]
 */
function detect(text, options = {}) {
  const source = String(text || '');
  const toggles = {
    phone: true, idCard: true, bank: true, email: true,
    passport: true, name: true, address: true, plate: true,
    caseNo: true, license: true, org: true,
    landline: true, im: false, hkmt: false, uscc: true,
    ...(options.toggles || {}),
  };
  const items = detectStrong(source, toggles);
  items.push(...detectEntities(source, { ...options, toggles }));
  const excluded = exclusionRanges(source);
  const filtered = items.filter((it) => !excluded.some(([a, b]) => it.start >= a && it.end <= b));
  const deduped = extendCasePrefixes(source, dedupe(filtered));
  const counts = {};
  for (const it of deduped) counts[it.type] = (counts[it.type] || 0) + 1;
  return { items: deduped, counts };
}

module.exports = {
  detect, isValidIdCard, isValidUscc, luhnValid, ORG_SUFFIXES, hashName, orgLevelOf, addressLevelOf,
};
