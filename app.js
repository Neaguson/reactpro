'use strict';

/* =========================================================
   ReactPro — PWA de reação a vídeos
   O vídeo final é montado num <canvas> (fundo + câmera + vídeo)
   e gravado com MediaRecorder. Botões e menus ficam fora do canvas,
   por isso não aparecem na gravação.
   A gravação é salva em partes no IndexedDB enquanto acontece, para
   ser recuperada se o app fechar no meio.
   ========================================================= */

const $ = (s) => document.querySelector(s);
const W = 1080, H = 1920;            // coordenadas lógicas do quadro (9:16)
const PAD = 44, GAP = 28, RADIUS = 34;

const DEFAULTS = {
  blur: 14, dim: 35,
  layout: 'stack', split: 45, pipSize: 38, pipCorner: 'tr',
  fit: 'contain', mirror: true, showBar: true, countdown: true,
  camZoom: 1, camX: 0, camY: 0,
  volVid: 100, volMic: 100, quality: '1080', format: 'mp4',
};

const state = {
  settings: { ...DEFAULTS },
  camStream: null,
  micStream: null,
  videoUrl: null,
  videoReady: false,
  bgBitmap: null,
  bgCanvas: null,
  // gravação: 'idle' | 'countdown' | 'recording' | 'paused' | 'saving'
  phase: 'idle',
  recorder: null,
  vStream: null,
  rec: null,            // { rid, created, type, marks, duration }
  seq: 0,
  recAccum: 0,
  recSegStart: 0,
  recTimer: null,
  countdownT: null,
  writeChain: Promise.resolve(),
  diskWarned: false,
  wakeLock: null,
  audio: null,          // { ctx, dest, vidGain, micGain, micNode, analyser }
  current: null,
};

const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const camVideo = $('#camVideo');
const mainVideo = $('#mainVideo');

/* ---------------- IndexedDB ---------------- */
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('reactpro', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const range = (rid) => IDBKeyRange.bound(rid + ':', rid + ':￿');
  return {
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    put: (store, val, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
    chunks: (rid) => tx('chunks', 'readonly', (s) => s.getAll(range(rid))),
    delChunks: (rid) => tx('chunks', 'readwrite', (s) => s.delete(range(rid))),
  };
})();

/* ---------------- util ---------------- */
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtBytes(b) {
  if (b > 1e9) return (b / 1e9).toFixed(1).replace('.', ',') + ' GB';
  return Math.max(0.1, b / 1e6).toFixed(1).replace('.', ',') + ' MB';
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const vibrate = (ms) => { try { navigator.vibrate?.(ms); } catch {} };
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
function setRangeFill(el) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--p', p + '%');
}
function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
const busy = () => state.phase !== 'idle';
const recActive = () => state.phase === 'recording' || state.phase === 'paused';

/* ---------------- layout do quadro ---------------- */
function layout() {
  const s = state.settings;
  const iw = W - PAD * 2, ih = H - PAD * 2;
  if (s.layout === 'pip') {
    const vid = { x: PAD, y: PAD, w: iw, h: ih };
    const cw = Math.round(W * s.pipSize / 100), ch = Math.round(cw * 4 / 3);
    const m = PAD + 28;
    const right = s.pipCorner.includes('r'), bottom = s.pipCorner.includes('b');
    const cam = {
      x: right ? W - m - cw : m,
      y: bottom ? H - m - ch - (s.showBar ? 110 : 0) : m,
      w: cw, h: ch,
    };
    return { cam, vid, pip: true };
  }
  const inner = ih - GAP;
  const camH = Math.round(inner * (s.split / 100));
  const vidH = inner - camH;
  if (s.layout === 'stackInv') {
    return { vid: { x: PAD, y: PAD, w: iw, h: vidH }, cam: { x: PAD, y: PAD + vidH + GAP, w: iw, h: camH }, pip: false };
  }
  return { cam: { x: PAD, y: PAD, w: iw, h: camH }, vid: { x: PAD, y: PAD + camH + GAP, w: iw, h: vidH }, pip: false };
}

function outputSize() {
  return state.settings.quality === '720' ? [720, 1280] : [1080, 1920];
}

function applyCanvasSize() {
  const [w, h] = outputSize();
  if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
  buildBackground();
  positionOverlays();
}

function fitStage() {
  const wrap = $('#stageWrap');
  const aw = wrap.clientWidth, ah = wrap.clientHeight;
  if (!aw || !ah) return;
  let w = aw, h = (aw * 16) / 9;
  if (h > ah) { h = ah; w = (ah * 9) / 16; }
  const st = $('#stage');
  st.style.width = Math.floor(w) + 'px';
  st.style.height = Math.floor(h) + 'px';
}

function positionOverlays() {
  const { cam, vid } = layout();
  const set = (el, r) => {
    el.style.top = (r.y / H) * 100 + '%';
    el.style.height = (r.h / H) * 100 + '%';
    el.style.left = (r.x / W) * 100 + '%';
    el.style.width = (r.w / W) * 100 + '%';
  };
  set($('#ovCam'), cam);
  set($('#ovVid'), vid);
}

/* ---------------- fundo ---------------- */
const canvasFilterSupported = (() => {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 9;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 9, 9);
    x.filter = 'blur(2px)';
    x.fillStyle = '#fff'; x.fillRect(4, 4, 1, 1);
    return x.getImageData(2, 4, 1, 1).data[0] > 0;
  } catch { return false; }
})();

