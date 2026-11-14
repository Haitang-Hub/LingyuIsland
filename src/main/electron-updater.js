'use strict';
/**
 * 安装版更新后端：基于 electron-updater，更新源为 GitHub Releases。
 *
 * 与 src/main/updater.js（源码直跑后端）保持同一接口：
 *   { checkNow, install, apply, getStatus }
 * 广播通道也复用同一组：update:found / update:progress / update:staged / update:error，
 * 面板 UI 不感知后端差异。
 *
 * 说明：electron-updater 只在打包版下可用（dev 下 App 不带 app-update.yml）。
 * 流程：检查更新 → 「立即更新」触发下载（含进度）→ 下载完成 → 「重启完成安装」
 * → quitAndInstall(false, true) 静默安装并重启（before-quit 先持久化映射库）。
 */

const { autoUpdater } = require('electron-updater');

const RELEASES_PAGE = 'https://github.com/Haitang-Hub/LingyuIsland/releases/latest';

function createAutoUpdater({ currentVersion, onBroadcast, feedUrl } = {}) {
  // state: idle → available → downloading → staged（与源码后端状态机一致）
  let state = 'idle';
  let lastCheck = null;

  const broadcast = (ch, payload) => { try { onBroadcast && onBroadcast(ch, payload); } catch { /* ignore */ } };
  const setState = (s) => { state = s; };

  // feed 覆盖：ISLAND_UPDATE_FEED 环境变量 / 构造参数（镜像或测试用）
  const override = feedUrl || process.env.ISLAND_UPDATE_FEED;
  if (override) {
    autoUpdater.setFeedURL({ provider: 'generic', url: override });
  }
  autoUpdater.autoDownload = false;        // 点「立即更新」才下载
  autoUpdater.autoInstallOnAppQuit = false; // 只走「重启完成安装」按钮
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('download-progress', (p) => {
    broadcast('update:progress', { phase: 'download', pct: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setState('staged');
    broadcast('update:staged', { latest: info.version, depsChanged: false });
  });
  autoUpdater.on('error', (err) => {
    if (state === 'downloading') {
      setState('idle');
      broadcast('update:error', { message: String(err && err.message || err) });
    }
  });
  autoUpdater.on('update-available', (info) => {
    // 事件侧兜底记录 latest（checkForUpdates 的 Promise 也会带）
    lastCheck = {
      ...(lastCheck || {}),
      latest: info.version,
      hasUpdate: true,
      packaged: true,
      releasePage: RELEASES_PAGE,
    };
  });

  /** 把 electron-updater 的网络错误翻译成用户能看懂的中文 */
  function friendlyError(err) {
    const raw = String(err && err.message || err);
    if (/ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ENOTFOUND|ECONNRESET|ETIMEDOUT|timeout/i.test(raw)) {
      return '无法连接更新服务器（GitHub）。请检查网络或代理后重试，也可点「打开下载页」手动下载安装包。';
    }
    if (/404/.test(raw)) return '更新服务器上暂时没有找到版本信息，请稍后重试。';
    return '检查更新失败：' + raw.slice(0, 80);
  }

  /** 检查更新：返回 { current, latest, hasUpdate, packaged, releasePage } */
  async function checkNow() {
    if (state === 'downloading') return lastCheck || { current: currentVersion, hasUpdate: false, packaged: true };
    setState('idle');
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result && result.updateInfo;
      const latest = info && info.version;
      const hasUpdate = !!latest && latest !== currentVersion;
      lastCheck = {
        current: currentVersion,
        latest,
        hasUpdate,
        tarball: null, // electron-updater 自管下载，不暴露 tarball
        releasePage: RELEASES_PAGE,
        packaged: true,
      };
      if (hasUpdate) {
        broadcast('update:found', { latest, current: currentVersion, packaged: true });
      }
      return lastCheck;
    } catch (err) {
      setState('idle');
      const message = friendlyError(err);
      // 不广播 update:error：启动时的自动检查应保持静默；手动检查经返回值 error 字段提示
      return { current: currentVersion, latest: null, hasUpdate: false, error: message, packaged: true, releasePage: RELEASES_PAGE };
    }
  }

  /** 下载新版本（进度经 update:progress 广播），完成后进入 staged */
  async function install() {
    if (!lastCheck || !lastCheck.hasUpdate) {
      return { ok: false, reason: '请先检查更新，确认有新版本后再下载' };
    }
    if (state === 'downloading' || state === 'staged') {
      return { ok: true, staged: state === 'staged', depsChanged: false, packaged: true };
    }
    setState('downloading');
    try {
      await autoUpdater.downloadUpdate(); // update-downloaded 事件负责置 staged 并广播
      if (state !== 'staged') { // 事件竞态兜底
        setState('staged');
        broadcast('update:staged', { latest: lastCheck.latest, depsChanged: false });
      }
      return { ok: true, staged: true, depsChanged: false, packaged: true };
    } catch (err) {
      setState('idle');
      const message = friendlyError(err);
      broadcast('update:error', { message });
      return { ok: false, reason: message, packaged: true };
    }
  }

  /** 重启并静默安装（NSIS /S + 完成后自动重启；before-quit 先持久化映射库） */
  function apply() {
    if (state !== 'staged') return { ok: false, reason: '没有已下载完成的更新' };
    setImmediate(() => {
      try { autoUpdater.quitAndInstall(false, true); } catch { /* 安装器接管进程 */ }
    });
    return { ok: true, relaunch: true, packaged: true };
  }

  /** 状态快照（不发网络请求，面板重开时恢复 UI） */
  function getStatus() {
    return {
      state,
      current: currentVersion,
      latest: lastCheck ? lastCheck.latest : null,
      hasUpdate: !!(lastCheck && lastCheck.hasUpdate),
      depsChanged: false,
      releasePage: RELEASES_PAGE,
      packaged: true,
    };
  }

  return { checkNow, install, apply, getStatus };
}

module.exports = { createAutoUpdater, RELEASES_PAGE };
