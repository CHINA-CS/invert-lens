const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  nativeImage,
  desktopCapturer,
  session,
} = require('electron');
const path = require('path');
const fs = require('fs');

const STATE_PATH = path.join(app.getPath('userData'), 'lens-state.json');

let win = null;
let tray = null;
let hidden = false;

const MODES = ['off', 'invert', 'gray', 'combo'];
const MODE_LABELS = {
  off: '原样',
  invert: '反色',
  gray: '灰度',
  combo: '反色+灰度',
};

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 560;
  const height = 360;
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveState(partial) {
  try {
    const prev = loadState();
    const next = { ...prev, ...partial };
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(next), 'utf8');
  } catch (err) {
    console.error('save state failed', err);
  }
}

function createTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - 7.5;
      const dy = y - 7.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const on = d > 3 && d < 7;
      buf[i] = on ? 240 : 20;
      buf[i + 1] = on ? 240 : 20;
      buf[i + 2] = on ? 240 : 20;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const mode = loadState().mode || 'combo';
  const menu = Menu.buildFromTemplate([
    { label: hidden ? '显示镜片' : '隐藏镜片', click: () => toggleVisible() },
    { type: 'separator' },
    {
      label: '滤镜模式',
      submenu: MODES.map((m) => ({
        label: MODE_LABELS[m],
        type: 'radio',
        checked: mode === m,
        click: () => setMode(m),
      })),
    },
    {
      label: '重置位置',
      click: () => {
        const b = defaultBounds();
        if (win) {
          win.setBounds(b);
          saveState({ bounds: b });
          sendBounds();
        }
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(
    `反色滤镜片 · ${MODE_LABELS[mode] || mode}\nCtrl+Alt+C 唤出/隐藏`
  );
}

function sendBounds() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  win.webContents.send('window-bounds', {
    bounds,
    display: {
      id: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    },
    interactive,
  });
}

function setMode(mode) {
  if (!MODES.includes(mode)) return;
  saveState({ mode });
  if (win && !win.isDestroyed()) {
    win.webContents.send('set-mode', mode);
  }
  rebuildTrayMenu();
}

function cycleMode() {
  const current = loadState().mode || 'combo';
  const idx = MODES.indexOf(current);
  setMode(MODES[(idx + 1) % MODES.length]);
}

let interactive = false;

const TOP_ZONE = 110; // 覆盖拖拽条 + 整行工具栏（含亮度滑杆）
const EDGE_ZONE = 10;

function setInteractive(on, notifyRenderer) {
  const next = !!on;
  if (next === interactive) return;
  interactive = next;
  if (!win || win.isDestroyed()) return;
  try {
    if (interactive) {
      win.setIgnoreMouseEvents(false);
    } else {
      win.setIgnoreMouseEvents(true, { forward: false });
    }
  } catch (err) {
    console.error('setIgnoreMouseEvents failed', err);
  }
  if (notifyRenderer !== false) {
    win.webContents.send('set-interactive', interactive);
  }
}

/**
 * 轮询光标：顶栏/边缘 → 接管；中部穿透。
 * 并把窗口内坐标发给渲染层，用于从截屏画面里抹掉指针像素。
 */
function startCursorWatch() {
  let lastSent = 0;
  setInterval(() => {
    if (!win || win.isDestroyed() || hidden || !win.isVisible()) return;
    if (win.isMinimized()) return;

    let b;
    try {
      b = win.getBounds();
    } catch (_) {
      return;
    }

    const p = screen.getCursorScreenPoint();
    const over =
      p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

    if (!over) {
      setInteractive(false);
      const t0 = Date.now();
      if (t0 - lastSent > 80) {
        lastSent = t0;
        win.webContents.send('cursor-local', null);
      }
      return;
    }

    const rx = p.x - b.x;
    const ry = p.y - b.y;
    const hot =
      ry <= TOP_ZONE ||
      ry >= b.height - EDGE_ZONE ||
      rx <= EDGE_ZONE ||
      rx >= b.width - EDGE_ZONE;

    setInteractive(hot);

    const t = Date.now();
    if (t - lastSent >= 16) {
      lastSent = t;
      win.webContents.send('cursor-local', { x: rx, y: ry });
    }
  }, 16);
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (hidden || !win.isVisible()) {
    // 先钉截屏排除，再显示，减少唤出瞬间的反色反馈闪烁
    applyContentProtection();
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
    } catch (_) {}
    win.show();
    applyContentProtection();
    try {
      win.focus();
      win.moveTop();
    } catch (_) {}
    hidden = false;
    win.webContents.send('wake');
  } else {
    win.hide();
    hidden = true;
    setInteractive(false);
    win.webContents.send('sleep');
  }
  rebuildTrayMenu();
}

function applyContentProtection() {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
  } catch (_) {}
}

