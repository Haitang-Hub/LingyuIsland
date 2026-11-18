'use strict';
/**
 * 敏感信息检测器。
 * 格式类号码使用正则与校验；姓名/地址/机构统一委托 entities.js 的结构规则。
 * 性别、年龄、出生日期、民族不属于本检测器的屏蔽对象。
 */

const {
  ORG_SUFFIXES, detectEntities, hashName,
} = require('./entities');

const RE = {
  phone: /(?<![\dXx])(?:\+?86[-\s·]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g,
  idCard: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  bank: /(?<![\d\-])(?:62|60|4\d|5[1-5]|3[47]|35(?:2[89]|[3-8]))\d(?:[\s\-—－]?\d){10,18}(?![\d\-])/g,
  email: /[\u4e00-\u9fa5A-Za-z0-9._%+-]+@[\u4e00-\u9fa5A-Za-z0-9-]+(?:\.[\u4e00-\u9fa5A-Za-z0-9-]+)+/g,
  passport: /(?<![A-Za-z0-9])[EGSPD][0-9]{8}(?![0-9A-Za-z])/g,
  plate: /(?<![A-Za-z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵青藏川宁琼使领粤][A-HJ-NP-Z][A-HJ-NP-Z0-9挂学警港澳]{5,6}(?![A-Za-z0-9])/g,
  caseNo: /[（(\[【［]\s*(?:19|20)\d{2}\s*[）)\]】］]\s*[\u4e00-\u9fa5]{1,8}\s*\d{0,6}\s*[\u4e00-\u9fa5A-Za-z]{1,6}\s*\d{1,6}\s*号(?:之[一二三四五六七八九十]+)?/g,
  caseNoInline: /[（(\[【［]\s*(?:19|20)\d{2}\s*[）)\]】］]\s*[\u4e00-\u9fa5A-Za-z0-9]{1,12}\s*号(?:之[一二三四五六七八九十\d]+)?/g,
  landline: /(?<!\d)0\d{2,3}[-—\s]?\d{7,8}(?!\d)/g,
  hotline: /(?<!\d)(?:400|800)[-—\s]?\d{3}[-—\s]?\d{4}(?!\d)/g,
  imWechat: /(?:微信号|微信账号|WX号|wx号|vx号|VX号|威信号|WeChat号)\s*[:：]?\s*([A-Za-z][-_A-Za-z0-9]{5,19})/g,
  imQQ: /(?:QQ号|QQ账号|QQ)\s*[:：]?\s*([1-9]\d{4,10})(?!\d)/g,
  hkmtPermit: /(?<![A-Za-z0-9])[HM]\d{8}(?![0-9A-Za-z])/g,
  hkmtTaiwan: /台胞证\s*[:：]?\s*([1-9]\d{7})(?!\d)/g,
  uscc: /(?<![0-9A-Z])[159Y][1239]\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/g,
};

const RE_LICENSE = /(?:律师执业证号|执业证号|执业证书号|执业证|资格证号|法律职业资格证号|公证员执业证号)\s*[:：]?\s*第?\s*([A-Za-z]?\d{15,20})/g;
const RE_IDCARD_LOOSE = /(?:公民身份号码|居民身份号码|身份号码|身份证号码|身份证号|身份证|证件号码|证件号)\s*[:：]?\s*([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])/g;
const RE_BANK_KEYWORD = /(?:银行卡号|银行账号|卡号|账号|储蓄卡|借记卡|信用卡)\s*[:：]?\s*((?:\d[\s\-—－]?){12,20}\d)/g;

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
  if (opts.caseNo !== false) {
    scan(RE.caseNo, 'caseNo');
    scan(RE.caseNoInline, 'caseNo');
  }
  if (opts.bank !== false) {
    scan(RE.bank, 'bank', isValidBank, cleanBank);
    scanGrouped(RE_BANK_KEYWORD, 'bank', cleanBank);
  }
  if (opts.phone !== false) scan(RE.phone, 'phone');
  if (opts.email !== false) scan(RE.email, 'email');
  if (opts.passport !== false) scan(RE.passport, 'passport');
  if (opts.plate !== false) scan(RE.plate, 'plate');
  if (opts.landline === true) { scan(RE.landline, 'landline'); scan(RE.hotline, 'landline'); }
  if (opts.im === true) { scanGrouped(RE.imWechat, 'im'); scanGrouped(RE.imQQ, 'im'); }
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
 * 案号前缀补回：正则从括号年份起匹配，「南检刑诉[2026]Z25号」中机关简称会被留下。
 * 这里只对已检出的案号向左补回紧邻的「简称 + 类别词」，且不吞进已被识别为
 * 机构/地址/姓名的部分，避免把「临江市清河区人民检察院南检刑诉…」整体吞成案号。
 */
const CASE_PREFIX_RE = /[\u4e00-\u9fa5]{0,2}(?:检|刑|民|行|政|执|他)(?:刑诉|民诉|行诉|刑初|民初|民终|刑终|指字|刑指|检字|政发|执字|他字)$/;
function extendCasePrefixes(text, items) {
  for (const it of items) {
    if (it.type !== 'caseNo') continue;
    const before = text.slice(Math.max(0, it.start - 8), it.start);
    const m = CASE_PREFIX_RE.exec(before);
    if (!m) continue;
    const prefix = m[0].replace(/^[以在向由给经为与和及对从当被把了新的]+/, '');
    if (!prefix) continue;
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
  detect, isValidIdCard, isValidUscc, luhnValid, ORG_SUFFIXES, hashName,
};
