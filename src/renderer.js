(() => {
  const frame = document.getElementById('frame');
  const video = document.getElementById('screen-video');
  const view = document.getElementById('view-canvas');
  const emptyHint = document.getElementById('empty-hint');
  const btnEffect = document.getElementById('btn-effect');
  const btnMode = document.getElementById('btn-mode');
  const btnCapture = document.getElementById('btn-capture');
  const btnRefresh = document.getElementById('btn-refresh');
  const dragBar = document.getElementById('drag-bar');
  const viewport = document.getElementById('viewport');
  const brightnessInput = document.getElementById('brightness');
  const brightnessLabel = document.getElementById('brightness-label');
  const ctx = view.getContext('2d', { willReadFrequently: false });

  const MODES = ['off', 'invert', 'gray', 'combo'];
  const MODE_LABELS = {
    off: '关闭',
    invert: '仅反色',
    gray: '仅灰度',
    combo: '反色+灰度',
  };

  const MIN_W = 180;
  const MIN_H = 140;
  // 覆盖 Windows 箭头指针热区
  const CUR_PAD = 28;

  let mode = 'combo';
  let effectOn = true;
  let brightness = 100;
  let captureMode = 'live';
  let bounds = { x: 0, y: 0, width: 560, height: 360 };
  let display = null;
  let stream = null;
  let starting = false;
  let streamReady = false;
  let failCount = 0;
  let drag = null;
  let lastStreamDisplayId = null;
  let switchTimer = 0;
  let interactive = false;
  let lastInteractive = null;
  let cursorLocal = null;
  let lastDrawKey = '';
  let frozenFrame = null; // 冻结用的离屏帧

  // ---------- 滤镜 ----------
  function applyFilters() {
    const parts = [];
    if (effectOn && mode !== 'off') {
      if (mode === 'invert' || mode === 'combo') parts.push('invert(1)');
      if (mode === 'gray' || mode === 'combo') parts.push('grayscale(1)');
      if (brightness !== 100) parts.push(`brightness(${(brightness / 100).toFixed(2)})`);
    }
    view.style.filter = parts.length ? parts.join(' ') : 'none';
  }

  function applyUi() {
    frame.dataset.mode = mode;
    frame.dataset.effect = effectOn ? 'on' : 'off';
    frame.dataset.capture = captureMode;
    frame.dataset.interactive = interactive ? 'true' : 'false';
    applyFilters();

    btnEffect.textContent = effectOn ? '滤镜' : '滤镜关';
    btnEffect.classList.toggle('off-state', !effectOn);

    btnMode.textContent = mode === 'combo' ? '反灰' : MODE_LABELS[mode] || mode;
    btnMode.title = MODE_LABELS[mode] || mode;
    btnMode.classList.toggle('active', mode !== 'off' && effectOn);

    btnCapture.textContent = captureMode === 'freeze' ? '冻结' : '实时';
    btnCapture.classList.toggle('active', captureMode === 'live');
    btnRefresh.disabled = !streamReady && captureMode === 'freeze';

    if (brightnessInput) brightnessInput.value = String(brightness);
    if (brightnessLabel) brightnessLabel.textContent = `${brightness}%`;
  }

  function setMode(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    window.lensAPI?.reportMode?.(mode);
    applyUi();
  }

  function cycleMode() {
    const idx = MODES.indexOf(mode);
    setMode(MODES[(idx + 1) % MODES.length]);
  }

  function toggleEffect() {
    effectOn = !effectOn;
    applyUi();
  }

  function setBrightness(pct) {
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n)) return;
    brightness = Math.min(100, Math.max(10, n));
    window.lensAPI?.reportBrightness?.(brightness);
    applyUi();
  }

  function showHint(text, sticky) {
    emptyHint.textContent = text;
    emptyHint.classList.remove('hidden');
    clearTimeout(showHint._t);
    if (!sticky) {
      showHint._t = setTimeout(() => {
        if (streamReady) emptyHint.classList.add('hidden');
      }, 1200);
    }
  }

  function hideHint() {
    emptyHint.classList.add('hidden');
  }

  function applyInteractive(on) {
    const next = !!on;
    if (next === lastInteractive) return;
    lastInteractive = next;
    interactive = next;
    frame.dataset.interactive = interactive ? 'true' : 'false';
  }

  // ---------- 几何：把全屏 video 裁到镜片矩形 ----------
  function displayBounds() {
    if (display && display.bounds) return display.bounds;
    return { x: 0, y: 0, width: window.screen.width, height: window.screen.height };
  }

  function scaleFactor() {
    return (display && display.scaleFactor) || 1;
  }

  /** 镜片矩形在「捕获像素坐标系」里的位置 */
  function sourceRect(mediaW, mediaH) {
    const db = displayBounds();
    const sf = scaleFactor();
    const scaleX = mediaW / Math.max(1, db.width * sf);
    const scaleY = mediaH / Math.max(1, db.height * sf);
    const scale = (scaleX + scaleY) / 2 || 1;
    const relX = bounds.x - db.x;
    const relY = bounds.y - db.y;
    return {
      sx: Math.max(0, Math.round(relX * scale)),
      sy: Math.max(0, Math.round(relY * scale)),
      sw: Math.max(1, Math.round(bounds.width * scale)),
      sh: Math.max(1, Math.round(bounds.height * scale)),
      scale,
    };
  }

  function ensureViewSize(cssW, cssH) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (view.width !== w || view.height !== h) {
      view.width = w;
      view.height = h;
      lastDrawKey = '';
    }
  }

  /**
   * 在 canvas 坐标系里抹掉指针：
   * 把指针上方一块内容盖到指针位置（无未滤镜圆、无第二光标）。
   */
  function stampOutCursor(c, cx, cy, cw, ch) {
    if (cursorLocal == null) return;
    const pad = CUR_PAD;
    const x = Math.round(cursorLocal.x - pad * 0.35);
    const y = Math.round(cursorLocal.y - pad * 0.25);
    const w = pad;
    const h = pad * 1.35;
    if (x + w < 0 || y + h < 0 || x > cw || y > ch) return;

    // 从上方拷贝同尺寸区域盖住指针；若上方不够则用下方
    const srcY = y - h - 2;
    if (srcY >= 0) {
      c.drawImage(c, x, srcY, w, h, x, y, w, h);
    } else {
      c.drawImage(c, x, y + h + 2, w, h, x, y, w, h);
    }
  }

  /** 实时：从 video 裁剪 → 抹指针 */
  function drawLive() {
    if (!streamReady || !video.videoWidth) return;
    const cssW = Math.max(1, Math.round(bounds.width));
    const cssH = Math.max(1, Math.round(bounds.height));
    ensureViewSize(cssW, cssH);

    const R = sourceRect(video.videoWidth, video.videoHeight);
    const key = `${R.sx}|${R.sy}|${R.sw}|${R.sh}|${cssW}|${cssH}`;
    // 即使用同一 key，指针会动，必须每帧重画
    lastDrawKey = key;

    try {
      ctx.drawImage(
        video,
        R.sx, R.sy, R.sw, R.sh,
        0, 0, cssW, cssH
      );
      stampOutCursor(ctx, cursorLocal && cursorLocal.x, cursorLocal && cursorLocal.y, cssW, cssH);
    } catch (_) {}
  }

  /** 冻结：抓一帧到离屏，再显示 */
  function freezeOnce() {
    if (!video.videoWidth) {
      showHint('还没有可截取的画面', true);
      return;
    }
    const cssW = Math.max(1, Math.round(bounds.width));
    const cssH = Math.max(1, Math.round(bounds.height));
    ensureViewSize(cssW, cssH);
    const R = sourceRect(video.videoWidth, video.videoHeight);
    try {
      ctx.drawImage(video, R.sx, R.sy, R.sw, R.sh, 0, 0, cssW, cssH);
      stampOutCursor(ctx, cursorLocal && cursorLocal.x, cursorLocal && cursorLocal.y, cssW, cssH);
      frozenFrame = document.createElement('canvas');
      frozenFrame.width = view.width;
      frozenFrame.height = view.height;
      frozenFrame.getContext('2d').drawImage(view, 0, 0);
    } catch (_) {}
    hideHint();
  }

  function drawFreeze() {
    if (!frozenFrame) return;
    ensureViewSize(bounds.width, bounds.height);
    try {
      ctx.drawImage(frozenFrame, 0, 0, view.width, view.height);
    } catch (_) {}
  }

  // ---------- 捕获 ----------
  function stopStream() {
    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    }
    stream = null;
    video.srcObject = null;
    streamReady = false;
    lastStreamDisplayId = null;
  }

  async function startCapture() {
    if (starting) return;
    starting = true;
    showHint('正在连接屏幕捕获…', true);

    let newStream = null;
    try {
      newStream = await startViaChromeMediaSource();
    } catch (err1) {
      console.error('[lens] chromeMediaSource failed', err1);
      try {
        newStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 } },
          audio: false,
        });
      } catch (err2) {
        console.error('[lens] getDisplayMedia failed', err2);
        starting = false;
        failCount += 1;
        showHint(`屏幕捕获失败：${err1?.message || err1}`, true);
        if (failCount < 4) {
          setTimeout(() => {
            starting = false;
            startCapture();
          }, 2500);
        }
        return;
      }
    }

    if (stream && stream !== newStream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    }

    stream = newStream;
    video.srcObject = stream;
    video.muted = true;
    try { await video.play(); } catch (_) {}

    await new Promise((resolve) => {
      if (video.videoWidth > 0) return resolve();
      video.addEventListener('loadedmetadata', resolve, { once: true });
      setTimeout(resolve, 2000);
    });

    streamReady = true;
    starting = false;
    failCount = 0;
    lastStreamDisplayId = display ? display.id : null;
    frozenFrame = null;
    if (captureMode === 'freeze') freezeOnce();
    else hideHint();
    applyUi();

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (starting) return;
      streamReady = false;
      stream = null;
      applyUi();
      showHint('捕获中断，1.5 秒后重连…', true);
      setTimeout(() => {
        if (!starting && !streamReady) startCapture();
      }, 1500);
    });
  }

  async function startViaChromeMediaSource() {
    if (!window.lensAPI) throw new Error('no lensAPI');
    const data = await window.lensAPI.getSources();
    if (!data?.sources?.length) throw new Error('no screen sources');

    let sourceId = data.pickedSourceId || data.sources[0].id;
    if (display) {
      const byDisplay = data.sources.find(
        (s) => String(s.display_id) === String(display.id)
      );
      if (byDisplay) sourceId = byDisplay.id;
    }

    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: 4096,
          minHeight: 720,
          maxHeight: 2160,
        },
      },
    });
  }

  function ensureCaptureForDisplay() {
    if (!display || starting) return;
    if (!streamReady) {
      startCapture();
      return;
    }
    if (lastStreamDisplayId != null && String(lastStreamDisplayId) === String(display.id)) {
      return;
    }
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => {
      if (starting || !display) return;
      if (lastStreamDisplayId != null && String(lastStreamDisplayId) === String(display.id)) {
        return;
      }
      startCapture();
    }, 350);
  }

  function setCaptureMode(next) {
    if (next !== 'freeze' && next !== 'live') return;
    captureMode = next;
    window.lensAPI?.reportCaptureMode?.(captureMode);
    applyUi();
    if (captureMode === 'freeze') freezeOnce();
    else hideHint();
  }

  function toggleCaptureMode() {
    setCaptureMode(captureMode === 'freeze' ? 'live' : 'freeze');
  }

  function refreshFreeze() {
    if (!streamReady) {
      startCapture();
      return;
    }
    freezeOnce();
  }

  // ---------- 按钮 ----------
  btnEffect.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEffect();
  });
  btnMode.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleMode();
  });
  btnCapture.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCaptureMode();
  });
  btnRefresh.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshFreeze();
  });
  brightnessInput?.addEventListener('input', (e) => {
    e.stopPropagation();
    setBrightness(e.target.value);
  });
  brightnessInput?.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ---------- 缩放 ----------
  function onHandlePointerDown(e) {
    if (e.button !== 0) return;
    const handle = e.target.closest('.handle');
    if (!handle) return;
    drag = {
      dir: handle.dataset.dir,
      startX: e.screenX,
      startY: e.screenY,
      origin: { ...bounds },
    };
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.screenX - drag.startX;
    const dy = e.screenY - drag.startY;
    let { x, y, width, height } = drag.origin;
    const d = drag.dir;
    if (d.includes('e')) width = Math.max(MIN_W, drag.origin.width + dx);
    if (d.includes('s')) height = Math.max(MIN_H, drag.origin.height + dy);
    if (d.includes('w')) {
      width = Math.max(MIN_W, drag.origin.width - dx);
      x = drag.origin.x + (drag.origin.width - width);
    }
    if (d.includes('n')) {
      height = Math.max(MIN_H, drag.origin.height - dy);
      y = drag.origin.y + (drag.origin.height - height);
    }
    bounds = { x, y, width, height };
    window.lensAPI?.requestBounds?.(bounds);
  }

  function onPointerUp() {
    if (!drag) return;
    window.lensAPI?.persistBounds?.(bounds);
    drag = null;
  }

  document.querySelectorAll('.handle').forEach((h) => {
    h.addEventListener('pointerdown', onHandlePointerDown);
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  dragBar.style.webkitAppRegion = 'drag';
  document.getElementById('chrome').style.webkitAppRegion = 'no-drag';
  document.querySelectorAll('.handle').forEach((h) => {
    h.style.webkitAppRegion = 'no-drag';
  });
  document.getElementById('viewport').style.webkitAppRegion = 'no-drag';

  function tick() {
    if (captureMode === 'live') drawLive();
    else if (frozenFrame) drawFreeze();
    requestAnimationFrame(tick);
  }

  // ---------- IPC ----------
  if (window.lensAPI) {
    window.lensAPI.onInit((data) => {
      if (data.mode) mode = data.mode;
      if (data.bounds) bounds = data.bounds;
      effectOn = true;
      if (data.brightness != null) {
        brightness = Math.min(100, Math.max(10, Math.round(data.brightness)));
      }
      captureMode = data.captureMode === 'freeze' ? 'freeze' : 'live';
      applyInteractive(false);
      applyUi();
      startCapture();
    });

    window.lensAPI.onInteractive?.((on) => applyInteractive(on));

    window.lensAPI.onCursorLocal?.((pos) => {
      cursorLocal = pos;
    });

    window.lensAPI.onBounds((data) => {
      bounds = data.bounds;
      display = data.display;
      applyUi();
      ensureCaptureForDisplay();
    });

    window.lensAPI.onMode((m) => setMode(m));
    window.lensAPI.onRefreshFreeze?.(() => refreshFreeze());
    window.lensAPI.onToggleEffect?.(() => toggleEffect());

    window.lensAPI.onWake?.(() => {
      applyInteractive(false);
      if (captureMode === 'freeze' && streamReady) freezeOnce();
      else if (streamReady) hideHint();
      else startCapture();
    });

    window.lensAPI.onSleep?.(() => {
      cursorLocal = null;
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.code === 'KeyR' || e.key === 'R' || e.key === 'r')) {
      e.preventDefault();
      refreshFreeze();
    }
    if (e.ctrlKey && e.shiftKey && (e.code === 'KeyE' || e.key === 'E' || e.key === 'e')) {
      e.preventDefault();
      toggleEffect();
    }
  });

  applyUi();
  requestAnimationFrame(tick);
})();
