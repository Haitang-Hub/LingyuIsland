'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_CHANNELS = new Set([
  'settings:get', 'settings:set',
  'dialog:pick-bg', 'appearance:clear-bg',
  'dialog:pick-root', 'dialog:pick-files',
  'mask:files', 'mask:restore-file', 'mask:restore-text',
  'search:query', 'index:stats', 'index:rescan',
  'history:list', 'history:clear', 'history:remove',
  'clip:restore',
  'clipboard:write-text',
  'app:open-path', 'app:reveal-path', 'app:version', 'app:quit',
  'app:open-vault-folder',
  'update:check', 'update:status', 'update:install', 'update:apply', 'update:open-page',
  'panel:hide', 'panel:show-tab', 'pill:expand', 'pill:collapse', 'pill:peek', 'pill:hide',
]);

const SEND_CHANNELS = new Set([
  'clip:found', 'clip:cleared', 'mask:progress', 'mask:converting', 'mask:done',
  'index:updated', 'settings:changed', 'panel:show-tab', 'history:changed',
  'pill:state', 'panel:state', 'pill:hover-sync', 'panel:enter', 'panel:exit',
  'update:found', 'update:progress', 'update:staged', 'update:error',
]);

contextBridge.exposeInMainWorld('island', {
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.has(channel)) throw new Error('channel denied: ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, callback) => {
    if (!SEND_CHANNELS.has(channel)) throw new Error('channel denied: ' + channel);
    const listener = (_e, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** 拖放的 File 对象 → 磁盘路径（Electron 32+ 需 webUtils） */
  filePath(file) {
    try { return webUtils.getPathForFile(file); }
    catch { return file && file.path ? file.path : null; }
  },
});
