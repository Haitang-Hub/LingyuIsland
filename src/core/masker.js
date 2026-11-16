'use strict';
/**
 * 屏蔽 / 恢复引擎（纯 JS，依赖 node 内置 crypto）
 *
 * 核心设计：屏蔽值形如  138****5678〔ab12cd〕
 *  - 前后保留部分原文，让用户“能判断出是什么内容”
 *  - 〔〕内 6~12 位十六进制编码是找回原文的钥匙：
 *    只要编码未被改动（哪怕从文件里复制到别处），都能还原出真实内容
 *  - 同一真实值在全库中永远对应同一个编码
 *
 * v1.5 规则重构：
 *  - 地址 / 机构名只保留省级行政区的前 2 字作前缀，其余信息（字号、
 *    县市镇村、门牌）一个字都不留；没有省级前缀时直接用「……」开头，
 *    不插入「某地 / 某某」之类的占位词。旧实现保留字号前 2 字，导致
 *    「陈阿满是广东雷阳律师事务所」被屏蔽成「陈阿……律师事务所」——
 *    人名首字反而残留在脱敏产物里。
 *  - 因为前缀变成变长（2 字 或 0 字），还原时按 vault 里的原值判断当初
 *    有没有前缀（见 decorFor），避免泛型 [\u4e00-\u9fa5]{2} 误吞正文汉字。
 *  - 导出 maskEdits / restoreEdits：把「算出编辑区间」与「应用到文本」拆开，
 *    Office XML 段落级拼接管道可以复用同一套判定，再映射回各个 <w:t> 节点。
 */

const crypto = require('crypto');
const { detect, ORG_SUFFIXES } = require('./detector');

/** 屏蔽编码格式：〔 + 6~12 位十六进制 + 〕 */
const CODE_RE = /〔([0-9a-f]{6,12})〕/g;

const ORG_SUFFIX_ALT = ORG_SUFFIXES.join('|');

const TYPE_LABEL = {
  phone: '手机号', idCard: '身份证', bank: '银行卡', email: '邮箱',
  name: '姓名', address: '位置信息/住址', passport: '护照', plate: '车牌',
  caseNo: '案号', license: '执业证号', org: '机构名称',
  landline: '固定电话', im: '社交账号', hkmt: '港澳台证件', uscc: '统一社会信用代码',
};

// 省级行政区 / 直辖市：地址和机构名只保留这一级别，县市镇村一律不出现在脱敏产物里
const PROVINCE_RE = /^(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾)/;

/** 返回省级行政区的前 2 字作安全前缀；不含省级行政区时返回传入的占位词（通常为空串） */
function safeHead(value, placeholder) {
  const m = PROVINCE_RE.exec(String(value || ''));
  return m ? m[0].slice(0, 2) : placeholder;
}

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
    case 'address': // ……〔..〕 / 浙江……〔..〕：门牌、县市镇村一个字都不留
      return `${safeHead(value, '')}……〔${code}〕`;
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
    case 'org': { // ……有限公司〔..〕 / 安徽……有限公司〔..〕：字号一个字都不留
      const suffix = ORG_SUFFIXES.find((s) => value.endsWith(s)) || '';
      const brand = suffix ? value.slice(0, -suffix.length) : value;
      return `${safeHead(brand, '')}……${suffix || brand.slice(-2)}〔${code}〕`;
    }
    default: // 兜底：首尾各 1 字符
      return `${value.slice(0, 1)}**${value.slice(-1)}〔${code}〕`;
  }
}

/* ------------------------------------------------------------------ */
/* 编辑区间：纯文本与 Office XML 共用                                    */
/* ------------------------------------------------------------------ */

