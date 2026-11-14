'use strict';
/**
 * 设置工具：node set-root.js [--root <路径>] [--no-collapse]
 *  - 不传 --root 时保留现有 rootDir 不变
 *  - --no-collapse 临时关闭面板自动收起（自动化测试用）
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.APPDATA, '灵屿岛');
const p = path.join(dir, 'settings.json');
let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 首次 */ }

const rootIdx = process.argv.indexOf('--root');
if (rootIdx > -1 && process.argv[rootIdx + 1]) {
  s.rootDir = process.argv[rootIdx + 1];
}
s.rootDir = s.rootDir || '';
s.toggles = s.toggles || { phone: true, idCard: true, bank: true, email: true, name: true, address: true, passport: true, plate: true };
s.clipboardWatch = s.clipboardWatch !== false;
// autoCollapse 由命令行参数控制：node set-root.js --no-collapse
s.autoCollapse = !process.argv.includes('--no-collapse');
fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
console.log('settings written:', p);
console.log('rootDir =', s.rootDir, '| autoCollapse =', s.autoCollapse);