function drawCover(c, img, iw, ih, x, y, w, h) {
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  c.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function buildBackground() {
  const [ow, oh] = outputSize();
  const bc = document.createElement('canvas');
  bc.width = ow; bc.height = oh;
  const b = bc.getContext('2d');
  const img = state.bgBitmap;
  if (!img) {
    const g = b.createLinearGradient(0, 0, ow * 0.4, oh);
    g.addColorStop(0, '#17171a');
    g.addColorStop(1, '#0a0a0b');
    b.fillStyle = g; b.fillRect(0, 0, ow, oh);
  } else {
    const iw = img.width, ih = img.height;
    const blur = state.settings.blur * (ow / 1080);
    if (blur <= 0) {
      drawCover(b, img, iw, ih, 0, 0, ow, oh);
    } else if (canvasFilterSupported) {
      b.filter = `blur(${blur}px)`;
      const m = blur * 2;
      drawCover(b, img, iw, ih, -m, -m, ow + m * 2, oh + m * 2);
      b.filter = 'none';
    } else {
      // Safari: desfoque por redução e ampliação em etapas
      const k = Math.max(2, Math.round(blur / 2.2));
      let cur = document.createElement('canvas');
      cur.width = Math.max(4, Math.round(ow / k)); cur.height = Math.max(4, Math.round(oh / k));
      const cc = cur.getContext('2d');
      cc.imageSmoothingQuality = 'high';
      drawCover(cc, img, iw, ih, 0, 0, cur.width, cur.height);
      let w = cur.width, h = cur.height;
      while (w * 2 < ow) {
        const n = document.createElement('canvas');
        n.width = w * 2; n.height = h * 2;
        const nc = n.getContext('2d'); nc.imageSmoothingQuality = 'high';
        nc.drawImage(cur, 0, 0, n.width, n.height);
        cur = n; w = n.width; h = n.height;
      }
      b.imageSmoothingQuality = 'high';
      b.drawImage(cur, 0, 0, ow, oh);
    }
    if (state.settings.dim > 0) {
      b.fillStyle = `rgba(0,0,0,${state.settings.dim / 100})`;
      b.fillRect(0, 0, ow, oh);
    }
  }
  state.bgCanvas = bc;
}

async function loadBgBlob(blob) {
  if (!blob) { state.bgBitmap = null; updateBgDom(null); buildBackground(); return; }
  try {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    const max = 1600, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    state.bgBitmap = c;
    updateBgDom(c.toDataURL('image/jpeg', 0.7));
  } catch (e) {
    console.error(e);
    toast('Não foi possível abrir essa imagem.');
    state.bgBitmap = null; updateBgDom(null);
  }
  buildBackground();
}

function updateBgDom(dataUrl) {
  $('#appBg').style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
  $('#bgThumb').style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
}

/* ---------------- desenho do quadro ---------------- */
function camOverflow(r) {
  const sw = camVideo.videoWidth, sh = camVideo.videoHeight;
  if (!sw || !sh) return { sc: 1, mx: 0, my: 0, dw: 0, dh: 0 };
  const sc = Math.max(r.w / sw, r.h / sh) * state.settings.camZoom;
  const dw = sw * sc, dh = sh * sc;
  return { sc, dw, dh, mx: (dw - r.w) / 2, my: (dh - r.h) / 2 };
}

function drawCamera(r) {
  const s = state.settings;
  const { dw, dh, mx, my } = camOverflow(r);
  if (!dw) return;
  // com espelho, o deslocamento é invertido para acompanhar o dedo na tela
  const ox = (s.mirror ? -s.camX : s.camX) * mx;
  const oy = s.camY * my;
  const dx = r.x + (r.w - dw) / 2 + ox, dy = r.y + (r.h - dh) / 2 + oy;
  if (s.mirror) {
    ctx.save();
    ctx.translate(2 * (r.x + r.w / 2), 0);
    ctx.scale(-1, 1);
    ctx.drawImage(camVideo, dx, dy, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(camVideo, dx, dy, dw, dh);
  }
}

function drawVideo(r) {
  const sw = mainVideo.videoWidth, sh = mainVideo.videoHeight;
  const s = state.settings.fit === 'cover' ? Math.max(r.w / sw, r.h / sh) : Math.min(r.w / sw, r.h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(mainVideo, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
}

function drawProgress(r) {
  const v = mainVideo;
  const dur = v.duration || 0, cur = v.currentTime || 0;
  const h = 96;
  const y0 = r.y + r.h - h;
  const g = ctx.createLinearGradient(0, y0, 0, r.y + r.h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = g;
  ctx.fillRect(r.x, y0, r.w, h);

  const bx = r.x + 34, bw = r.w - 68, by = r.y + r.h - 30;
  ctx.fillStyle = '#fff';
  const ix = bx, iy = by - 40;
  if (v.paused) {
    ctx.beginPath(); ctx.moveTo(ix, iy - 13); ctx.lineTo(ix + 22, iy); ctx.lineTo(ix, iy + 13); ctx.closePath(); ctx.fill();
  } else {
    ctx.fillRect(ix, iy - 13, 7, 26); ctx.fillRect(ix + 13, iy - 13, 7, 26);
  }
  ctx.font = '500 26px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(`${fmt(cur)} / ${fmt(dur)}`, ix + 40, iy + 1);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  roundRectPath(ctx, bx, by - 3, bw, 6, 3); ctx.fill();
  const p = dur ? Math.min(1, cur / dur) : 0;
  if (p > 0) { ctx.fillStyle = '#c9a961'; roundRectPath(ctx, bx, by - 3, Math.max(6, bw * p), 6, 3); ctx.fill(); }
}

function draw() {
  const sc = canvas.width / W;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (state.bgCanvas) ctx.drawImage(state.bgCanvas, 0, 0, canvas.width, canvas.height);
  else { ctx.fillStyle = '#0b0b0c'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.setTransform(sc, 0, 0, sc, 0, 0);

  const { cam, vid, pip } = layout();
  const hasBg = !!state.bgBitmap;
  const tint = hasBg ? 'rgba(14,14,16,0.55)' : 'rgba(22,22,25,1)';

  // vídeo (no modo canto ele fica por baixo da câmera)
  ctx.save();
  roundRectPath(ctx, vid.x, vid.y, vid.w, vid.h, RADIUS);
  ctx.fillStyle = !state.videoReady ? tint
    : (hasBg && state.settings.fit === 'contain' ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.88)');
  ctx.fill();
  ctx.clip();
  if (state.videoReady && mainVideo.videoWidth) {
    drawVideo(vid);
    if (state.settings.showBar) drawProgress(vid);
  }
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  roundRectPath(ctx, vid.x, vid.y, vid.w, vid.h, RADIUS); ctx.stroke();

  // câmera
  const camOn = !!(state.camStream && camVideo.videoWidth);
  if (pip && !camOn && recActive()) return; // no modo canto, sem câmera não desenha caixa vazia
  const cr = pip ? 26 : RADIUS;
  if (pip) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 8;
    roundRectPath(ctx, cam.x, cam.y, cam.w, cam.h, cr);
    ctx.fillStyle = '#16161a'; ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRectPath(ctx, cam.x, cam.y, cam.w, cam.h, cr);
  if (!pip) { ctx.fillStyle = tint; ctx.fill(); }
  ctx.clip();
  if (camOn) drawCamera(cam);
  ctx.restore();
  ctx.lineWidth = pip ? 3 : 2;
  ctx.strokeStyle = pip ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
  roundRectPath(ctx, cam.x, cam.y, cam.w, cam.h, cr); ctx.stroke();
}

/* ---------------- medidor do microfone ---------------- */
const meterBars = [...document.querySelectorAll('#micMeter i')];
const meterBuf = new Uint8Array(512);
let meterLevel = 0, meterShown = -1;
function updateMeter() {
  const an = state.audio?.analyser;
  const el = $('#micMeter');
  const visible = !!(an && state.audio.micNode);
  el.hidden = !visible;
  if (!visible) return;
  an.getByteTimeDomainData(meterBuf);
  let sum = 0;
  for (let i = 0; i < meterBuf.length; i++) { const d = (meterBuf[i] - 128) / 128; sum += d * d; }
  const rms = Math.sqrt(sum / meterBuf.length);
  const target = clamp(rms * 5, 0, 1);
  meterLevel = target > meterLevel ? target : meterLevel * 0.9 + target * 0.1;
  const n = Math.round(meterLevel * meterBars.length);
  if (n !== meterShown) {
    meterBars.forEach((b, i) => b.classList.toggle('on', i < n));
    meterShown = n;
  }
  el.classList.toggle('off', state.settings.volMic === 0);
}

function loop() { draw(); updateMeter(); requestAnimationFrame(loop); }

/* ---------------- câmera / microfone ---------------- */
async function cameraOn() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Este navegador não permite câmera. Abra pelo link https no Chrome ou Safari.'); return;
  }
  ensureAudio();
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.camStream = new MediaStream(s.getVideoTracks());
    setMic(new MediaStream(s.getAudioTracks()));
    camVideo.srcObject = state.camStream;
    await camVideo.play().catch(() => {});
    refreshUi();
    showFrameHint();
  } catch (e) {
    console.error(e);
    toast(e.name === 'NotAllowedError'
      ? 'Permissão negada. Libere câmera e microfone nas configurações do navegador.'
      : 'Não foi possível abrir a câmera.');
  }
}

function cameraOff() {
  if (busy()) { toast('Pare a gravação antes de desligar a câmera.'); return; }
  state.camStream?.getTracks().forEach((t) => t.stop());
  state.camStream = null;
  camVideo.srcObject = null;
  refreshUi();
}

function ensureAudio() {
  if (!state.audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    const dest = actx.createMediaStreamDestination();
    const vidSrc = actx.createMediaElementSource(mainVideo);
    const vidGain = actx.createGain();
    const micGain = actx.createGain();
    const analyser = actx.createAnalyser();
    analyser.fftSize = 512;
    vidSrc.connect(actx.destination);        // você ouve o vídeo
    vidSrc.connect(vidGain).connect(dest);   // e ele entra na gravação
    micGain.connect(dest);                   // a voz só vai para a gravação (sem retorno)
    state.audio = { ctx: actx, dest, vidGain, micGain, micNode: null, analyser };
    applyVolumes();
    if (state.micStream) setMic(state.micStream);
  }
  if (state.audio.ctx.state !== 'running') state.audio.ctx.resume().catch(() => {});
  return state.audio;
}

function setMic(stream) {
  state.micStream = stream;
  if (!state.audio) return;
  state.audio.micNode?.disconnect();
  state.audio.micNode = null;
  if (stream && stream.getAudioTracks().length) {
    state.audio.micNode = state.audio.ctx.createMediaStreamSource(stream);
    state.audio.micNode.connect(state.audio.micGain);
    state.audio.micNode.connect(state.audio.analyser);
  }
}

function applyVolumes() {
  if (!state.audio) return;
  state.audio.vidGain.gain.value = state.settings.volVid / 100;
  state.audio.micGain.gain.value = state.settings.volMic / 100;
}

/* ---------------- enquadramento do rosto (arrastar / pinçar) ---------------- */
const ovCam = $('#ovCam');
const pointers = new Map();
let gesture = null, lastCamTap = 0, hintShown = false;

function showFrameHint() {
  if (hintShown) return;
  hintShown = true;
  const h = $('#frameHint');
  h.hidden = false;
  setTimeout(() => (h.hidden = true), 3500);
}

function stagePxToLogical() { return W / $('#stage').clientWidth; }

ovCam.addEventListener('pointerdown', (e) => {
  if (!state.camStream || e.target.closest('button')) return;
  try { ovCam.setPointerCapture(e.pointerId); } catch {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const s = state.settings;
  if (pointers.size === 1) {
    const now = Date.now();
    if (now - lastCamTap < 300) { // dois toques: volta ao normal
      s.camZoom = 1; s.camX = 0; s.camY = 0; saveSettings(); lastCamTap = 0; gesture = null; return;
    }
    lastCamTap = now;
    gesture = { type: 'pan', x: e.clientX, y: e.clientY, camX: s.camX, camY: s.camY };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: s.camZoom };
  }
});
ovCam.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const s = state.settings;
  const r = layout().cam;
  if (gesture.type === 'pan' && pointers.size === 1) {
    const k = stagePxToLogical();
    const { mx, my } = camOverflow(r);
    if (mx > 0) s.camX = clamp(gesture.camX + ((e.clientX - gesture.x) * k) / mx, -1, 1);
    if (my > 0) s.camY = clamp(gesture.camY + ((e.clientY - gesture.y) * k) / my, -1, 1);
  } else if (gesture.type === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    s.camZoom = clamp(gesture.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist), 1, 3);
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    const [p] = [...pointers.values()];
    const s = state.settings;
    gesture = { type: 'pan', x: p.x, y: p.y, camX: s.camX, camY: s.camY };
  } else if (pointers.size === 0) {
    gesture = null;
    saveSettings();
  }
}
ovCam.addEventListener('pointerup', endPointer);
ovCam.addEventListener('pointercancel', endPointer);

/* ---------------- vídeo principal ---------------- */
function loadVideo(file) {
  if (!file) return;
  if (busy()) { toast('Pare a gravação antes de trocar o vídeo.'); return; }
  ensureAudio();
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoReady = false;
  state.videoUrl = URL.createObjectURL(file);
  mainVideo.src = state.videoUrl;
  mainVideo.load();
  refreshUi();
}

mainVideo.addEventListener('loadeddata', () => {
  state.videoReady = true;
  try { mainVideo.currentTime = 0.001; } catch {}
  refreshUi();
});
mainVideo.addEventListener('error', () => {
  if (!mainVideo.src) return;
  state.videoReady = false;
  toast('Não foi possível abrir esse vídeo. Tente outro formato (MP4).');
  refreshUi();
});
mainVideo.addEventListener('timeupdate', updateSeek);
mainVideo.addEventListener('durationchange', updateSeek);
mainVideo.addEventListener('play', refreshPlayIcon);
mainVideo.addEventListener('pause', refreshPlayIcon);
mainVideo.addEventListener('ended', refreshPlayIcon);

function togglePlay() {
  if (!state.videoReady) return;
  ensureAudio();
  if (mainVideo.paused || mainVideo.ended) mainVideo.play().catch((e) => { console.error(e); toast('Toque de novo para reproduzir.'); });
  else mainVideo.pause();
}
function skip(sec) {
  if (!state.videoReady) return;
  mainVideo.currentTime = clamp(mainVideo.currentTime + sec, 0, Math.max(0, (mainVideo.duration || 0) - 0.05));
}

// toque único = play/pausa; dois toques nas laterais = ±10s
let tapTimer = null, lastVidTap = 0;
function flash(id) {
  const el = $(id);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 450);
}
$('#ovVid').addEventListener('click', (e) => {
  if (e.target.closest('.pill, .mini') || !state.videoReady) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const now = Date.now();
  if (now - lastVidTap < 300) {
    clearTimeout(tapTimer); lastVidTap = 0;
    if (x < 0.4) { skip(-10); flash('#flashL'); }
    else if (x > 0.6) { skip(10); flash('#flashR'); }
    else togglePlay();
    return;
  }
  lastVidTap = now;
  tapTimer = setTimeout(togglePlay, 300);
});

