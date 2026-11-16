'use strict';
/**
 * 灵屿岛 —— 应用入口
 */

const { app, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { Island } = require('./island');
const { Indexer } = require('./indexer');
const { ClipboardWatcher } = require('./clipboard');
const { register } = require('./ipc');
const { createUpdater } = require('./updater');
const { createAutoUpdater } = require('./electron-updater');
const { createTray } = require('./tray');

// E2E 跑测试时使用独立 userData：不与正在运行的应用实例争单实例锁/磁盘缓存
if (process.env.ISLAND_E2E) {
  app.setPath('userData', path.join(app.getPath('temp'), 'lingyu-e2e-userdata'));
}

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId('com.yu.dynamic-island');

// macOS：作为托盘工具，不占用 Dock 图标
if (process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

// macOS 需要应用菜单提供编辑快捷键（Cmd+C/V/X）；Windows 使用无边框窗口，移除菜单
if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
} else {
  Menu.setApplicationMenu(null);
}

// 关闭硬件加速问题排查开关（默认开启加速；透明窗在部分驱动下需软渲染，按需调整）
// app.disableHardwareAcceleration();

let store, island, indexer, clipboardWatcher, tray, updater;

app.whenReady().then(() => {
  store = new Store();
  store.init();

  island = new Island();
  island.setUiScale(store.settings.uiScale);
  island.create();
  island.pill.webContents.on('did-finish-load', () => island.pill.showInactive());

  indexer = new Indexer();
  indexer.onUpdate(() => island.broadcast('index:updated', indexer.stats()));
  indexer.setRoot(store.settings.rootDir);

  clipboardWatcher = new ClipboardWatcher();
  clipboardWatcher.start(
    () => store.settings.clipboardWatch,
    (info) => island.broadcast('clip:found', info),
    () => island.broadcast('clip:cleared')
  );

  // 双后端更新器：安装版（asar 只读）走 electron-updater（GitHub Releases，
  // 下载 Setup 静默安装 + 重启）；源码直跑保留 npm 包覆盖机制。接口完全一致。
  updater = app.isPackaged
    ? createAutoUpdater({
        currentVersion: app.getVersion(),
        onBroadcast: (ch, payload) => island.broadcast(ch, payload),
      })
    : createUpdater({
        appDir: path.resolve(__dirname, '..', '..'),
        currentVersion: app.getVersion(),
        onBroadcast: (ch, payload) => island.broadcast(ch, payload),
        isPackaged: app.isPackaged,
      });

  register({ store, island, indexer, clipboardWatcher, updater });

  tray = createTray(island, store);

  // 启动后延迟自动检查更新（E2E 绝不发真实网络请求）
  if (!process.env.ISLAND_E2E) {
    setTimeout(() => {
      updater.checkNow().catch(() => { /* 静默：更新检查失败不打扰用户 */ });
    }, 5000);
  }

  // 第二次启动实例 → 聚焦面板
  app.on('second-instance', () => island.showPanel());

  // 开机自启设置同步
  if (store.settings.launchOnBoot) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  // E2E 自动化测试入口
  if (process.env.ISLAND_E2E) {
    require('../../test/e2e').run({ store, island, indexer, updater });
  }
});

// 保持常驻（托盘应用），窗口全部关闭不退出
app.on('window-all-closed', () => { /* keep running */ });
app.on('before-quit', () => {
  try {
    if (store) store.persistVault();
    if (indexer) indexer._closeWatch();
  } catch { /* ignore */ }
});
