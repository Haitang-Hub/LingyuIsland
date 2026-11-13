'use strict';
/**
 * 版本更新器：npm registry 检查 → 下载 tgz → 系统 tar 解压暂存 → 重启时拷贝覆盖
 *
 * 不直接 require('electron')：appDir / currentVersion / 广播回调由调用方注入，
 * 便于 node 环境单测。应用以 `electron .` 直跑源码，无 electron-updater 基础设施，
 * 因此采用「暂存 + 重启覆盖」的就地更新方案。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { compareVersions } = require('../core/version');

const PKG_NAME = '@haitang-hub/lingyu-island';
const REGISTRY_PRIMARY = 'https://registry.npmjs.org';
const REGISTRY_MIRROR = 'https://registry.npmmirror.com';
const NPM_PAGE = 'https://www.npmjs.com/package/' + PKG_NAME;
const FETCH_TIMEOUT_MS = 8000;

// 覆盖拷贝时永远不碰的目录（运行时依赖 / 仓库元数据 / 暂存区自身）
const SKIP_COPY = new Set(['node_modules', '.git', 'update-staging', '.workbuddy']);

const STAGE_DIR_NAME = 'update-staging';

function fetchJSON(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(url, { signal: ctl.signal })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      return res.json();
    })
    .finally(() => clearTimeout(timer));
}

function tarBin() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

/**
 * 递归拷贝 src → dest，跳过 skipNames 中的目录名。
 * 参数化（不读模块级常量）以便单测在临时目录中验证。
 */
function copyTreeSync(src, dest, skipNames) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skipNames && skipNames.has(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) {
      copyTreeSync(s, d, skipNames);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** 比较 dependencies 对象是否变化（键集合与值均相同才算不变） */
function depsEqual(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a || {})[k] === (b || {})[k]);
}

