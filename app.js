'use strict';

/* =========================================================
   ReactPro — PWA de reação a vídeos
   O vídeo final é montado num <canvas> (fundo + câmera + vídeo)
   e gravado com MediaRecorder. Botões e menus ficam fora do canvas,
   por isso não aparecem na gravação.
   ========================================================= */

const $ = (s) => document.querySelector(s);
const W = 1080, H = 1920;            // coordenadas lógicas do quadro (9:16)
const PAD = 44, GAP = 28, RADIUS = 34;

const DEFAULTS = {
  blur: 14, dim: 35, split: 45, fit: 'contain', mirror: true, showBar: true,
  volVid: 100, volMic: 100, quality: '1080',
};

const state = {
  settings: { ...DEFAULTS },
  camStream: null,
  micStream: null,
  videoUrl: null,
  videoReady: false,
  bgBitmap: null,       // imagem original do fundo
  bgCanvas: null,       // fundo já desfocado/escurecido no tamanho do quadro
  recorder: null,
  chunks: [],
  recStart: 0,
  recTimer: null,
  wakeLock: null,
  audio: null,          // { ctx, dest, vidGain, micGain, micNode }
  current: null,        // gravação aberta no player
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
      const r = indexedDB.open('reactpro', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('videos', { keyPath: 'id' });
        db.createObjectStore('kv');
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
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    put: (store, val, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
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

/* ---------------- layout do quadro ---------------- */
function layout() {
  const inner = H - PAD * 2 - GAP;
  const camH = Math.round(inner * (state.settings.split / 100));
  const cam = { x: PAD, y: PAD, w: W - PAD * 2, h: camH };
  const vid = { x: PAD, y: PAD + camH + GAP, w: W - PAD * 2, h: inner - camH };
  return { cam, vid };
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
    el.style.right = (r.x / W) * 100 + '%';
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
      const m = blur * 2; // margem para não escurecer as bordas
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
    // reduz para no máximo 1600px no lado maior (economiza memória)
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
function drawMedia(src, sw, sh, r, mode, mirror) {
  const s = mode === 'cover' ? Math.max(r.w / sw, r.h / sh) : Math.min(r.w / sw, r.h / sh);
  const dw = sw * s, dh = sh * s;
  const dx = r.x + (r.w - dw) / 2, dy = r.y + (r.h - dh) / 2;
  if (mirror) {
    ctx.save();
    ctx.translate(2 * (r.x + r.w / 2), 0);
    ctx.scale(-1, 1);
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(src, dx, dy, dw, dh);
  }
}

function panel(r, fill) {
  roundRectPath(ctx, r.x, r.y, r.w, r.h, RADIUS);
  ctx.fillStyle = fill;
  ctx.fill();
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
  // ícone play/pause
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
  // barra
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

  const { cam, vid } = layout();
  const translucent = state.bgBitmap ? 'rgba(14,14,16,0.55)' : 'rgba(22,22,25,1)';

  // câmera
  ctx.save();
  panel(cam, translucent);
  ctx.clip();
  if (state.camStream && camVideo.videoWidth) {
    drawMedia(camVideo, camVideo.videoWidth, camVideo.videoHeight, cam, 'cover', state.settings.mirror);
  }
  ctx.restore();

  // vídeo
  ctx.save();
  panel(vid, state.videoReady ? 'rgba(0,0,0,0.78)' : translucent);
  ctx.clip();
  if (state.videoReady && mainVideo.videoWidth) {
    drawMedia(mainVideo, mainVideo.videoWidth, mainVideo.videoHeight, vid, state.settings.fit, false);
    if (state.settings.showBar) drawProgress(vid);
  }
  ctx.restore();

  // contorno sutil
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  roundRectPath(ctx, cam.x, cam.y, cam.w, cam.h, RADIUS); ctx.stroke();
  roundRectPath(ctx, vid.x, vid.y, vid.w, vid.h, RADIUS); ctx.stroke();
}

// Mantém o desenho rodando mesmo se a aba estiver em segundo plano por instantes.
function loop() { draw(); requestAnimationFrame(loop); }

/* ---------------- câmera / microfone ---------------- */
async function cameraOn() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Este navegador não permite câmera. Abra pelo link https no Chrome ou Safari.'); return;
  }
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
  } catch (e) {
    console.error(e);
    toast(e.name === 'NotAllowedError'
      ? 'Permissão negada. Libere câmera e microfone nas configurações do navegador.'
      : 'Não foi possível abrir a câmera.');
  }
}

function cameraOff() {
  if (state.recorder) { toast('Pare a gravação antes de desligar a câmera.'); return; }
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
    vidSrc.connect(actx.destination);   // você ouve o vídeo
    vidSrc.connect(vidGain).connect(dest); // e ele entra na gravação
    micGain.connect(dest);              // a voz só vai para a gravação (sem retorno)
    state.audio = { ctx: actx, dest, vidGain, micGain, micNode: null };
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
  }
}