let seeking = false;
function updateSeek() {
  const d = mainVideo.duration || 0;
  $('#tCur').textContent = fmt(mainVideo.currentTime);
  $('#tDur').textContent = fmt(d);
  if (!seeking) {
    const el = $('#seek');
    el.value = d ? Math.round((mainVideo.currentTime / d) * 1000) : 0;
    setRangeFill(el);
  }
}
function refreshPlayIcon() {
  const playing = !mainVideo.paused && !mainVideo.ended;
  $('#btnPlay .i-play').hidden = playing;
  $('#btnPlay .i-pause').hidden = !playing;
  $('#btnPlay').setAttribute('aria-label', playing ? 'Pausar' : 'Reproduzir');
}

/* ---------------- gravação ---------------- */
// MP4: melhor para postar/editar. WebM: no Chrome é salvo a cada segundo (recuperável).
// O MP4 do Chrome só entrega o arquivo no final, então não dá para recuperar se o app fechar.
function pickMime() {
  if (!window.MediaRecorder) return null;
  const mp4 = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const list = state.settings.format === 'webm' ? [...webm, ...mp4] : [...mp4, ...webm];
  return list.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) ?? '';
}

function elapsedMs() {
  return state.recAccum + (state.phase === 'recording' ? performance.now() - state.recSegStart : 0);
}

