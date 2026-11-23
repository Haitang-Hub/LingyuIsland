'use strict';
/**
 * 灵屿岛 —— 应用入口
 */

const { app, Menu, protocol, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('node:url');

const { Store } = require('./store');
const { Island } = require('./island');
const { Indexer } = require('./indexer');
const { ClipboardWatcher } = require('./clipboard');
const { FullscreenWatch } = require('./fullscreen-watch');
const { register } = require('./ipc');
const { createUpdater } = require('./updater');
const { createAutoUpdater } = require('./electron-updater');
const { createTray } = require('./tray');
const { BG_FILE_RE } = require('../core/appearance');

// islandbg:// 协议：面板自定义背景（图片/视频）从 userData/appearance 安全读取。
// standard 协议必须 Relative URL 以 host 形式解析（islandbg://bg/<file>），
// 且必须在 app ready 之前注册 privileged schemes。
protocol.registerSchemesAsPrivileged([
  { scheme: 'islandbg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** islandbg://bg/<file> → userData/appearance/<file>；白名单文件名，杜绝目录穿越 */
function registerAppearanceProtocol(store) {
  protocol.handle('islandbg', (request) => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== 'bg') return new Response(null, { status: 404 });
      const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!BG_FILE_RE.test(name)) return new Response(null, { status: 404 });
      const file = path.join(store.paths.appearanceDir, name);
      if (!fs.existsSync(file)) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

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

let store, island, indexer, clipboardWatcher, tray, updater, fullscreenWatch;

app.whenReady().then(() => {
  store = new Store();
  store.init();

  // 背景协议依赖 store.paths，ready 后注册
  registerAppearanceProtocol(store);

  island = new Island();
  // 密度按外观设置初始化（档位由布局层钳制，不会越出屏幕）
  island.setPanelSize(store.settings.appearance.panel);
  // 灵动岛位置：启动时恢复上次拖动换位保存的比例
  island.pillX = Number(store.settings.appearance.pillX) || 0.5;
  // 字体档位：启动时恢复（胶囊宽度按档位伸缩）
  island.fontScale = Number(store.settings.appearance.fontScale) || 1;
  // 拖动换位结束 → 写回外观设置并广播（面板/胶囊同步）
  island.onPillOffsetChange = (ratio) => {
    const next = store.saveSettings({ appearance: { pillX: ratio } });
    island.broadcast('settings:changed', next);
  };
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

  // 全屏/截图让位探测：前台窗口铺满主屏（全屏应用或截图遮罩）时，
  // 按「全屏时自动隐藏」开关让胶囊/面板让位；期间置顶看门狗停止抢位。
  island.fullscreenAutoHide = store.settings.fullscreenAutoHide !== false;
  fullscreenWatch = new FullscreenWatch({
    getPrimaryBounds: () => {
      try { return screen.getPrimaryDisplay().bounds; } catch { return null; }
    },
    onChange: (active, overlay) => island.setFullscreen(active, overlay),
  });
  // E2E 模式下不启动探测：自动化测试跑在前台覆盖窗口里，全屏判定会干扰断言。
  // 探测恒开（截图遮罩让位不受开关影响）；「全屏时自动隐藏」开关只在 island 内部起作用。
  if (!process.env.ISLAND_E2E) fullscreenWatch.start();

  register({ store, island, indexer, clipboardWatcher, updater, fullscreenWatch });

  tray = createTray(island, store);

  // 启动后延迟自动检查更新（E2E 绝不发真实网络请求）
  if (!process.env.ISLAND_E2E) {
    setTimeout(() => {
      updater.checkNow().catch(() => { /* 静默：更新检查失败不打扰用户 */ });
    }, 5000);
  }

  // 第二次启动实例（如再次双击快捷方式）→ 展开胶囊并聚焦面板。
  // 胶囊无操作 20 秒会自动收起为顶部细线，仅 showPanel 会让用户以为「胶囊没弹出来」，
  // 所以先把胶囊从线段展开，再打开面板（expandPill 在展开态下自会跳过）。
  app.on('second-instance', () => {
    island.expandPill();
    island.showPanel();
  });

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
    if (fullscreenWatch) fullscreenWatch.stop();
    // 遮盖工作进程与常驻 OCR 引擎随退出释放
    require('./redactpool').getRedactPool().dispose();
    require('../core/pdfredact').disposeOcrEngine();
  } catch { /* ignore */ }
});
