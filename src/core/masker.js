'use strict';
/**
 * 屏蔽 / 恢复引擎（纯 JS，依赖 node 内置 crypto）
 *
 * 核心设计：屏蔽值形如  138****5678〔ab12cd〕
 *  - 前后保留部分原文，让用户“能判断出是什么内容”
 *  - 〔〕内 6~12 位十六进制编码是找回原文的钥匙：
 *    只要编码未被改动（哪怕从文件里复制到别处），都能还原出真实内容
 *  - 同一真实值在全库中永远对应同一个编码
 */

const crypto = require('crypto');
const { detect, ORG_SUFFIXES } = require('./detector');

/** 屏蔽编码格式：〔 + 6~12 位十六进制 + 〕 */
const CODE_RE = /〔([0-9a-f]{6,12})〕/g;

const ORG_SUFFIX_ALT = ORG_SUFFIXES.join('|');

const TYPE_LABEL = {
  phone: '手机号', idCard: '身份证', bank: '银行卡', email: '邮箱',
  name: '姓名', address: '住址', passport: '护照', plate: '车牌',
  caseNo: '案号', license: '执业证号', org: '机构名称',
  landline: '固定电话', im: '社交账号', hkmt: '港澳台证件', uscc: '统一社会信用代码',
};

/* ------------------------------------------------------------------ */
/* 映射库（Vault）：编码 ↔ 原文，由主进程负责加密持久化                    */
/* ------------------------------------------------------------------ */

class Vault {
  constructor() {
    this.codeMap = new Map();   // code -> { v: 原文, t: 类型 }
    this.valueMap = new Map();  // type\x00value -> code（保证同一值同一编码）
  }

  /** 为 (type,value) 取得稳定编码；碰撞时自动加长 */
  ensureCode(type, value) {
    const key = type + '\x00' + value;
    const exist = this.valueMap.get(key);
    if (exist) return exist;

    const digest = crypto.createHash('sha256').update(key).digest('hex');
    for (let len = 6; len <= 12; len += 2) {
      const code = digest.slice(0, len);
      const holder = this.codeMap.get(code);
      if (!holder) {
        this.codeMap.set(code, { v: value, t: type });
        this.valueMap.set(key, code);
        return code;
      }
      if (holder.v === value && holder.t === type) { // 极端哈希碰撞视为同值
        this.valueMap.set(key, code);
        return code;
      }
    }
    // 兜底：12 位仍碰撞（不可能发生）→ 追加随机段
    const code = digest.slice(0, 12) + crypto.randomBytes(2).toString('hex');
    this.codeMap.set(code, { v: value, t: type });
    this.valueMap.set(key, code);
    return code;
  }

  lookup(code) {
    const hit = this.codeMap.get(code.toLowerCase());
    return hit ? { value: hit.v, type: hit.t } : null;
  }

  get size() { return this.codeMap.size; }

  toJSON() {
    return { v: 1, codes: Object.fromEntries(this.codeMap) };
  }

  static fromJSON(data) {
    const vault = new Vault();
    if (data && data.codes) {
      for (const [code, meta] of Object.entries(data.codes)) {
        if (meta && typeof meta.v === 'string' && typeof meta.t === 'string') {
          vault.codeMap.set(code, { v: meta.v, t: meta.t });
          vault.valueMap.set(meta.t + '\x00' + meta.v, code);
        }
      }
    }
    return vault;
  }
}

/* ------------------------------------------------------------------ */
/* 屏蔽值构造：保留首尾特征 + 内嵌编码                                   */
/* ------------------------------------------------------------------ */

function buildMasked(type, value, code) {
  switch (type) {
    case 'phone': { // 138****5678〔..〕
      const digits = value.replace(/\D/g, '');
      return `${digits.slice(0, 3)}****${digits.slice(-4)}〔${code}〕`;
    }
    case 'idCard': // 3301……567X〔..〕
      return `${value.slice(0, 4)}……${value.slice(-4)}〔${code}〕`;
    case 'bank': // 6222******3456〔..〕
      return `${value.slice(0, 4)}******${value.slice(-4)}〔${code}〕`;
    case 'email': { // z***@example.com〔..〕
      const at = value.lastIndexOf('@');
      const local = value.slice(0, at);
      const domain = value.slice(at);
      const head = [...local][0] || '*';
      return `${head}***${domain}〔${code}〕`;
    }
    case 'passport': // E******5〔..〕
      return `${value[0]}******${value.slice(-1)}〔${code}〕`;
    case 'plate': // 京A***5〔..〕
      return `${value.slice(0, 2)}***${value.slice(-1)}〔${code}〕`;
    case 'name': { // 张*〔..〕 / 张*丰〔..〕
      const chars = [...value];
      if (chars.length <= 2) return `${chars[0]}*〔${code}〕`;
      return `${chars[0]}*${chars[chars.length - 1]}〔${code}〕`;
    }
    case 'address': { // 安徽省……〔..〕：只留行政区划，门牌号一个字都不留
      const m = /^.{2,8}?(?:省|自治区|市|县|区|镇|乡|村)/.exec(value);
      const head = m ? m[0] : [...value].slice(0, 2).join('');
      return `${head}……〔${code}〕`;
    }
    case 'caseNo': { // （2020）……号〔..〕
      const compact = value.replace(/\s+/g, '');
      const y = /[（(]((?:19|20)\d{2})[）)]/.exec(compact);
      return `${y ? `（${y[1]}）` : ''}……号〔${code}〕`;
    }
    case 'license': // 1440……7921〔..〕
      return `${value.slice(0, 4)}……${value.slice(-4)}〔${code}〕`;
    case 'landline': { // 075****5678〔..〕：按数字位对齐手机号风格
      const digits = value.replace(/\D/g, '');
      return `${digits.slice(0, 3)}****${digits.slice(-4)}〔${code}〕`;
    }
    case 'im': // we***89〔..〕：社交账号保留首尾各 2 字符
      return `${value.slice(0, 2)}***${value.slice(-2)}〔${code}〕`;
    case 'hkmt': // H******8〔..〕：同护照风格
      return `${value[0]}******${value.slice(-1)}〔${code}〕`;
    case 'uscc': // 91……WXYZ〔..〕：统一社会信用代码留首 2 尾 4
      return `${value.slice(0, 2)}……${value.slice(-4)}〔${code}〕`;
    case 'org': { // 广东……律师事务所〔..〕
      const suffix = ORG_SUFFIXES.find((s) => value.endsWith(s)) || '';
      const brand = suffix ? value.slice(0, -suffix.length) : value;
      return `${brand.slice(0, 2)}……${suffix || brand.slice(-2)}〔${code}〕`;
    }
    default: // 兜底：首尾各 1 字符
      return `${value.slice(0, 1)}**${value.slice(-1)}〔${code}〕`;
  }
}