function onRecButton() {
  if (state.phase === 'countdown') return cancelCountdown();
  if (state.phase === 'idle') return beginRec();
  if (recActive()) return stopRec();
}

async function beginRec() {
  if (!state.videoReady) { toast('Carregue um vídeo primeiro.'); return; }
  const mime = pickMime();
  if (mime === null || !canvas.captureStream) { toast('Este navegador não consegue gravar. Use o Chrome (Android) ou o Safari (iPhone) atualizados.'); return; }
  ensureAudio();
  if (!state.micStream) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      setMic(s);
    } catch {
      toast('Sem microfone: a gravação terá só o som do vídeo.');
    }
  }
  if (!state.settings.countdown) return startRecNow(mime);

  state.phase = 'countdown';
  refreshUi();
  let n = 3;
  const num = $('#countdownNum');
  const show = () => { num.textContent = n; num.style.animation = 'none'; void num.offsetWidth; num.style.animation = ''; vibrate(15); };
  $('#countdown').hidden = false;
  show();
  state.countdownT = setInterval(() => {
    n--;
    if (n > 0) return show();
    clearInterval(state.countdownT);
    $('#countdown').hidden = true;
    startRecNow(mime);
  }, 1000);
}

function cancelCountdown() {
  clearInterval(state.countdownT);
  $('#countdown').hidden = true;
  state.phase = 'idle';
  refreshUi();
  toast('Gravação cancelada.');
}

