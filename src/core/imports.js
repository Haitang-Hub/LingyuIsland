'use strict';
/**
 * 导入与分类（纯函数，可独立测试）
 *  - 拖入/选择的文件直接读取，只在根目录生成脱敏/还原结果，不生成工作副本
 *  - 结果文件同名时：keep → 自动加序号 _02/_03…；overwrite → 覆盖同名结果
 */

const path = require('path');
const fs = require('fs');

/** 判断路径是否位于根目录内（Windows 大小写不敏感，统一分隔符后前缀比较） */
function isInsideRoot(p, root) {
  if (!p || !root) return false;
  const norm = (s) => String(s).replace(/[\\/]+/g, '\\').replace(/[\\/]+$/, '').toLowerCase();
  const a = norm(p);
  const b = norm(root);
  return a.startsWith(b + '\\') || a === b;
}

/**
 * 在 dir 中为 (name, ext) 取得不冲突的目标名：
 *   name.ext → name_02.ext → name_03.ext …（序号补足两位，便于排序）
 * @param {string} dir 根目录
 * @param {string} name 不含扩展名的文件名
 * @param {string} ext 含点的扩展名（如 '.docx'）
 * @param {(full:string)=>boolean} [existsFn] 存在性检查（默认 fs 同步），测试可注入
 */
function uniqueTargetName(dir, name, ext, existsFn) {
  const exists = existsFn || ((full) => fs.existsSync(full));
  let full = path.join(dir, name + ext);
  if (!exists(full)) return name + ext;
  for (let i = 2; i < 1000; i++) {
    const serial = String(i).padStart(2, '0');
    full = path.join(dir, `${name}_${serial}${ext}`);
    if (!exists(full)) return `${name}_${serial}${ext}`;
  }
  return `${name}_${Date.now()}${ext}`;
}

/* ---------------- 同名冲突策略 ---------------- */

const CONFLICT_POLICIES = new Set(['keep', 'overwrite']);

/** 非法值回退默认策略（保留两份） */
function normalizeConflictPolicy(value) {
  return CONFLICT_POLICIES.has(value) ? value : 'keep';
}

/**
 * 按策略决定导入到根目录时使用的文件名
 *  - 无同名文件 → 原名
 *  - 有同名 + overwrite → 原名（由调用方覆盖）
 *  - 有同名 + keep → 自动加序号 _02/_03…
 * @returns {{name:string, action:'new'|'overwrite'|'keep'}}
 */
function resolveConflictName(dir, name, ext, policy = 'keep', existsFn) {
  const exists = existsFn || ((full) => fs.existsSync(full));
  const plain = name + ext;
  if (!exists(path.join(dir, plain))) return { name: plain, action: 'new' };
  if (policy === 'overwrite') return { name: plain, action: 'overwrite' };
  return { name: uniqueTargetName(dir, name, ext, exists), action: 'keep' };
}

/* ---------------- 文件类别 ---------------- */

const CATEGORY_EXTS = {
  doc: ['docx', 'doc', 'pdf', 'pptx', 'ppt', 'odt', 'rtf', 'wps', 'pages'],
  sheet: ['xlsx', 'xls', 'csv', 'tsv', 'ods', 'numbers'],
  text: ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'log', 'srt', 'vtt', 'properties'],
  code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs',
         'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'vue', 'html', 'htm', 'css', 'scss', 'less',
         'toml', 'tex', 'swift', 'dart', 'lua'],
};

const CATEGORY_LABEL = { all: '全部', doc: '文档', sheet: '表格', text: '文本', code: '代码', other: '其他' };

/** 扩展名 → 类别（doc/sheet/text/code/other） */
function categoryOf(ext) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  for (const [cat, list] of Object.entries(CATEGORY_EXTS)) {
    if (list.includes(e)) return cat;
  }
  return 'other';
}

/** 时间 → 分组名（今天/昨天/本周/更早） */
function timeGroupOf(ts) {
  if (!ts) return '更早';
  const d = new Date(ts);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(d)) / 86400000);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return '本周';
  return '更早';
}

module.exports = {
  isInsideRoot, uniqueTargetName, categoryOf, timeGroupOf,
  CATEGORY_EXTS, CATEGORY_LABEL,
  CONFLICT_POLICIES, normalizeConflictPolicy, resolveConflictName,
};
