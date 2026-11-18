'use strict';
/**
 * 屏蔽 / 恢复引擎（纯 JS，依赖 node 内置 crypto）
 *
 * 核心设计：屏蔽值形如  138****5678〔手机号·ab12cd〕
 *  - 前后保留部分原文 + 类型标签，让用户「能判断出是什么内容」
 *  - 〔〕内 6~12 位十六进制编码（可带「类型·」前缀）是找回原文的钥匙：
 *    只要编码未被改动（哪怕从文件里复制到别处），都能还原出真实内容
 *  - 同一真实值在同一映射库中对应同一编码；跨文本节点实体因还原需要
 *    按原始分段回填，分段长度参与编码键（见 maskEdits 的 boundaries）。
 *
 * 可读性约定：
 *  - 编码括号内嵌「类型·」标签（〔姓名·ab12cd〕），脱敏产物一眼可读；
 *    还原时标签随编码一并剥除。旧格式（无标签）的屏蔽文件照常解析。
 *  - 跨排版 run 的实体也按完整屏蔽形态输出（「江苏****507室〔地址·编码〕」），
 *    屏蔽值落在首节点、其余节点清空；vault 记录原文分段长度，还原时逐段回填。
 *
 * 屏蔽形态（统一按类型区分）：
 *  - 身份证：前 6 位 + ****
 *  - 银行卡 / 执业证号 / 统一社会信用代码：**** + 尾 4 位
 *  - 地址：前 2 字 + **** + 尾 4 字（短值无尾段）
 *  - 机构名：按长度分档——6字 前2+**+尾2 / 7字 前2+***+尾2 / 8字 前2+****+尾2 / 9字+ 前2+****+尾4
 *  - 案号：前 2 字 + **** + 号
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

// 「保留位数」已统一写入 buildMasked 各类型分支（见 switch），
// 不再暴露 keep 参数，也不再做前后段同时可见的配置选项。

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

  /**
   * 为 (type,value) 取得稳定编码；碰撞时自动加长。
   * @param {number[]} [splitLens] 跨文本节点实体的原始分段长度。
   *   同一值被 Word 拆成不同 run 数量时，还原必须按各自的分段把原文放回
   *   原来的节点，否则 Office 往返无法逐字节一致；因此分段长度参与编码键。
   */
  ensureCode(type, value, splitLens = null) {
    const lens = Array.isArray(splitLens) && splitLens.length > 1
      ? splitLens.map((n) => Math.max(0, n | 0))
      : null;
    const key = type + '\x00' + value + (lens ? '\x00#' + lens.join(',') : '');
    const exist = this.valueMap.get(key);
    if (exist) return exist;

    // 盐值参与哈希：不同批次对同一真实值产出不同编码，编码本身不再可跨文档关联
    const digest = crypto.createHash('sha256').update(this.salt + '\x00' + key).digest('hex');
    for (let len = 6; len <= 12; len += 2) {
      const code = digest.slice(0, len);
      const holder = this.codeMap.get(code);
      if (!holder) {
        this.codeMap.set(code, lens ? { v: value, t: type, l: lens } : { v: value, t: type });
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
    this.codeMap.set(code, lens ? { v: value, t: type, l: lens } : { v: value, t: type });
    this.valueMap.set(key, code);
    return code;
  }

  lookup(code) {
    const hit = this.codeMap.get(code.toLowerCase());
    return hit ? { value: hit.v, type: hit.t, lens: hit.l || null } : null;
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
          const lens = Array.isArray(meta.l) && meta.l.length > 1
            ? meta.l.map((n) => Math.max(0, n | 0)) : null;
          vault.codeMap.set(code, lens
            ? { v: meta.v, t: meta.t, l: lens } : { v: meta.v, t: meta.t });
          const key = meta.t + '\x00' + meta.v + (lens ? '\x00#' + lens.join(',') : '');
          vault.valueMap.set(key, code);
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
  let body;
  switch (type) {
    case 'phone': { // 138****5678
      const digits = value.replace(/\D/g, '');
      body = `${digits.slice(0, 3)}****${digits.slice(-4)}`;
      break;
    }
    case 'idCard': { // 330106****：前6位 + ****（行政区划 / 出生日期段不外泄）
      const digits = value.replace(/\D/g, '');
      body = `${digits.slice(0, 6)}****`;
      break;
    }
    case 'bank': { // ****3349：**** + 尾4（BIN 段不外泄）
      const digits = value.replace(/\D/g, '');
      body = `****${digits.slice(-4)}`;
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
    case 'passport': // E****5
      body = `${value[0]}****${value.slice(-1)}`;
      break;
    case 'plate': // 京A***5
      body = `${value.slice(0, 2)}***${value.slice(-1)}`;
      break;
    case 'name': { // 张* / 张*丰
      const chars = [...value];
      body = chars.length <= 2 ? `${chars[0]}*` : `${chars[0]}*${chars[chars.length - 1]}`;
      break;
    }
    case 'address': { // 前2 + **** + 尾4（短值退化为前2 + ****）
      const chars = [...value];
      if (chars.length <= 6) {
        body = chars.slice(0, 2).join('') + '****';
      } else {
        body = chars.slice(0, 2).join('') + '****' + chars.slice(-4).join('');
      }
      break;
    }
    case 'caseNo': { // 前2 + **** + 号（前2取自年份括号前的前缀，否则取括号后首个中文词的前2字）
      const compact = value.replace(/\s+/g, '');
      const y = /[（(\[【［]((?:19|20)\d{2})[）)\]】］]/.exec(compact);
      let head = '';
      if (y) {
        const beforeYear = compact.slice(0, y.index);
        if (beforeYear.length > 0) {
          head = beforeYear.slice(0, 2);
        } else {
          const afterBracket = compact.slice(y.index + y[0].length);
          const m = /^[\u4e00-\u9fa5]{1,2}/.exec(afterBracket);
          head = m ? m[0].slice(0, 2) : afterBracket.slice(0, 2);
        }
      } else {
        head = compact.slice(0, 2);
      }
      body = `${head}****号`;
      break;
    }
    case 'license': // ****3456：**** + 尾4（执业地区码不外泄）
      body = `****${value.slice(-4)}`;
      break;
    case 'landline': { // 075****5678：按数字位对齐手机号风格
      const digits = value.replace(/\D/g, '');
      body = `${digits.slice(0, 3)}****${digits.slice(-4)}`;
      break;
    }
    case 'im': // we***89：社交账号保留首尾各 2 字符
      body = `${value.slice(0, 2)}***${value.slice(-2)}`;
      break;
    case 'hkmt': // H****8：同护照风格
      body = `${value[0]}****${value.slice(-1)}`;
      break;
    case 'uscc': // ****QX1T：**** + 尾4（登记部门码不外泄）
      body = `****${value.slice(-4)}`;
      break;
    case 'org': { // 6字：前2+**+尾2；7字：前2+***+尾2；8字：前2+****+尾2；9字+：前2+****+尾4（不足6字走旧兜底）
      const chars = [...value];
      if (chars.length === 6) {
        body = chars.slice(0, 2).join('') + '**' + chars.slice(-2).join('');
      } else if (chars.length === 7) {
        body = chars.slice(0, 2).join('') + '***' + chars.slice(-2).join('');
      } else if (chars.length === 8) {
        body = chars.slice(0, 2).join('') + '****' + chars.slice(-2).join('');
      } else if (chars.length >= 9) {
        body = chars.slice(0, 2).join('') + '****' + chars.slice(-4).join('');
      } else {
        body = chars.slice(0, 2).join('') + '****';
      }
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
 * 实体跨节点时仍按完整屏蔽形态输出，把原始分段长度记入编码；还原时
 * xmltext 依据这些长度把原文逐段回填到原节点，保证跨 run 往返逐字节一致。
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
      // 跨文本节点实体：整条按正常屏蔽形态输出（如「江苏****507室〔地址·xxx〕」），
      // 屏蔽值整体落在首个节点，其余节点清空；同时把原始分段长度记进编码，
      // 还原时再按这些长度把原文逐段放回原节点，保证 Office 往返逐字节一致。
      const cuts = [it.start, ...inner, it.end];
      const lens = [];
      for (let k = 0; k < cuts.length - 1; k++) lens.push(cuts[k + 1] - cuts[k]);
      const code = vault.ensureCode(it.type, it.value, lens);
      edits.push({
        start: it.start,
        end: it.end,
        replacement: buildMasked(it.type, it.value, code),
      });
    } else {
      edits.push({
        start: it.start,
        end: it.end,
        replacement: buildMasked(it.type, it.value, vault.ensureCode(it.type, it.value)),
      });
    }
  }
  return { edits, items, counts };
}

/** 各类型屏蔽值「修饰部分」的形状（用于连同修饰一起整体还原） */
const FULL = {
  phone: '\\d{3}\\*{4}\\d{4}',
  // idCard 新形态: 前6位数字 + 4 个 *；旧格式(兼容): 6 个 * 或 ……[尾0-4位]
  idCard: '(?:[0-9Xx]{6}\\*{4,6}|[0-9Xx]{0,4}……[0-9Xx]{0,4})',
  // bank 新形态: 4 个 * + 尾4位；旧格式(兼容): 6 个 * + 尾0-4位
  bank: '\\*{4,6}[0-9Xx]{2,4}',
  email: '.\\*{3}@[^〔〕\\s]{1,80}',
  passport: '[A-Za-z]\\*{4,6}[0-9A-Za-z]',
  plate: '[\\u4e00-\\u9fa5][A-HJ-NP-Z]\\*{3}[0-9A-Za-z挂学警港澳]',
  name: '[\\u4e00-\\u9fa5]\\*[\\u4e00-\\u9fa5]?',
  // caseNo 新形态: 0-2字符前缀 + 4 个 * + 号；旧格式(兼容): 6 个 * 或 (年份)……号
  caseNo: '(?:[\\u4e00-\\u9fa5]{0,2}\\*{4,6}号|[（(]\\d{4}[）)]……号)',
  // license 新形态: 4 个 * + 尾4；旧格式(兼容): 6 个 * 或 头0-4……尾0-4
  license: '(?:\\*{4,6}[A-Za-z0-9]{4}|[A-Za-z0-9]{0,4}……[A-Za-z0-9]{0,4})',
  landline: '\\d{3}\\*{4}\\d{4}',
  im: '.{2}\\*{3}.{2}',
  hkmt: '[A-Za-z]\\*{4,6}[0-9A-Za-z]',
  // uscc 新形态: 4 个 * + 尾4；旧格式(兼容): 6 个 * 或 ……尾4
  uscc: '(?:\\*{4,6}|……)[0-9A-HJ-NPQRTUWXY]{4}',
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
    // 新形态：前2 + **** + 尾4（短值退化为前2 + ****）
    // 前缀按原值精确生成：首字可能是字母/数字（如「A市B镇C村」），
    // 用泛型汉字类会匹配失败，导致还原时前缀残留在正文里。
    const chars = [...v];
    const headRe = escapeRe(chars.slice(0, Math.min(2, chars.length)).join(''));
    const newSimple = chars.length <= 6
      ? `${headRe}\\*{4,6}`
      : `${headRe}\\*{4,6}.{4}`;
    // 旧形态：层级提示（某村/某区…）或纯省略号，均保留兼容
    const level = addressLevel(v);
    const head = safeHead(v, '');    const oldLevelDecor = (head ? '[\\u4e00-\\u9fa5]{2}……' : '') + `某${level}`;
    const oldPlainDecor = head ? '[\\u4e00-\\u9fa5]{2}……' : '……';
    return `(?:${newSimple}|${oldLevelDecor}|${oldPlainDecor})`;
  }
  if (hit.type === 'org') {
    // 新形态按原值长度分档：6字 前2+**+尾2；7字 前2+***+尾2；8字 前2+****+尾2；
    // 9字+ 前2+****+尾4（前缀同样按原值精确生成，兼容字母/数字开头）
    const chars = [...v];
    const head = escapeRe(chars.slice(0, Math.min(2, chars.length)).join(''));
    const n = chars.length;
    const newDecor = n === 6 ? `${head}\\*{2}.{2}`
      : n === 7 ? `${head}\\*{3}.{2}`
      : n === 8 ? `${head}\\*{4}.{2}`
      : n >= 9 ? `${head}\\*{4}.{4}`
      : `${head}\\*{4,6}`;
    // 旧形态（兼容）：≤6字 前2+****；>6字 前2+****+尾4；省级前缀/层级词 + …… + 后缀
    const oldShort = `${head}\\*{4,6}`;
    const oldLong = `${head}\\*{4,6}.{4}`;
    const suffix = findOrgSuffix(v);
    const brand = suffix ? v.slice(0, -suffix.length) : v;
    const level = orgLevelWord(brand);
    const oldHead = level
      ? '(?:某[\\u4e00-\\u9fa5]|[\\u4e00-\\u9fa5]{2})?'
      : (safeHead(brand, '') ? '[\\u4e00-\\u9fa5]{2}' : '');
    const oldTail = suffix ? `(?:${ORG_SUFFIX_ALT})` : '[\\u4e00-\\u9fa5]{2}';
    const oldDecor = oldHead + '……' + oldTail;
    return `(?:${newDecor}|${oldShort}|${oldLong}|${oldDecor})`;
  }
  if (hit.type === 'caseNo') {
    // 新形态：头 N 字符 + **** + 号（N 精确来自 buildMasked 的 head 长度）
    const compact = v.replace(/\s+/g, '');
    const y = /[（(\[【［]((?:19|20)\d{2})[）)\]】］]/.exec(compact);
    let head = '';
    if (y) {
      const beforeYear = compact.slice(0, y.index);
      if (beforeYear.length > 0) {
        head = beforeYear.slice(0, 2);
      } else {
        const afterBracket = compact.slice(y.index + y[0].length);
        const m = /^[\u4e00-\u9fa5]{1,2}/.exec(afterBracket);
        head = m ? m[0].slice(0, 2) : afterBracket.slice(0, 2);
      }
    } else {
      head = compact.slice(0, 2);
    }
    // head 里含中文时用精确位数，否则用 [^〔〕\s]{N} 匹配
    const chineseCount = [...head].filter((c) => /[\u4e00-\u9fa5]/.test(c)).length;
    const escapedHead = escapeRe(head);
    const headRe = head
      ? (chineseCount === [...head].length
          ? `[\\u4e00-\\u9fa5]{${head.length}}`
          : escapedHead)
      : '';
    const newDecor = `${headRe}\\*{4,6}号`;
    // 旧形态（兼容）：(年份)……号
    const oldDecor = '[（(]\\d{4}[）)]……号';
    return `(?:${newDecor}|${oldDecor})`;
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
          edits.push({
            start: m.index, end: m.index + m[0].length,
            replacement: hit.value, partLens: hit.lens,
          });
          matched = true;
          if (m.index === fullRe.lastIndex) fullRe.lastIndex++;
        }
      }
      if (!matched) {
        let p = 0;
        while ((p = text.indexOf(full, p)) !== -1) {
          edits.push({
            start: p, end: p + full.length,
            replacement: hit.value, partLens: hit.lens,
          });
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
  CODE_RE, CODE_LABEL, TYPE_LABEL, codeBracket,
};
