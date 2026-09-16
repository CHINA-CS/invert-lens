(() => {
  const frame = document.getElementById('frame');
  const video = document.getElementById('screen-video');
  const canvas = document.getElementById('freeze-canvas');
  const emptyHint = document.getElementById('empty-hint');
  const btnEffect = document.getElementById('btn-effect');
  const btnMode = document.getElementById('btn-mode');
  const btnCapture = document.getElementById('btn-capture');
  const btnRefresh = document.getElementById('btn-refresh');
  const dragBar = document.getElementById('drag-bar');
  const viewport = document.getElementById('viewport');
  const brightnessInput = document.getElementById('brightness');
  const brightnessLabel = document.getElementById('brightness-label');

  const MODES = ['off', 'invert', 'gray', 'combo'];
  const MODE_LABELS = {
    off: '关闭',
    invert: '仅反色',
    gray: '仅灰度',
    combo: '反色+灰度',
  };

  const MIN_W = 180;
  const MIN_H = 140;

  let mode = 'combo';
  let effectOn = true;
  let brightness = 100; // 100%=原亮度，降低则变暗
  let captureMode = 'live';
  let bounds = { x: 0, y: 0, width: 560, height: 360 };
  let display = null;
  let stream = null;
  let starting = false;
  let streamReady = false;
  let failCount = 0;
  let drag = null;
  let lastVideoAlignKey = '';
  let lastCanvasAlignKey = '';
  let lastStreamDisplayId = null;
  let switchTimer = 0;
  let interactive = false;
  let lastInteractive = null;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  // ---------- 滤镜（反色 / 灰度 / 亮度） ----------
  function applyFilters() {
    const parts = [];
    if (effectOn && mode !== 'off') {
      if (mode === 'invert' || mode === 'combo') parts.push('invert(1)');
      if (mode === 'gray' || mode === 'combo') parts.push('grayscale(1)');
      if (brightness !== 100) parts.push(`brightness(${(brightness / 100).toFixed(2)})`);
    }
    viewport.style.filter = parts.length ? parts.join(' ') : 'none';
  }

  // ---------- UI ----------
  function applyUi() {
    frame.dataset.mode = mode;
    frame.dataset.effect = effectOn ? 'on' : 'off';
    frame.dataset.capture = captureMode;
    frame.dataset.interactive = interactive ? 'true' : 'false';
    applyFilters();

    btnEffect.textContent = effectOn ? '滤镜 开' : '滤镜 关';
    btnEffect.classList.toggle('off-state', !effectOn);

    btnMode.textContent = MODE_LABELS[mode] || mode;
    btnMode.classList.toggle('active', mode !== 'off' && effectOn);

    btnCapture.textContent = captureMode === 'freeze' ? '冻结' : '实时';
    btnCapture.classList.toggle('active', captureMode === 'live');
    btnRefresh.disabled = !streamReady && captureMode === 'freeze';

    if (brightnessInput) brightnessInput.value = String(brightness);
    if (brightnessLabel) brightnessLabel.textContent = `${brightness}%`;
  }

  function setBrightness(pct) {
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n)) return;
    brightness = Math.min(100, Math.max(10, n));
    window.lensAPI?.reportBrightness?.(brightness);
    applyUi();
  }

  function setMode(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    window.lensAPI?.reportMode?.(mode);
    applyUi();
    if (captureMode === 'freeze' && streamReady) freezeOnce();
  }

  function cycleMode() {
    const idx = MODES.indexOf(mode);
    setMode(MODES[(idx + 1) % MODES.length]);
  }

  function toggleEffect() {
    effectOn = !effectOn;
    applyUi();
    if (effectOn && captureMode === 'freeze' && streamReady) freezeOnce();
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

  // ---------- 交互状态由主进程光标轮询驱动 ----------
  function applyInteractive(on) {
    const next = !!on;
    if (next === lastInteractive) return;
    lastInteractive = next;
    interactive = next;
    frame.dataset.interactive = interactive ? 'true' : 'false';
  }

  // ---------- 几何对齐 ----------
  function displayBounds() {
    if (display && display.bounds) return display.bounds;
    return { x: 0, y: 0, width: window.screen.width, height: window.screen.height };
  }

  function scaleFactor() {
    return (display && display.scaleFactor) || 1;
  }

  function computeSurfaceLayout(mediaW, mediaH) {
    const db = displayBounds();
    const sf = scaleFactor();
    const scaleX = mediaW / Math.max(1, db.width * sf);
    const scaleY = mediaH / Math.max(1, db.height * sf);
    const scale = (scaleX + scaleY) / 2 || 1;
    return {
      cssW: mediaW / scale,
      cssH: mediaH / scale,
      left: -(bounds.x - db.x),
      top: -(bounds.y - db.y),
    };
  }

  function alignVideo() {
    if (!video.videoWidth || !video.videoHeight) return;
    const L = computeSurfaceLayout(video.videoWidth, video.videoHeight);
    const key = `${L.cssW}|${L.cssH}|${L.left}|${L.top}`;
    if (key === lastVideoAlignKey) return;
    lastVideoAlignKey = key;
    video.style.width = `${L.cssW}px`;
    video.style.height = `${L.cssH}px`;
    video.style.left = `${L.left}px`;
    video.style.top = `${L.top}px`;
  }

  function alignCanvas() {
    if (!canvas.width || !canvas.height) return;
    const L = computeSurfaceLayout(canvas.width, canvas.height);
    const key = `${L.cssW}|${L.cssH}|${L.left}|${L.top}`;
    if (key === lastCanvasAlignKey) return;
    lastCanvasAlignKey = key;
    canvas.style.width = `${L.cssW}px`;
    canvas.style.height = `${L.cssH}px`;
    canvas.style.left = `${L.left}px`;
    canvas.style.top = `${L.top}px`;
  }

  function freezeOnce() {
    if (!video.videoWidth || !video.videoHeight) {
      showHint('还没有可截取的画面', true);
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      lastCanvasAlignKey = '';
    }
    ctx.drawImage(video, 0, 0, w, h);
    alignCanvas();
    hideHint();
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
    lastVideoAlignKey = '';
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
    lastVideoAlignKey = '';
    alignVideo();
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
    else {
      alignVideo();
      hideHint();
    }
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

  // 顶栏用系统 drag；工具条 no-drag
  dragBar.style.webkitAppRegion = 'drag';
  document.getElementById('chrome').style.webkitAppRegion = 'no-drag';
  document.querySelectorAll('.handle').forEach((h) => {
    h.style.webkitAppRegion = 'no-drag';
  });
  // 画面区域不参与系统 drag，避免抢走穿透
  document.getElementById('viewport').style.webkitAppRegion = 'no-drag';

  function tick() {
    if (captureMode === 'live' && video.videoWidth) alignVideo();
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

    window.lensAPI.onBounds((data) => {
      bounds = data.bounds;
      display = data.display;
      applyUi();
      ensureCaptureForDisplay();
      if (captureMode === 'freeze') alignCanvas();
      else alignVideo();
    });

    window.lensAPI.onMode((m) => setMode(m));
    window.lensAPI.onRefreshFreeze?.(() => refreshFreeze());
    window.lensAPI.onToggleEffect?.(() => toggleEffect());
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
