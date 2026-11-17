'use strict';
/**
 * 屏蔽 / 恢复引擎（纯 JS，依赖 node 内置 crypto）
 *
 * 核心设计：屏蔽值形如  138****5678〔手机号·ab12cd〕
 *  - 前后保留部分原文 + 类型标签，让用户「能判断出是什么内容」
 *  - 〔〕内 6~12 位十六进制编码（可带「类型·」前缀）是找回原文的钥匙：
 *    只要编码未被改动（哪怕从文件里复制到别处），都能还原出真实内容
 *  - 同一真实值在同一映射库中永远对应同一个编码
 *
 * 可读性约定（v1.9）：
 *  - 编码括号内嵌「类型·」标签（〔姓名·ab12cd〕），脱敏产物一眼可读；
 *    还原时标签随编码一并剥除。旧格式（无标签）的屏蔽文件照常解析。
 *  - 跨排版 run 的实体片段（见 maskEdits 的 boundaries）无法呈现完整
 *    修饰形态，输出「〔类型·编码〕」占位，同样可读、可还原。
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

/**
 * 屏蔽编码格式：〔类型·6~12 位十六进制〕，类型标签可省略（兼容旧格式）。
 * 标签只取汉字，避免吞进正文（「〔灵屿岛脱敏声明〕」等非编码括号不会误匹配）。
 */
const CODE_RE = /〔(?:([\u4e00-\u9fa5]{1,6})·)?([0-9a-f]{6,12})〕/g;

/** 编码括号内的类型标签：脱敏产物「张*〔姓名·ab12cd〕」一眼可知原内容类型 */
const CODE_LABEL = {
  phone: '手机号', idCard: '身份证', bank: '卡号', email: '邮箱', name: '姓名',
  address: '地址', passport: '护照', plate: '车牌', caseNo: '案号', license: '证号',
  org: '机构', landline: '电话', im: '账号', hkmt: '证件', uscc: '信用代码', meta: '元数据',
};

const codeBracket = (type, code) => {
  const label = CODE_LABEL[type];
  return label ? `〔${label}·${code}〕` : `〔${code}〕`;
};

const TYPE_LABEL = {
  phone: '手机号', idCard: '身份证', bank: '银行卡', email: '邮箱',
  name: '姓名', address: '位置信息/住址', passport: '护照', plate: '车牌',
  caseNo: '案号', license: '执业证号', org: '机构名称',
  landline: '固定电话', im: '社交账号', hkmt: '港澳台证件', uscc: '统一社会信用代码',
  meta: '文档元数据',
};

// 机构后缀识别表：遮蔽（buildMasked）与还原（decorFor）共用，保证修饰形状两端一致。
// 按长度降序，保证「股份有限公司」这类长后缀不会被短后缀「公司」截断。
const ORG_SUFFIX_ALT = ORG_SUFFIXES.slice().sort((a, b) => b.length - a.length).join('|');
function findOrgSuffix(value) {
  return ORG_SUFFIXES.slice().sort((a, b) => b.length - a.length).find((s) => value.endsWith(s)) || '';
}

// 身份证 / 银行卡保留位数：默认收紧为「只保留末尾 2 位」。
// 首尾同时可见（旧的各 4 位）会让身份证前 6 位行政区划 + 出生年段
// 与银行卡 BIN 段进入脱敏产物，配合其他文档可拼合还原；改为只留尾段后
// 「首尾同时可见」不再出现。还原正则仍兼容 0~4 位（历史屏蔽文件可还原）。
const KEEP_DEFAULT = 2;
function normalizeKeep(keep) {
  if (!keep || typeof keep !== 'object') return { idCard: KEEP_DEFAULT, bank: KEEP_DEFAULT };
  const one = (v) => Number.isInteger(v) ? Math.max(0, Math.min(4, v)) : KEEP_DEFAULT;
  return { idCard: one(keep.idCard), bank: one(keep.bank) };
}

// 省级行政区 / 直辖市：地址和机构名只保留这一级别，县市镇村一律不出现在脱敏产物里
const PROVINCE_RE = /^(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|香港|澳门|台湾)/;

/** 返回省级行政区的前 2 字作安全前缀；不含省级行政区时返回传入的占位词（通常为空串） */
function safeHead(value, placeholder) {
  const m = PROVINCE_RE.exec(String(value || ''));
  return m ? m[0].slice(0, 2) : placeholder;
}

// 机构字号的末级行政层级（镇/村/县/区/市/省/乡）：有层级时屏蔽值用「某镇……卫生院」
// 形态提示主体级别，具体行政区划与字号全隐去（与地址的「某村」提示同一策略）。
const ORG_LEVEL_RE = /(省|市|县|区|镇|乡|村)$/;
function orgLevelWord(brand) {
  const m = ORG_LEVEL_RE.exec(String(brand || '').trim());
  return m ? m[1] : '';
}