async function startRecNow(mime) {
  const audio = ensureAudio();
  const vStream = canvas.captureStream(30);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...audio.dest.stream.getAudioTracks()]);
  const opts = { videoBitsPerSecond: state.settings.quality === '720' ? 5_000_000 : 9_000_000, audioBitsPerSecond: 160_000 };
  if (mime) opts.mimeType = mime;

  let rec;
  try { rec = new MediaRecorder(stream, opts); }
  catch {
    try { rec = new MediaRecorder(stream); }
    catch (e2) { console.error(e2); vStream.getTracks().forEach((t) => t.stop()); state.phase = 'idle'; refreshUi(); toast('Não foi possível iniciar a gravação.'); return; }
  }

  const rid = Date.now().toString(36);
  state.rec = { rid, created: Date.now(), type: (rec.mimeType || mime || 'video/webm').split(';')[0], marks: [], duration: 0 };
  state.seq = 0;
  state.diskWarned = false;
  state.writeChain = DB.put('kv', { ...state.rec }, 'activeRec').catch(console.error);
  rec.ondataavailable = (e) => persistChunk(e.data);
  rec.onstop = () => finishRec();
  rec.onerror = (e) => { console.error(e); toast('Erro durante a gravação.'); };
  rec.start(1000);

  state.recorder = rec;
  state.vStream = vStream;
  state.recAccum = 0;
  state.recSegStart = performance.now();
  state.phase = 'recording';
  state.recTimer = setInterval(tickRec, 250);
  tickRec();
  vibrate(40);
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  refreshUi();
}

function persistChunk(data) {
  if (!data || !data.size || !state.rec) return;
  const meta = state.rec;
  const seq = state.seq++;
  if (!meta.type && data.type) meta.type = data.type.split(';')[0];
  const dur = elapsedMs() / 1000;
  state.writeChain = state.writeChain
    .then(() => DB.put('chunks', { k: `${meta.rid}:${String(seq).padStart(7, '0')}`, rid: meta.rid, seq, data }))
    .then(() => { meta.duration = Math.max(meta.duration, dur); return DB.put('kv', { ...meta }, 'activeRec'); })
    .catch((e) => {
      console.error(e);
      if (!state.diskWarned) { state.diskWarned = true; toast('Pouco espaço no celular: a gravação pode não ser salva por completo.', 5000); }
    });
}

function togglePauseRec() {
  const rec = state.recorder;
  if (!rec) return;
  if (state.phase === 'recording') {
    try { rec.pause(); } catch (e) { console.error(e); toast('Este celular não permite pausar a gravação.'); return; }
    state.recAccum += performance.now() - state.recSegStart;
    state.phase = 'paused';
    vibrate(20);
  } else if (state.phase === 'paused') {
    rec.resume();
    state.recSegStart = performance.now();
    state.phase = 'recording';
    vibrate(20);
  }
  tickRec();
  refreshUi();
}