function createWindow() {
  const state = loadState();
  const bounds =
    state.bounds && typeof state.bounds === 'object'
      ? state.bounds
      : defaultBounds();

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: Math.max(160, bounds.width || 560),
    height: Math.max(120, bounds.height || 360),
    frame: false,
    // 不用透明窗：透明 + 置顶 + 截屏排除在 Win 上更容易 DWM 闪烁
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 把本窗口从系统截屏里排除，避免「反色结果再被拍进来」黑白乱跳
  applyContentProtection();

  // 默认穿透；光标轮询会在顶栏/边缘接管
  interactive = false;
  try {
    win.setIgnoreMouseEvents(true, { forward: false });
  } catch (_) {}

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  let lastSentBounds = null;
  let boundsTimer = 0;

  const sendBoundsThrottled = (immediate) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const key = `${b.x},${b.y},${b.width},${b.height}`;
    if (key === lastSentBounds && !immediate) return;
    lastSentBounds = key;
    sendBounds();
  };

  win.once('ready-to-show', () => {
    win.show();
    applyContentProtection();
    // 显示后再钉一次，部分系统要 HWND 就绪才生效
    setTimeout(applyContentProtection, 300);
    setTimeout(applyContentProtection, 1500);

    const mode = state.mode || 'combo';
    const bright =
      typeof state.brightness === 'number'
        ? Math.min(100, Math.max(10, Math.round(state.brightness)))
        : 100;
    win.webContents.send('init', {
      mode: MODES.includes(mode) ? mode : 'combo',
      captureMode: state.captureMode === 'freeze' ? 'freeze' : 'live',
      brightness: bright,
      bounds: win.getBounds(),
    });
    sendBoundsThrottled(true);
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    if (!win.isVisible()) return;
    saveState({ bounds: win.getBounds() });
  };

  // 拖动时节流 sendBounds，避免渲染层被刷爆
  win.on('move', () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => sendBoundsThrottled(true), 16);
    persistBounds();
  });
  win.on('moved', () => {
    persistBounds();
    sendBoundsThrottled(true);
  });
  win.on('resize', () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => sendBoundsThrottled(true), 16);
    persistBounds();
  });
  win.on('resized', () => {
    persistBounds();
    sendBoundsThrottled(true);
  });
  win.on('show', () => {
    applyContentProtection();
    sendBoundsThrottled(true);
  });

  win.on('closed', () => {
    win = null;
  });
}

function requestFreezeRefresh() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('refresh-freeze');
  }
}

function toggleEffectShortcut() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('toggle-effect');
  }
}

function registerShortcuts() {
  const list = [
    // 主唤出/隐藏键
    ['CommandOrControl+Alt+C', toggleVisible],
    ['CommandOrControl+Shift+Z', toggleVisible],
    ['CommandOrControl+Shift+I', cycleMode],
    ['CommandOrControl+Shift+E', toggleEffectShortcut],
    ['CommandOrControl+Shift+R', requestFreezeRefresh],
    ['CommandOrControl+Shift+H', toggleVisible],
    ['CommandOrControl+Shift+Q', () => app.quit()],
  ];
  for (const [accel, fn] of list) {
    try {
      globalShortcut.register(accel, fn);
    } catch (err) {
      console.error('shortcut failed', accel, err);
    }
  }
}

/** 当前镜片所在的显示器 */
function currentDisplay() {
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(win.getBounds());
}

/**
 * 在 desktopCapturer 源里挑出与 displayId 对应的那块屏。
 * 1) display_id 精确匹配
 * 2) name 里带 Screen N / 显示器 N，按显示器顺序对齐
 * 3) 按 all-displays 的索引顺序对齐
 */