/* ------------------------------------------------------------------ */
/* 文本屏蔽 / 文本恢复                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {string} text 原文
 * @param {Vault} vault
 * @param {{toggles?:Record<string,boolean>}} [options]
 * @returns {{masked:string, items:Array, counts:Record<string,number>}}
 */
function maskText(text, vault, options = {}) {
  const { items, counts } = detect(text, options);
  let masked = text;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const code = vault.ensureCode(it.type, it.value);
    masked = masked.slice(0, it.start) + buildMasked(it.type, it.value, code) + masked.slice(it.end);
  }
  return { masked, items, counts };
}

/**
 * @param {string} text 含屏蔽值的文本
 * @param {Vault} vault
 * @returns {{text:string, resolved:number, restored:Array<{type,value,code}>, missing:string[]}}
 */
function restoreText(text, vault) {
  // 收集文本中的全部编码
  const codes = [];
  let m;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text)) !== null) {
    if (!codes.includes(m[1])) codes.push(m[1]);
  }

  // 各类型屏蔽值“修饰部分”的形状（用于连同修饰一起整体还原）
  const FULL = {
    phone: '\\d{3}\\*{4}\\d{4}',
    idCard: '[0-9Xx]{4}……[0-9Xx]{4}',
    bank: '\\d{4}\\*{6}\\d{4}',
    email: '.\\*{3}@[^〔〕\\s]{1,80}',
    passport: '[A-Za-z]\\*{6}[0-9A-Za-z]',
    plate: '[\\u4e00-\\u9fa5][A-HJ-NP-Z]\\*{3}[0-9A-Za-z挂学警港澳]',
    name: '[\\u4e00-\\u9fa5]\\*[\\u4e00-\\u9fa5]?',
    address: '(?:[\\u4e00-\\u9fa5]{2,8}……|[\\u4e00-\\u9fa50-9A-Za-z]{2,6}……[\\u4e00-\\u9fa50-9A-Za-z \\t\\u3000]{1,4})',
    caseNo: '[（(]\\d{4}[）)]……号',
    license: '[A-Za-z0-9]{4}……[A-Za-z0-9]{4}',
    org: `[\\u4e00-\\u9fa5]{2}……(?:${ORG_SUFFIX_ALT})`,
    landline: '\\d{3}\\*{4}\\d{4}',
    im: '.{2}\\*{3}.{2}',
    hkmt: '[A-Za-z]\\*{6}[0-9A-Za-z]',
    uscc: '[0-9A-HJ-NPQRTUWXY]{2}……[0-9A-HJ-NPQRTUWXY]{4}',
  };

  let out = text;
  const restored = [];
  const missing = [];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapeRep = (s) => s.replace(/\$/g, '$$$$');

  for (const code of codes) {
    const hit = vault.lookup(code);
    if (!hit) { missing.push(code); continue; }
    const decor = FULL[hit.type] || '';
    // 第一层：修饰部分 + 编码 整体还原
    const fullRe = new RegExp(decor + escapeRe('〔' + code + '〕'), 'g');
    if (decor && fullRe.test(out)) {
      out = out.replace(fullRe, escapeRep(hit.value));
      restored.push({ type: hit.type, value: hit.value, code });
    }
  }
  // 第二层：裸编码兜底（修饰部分被用户改动/丢弃时仍可还原编码本身）
  for (const code of codes) {
    const hit = vault.lookup(code);
    if (!hit) continue;
    const bare = '〔' + code + '〕';
    if (out.includes(bare)) {
      out = out.split(bare).join(hit.value);
      if (!restored.some((r) => r.code === code)) {
        restored.push({ type: hit.type, value: hit.value, code });
      }
    }
  }
  return { text: out, resolved: restored.length, restored, missing };
}

/** 快速判断文本中是否含有屏蔽编码 */
function hasCodes(text) {
  CODE_RE.lastIndex = 0;
  return CODE_RE.test(text);
}

/** 统计文本中的编码个数 */
function countCodes(text) {
  let n = 0;
  CODE_RE.lastIndex = 0;
  while (CODE_RE.exec(text) !== null) n++;
  return n;
}

module.exports = {
  Vault, buildMasked, maskText, restoreText, hasCodes, countCodes,
  CODE_RE, TYPE_LABEL,
};