function markMoment() {
  if (!recActive() || !state.rec) return;
  const t = elapsedMs() / 1000;
  state.rec.marks.push(Math.round(t * 10) / 10);
  DB.put('kv', { ...state.rec }, 'activeRec').catch(console.error);
  vibrate(25);
  const b = $('#btnMark');
  b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 400);
  $('#markCount').textContent = state.rec.marks.length;
  $('#markCount').hidden = false;
  toast('Momento marcado · ' + fmt(t), 1300);
}

function stopRec() {
  const rec = state.recorder;
  if (!rec || !state.rec) return;
  state.rec.duration = elapsedMs() / 1000;
  state.phase = 'saving';
  clearInterval(state.recTimer);
  refreshUi();
  if (rec.state !== 'inactive') rec.stop();
}

async function finishRec() {
  const meta = state.rec;
  state.vStream?.getTracks().forEach((t) => t.stop());
  state.vStream = null;
  state.recorder = null;
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
  vibrate([30, 60, 30]);
  try {
    await state.writeChain;
    const thumb = await makeThumb();
    await assembleAndSave(meta, thumb, false);
    toast('Gravação salva em Meus vídeos ✓');
  } catch (e) {
    console.error(e);
    toast('Não foi possível salvar a gravação.', 4000);
  }
  state.rec = null;
  state.phase = 'idle';
  $('#markCount').hidden = true;
  refreshUi();
}

// Junta as partes salvas, cria o vídeo em "Meus vídeos" e apaga as partes.
async function assembleAndSave(meta, thumb, recovered) {
  const parts = (await DB.chunks(meta.rid)).sort((a, b) => a.seq - b.seq);
  if (!parts.length) { await DB.del('kv', 'activeRec'); throw new Error('sem partes'); }
  const blob = new Blob(parts.map((p) => p.data), { type: meta.type || 'video/webm' });
  const item = {
    id: meta.rid, created: meta.created, duration: meta.duration, type: blob.type,
    size: blob.size, blob, thumb, marks: meta.marks || [], name: recovered ? 'Gravação recuperada' : '',
  };
  try {
    await DB.put('videos', item);
  } catch (e) {
    console.error(e);
    toast('Sem espaço para guardar no app. Baixando o arquivo…', 4000);
    downloadBlob(blob, fileName(item));
  }
  await DB.delChunks(meta.rid).catch(console.error);
  await DB.del('kv', 'activeRec').catch(console.error);
  renderLibrary();
  return item;
}

function makeThumb() {
  return new Promise((res) => {
    const c = document.createElement('canvas');
    c.width = 270; c.height = 480;
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    c.toBlob((b) => res(b), 'image/jpeg', 0.75);
  });
}

function thumbFromVideoBlob(blob) {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true;
    const url = URL.createObjectURL(blob);
    const done = (b) => { URL.revokeObjectURL(url); res(b); };
    const to = setTimeout(() => done(null), 5000);
    v.onloadeddata = () => { try { v.currentTime = 0.5; } catch { clearTimeout(to); done(null); } };
    v.onseeked = () => {
      const c = document.createElement('canvas'); c.width = 270; c.height = 480;
      c.getContext('2d').drawImage(v, 0, 0, 270, 480);
      c.toBlob((b) => { clearTimeout(to); done(b); }, 'image/jpeg', 0.75);
    };
    v.onerror = () => { clearTimeout(to); done(null); };
    v.src = url;
  });
}

async function recoverInterrupted() {
  let meta;
  try { meta = await DB.get('kv', 'activeRec'); } catch { return; }
  if (!meta) return;
  try {
    const parts = await DB.chunks(meta.rid);
    if (!parts.length) { await DB.del('kv', 'activeRec'); return; }
    const preview = new Blob(parts.sort((a, b) => a.seq - b.seq).map((p) => p.data), { type: meta.type || 'video/webm' });
    const thumb = await thumbFromVideoBlob(preview);
    await assembleAndSave(meta, thumb, true);
    toast('Recuperamos uma gravação que foi interrompida. Veja em Meus vídeos.', 5000);
  } catch (e) {
    console.error(e);
  }
}

function tickRec() {
  const t = fmt(elapsedMs() / 1000);
  $('#recBadgeTime').textContent = t;
}

/* ---------------- UI geral ---------------- */
function refreshUi() {
  const p = state.phase;
  const camOn = !!state.camStream;
  const active = recActive();
  $('#btnCamOn').hidden = camOn;
  $('#btnCamOff').hidden = !camOn || busy();
  ovCam.classList.toggle('framing', camOn);
  $('#btnLoadInStage').hidden = state.videoReady || busy();
  $('#btnSwapVideo').hidden = !state.videoReady || busy();

  for (const id of ['#btnPlay', '#btnBack', '#btnFwd', '#seek']) $(id).disabled = !state.videoReady;
  const rb = $('#btnRec');
  rb.disabled = p === 'saving' || (p === 'idle' && !state.videoReady);
  rb.classList.toggle('on', active || p === 'saving');
  rb.classList.toggle('cd', p === 'countdown');
  rb.setAttribute('aria-label', active ? 'Parar e salvar' : p === 'countdown' ? 'Cancelar' : 'Gravar');

  const badge = $('#recBadge');
  badge.hidden = !(active || p === 'saving');
  badge.classList.toggle('paused', p === 'paused');
  $('#recBadgeLabel').textContent = p === 'paused' ? 'Pausado ' : p === 'saving' ? 'Salvando… ' : '';

  $('#recTools').hidden = !active;
  $('#btnRecPause .i-rp').hidden = p === 'paused';
  $('#btnRecPause .i-rr').hidden = p !== 'paused';
  $('#btnRecPause').setAttribute('aria-label', p === 'paused' ? 'Continuar gravação' : 'Pausar gravação');

  const hint = $('#recHint');
  hint.hidden = active;
  hint.textContent = p === 'countdown' ? 'Começando…'
    : p === 'saving' ? 'Salvando a gravação…'
    : !state.videoReady ? 'Carregue um vídeo para gravar'
    : camOn ? 'Pronto. Toque no REC' : 'Ative a câmera e toque no REC';

  refreshPlayIcon();
  updateSeek();
}