function applyVolumes() {
  if (!state.audio) return;
  state.audio.vidGain.gain.value = state.settings.volVid / 100;
  state.audio.micGain.gain.value = state.settings.volMic / 100;
}

/* ---------------- vídeo principal ---------------- */
function loadVideo(file) {
  if (!file) return;
  if (state.recorder) { toast('Pare a gravação antes de trocar o vídeo.'); return; }
  ensureAudio();
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoReady = false;
  state.videoUrl = URL.createObjectURL(file);
  mainVideo.src = state.videoUrl;
  mainVideo.load();
  $('#uploadText').textContent = file.name || 'Vídeo carregado';
  refreshUi();
}

mainVideo.addEventListener('loadeddata', () => {
  state.videoReady = true;
  try { mainVideo.currentTime = 0.001; } catch {}
  refreshUi();
});
mainVideo.addEventListener('error', () => {
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
  mainVideo.currentTime = Math.max(0, Math.min((mainVideo.duration || 0) - 0.05, mainVideo.currentTime + sec));
}

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
function pickMime() {
  if (!window.MediaRecorder) return null;
  const list = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return list.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) ?? '';
}

async function startRec() {
  if (!state.videoReady) { toast('Carregue um vídeo primeiro.'); return; }
  const mime = pickMime();
  if (mime === null || !canvas.captureStream) { toast('Este navegador não consegue gravar. Use o Chrome (Android) ou o Safari (iPhone) atualizados.'); return; }

  const audio = ensureAudio();
  if (!state.micStream) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      setMic(s);
    } catch {
      toast('Sem microfone: a gravação terá só o som do vídeo.');
    }
  }

  const vStream = canvas.captureStream(30);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...audio.dest.stream.getAudioTracks()]);
  const opts = { videoBitsPerSecond: state.settings.quality === '720' ? 5_000_000 : 9_000_000, audioBitsPerSecond: 160_000 };
  if (mime) opts.mimeType = mime;

  let rec;
  try { rec = new MediaRecorder(stream, opts); }
  catch (e) {
    try { rec = new MediaRecorder(stream); } catch (e2) { console.error(e2); toast('Não foi possível iniciar a gravação.'); return; }
  }
  state.chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
  rec.onstop = () => finishRec(rec, vStream);
  rec.onerror = (e) => { console.error(e); toast('Erro durante a gravação.'); };
  rec.start(1000);
  state.recorder = rec;
  state.recStart = performance.now();
  state.recTimer = setInterval(tickRec, 250);
  tickRec();
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  refreshUi();
}

function stopRec() {
  const rec = state.recorder;
  if (!rec) return;
  if (rec.state !== 'inactive') { try { rec.requestData(); } catch {} rec.stop(); }
}

async function finishRec(rec, vStream) {
  const duration = (performance.now() - state.recStart) / 1000;
  clearInterval(state.recTimer);
  vStream.getTracks().forEach((t) => t.stop());
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
  state.recorder = null;
  refreshUi();

  const type = (rec.mimeType || state.chunks[0]?.type || 'video/webm').split(';')[0];
  const blob = new Blob(state.chunks, { type });
  state.chunks = [];
  if (!blob.size) { toast('A gravação ficou vazia. Tente de novo.'); return; }

  const thumb = await makeThumb();
  const item = { id: Date.now().toString(36), created: Date.now(), duration, type, size: blob.size, blob, thumb };
  try {
    await DB.put('videos', item);
    toast('Gravação salva em Meus vídeos ✓');
    renderLibrary();
  } catch (e) {
    console.error(e);
    toast('Sem espaço para salvar no app. Baixando o arquivo…', 4000);
    downloadBlob(blob, fileName(item));
  }
}

function makeThumb() {
  return new Promise((res) => {
    const c = document.createElement('canvas');
    c.width = 270; c.height = 480;
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    c.toBlob((b) => res(b), 'image/jpeg', 0.75);
  });
}

function tickRec() {
  const s = (performance.now() - state.recStart) / 1000;
  const t = fmt(s);
  $('#recBadgeTime').textContent = t;
  $('#recHint').textContent = '● ' + t;
}