function pickSourceForDisplay(sources, displays, displayId) {
  if (!sources || !sources.length) return null;
  if (displayId != null) {
    const byId = sources.find(
      (s) => String(s.display_id) === String(displayId)
    );
    if (byId) return byId;
  }

  const idx = displays.findIndex((d) => d.id === displayId);
  if (idx >= 0) {
    // Windows 常见：Screen 1 / Screen 2 与显示器顺序一致
    const byName = sources.find((s) => {
      const m = /(?:screen|display|显示器)\s*(\d+)/i.exec(s.name || '');
      return m && Number(m[1]) === idx + 1;
    });
    if (byName) return byName;
    if (sources[idx]) return sources[idx];
  }

  return sources[0];
}

async function getScreenSources(thumbnailWidth = 0) {
  return desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: thumbnailWidth
      ? { width: thumbnailWidth, height: Math.round(thumbnailWidth * 0.5625) }
      : { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
}

// getDisplayMedia：按「镜片当前所在显示器」供源，而不是永远主屏
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const displays = screen.getAllDisplays();
        const target = currentDisplay();
        const sources = await getScreenSources(0);
        if (!sources || !sources.length) {
          callback({});
          return;
        }
        const chosen = pickSourceForDisplay(sources, displays, target.id);
        callback({ video: chosen, enableLocalEcho: false });
      } catch (err) {
        console.error('display media handler error', err);
        try {
          callback({});
        } catch (_) {}
      }
    },
    { useSystemPicker: false }
  );
}

ipcMain.handle('set-bounds', async (_e, bounds) => {
  if (!win || win.isDestroyed() || !bounds) return false;
  const next = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(160, Math.round(bounds.width)),
    height: Math.max(120, Math.round(bounds.height)),
  };
  win.setBounds(next);
  return true;
});

ipcMain.on('persist-bounds', (_e, bounds) => {
  if (!win || win.isDestroyed() || !bounds) return;
  saveState({
    bounds: {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(160, Math.round(bounds.width)),
      height: Math.max(120, Math.round(bounds.height)),
    },
  });
});

ipcMain.handle('get-sources', async () => {
  const displays = screen.getAllDisplays();
  const sources = await getScreenSources(0);
  const target = currentDisplay();
  const picked = pickSourceForDisplay(sources, displays, target.id);
  return {
    activeDisplayId: target.id,
    pickedSourceId: picked ? picked.id : null,
    displays: displays.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      label: d.label || '',
      isPrimary: d.id === screen.getPrimaryDisplay().id,
    })),
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      display_id: s.display_id,
    })),
  };
});

// 供渲染层调试用
ipcMain.handle('probe-capture', async () => {
  try {
    const sources = await getScreenSources(64);
    const displays = screen.getAllDisplays();
    const target = currentDisplay();
    const picked = pickSourceForDisplay(sources, displays, target.id);
    return {
      ok: sources.length > 0,
      count: sources.length,
      activeDisplayId: target.id,
      pickedSourceId: picked ? picked.id : null,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        display_id: s.display_id,
      })),
      displays: displays.map((d) => ({
        id: d.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
        isPrimary: d.id === screen.getPrimaryDisplay().id,
      })),
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.on('report-mode', (_e, mode) => {
  if (MODES.includes(mode)) {
    saveState({ mode });
    rebuildTrayMenu();
  }
});

ipcMain.on('report-capture-mode', (_e, mode) => {
  if (mode === 'freeze' || mode === 'live') {
    saveState({ captureMode: mode });
  }
});

ipcMain.on('report-brightness', (_e, pct) => {
  const n = Math.round(Number(pct));
  if (Number.isFinite(n)) {
    saveState({ brightness: Math.min(100, Math.max(10, n)) });
  }
});

ipcMain.on('set-interactive', (_e, on) => {
  setInteractive(!!on);
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.mimo.invertlens');
  }

  setupDisplayMediaHandler();
  createWindow();
  startCursorWatch();
  tray = new Tray(createTrayIcon());
  rebuildTrayMenu();
  tray.on('click', () => {
    if (process.platform === 'win32') rebuildTrayMenu();
  });

  registerShortcuts();

  screen.on('display-metrics-changed', () => sendBounds());
  screen.on('display-added', () => sendBounds());
  screen.on('display-removed', () => sendBounds());
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