/* ---------------- biblioteca ---------------- */
function fileName(item) {
  const d = new Date(item.created);
  const p = (n) => String(n).padStart(2, '0');
  const ext = item.type.includes('mp4') ? 'mp4' : 'webm';
  const base = item.name ? item.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : 'react';
  return `${base || 'react'}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}
function dateLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR') + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const thumbUrls = [];
async function renderLibrary() {
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  let items = [];
  try { items = await DB.all('videos'); } catch (e) { console.error(e); }
  items.sort((a, b) => b.created - a.created);
  const grid = $('#libGrid');
  grid.innerHTML = '';
  $('#libEmpty').hidden = items.length > 0;
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'card';
    const url = it.thumb ? URL.createObjectURL(it.thumb) : '';
    if (url) thumbUrls.push(url);
    const marks = it.marks?.length || 0;
    const title = it.name ? esc(it.name) : dateLabel(it.created);
    const sub = (it.name ? dateLabel(it.created) + ' · ' : '') + fmtBytes(it.size);
    b.innerHTML = `<div class="thumb" style="${url ? `background-image:url('${url}')` : ''}"><span class="dur">${fmt(it.duration)}</span></div>
      <div class="meta"><b>${title}</b>${sub}${marks ? `<br><span class="marks-n">⚑ ${marks} momento${marks > 1 ? 's' : ''}</span>` : ''}</div>`;
    b.onclick = () => openPlayer(it);
    grid.appendChild(b);
  }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) $('#storageInfo').textContent = `${fmtBytes(est.usage || 0)} de ${fmtBytes(est.quota)}`;
  } catch {}
}

let playerUrl = null;
function openPlayer(it) {
  state.current = it;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(it.blob);
  const v = $('#playerVideo');
  v.src = playerUrl;
  $('#playerTitle').textContent = dateLabel(it.created);
  $('#playerName').value = it.name || '';
  $('#playerMeta').textContent = `${fmt(it.duration)} · ${fmtBytes(it.size)} · ${it.type.includes('mp4') ? 'MP4' : 'WebM'}`;
  const marks = it.marks || [];
  $('#playerMarks').hidden = !marks.length;
  const chips = $('#playerChips');
  chips.innerHTML = '';
  marks.forEach((t) => {
    const c = document.createElement('button');
    c.textContent = '⚑ ' + fmt(t);
    c.onclick = () => { v.currentTime = Math.max(0, t - 2); v.play().catch(() => {}); };
    chips.appendChild(c);
  });
  openSheet('#playerSheet');
}

async function saveName() {
  const it = state.current; if (!it) return;
  const name = $('#playerName').value.trim();
  if (name === (it.name || '')) return;
  it.name = name;
  try { await DB.put('videos', it); renderLibrary(); } catch (e) { console.error(e); }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function shareCurrent() {
  const it = state.current; if (!it) return;
  const file = new File([it.blob], fileName(it), { type: it.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: it.name || 'Vídeo React' });
    } catch (e) {
      if (e.name !== 'AbortError') { console.error(e); toast('Não deu para compartilhar. Use Baixar arquivo.'); }
    }
  } else {
    downloadBlob(it.blob, fileName(it));
    toast('Baixando… o vídeo vai para a pasta Downloads.');
  }
}

async function deleteCurrent() {
  const it = state.current; if (!it) return;
  if (!confirm('Excluir esta gravação do app? Isso não pode ser desfeito. (Cópias já salvas na galeria continuam lá.)')) return;
  await DB.del('videos', it.id);
  closeSheet('#playerSheet');
  renderLibrary();
  toast('Gravação excluída.');
}

/* ---------------- sheets ---------------- */
function openSheet(sel) { $(sel).hidden = false; }
function closeSheet(sel) {
  $(sel).hidden = true;
  if (sel === '#playerSheet') { $('#playerVideo').pause(); saveName(); }
}
document.querySelectorAll('.sheet-backdrop').forEach((bd) => {
  bd.addEventListener('click', (e) => {
    if (e.target === bd || e.target.closest('[data-close]')) closeSheet('#' + bd.id);
  });
});

/* ---------------- configurações ---------------- */
let saveT;
function saveSettings() {
  clearTimeout(saveT);
  saveT = setTimeout(() => DB.put('kv', state.settings, 'settings').catch(console.error), 300);
}

function bindRange(id, key, label, fmtFn, onChange) {
  const el = $(id);
  el.value = state.settings[key];
  const show = () => { $(label).textContent = fmtFn(+el.value); setRangeFill(el); };
  show();
  el.addEventListener('input', () => { state.settings[key] = +el.value; show(); onChange?.(); saveSettings(); });
}
function bindSeg(id, key, onChange) {
  const seg = $(id);
  const mark = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.settings[key]));
  mark();
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if ((key === 'quality' || key === 'format') && busy()) { toast('Mude isso antes de gravar.'); return; }
    state.settings[key] = b.dataset.v; mark(); onChange?.(); saveSettings();
  });
}
function bindToggle(id, key, onChange) {
  const el = $(id);
  el.checked = !!state.settings[key];
  el.addEventListener('change', () => { state.settings[key] = el.checked; onChange?.(); saveSettings(); });
}

let bgT;
const rebuildBgSoon = () => { clearTimeout(bgT); bgT = setTimeout(buildBackground, 60); };

function refreshLayoutFields() {
  const pip = state.settings.layout === 'pip';
  $('#fieldSplit').hidden = pip;
  $('#fieldPip').hidden = !pip;
  positionOverlays();
}

function initSettingsUi() {
  bindRange('#sBlur', 'blur', '#vBlur', (v) => (v ? v : 'sem'), rebuildBgSoon);
  bindRange('#sDim', 'dim', '#vDim', (v) => v + '%', rebuildBgSoon);
  bindRange('#sSplit', 'split', '#vSplit', (v) => v + '%', positionOverlays);
  bindRange('#sPipSize', 'pipSize', '#vPipSize', (v) => v + '%', positionOverlays);
  bindRange('#sVolVid', 'volVid', '#vVolVid', (v) => v + '%', applyVolumes);
  bindRange('#sVolMic', 'volMic', '#vVolMic', (v) => v + '%', applyVolumes);
  bindSeg('#segLayout', 'layout', refreshLayoutFields);
  bindSeg('#segCorner', 'pipCorner', positionOverlays);
  bindSeg('#segFit', 'fit');
  bindSeg('#segQuality', 'quality', applyCanvasSize);
  bindSeg('#segFormat', 'format');
  bindToggle('#sMirror', 'mirror');
  bindToggle('#sBar', 'showBar', positionOverlays);
  bindToggle('#sCountdown', 'countdown');
  refreshLayoutFields();

  $('#btnFrameReset').addEventListener('click', () => {
    Object.assign(state.settings, { camZoom: 1, camX: 0, camY: 0 });
    saveSettings();
    toast('Câmera centralizada.');
  });
  $('#bgInput').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    await DB.put('kv', f, 'bgImage').catch(console.error);
    await loadBgBlob(f);
    toast('Fundo aplicado.');
  });
  $('#bgRemove').addEventListener('click', async () => {
    await DB.del('kv', 'bgImage').catch(console.error);
    await loadBgBlob(null);
  });
}

/* ---------------- navegação ---------------- */
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  if (busy() && t.dataset.view !== 'viewRecord') { toast('Pare a gravação antes de sair desta tela.'); return; }
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== t.dataset.view));
  if (t.dataset.view === 'viewLibrary') renderLibrary();
  else fitStage();
}));

/* ---------------- eventos ---------------- */
$('#btnCamOn').addEventListener('click', cameraOn);
$('#btnCamOff').addEventListener('click', cameraOff);
$('#fileInput').addEventListener('change', (e) => { loadVideo(e.target.files?.[0]); e.target.value = ''; });
$('#fileInput2').addEventListener('change', (e) => { loadVideo(e.target.files?.[0]); e.target.value = ''; });
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnBack').addEventListener('click', () => skip(-10));
$('#btnFwd').addEventListener('click', () => skip(10));
$('#btnRec').addEventListener('click', onRecButton);
$('#btnRecPause').addEventListener('click', togglePauseRec);
$('#btnMark').addEventListener('click', markMoment);
$('#btnSettings').addEventListener('click', () => openSheet('#settingsSheet'));
$('#btnHelp').addEventListener('click', () => openSheet('#helpSheet'));
$('#pShare').addEventListener('click', shareCurrent);
$('#pDownload').addEventListener('click', () => state.current && downloadBlob(state.current.blob, fileName(state.current)));
$('#pDelete').addEventListener('click', deleteCurrent);
$('#playerName').addEventListener('change', saveName);
$('#playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

const seekEl = $('#seek');
seekEl.addEventListener('input', () => {
  seeking = true; setRangeFill(seekEl);
  const d = mainVideo.duration || 0;
  if (d) { mainVideo.currentTime = (seekEl.value / 1000) * d; $('#tCur').textContent = fmt(mainVideo.currentTime); }
});
seekEl.addEventListener('change', () => { seeking = false; });

window.addEventListener('beforeunload', (e) => { if (busy()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (recActive()) {
      toast('Você saiu do app durante a gravação: esse trecho pode ter ficado congelado.', 4500);
      try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    }
    state.audio?.ctx.resume().catch(() => {});
  }
});

new ResizeObserver(fitStage).observe($('#stageWrap'));

/* ---------------- início ---------------- */
(async function init() {
  try {
    const saved = await DB.get('kv', 'settings');
    if (saved) state.settings = { ...DEFAULTS, ...saved };
  } catch (e) { console.error(e); }
  initSettingsUi();
  applyCanvasSize();
  try { await loadBgBlob(await DB.get('kv', 'bgImage')); } catch (e) { console.error(e); }
  fitStage();
  refreshUi();
  requestAnimationFrame(loop);
  recoverInterrupted();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
})();