// 地址层级词：从原值提取最有辨识度的末级层级，生成「某村 / 某区 / 某路」这类可读提示。
// 优先取末级行政区划，其次道路，最后门牌要素；遮蔽与还原共用同一函数，保证形状一致。
const ADDR_LEVEL_ADMIN = ['自治区', '自治州', '自治县', '地区', '街道', '社区', '苏木', '省', '市', '区', '县', '镇', '乡', '村', '旗', '盟', '屯', '寨', '堡', '庄'];
const ADDR_LEVEL_ROAD = ['大道', '大街', '小巷', '路', '街', '巷', '弄'];
const ADDR_LEVEL_HOUSE = ['单元', '小区', '花园', '公寓', '大厦', '山庄', '宿舍', '大院', '新村', '广场', '庭院', '号楼', '号', '栋', '幢', '座', '室', '楼', '层', '户', '组', '队', '苑', '园', '府'];
function lastLevelWord(value, words) {
  const re = new RegExp(words.slice().sort((a, b) => b.length - a.length).join('|'), 'g');
  let m, last = '';
  while ((m = re.exec(value)) !== null) {
    last = m[0];
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return last;
}
/** 取地址里最有辨识度的末级层级词（村/区/路/号…），无层级词时返回空串 */
function addressLevel(value) {
  const s = String(value || '');
  return lastLevelWord(s, ADDR_LEVEL_ADMIN) || lastLevelWord(s, ADDR_LEVEL_ROAD) || lastLevelWord(s, ADDR_LEVEL_HOUSE) || '';
}

/* ------------------------------------------------------------------ */
/* 映射库（Vault）：编码 ↔ 原文，由主进程负责加密持久化                    */
/* ------------------------------------------------------------------ */

class Vault {
  /**
   * @param {string} [salt] 编码盐值。缺省随机生成：
   *  - 同一批次（同一个 Vault 实例）内同值同码，保证批内一致性；
   *  - 跨批次（不同 Vault 实例）同值不同码，阻断「跨文档拼合还原」；
   *  - 还原不依赖盐值（按 codeMap 反查），持久化时随 JSON 保存盐值即可续用。
   *  旧版映射库（JSON 无 salt 字段）回落为空盐，历史编码保持有效。
   */
  constructor(salt) {
    this.codeMap = new Map();   // code -> { v: 原文, t: 类型 }
    this.valueMap = new Map();  // type\x00value -> code（保证同批次同值同编码）
    this.salt = typeof salt === 'string' ? salt : crypto.randomBytes(8).toString('hex');
  }

  /** 为 (type,value) 取得稳定编码；碰撞时自动加长 */
  ensureCode(type, value) {
    const key = type + '\x00' + value;
    const exist = this.valueMap.get(key);
    if (exist) return exist;

    // 盐值参与哈希：不同批次对同一真实值产出不同编码，编码本身不再可跨文档关联
    const digest = crypto.createHash('sha256').update(this.salt + '\x00' + key).digest('hex');
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
    return { v: 2, salt: this.salt, codes: Object.fromEntries(this.codeMap) };
  }

  static fromJSON(data) {
    // 旧版（v1）无 salt 字段 → 空盐，历史编码值保持有效
    const vault = new Vault(data && typeof data.salt === 'string' ? data.salt : '');
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

function buildMasked(type, value, code, keep = null) {
  const keepCfg = normalizeKeep(keep);
  let body;
  switch (type) {
    case 'phone': { // 138****5678
      const digits = value.replace(/\D/g, '');
      body = `${digits.slice(0, 3)}****${digits.slice(-4)}`;
      break;
    }
    case 'idCard': { // ……67X：默认只保留末尾 2 位（首段行政区划/出生日期不外泄）
      body = `……${keepCfg.idCard ? value.slice(-keepCfg.idCard) : ''}`;
      break;
    }
    case 'bank': { // ******34：默认只保留末尾 2 位（BIN 段不外泄）
      body = `******${keepCfg.bank ? value.slice(-keepCfg.bank) : ''}`;
      break;
    }
    case 'email': { // z***@example.com
      const at = value.lastIndexOf('@');
      const local = value.slice(0, at);
      const domain = value.slice(at);
      const head = [...local][0] || '*';
      body = `${head}***${domain}`;
      break;
    }
    case 'passport': // E******5
      body = `${value[0]}******${value.slice(-1)}`;
      break;
    case 'plate': // 京A***5
      body = `${value.slice(0, 2)}***${value.slice(-1)}`;
      break;
    case 'name': { // 张* / 张*丰
      const chars = [...value];
      body = chars.length <= 2 ? `${chars[0]}*` : `${chars[0]}*${chars[chars.length - 1]}`;
      break;
    }
    case 'address': { // 某村 / 浙江……某区：留末级层级词提示类型，具体名称与门牌全隐去
      const level = addressLevel(value);
      const head = safeHead(value, '');
      body = `${head ? head + '……' : ''}某${level}`;
      break;
    }
    case 'caseNo': { // （2020）……号：年份括号统一输出圆括号，保证还原 decor（FULL.caseNo）可匹配
      const compact = value.replace(/\s+/g, '');
      const y = /[（(\[【［]((?:19|20)\d{2})[）)\]】］]/.exec(compact);
      body = `${y ? `（${y[1]}）` : ''}……号`;
      break;
    }
    case 'license': // ……7921：只保留末 4 位（首段执业地区码不外泄，与身份证同一「首段不可见」原则）
      body = `……${value.slice(-4)}`;
      break;
    case 'landline': { // 075****5678：按数字位对齐手机号风格
      const digits = value.replace(/\D/g, '');
      body = `${digits.slice(0, 3)}****${digits.slice(-4)}`;
      break;
    }
    case 'im': // we***89：社交账号保留首尾各 2 字符
      body = `${value.slice(0, 2)}***${value.slice(-2)}`;
      break;
    case 'hkmt': // H******8：同护照风格
      body = `${value[0]}******${value.slice(-1)}`;
      break;
    case 'uscc': // ……WXYZ：只保留末 4 位（首段登记部门码不外泄）
      body = `……${value.slice(-4)}`;
      break;
    case 'org': { // ……有限公司 / 安徽……有限公司 / 某镇……卫生院：字号一个字都不留
      const suffix = findOrgSuffix(value);
      const brand = suffix ? value.slice(0, -suffix.length) : value;
      const level = orgLevelWord(brand);
      body = level
        ? `某${level}……${suffix || brand.slice(-2)}`
        : `${safeHead(brand, '')}……${suffix || brand.slice(-2)}`;
      break;
    }
    default: // 兜底：首尾各 1 字符
      body = `${value.slice(0, 1)}**${value.slice(-1)}`;
  }
  // 编码括号带类型标签（〔姓名·ab12cd〕），脱敏产物自解释、可读性更好；
  // 还原时标签随编码一并剥除（见 restoreEdits）。
  return body + codeBracket(type, code);
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
 *
 * options.boundaries：块内各文本节点的起始偏移（由 xmltext.transformXmlText 传入）。
 * 实体跨节点时必须按边界拆成多段、各自独立编码：屏蔽值整体塞进首节点会让
 * 其余节点的原文在屏蔽时被清空、还原时无法逐字节复原（跨 run 往返不一致）。
 * @returns {{edits:Array, items:Array, counts:Object}}
 */
function maskEdits(text, vault, options = {}) {
  const { items, counts } = detect(text, options);
  const bounds = Array.isArray(options.boundaries)
    ? options.boundaries.filter((b) => Number.isFinite(b))
    : null;
  const edits = [];
  for (const it of items) {
    const inner = bounds
      ? bounds.filter((b) => b > it.start && b < it.end).sort((a, b) => a - b)
      : null;
    if (inner && inner.length) {
      // 跨节点实体：按节点边界拆成片段，各自独立编码。
      // 片段用「类型标签 + 编码」占位：buildMasked 的修饰形态按「完整值」
      // 设计（如案号的「（2026）……号」），片段缺头少尾时修饰部分要么凭空
      // 捏造、要么还原后残留；标签占位走还原的括号整段兜底，可读且可
      // 逐字节精确复原。
      const cuts = [it.start, ...inner, it.end];
      for (let k = 0; k < cuts.length - 1; k++) {
        const s = cuts[k];
        const e = cuts[k + 1];
        const piece = text.slice(s, e);
        edits.push({ start: s, end: e, replacement: codeBracket(it.type, vault.ensureCode(it.type, piece)) });
      }
    } else {
      edits.push({
        start: it.start,
        end: it.end,
        replacement: buildMasked(it.type, it.value, vault.ensureCode(it.type, it.value), options.keep),
      });
    }
  }
  return { edits, items, counts };
}

/** 各类型屏蔽值「修饰部分」的形状（用于连同修饰一起整体还原） */
const FULL = {
  phone: '\\d{3}\\*{4}\\d{4}',
  // 位数可配置（0~4）：省略号 / 星号锚点固定，两侧数字放宽到 0~4 位
  idCard: '[0-9Xx]{0,4}……[0-9Xx]{0,4}',
  bank: '\\d{0,4}\\*{6}\\d{0,4}',
  email: '.\\*{3}@[^〔〕\\s]{1,80}',
  passport: '[A-Za-z]\\*{6}[0-9A-Za-z]',
  plate: '[\\u4e00-\\u9fa5][A-HJ-NP-Z]\\*{3}[0-9A-Za-z挂学警港澳]',
  name: '[\\u4e00-\\u9fa5]\\*[\\u4e00-\\u9fa5]?',
  // 地址 / 机构名的前缀是变长的（省级 2 字或无前缀），不能用固定 2 字正则，
  // 否则会把正文汉字吞进屏蔽值。这两类改由 decorFor() 按原值精确重建。
  caseNo: '[（(]\\d{4}[）)]……号',
  // 证号 / 信用代码现为仅尾段（{0,4}），同时兼容旧版「首尾各 4 位」屏蔽文件
  license: '[A-Za-z0-9]{0,4}……[A-Za-z0-9]{0,4}',
  landline: '\\d{3}\\*{4}\\d{4}',
  im: '.{2}\\*{3}.{2}',
  hkmt: '[A-Za-z]\\*{6}[0-9A-Za-z]',
  uscc: '[0-9A-HJ-NPQRTUWXY]{0,2}……[0-9A-HJ-NPQRTUWXY]{0,4}',
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
    // 新形态带层级提示（某村/某区/某路…），旧形态无提示（……）。两种都匹配，
    // 保证历史文件（v1.5.2 之前用旧形态屏蔽）仍能被新版本正确还原。
    const level = addressLevel(v);
    const head = safeHead(v, '');
    const newDecor = (head ? '[\\u4e00-\\u9fa5]{2}……' : '') + `某${level}`;
    const oldDecor = head ? '[\\u4e00-\\u9fa5]{2}……' : '……';
    return `(?:${newDecor}|${oldDecor})`;
  }
  if (hit.type === 'org') {
    const suffix = findOrgSuffix(v);
    const brand = suffix ? v.slice(0, -suffix.length) : v;
    const level = orgLevelWord(brand);
    // 新形态「某镇……卫生院」与旧形态「广东……有限公司」都接受：
    // 历史文件（旧版本用省级前缀屏蔽）仍能按原样还原。
    const head = level
      ? '(?:某[\\u4e00-\\u9fa5]|[\\u4e00-\\u9fa5]{2})?'
      : (safeHead(brand, '') ? '[\\u4e00-\\u9fa5]{2}' : '');
    const tail = suffix ? `(?:${ORG_SUFFIX_ALT})` : '[\\u4e00-\\u9fa5]{2}';
    return head + '……' + tail;
  }
  return FULL[hit.type] || '';
}

/**
 * 只计算还原编辑，不改文本。
 * 第一层：按类型匹配「修饰部分 + 编码」整体还原（编码括号可为
 * 「〔ab12cd〕」旧格式或「〔姓名·ab12cd〕」新格式）；
 * 第二层：修饰部分被改动 / 丢弃时，按实际出现的括号整段兜底替换
 * （标签随编码一并剥除）。
 */
function restoreEdits(text, vault) {
  // 收集文档中出现的编码括号：同一编码可能以不同形态（带/不带标签）出现
  const byCode = new Map(); // hex -> [实际出现的括号全文]
  CODE_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RE.exec(text)) !== null) {
    const list = byCode.get(m[2]) || [];
    if (!list.includes(m[0])) list.push(m[0]);
    byCode.set(m[2], list);
  }

  const edits = [];
  const restored = [];
  const missing = [];
  for (const [code, fulls] of byCode) {
    const hit = vault.lookup(code);
    if (!hit) { missing.push(code); continue; }
    const decor = decorFor(hit);

    for (const full of fulls) {
      let matched = false;
      if (decor) {
        const fullRe = new RegExp(decor + escapeRe(full), 'g');
        while ((m = fullRe.exec(text)) !== null) {
          edits.push({ start: m.index, end: m.index + m[0].length, replacement: hit.value });
          matched = true;
          if (m.index === fullRe.lastIndex) fullRe.lastIndex++;
        }
      }
      if (!matched) {
        let p = 0;
        while ((p = text.indexOf(full, p)) !== -1) {
          edits.push({ start: p, end: p + full.length, replacement: hit.value });
          p += full.length;
        }
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
  normalizeKeep, KEEP_DEFAULT, CODE_RE, CODE_LABEL, TYPE_LABEL, codeBracket,
};