/* ---------------- UI geral ---------------- */
function refreshUi() {
  const recording = !!state.recorder;
  const camOn = !!state.camStream;
  $('#btnCamOn').hidden = camOn;
  $('#btnCamOff').hidden = !camOn || recording;
  $('#ovVid').querySelector('.pill').hidden = state.videoReady || recording;

  for (const id of ['#btnPlay', '#btnBack', '#btnFwd', '#seek']) $(id).disabled = !state.videoReady;
  const rb = $('#btnRec');
  rb.disabled = !state.videoReady;
  rb.classList.toggle('on', recording);
  rb.setAttribute('aria-label', recording ? 'Parar e salvar' : 'Gravar');
  $('#recBadge').hidden = !recording;
  $('#uploadLabel').classList.toggle('disabled', recording);

  const hint = $('#recHint');
  hint.classList.toggle('live', recording);
  if (!recording) {
    hint.textContent = !state.videoReady ? 'Carregue um vídeo para gravar'
      : camOn ? 'Pronto. Toque no REC' : 'Ative a câmera e toque no REC';
  }
  refreshPlayIcon();
  updateSeek();
}

/* ---------------- biblioteca ---------------- */
function fileName(item) {
  const d = new Date(item.created);
  const p = (n) => String(n).padStart(2, '0');
  const ext = item.type.includes('mp4') ? 'mp4' : 'webm';
  return `react-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

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
    const d = new Date(it.created);
    b.innerHTML = `<div class="thumb" style="${url ? `background-image:url('${url}')` : ''}"><span class="dur">${fmt(it.duration)}</span></div>
      <div class="meta"><b>${d.toLocaleDateString('pt-BR')} · ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b>${fmtBytes(it.size)}</div>`;
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
  const d = new Date(it.created);
  $('#playerTitle').textContent = d.toLocaleDateString('pt-BR') + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('#playerMeta').textContent = `${fmt(it.duration)} · ${fmtBytes(it.size)} · ${it.type.includes('mp4') ? 'MP4' : 'WebM'}`;
  openSheet('#playerSheet');
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
      await navigator.share({ files: [file], title: 'Vídeo React' });
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
  if (sel === '#playerSheet') { const v = $('#playerVideo'); v.pause(); }
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
    if (key === 'quality' && state.recorder) { toast('Mude a qualidade antes de gravar.'); return; }
    state.settings[key] = b.dataset.v; mark(); onChange?.(); saveSettings();
  });
}
function bindToggle(id, key) {
  const el = $(id);
  el.checked = !!state.settings[key];
  el.addEventListener('change', () => { state.settings[key] = el.checked; saveSettings(); });
}

let bgT;
const rebuildBgSoon = () => { clearTimeout(bgT); bgT = setTimeout(buildBackground, 60); };

function initSettingsUi() {
  bindRange('#sBlur', 'blur', '#vBlur', (v) => (v ? v : 'sem'), rebuildBgSoon);
  bindRange('#sDim', 'dim', '#vDim', (v) => v + '%', rebuildBgSoon);
  bindRange('#sSplit', 'split', '#vSplit', (v) => v + '%', positionOverlays);
  bindRange('#sVolVid', 'volVid', '#vVolVid', (v) => v + '%', applyVolumes);
  bindRange('#sVolMic', 'volMic', '#vVolMic', (v) => v + '%', applyVolumes);
  bindSeg('#segFit', 'fit');
  bindSeg('#segQuality', 'quality', applyCanvasSize);
  bindToggle('#sMirror', 'mirror');
  bindToggle('#sBar', 'showBar');

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
  if (state.recorder && t.dataset.view !== 'viewRecord') { toast('Pare a gravação antes de sair desta tela.'); return; }
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
$('#ovVid').addEventListener('click', (e) => { if (!e.target.closest('.pill')) togglePlay(); });
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnBack').addEventListener('click', () => skip(-10));
$('#btnFwd').addEventListener('click', () => skip(10));
$('#btnRec').addEventListener('click', () => (state.recorder ? stopRec() : startRec()));
$('#btnSettings').addEventListener('click', () => openSheet('#settingsSheet'));
$('#btnHelp').addEventListener('click', () => openSheet('#helpSheet'));
$('#pShare').addEventListener('click', shareCurrent);
$('#pDownload').addEventListener('click', () => state.current && downloadBlob(state.current.blob, fileName(state.current)));
$('#pDelete').addEventListener('click', deleteCurrent);

const seekEl = $('#seek');
seekEl.addEventListener('input', () => {
  seeking = true; setRangeFill(seekEl);
  const d = mainVideo.duration || 0;
  if (d) { mainVideo.currentTime = (seekEl.value / 1000) * d; $('#tCur').textContent = fmt(mainVideo.currentTime); }
});
seekEl.addEventListener('change', () => { seeking = false; });

window.addEventListener('beforeunload', (e) => { if (state.recorder) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (state.recorder) {
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
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
})();
