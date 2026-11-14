'use strict';
/**
 * IPC 处理器：屏蔽 / 恢复 / 查找 / 设置 / 系统操作
 */

const { dialog, shell, clipboard, BrowserWindow, ipcMain, app: electronApp } = require('electron');
const { restoreFile } = require('../core/fileproc');
const { restoreText } = require('../core/masker');
const importer = require('./importer');
const { COLLAPSE_MIN_SEC, COLLAPSE_MAX_SEC, DEFAULT_COLLAPSE_SEC } = require('./store');
const path = require('path');

function register(ctx) {
  const { store, island, indexer, clipboardWatcher, updater } = ctx;

  const ipc_handle = (channel, fn) => ipcMain.handle(channel, fn);

  /* ---------------- 设置 ---------------- */

  ipc_handle('settings:get', () => ({
    settings: store.settings,
    vaultEncrypted: store.vaultEncrypted,
    vaultSize: store.vault.size,
    vaultPath: store.paths.vaultBin,
    platform: process.platform,
    index: indexer.stats(),
    pillCollapsed: island.pillCollapsed, // 胶囊当前是否收起为顶部线段
    // 自动收起时长的合法范围由主进程统一给出，渲染层不硬编码
    collapseRange: {
      min: COLLAPSE_MIN_SEC,
      max: COLLAPSE_MAX_SEC,
      default: DEFAULT_COLLAPSE_SEC,
    },
  }));

  // 打开映射库文件夹（定位到映射库文件），供用户了解存储位置；需配合危害性提示
  ipc_handle('app:open-vault-folder', () => {
    shell.showItemInFolder(store.paths.vaultBin);
    return true;
  });

  ipc_handle('settings:set', async (_e, patch) => {
    const before = store.settings.rootDir;
    const next = store.saveSettings(patch || {});
    if (patch && 'rootDir' in patch && patch.rootDir !== before) {
      indexer.setRoot(next.rootDir);
    }
    if (patch && 'launchOnBoot' in patch) {
      try { app_ref().setLoginItemSettings({ openAtLogin: !!next.launchOnBoot }); } catch { /* ignore */ }
    }
    island.broadcast('settings:changed', next);
    return next;
  });

  ipc_handle('dialog:pick-root', async (e) => {
    island.dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
        title: '选择文件根目录',
        properties: ['openDirectory'],
        defaultPath: store.settings.rootDir || undefined,
      });
      if (r.canceled || !r.filePaths[0]) return null;
      store.saveSettings({ rootDir: r.filePaths[0] });
      indexer.setRoot(r.filePaths[0]);
      island.broadcast('settings:changed', store.settings);
      return r.filePaths[0];
    } finally { island.dialogOpen = false; }
  });

  ipc_handle('dialog:pick-files', async (e) => {
    island.dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
        title: '选择要屏蔽的文件',
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled) return [];
      return importer.importAndMask(r.filePaths, ctx, e.sender);
    } finally { island.dialogOpen = false; }
  });

  /* ---------------- 屏蔽 / 恢复 ---------------- */

  ipc_handle('mask:files', (e, inputPaths) => {
    const paths = Array.isArray(inputPaths) ? inputPaths : [];
    return importer.importAndMask(paths, ctx, e.sender);
  });

  ipc_handle('mask:restore-file', (_e, maskedPath) => {
    try { return restoreFile(maskedPath, store.vault); }
    catch (err) { return { ok: false, path: maskedPath, skipped: 'error', reason: String(err && err.message || err) }; }
  });

  ipc_handle('mask:restore-text', (_e, text) => {
    if (typeof text !== 'string') return { text: '', resolved: 0, missing: [] };
    return restoreText(text, store.vault);
  });

  /* ---------------- 查找 ---------------- */

  // 第四个参数是渲染层的类别筛选（all/doc/sheet/text/code/other），必须透传给索引层
  ipc_handle('search:query', (_e, q, limit, category) => indexer.search(q, limit, category));
  ipc_handle('index:stats', () => indexer.stats());
  ipc_handle('index:rescan', () => { indexer.rescan(); return true; });

  /* ---------------- 历史 ---------------- */

  ipc_handle('history:list', () => store.history);
  ipc_handle('history:clear', () => { store.clearHistory(); island.broadcast('history:changed'); return true; });
  ipc_handle('history:remove', (_e, id) => { store.removeHistory(id); island.broadcast('history:changed'); return true; });

  /* ---------------- 剪贴板恢复 ---------------- */

  ipc_handle('clip:restore', () => {
    // 只针对「检测到屏蔽信息时的那一次复制内容」生效，不读取点击瞬间剪贴板里的其他内容
    const pending = clipboardWatcher.getPendingText();
    if (!pending) return { ok: false, resolved: 0, stale: true };
    let current = '';
    try { current = clipboard.readText(); } catch { /* ignore */ }
    if (current !== pending) {
      // 用户又复制了别的内容 → 丢弃旧提示，绝不改写当前剪贴板
      clipboardWatcher.markHandled(current);
      return { ok: false, resolved: 0, stale: true };
    }
    const r = restoreText(pending, store.vault);
    if (r.resolved > 0) {
      clipboard.writeText(r.text);
      // 还原流程自身会更新胶囊 UI，无需再广播一次 cleared
      clipboardWatcher.markHandled(r.text, true);
    }
    return { ok: r.resolved > 0, resolved: r.resolved, missing: r.missing, text: r.text };
  });

  /* ---------------- 剪贴板写入（面板常不抢焦点，渲染层写剪贴板不可靠，统一走主进程） ---------------- */

  ipc_handle('clipboard:write-text', (_e, text) => {
    if (typeof text !== 'string' || !text) return false;
    clipboard.writeText(text);
    return true;
  });

  /* ---------------- 系统操作 ---------------- */

  ipc_handle('app:open-path', (_e, p) => { shell.openPath(p); return true; });
  ipc_handle('app:reveal-path', (_e, p) => { shell.showItemInFolder(p); return true; });

  /* ---------------- 版本更新 ---------------- */

  // 手动检查更新（真实网络请求）
  ipc_handle('update:check', () => updater.checkNow());
  // 当前更新状态快照（不发网络请求，面板重开时恢复 UI）
  ipc_handle('update:status', () => updater.getStatus());
  // 下载并暂存新版本（update:progress / update:staged / update:error 广播进度）
  ipc_handle('update:install', () => updater.installStaged());
  // 应用暂存更新：拷贝覆盖 → 重启（before-quit 会先持久化映射库）
  ipc_handle('update:apply', () => {
    const r = updater.applyStaged();
    if (r.ok) {
      electronApp.relaunch();
      electronApp.exit(0);
    }
    return r;
  });
  // 打开 npm 包页（用户选择手动下载时）
  ipc_handle('update:open-page', () => { shell.openExternal(updater.getStatus().releasePage); return true; });
  ipc_handle('app:version', () => app_ref().getVersion());
  ipc_handle('app:quit', () => app_ref().quit());
  ipc_handle('panel:hide', () => { island.hidePanel(); return true; });
  ipc_handle('panel:show-tab', (_e, tab) => { island.showPanel(tab); return true; });
  ipc_handle('pill:expand', (_e, tab) => { island.onPillClick(tab); return true; });
  // 灵动岛收起（渲染端空闲计时到期）/ 展开（鼠标悬停顶部线段）
  ipc_handle('pill:collapse', () => { island.collapsePill(); return true; });
  ipc_handle('pill:peek', () => { island.expandPill(); return true; });
}

function app_ref() { return electronApp; }

module.exports = { register };
