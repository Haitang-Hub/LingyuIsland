#!/usr/bin/env node
'use strict';

/**
 * 灵屿岛打包入口。
 *
 * 约定：所有构建产物按版本放进 release/v<version>/，release 根目录不再散落
 * exe / zip / latest.yml / win-unpacked。每次打包前自动清理历史产物，只留当前版本。
 * 复用本地 Electron 并走国内镜像，避免 electron-builder 去 GitHub 下载超时。
 *
 * 用法：
 *   node scripts/dist.js                 清理 + 打包 + 校验
 *   node scripts/dist.js --clean-only    只整理目录，不打包（重启后清残留用）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;
const versionDir = `v${version}`;
const releaseDir = path.join(root, 'release');
const outDir = path.join(releaseDir, versionDir);
const cleanOnly = process.argv.includes('--clean-only');

/** 递归删除；被进程占用的文件跳过并记录，其所在目录保留到下次清理。 */
function removeTree(target, result) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    const lockedBefore = result.locked.length;
    for (const name of fs.readdirSync(target)) {
      removeTree(path.join(target, name), result);
    }
    if (result.locked.length === lockedBefore) {
      try {
        fs.rmdirSync(target);
        result.deleted++;
      } catch {
        // 目录暂时删不掉，留给下次清理
      }
    }
  } else {
    try {
      fs.unlinkSync(target);
      result.deleted++;
    } catch {
      result.locked.push(target);
    }
  }
}

/** 整理 release：删除除 keep 以外的全部历史产物。 */
function cleanRelease(keep) {
  const result = { deleted: 0, locked: [] };
  if (!fs.existsSync(releaseDir)) return result;
  for (const name of fs.readdirSync(releaseDir)) {
    if (keep && name === keep) continue;
    removeTree(path.join(releaseDir, name), result);
  }
  console.log(`[clean] 已清理 ${result.deleted} 项；保留：${keep || '(无)'}`);
  if (result.locked.length) {
    console.log(`[clean] ${result.locked.length} 个文件被进程占用，已跳过（重启后运行 npm run clean:release 可清掉）：`);
    for (const p of result.locked) console.log(`  ${path.relative(root, p)}`);
  }
  return result;
}

function build() {
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  const args = [
    cli,
    '--win',
    '--config.electronDist=node_modules/electron/dist',
    `--config.directories.output=release/${versionDir}`,
  ];
  const env = {
    ...process.env,
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  };
  console.log(`[build] 正在打包 ${version} -> release/${versionDir}`);
  const r = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}

function verify() {
  const expected = [
    `LingyuIsland-${version}-win.zip`,
    `LingyuIsland-Setup-${version}.exe`,
    `LingyuIsland-Setup-${version}.exe.blockmap`,
    'latest.yml',
    'builder-debug.yml',
    'win-unpacked',
  ];
  const missing = expected.filter((n) => !fs.existsSync(path.join(outDir, n)));
  if (missing.length) throw new Error(`产物缺失：${missing.join(', ')}`);

  const yml = fs.readFileSync(path.join(outDir, 'latest.yml'), 'utf8');
  if (!yml.includes(`version: ${version}`)) throw new Error('latest.yml 版本号不一致');

  const exe = path.join(outDir, `LingyuIsland-Setup-${version}.exe`);
  const sha = crypto.createHash('sha512').update(fs.readFileSync(exe)).digest('base64');
  const m = yml.match(/^sha512:\s*(\S+)/m);
  if (!m || m[1] !== sha) throw new Error('latest.yml 的 sha512 与安装包不一致');

  for (const n of expected.slice(0, 4)) {
    console.log(`  ${n}  ${fs.statSync(path.join(outDir, n)).size} B`);
  }
  console.log('[verify] 产物齐全，latest.yml 版本号与 sha512 校验通过');
}

cleanRelease(cleanOnly ? versionDir : null);
if (cleanOnly) process.exit(0);
build();
verify();