/** 把互不重叠的编辑按「从后往前」应用到文本 */
function applyEdits(text, edits) {
  let out = text;
  const sorted = edits.slice().sort((a, b) => b.start - a.start);
  let lastStart = Infinity;
  for (const e of sorted) {
    if (e.end > lastStart) continue; // 防御：跳过重叠编辑
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

/**
 * 只计算屏蔽编辑，不改文本。Office XML 管道据此把编辑映射回各文本节点。
 * @returns {{edits:Array, items:Array, counts:Object}}
 */
function maskEdits(text, vault, options = {}) {
  const { items, counts } = detect(text, options);
  const edits = items.map((it) => ({
    start: it.start,
    end: it.end,
    replacement: buildMasked(it.type, it.value, vault.ensureCode(it.type, it.value)),
  }));
  return { edits, items, counts };
}

/** 各类型屏蔽值「修饰部分」的形状（用于连同修饰一起整体还原） */
const FULL = {
  phone: '\\d{3}\\*{4}\\d{4}',
  idCard: '[0-9Xx]{4}……[0-9Xx]{4}',
  bank: '\\d{4}\\*{6}\\d{4}',
  email: '.\\*{3}@[^〔〕\\s]{1,80}',
  passport: '[A-Za-z]\\*{6}[0-9A-Za-z]',
  plate: '[\\u4e00-\\u9fa5][A-HJ-NP-Z]\\*{3}[0-9A-Za-z挂学警港澳]',
  name: '[\\u4e00-\\u9fa5]\\*[\\u4e00-\\u9fa5]?',
  // 地址 / 机构名的前缀是变长的（省级 2 字或无前缀），不能用固定 2 字正则，
  // 否则会把正文汉字吞进屏蔽值。这两类改由 decorFor() 按原值精确重建。
  caseNo: '[（(]\\d{4}[）)]……号',
  license: '[A-Za-z0-9]{4}……[A-Za-z0-9]{4}',
  landline: '\\d{3}\\*{4}\\d{4}',
  im: '.{2}\\*{3}.{2}',
  hkmt: '[A-Za-z]\\*{6}[0-9A-Za-z]',
  uscc: '[0-9A-HJ-NPQRTUWXY]{2}……[0-9A-HJ-NPQRTUWXY]{4}',
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 地址 / 机构名的「修饰部分」正则要按原值精确判断前缀有无：
 * 有省级前缀时匹配「2 字 + ……」，无前缀时只匹配「……」。
 * 若统一用固定 2 字前缀，无前缀的屏蔽值（如『……有限公司〔code〕』）
 * 会把正文最后 2 个汉字误当成前缀一起吞掉，导致还原后正文缺字。
 */
function decorFor(hit) {
  const v = String(hit.value || '');
  if (hit.type === 'address') {
    return safeHead(v, '') ? '[\\u4e00-\\u9fa5]{2}……' : '……';
  }
  if (hit.type === 'org') {
    const suffix = ORG_SUFFIXES.find((s) => v.endsWith(s));
    const brand = suffix ? v.slice(0, -suffix.length) : v;
    const head = safeHead(brand, '') ? '[\\u4e00-\\u9fa5]{2}' : '';
    const tail = suffix ? `(?:${ORG_SUFFIX_ALT})` : '[\\u4e00-\\u9fa5]{2}';
    return head + '……' + tail;
  }
  return FULL[hit.type] || '';
}

/**
 * 只计算还原编辑，不改文本。
 * 第一层：按类型匹配「修饰部分 + 编码」整体还原；
 * 第二层：修饰部分被改动 / 丢弃时，裸编码兜底。
 */
function restoreEdits(text, vault) {
  const codes = [];
  let m;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text)) !== null) {
    if (!codes.includes(m[1])) codes.push(m[1]);
  }

  const edits = [];
  const restored = [];
  const missing = [];
  for (const code of codes) {
    const hit = vault.lookup(code);
    if (!hit) { missing.push(code); continue; }
    const bare = '〔' + code + '〕';
    const decor = decorFor(hit);
    let matched = false;

    if (decor) {
      const fullRe = new RegExp(decor + escapeRe(bare), 'g');
      while ((m = fullRe.exec(text)) !== null) {
        edits.push({ start: m.index, end: m.index + m[0].length, replacement: hit.value });
        matched = true;
        if (m.index === fullRe.lastIndex) fullRe.lastIndex++;
      }
    }
    if (!matched) {
      let p = 0;
      while ((p = text.indexOf(bare, p)) !== -1) {
        edits.push({ start: p, end: p + bare.length, replacement: hit.value });
        p += bare.length;
      }
    }
    restored.push({ type: hit.type, value: hit.value, code });
  }
  return { edits, restored, missing };
}

/** 丢弃重叠编辑（保留靠前者），避免不同编码的修饰区间互相踩踏 */
function cleanEdits(edits) {
  const sorted = edits.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.start < last.end) continue;
    out.push(e);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 文本屏蔽 / 文本恢复                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {string} text 原文
 * @param {Vault} vault
 * @param {{toggles?:Record<string,boolean>, knownNames?:Set<string>}} [options]
 * @returns {{masked:string, items:Array, counts:Record<string,number>}}
 */
function maskText(text, vault, options = {}) {
  const { edits, items, counts } = maskEdits(text, vault, options);
  return { masked: applyEdits(text, edits), items, counts };
}

/**
 * @param {string} text 含屏蔽值的文本
 * @param {Vault} vault
 * @returns {{text:string, resolved:number, restored:Array<{type,value,code}>, missing:string[]}}
 */
function restoreText(text, vault) {
  const { edits, restored, missing } = restoreEdits(text, vault);
  return { text: applyEdits(text, cleanEdits(edits)), resolved: restored.length, restored, missing };
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
  maskEdits, restoreEdits, applyEdits, cleanEdits, safeHead,
  CODE_RE, TYPE_LABEL,
};