function createUpdater({ appDir, currentVersion, onBroadcast, isPackaged = false }) {
  const stagingDir = () => path.join(appDir, STAGE_DIR_NAME);
  // state: idle → available → downloading → staged（→ applying，仅内存瞬时）
  let state = 'idle';
  let lastCheck = null; // 最近一次 checkNow 结果
  let depsChanged = false;

  const broadcast = (ch, payload) => { try { onBroadcast && onBroadcast(ch, payload); } catch { /* ignore */ } };
  const setState = (s) => { state = s; };

  /** 查询最新版本信息。ISLAND_UPDATE_URL 可覆盖 manifest 地址（测试/离线演示用） */
  async function fetchManifest() {
    const override = process.env.ISLAND_UPDATE_URL;
    if (override) {
      const m = await fetchJSON(override);
      return { version: m.version, tarball: m.dist && m.dist.tarball };
    }
    // 官方源失败降级 npmmirror（国内直连通常更稳）
    for (const base of [REGISTRY_PRIMARY, REGISTRY_MIRROR]) {
      try {
        const m = await fetchJSON(base + '/' + PKG_NAME + '/latest');
        if (m && m.version) return { version: m.version, tarball: m.dist && m.dist.tarball };
      } catch { /* 尝试下一个源 */ }
    }
    throw new Error('无法连接 npm registry（官方源与镜像均失败）');
  }

  /** 检查更新，返回 { current, latest, hasUpdate, tarball, releasePage, packaged } */
  async function checkNow() {
    if (state === 'downloading') return lastCheck || { current: currentVersion, hasUpdate: false };
    setState(state === 'staged' ? state : 'idle');
    try {
      const m = await fetchManifest();
      const hasUpdate = compareVersions(currentVersion, m.version) < 0;
      lastCheck = {
        current: currentVersion,
        latest: m.version,
        hasUpdate,
        tarball: m.tarball,
        releasePage: NPM_PAGE,
        packaged: isPackaged,
      };
      if (hasUpdate) broadcast('update:found', { latest: m.version, current: currentVersion, packaged: isPackaged });
      return lastCheck;
    } finally {
      if (state !== 'staged') setState('idle');
    }
  }

  /** 下载 + 解压 + 校验，完成后进入 staged 状态 */
  async function installStaged() {
    // 打包版（asar + Program Files）不支持就地覆盖，引导走下载页
    if (isPackaged) {
      return { ok: false, packaged: true, reason: '安装版请在下载页获取新版本安装包' };
    }
    if (!lastCheck || !lastCheck.hasUpdate || !lastCheck.tarball) {
      return { ok: false, reason: '请先检查更新，确认有新版本后再安装' };
    }
    if (state === 'downloading' || state === 'staged') return { ok: true, depsChanged, staged: true };
    const stage = stagingDir();
    setState('downloading');
    try {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      const tgz = path.join(stage, 'pkg.tgz');

      // —— 下载（有 content-length 时按百分比广播进度）——
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 120000);
      const res = await fetch(lastCheck.tarball, { signal: ctl.signal });
      if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
      const total = Number(res.headers.get('content-length') || 0);
      let received = 0;
      const chunks = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;
        if (total > 0) {
          broadcast('update:progress', { phase: 'download', pct: Math.round((received / total) * 100) });
        }
      }
      clearTimeout(timer);
      fs.writeFileSync(tgz, Buffer.concat(chunks));
      broadcast('update:progress', { phase: 'extract' });

      // —— 系统 tar 解压（Windows 10 1803+ 自带 bsdtar；macOS 自带 tar）——
      const r = spawnSync(tarBin(), ['-xzf', tgz, '-C', stage], { stdio: 'ignore' });
      if (r.error) throw new Error('无法调用系统 tar：' + r.error.message);
      if (r.status !== 0) throw new Error('tar 解压失败（退出码 ' + r.status + '）');

      // —— 校验暂存包版本与 manifest 一致 ——
      const stagedPkgPath = path.join(stage, 'package', 'package.json');
      if (!fs.existsSync(stagedPkgPath)) throw new Error('暂存包内容异常：缺少 package/package.json');
      const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
      if (stagedPkg.version !== lastCheck.latest) {
        throw new Error('暂存包版本不一致：期望 ' + lastCheck.latest + '，实际 ' + stagedPkg.version);
      }
      const curPkgPath = path.join(appDir, 'package.json');
      const curPkg = fs.existsSync(curPkgPath)
        ? JSON.parse(fs.readFileSync(curPkgPath, 'utf8'))
        : {};
      depsChanged = !depsEqual(curPkg.dependencies, stagedPkg.dependencies);

      setState('staged');
      broadcast('update:staged', { latest: lastCheck.latest, depsChanged });
      return { ok: true, depsChanged, staged: true };
    } catch (err) {
      setState('idle');
      const message = String(err && err.message || err);
      broadcast('update:error', { message });
      return { ok: false, reason: message };
    }
  }

  /**
   * 应用暂存更新：拷贝覆盖 appDir（跳过 node_modules 等），清理暂存区。
   * relaunch 只负责返回意图，重启动作由调用方（ipc.js）执行，
   * 这样单测可以在临时目录里验证拷贝而不真正退出进程。
   */
  function applyStaged() {
    if (state !== 'staged') return { ok: false, reason: '没有已就绪的更新' };
    const from = path.join(stagingDir(), 'package');
    if (!fs.existsSync(from)) return { ok: false, reason: '暂存区已不存在，请重新检查更新' };
    copyTreeSync(from, appDir, SKIP_COPY);
    fs.rmSync(stagingDir(), { recursive: true, force: true });
    setState('idle');
    lastCheck = null;
    return { ok: true, depsChanged, relaunch: true };
  }

  /** 当前状态快照（供面板重开时恢复 UI，不发网络请求） */
  function getStatus() {
    return {
      state,
      current: currentVersion,
      latest: lastCheck ? lastCheck.latest : null,
      hasUpdate: !!(lastCheck && lastCheck.hasUpdate),
      depsChanged,
      releasePage: NPM_PAGE,
      packaged: isPackaged,
    };
  }

  return { checkNow, installStaged, applyStaged, getStatus, copyTreeSync, SKIP_COPY };
}

module.exports = { createUpdater, copyTreeSync, depsEqual, SKIP_COPY, STAGE_DIR_NAME, NPM_PAGE };
