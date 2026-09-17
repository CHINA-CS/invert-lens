const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lensAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  probeCapture: () => ipcRenderer.invoke('probe-capture'),
  requestBounds: (bounds) => ipcRenderer.invoke('set-bounds', bounds),
  persistBounds: (bounds) => ipcRenderer.send('persist-bounds', bounds),
  onInit: (cb) => ipcRenderer.on('init', (_e, data) => cb(data)),
  onBounds: (cb) => ipcRenderer.on('window-bounds', (_e, data) => cb(data)),
  onMode: (cb) => ipcRenderer.on('set-mode', (_e, mode) => cb(mode)),
  onInteractive: (cb) => ipcRenderer.on('set-interactive', (_e, on) => cb(on)),
  onCursorLocal: (cb) => ipcRenderer.on('cursor-local', (_e, pos) => cb(pos)),
  onWake: (cb) => ipcRenderer.on('wake', () => cb()),
  onSleep: (cb) => ipcRenderer.on('sleep', () => cb()),
  onRefreshFreeze: (cb) => ipcRenderer.on('refresh-freeze', () => cb()),
  onToggleEffect: (cb) => ipcRenderer.on('toggle-effect', () => cb()),
  reportMode: (mode) => ipcRenderer.send('report-mode', mode),
  reportCaptureMode: (mode) => ipcRenderer.send('report-capture-mode', mode),
  reportBrightness: (pct) => ipcRenderer.send('report-brightness', pct),
});
