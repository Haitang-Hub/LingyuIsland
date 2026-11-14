'use strict';
/**
 * 托盘：显示/隐藏灵动岛（隐藏=收起为顶部线段）、打开面板、退出
 * 菜单在灵动岛状态变化后重建，保证「隐藏/显示灵动岛」文案始终正确
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

function createTray(island, store) {
  // macOS 使用黑白模板图标（随系统深浅色自适应）；Windows 使用彩色图标
  const iconName = process.platform === 'darwin' ? 'tray-macTemplate.png' : 'tray.png';
  const iconPath = path.join(__dirname, '..', '..', 'assets', iconName);
  let icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  if (icon.isEmpty()) {
    // 兜底：空图，避免托盘创建失败
    icon = nativeImage.createEmpty();
  }
  const tray = new Tray(icon);
  tray.setToolTip('灵屿岛');

  const buildMenu = () => Menu.buildFromTemplate([
    { label: '灵动岛面板', click: () => island.togglePanel() },
    {
      label: island._pillVisible ? '隐藏灵动岛' : '显示灵动岛',
      click: () => island.setPillVisible(!island._pillVisible),
    },
    { type: 'separator' },
    {
      label: '文件根目录快速查找',
      click: () => island.showPanel('search'),
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: store.settings.launchOnBoot,
      click: (item) => {
        store.saveSettings({ launchOnBoot: item.checked });
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]);

  const rebuild = () => tray.setContextMenu(buildMenu());
  rebuild();
  // 收起/展开后重建菜单，刷新「隐藏/显示灵动岛」文案
  island.onPillStateChange = rebuild;

  tray.on('click', () => island.togglePanel());
  return tray;
}

module.exports = { createTray };
