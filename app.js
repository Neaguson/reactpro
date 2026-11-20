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
const PAD = 14, GAP = 12, RADIUS = 26;

// efeitos da câmera (0 = sem efeito)
const FX_KEYS = ['smooth', 'shadow', 'bright', 'contrast', 'sat', 'warm'];
const FX_PRESETS = {
  off:     { smooth: 0,  shadow: 0,  bright: 0,  contrast: 0,  sat: 0,   warm: 0 },
  natural: { smooth: 35, shadow: 30, bright: 4,  contrast: 3,  sat: 4,   warm: 3 },
  suave:   { smooth: 65, shadow: 50, bright: 8,  contrast: -4, sat: 0,   warm: 6 },
  glow:    { smooth: 55, shadow: 45, bright: 12, contrast: 8,  sat: 14,  warm: 10 },
};

const DEFAULTS = {
  blur: 14, dim: 35,
  layout: 'stack', split: 45, pipSize: 38, pipCorner: 'tr',
  fit: 'contain', mirror: true, showBar: true, countdown: true,
  camZoom: 1, camX: 0, camY: 0,
  volVid: 100, volMic: 100, quality: '1080', format: 'mp4', fps: '60',
  watermark: false, wmOpacity: 16, autoClips: false, clipLen: '30',
  pauseVidWithRec: true, headTip: true, duck: true, duckAmt: 50,
  micNoise: true, micEq: true, micComp: true,
  fx: { ...FX_PRESETS.off },
};

// logo usado na marca d'água
const wmImg = new Image();
wmImg.src = 'assets/logo-mk.svg';

const state = {
  settings: { ...DEFAULTS },
  camStream: null,
  facing: 'user',       // 'user' (frontal) | 'environment' (traseira)
  camCount: 0,
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
    const m = PAD + 24;
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
  const src = FX.frame() || camVideo; // com efeitos, desenha a imagem já tratada
  // com espelho, o deslocamento é invertido para acompanhar o dedo na tela
  const mir = mirrorOn();
  const ox = (mir ? -s.camX : s.camX) * mx;
  const oy = s.camY * my;
  const dx = r.x + (r.w - dw) / 2 + ox, dy = r.y + (r.h - dh) / 2 + oy;
  if (mir) {
    ctx.save();
    ctx.translate(2 * (r.x + r.w / 2), 0);
    ctx.scale(-1, 1);
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(src, dx, dy, dw, dh);
  }
}

/* ---------------- efeitos da câmera (WebGL) ----------------
   Suaviza a pele (filtro que preserva bordas, só onde a cor é de pele),
   clareia sombras locais do rosto (olheiras) e ajusta brilho, contraste,
   saturação e temperatura. Se o celular não tiver WebGL, a câmera
   continua normal, sem efeito. */
const FX = (() => {
  const VS = `attribute vec2 p; varying vec2 uv;
    void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `precision mediump float;
    uniform sampler2D tex; uniform vec2 px; uniform float rad;
    uniform float uSmooth, uShadow, uBright, uContrast, uSat, uWarm;
    varying vec2 uv;
    float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
    float skin(vec3 c){
      float y = luma(c);
      float cb = (c.b - y) * 0.564 + 0.5, cr = (c.r - y) * 0.713 + 0.5;
      return smoothstep(0.26, 0.32, cb) * (1.0 - smoothstep(0.50, 0.55, cb))
           * smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.69, 0.74, cr))
           * smoothstep(0.06, 0.18, y);
    }
    void main(){
      vec3 c = texture2D(tex, uv).rgb;
      vec3 o = c;
      if (uSmooth > 0.0 || uShadow > 0.0) {
        vec3 sum = c; float ws = 1.0; float ls = 0.0;
        for (int ring = 1; ring <= 3; ring++) {
          float r = float(ring) * rad;
          for (int k = 0; k < 8; k++) {
            float a = float(k) * 0.785398 + float(ring) * 0.392699;
            vec3 s = texture2D(tex, uv + vec2(cos(a), sin(a)) * r * px).rgb;
            vec3 d = s - c;
            float w = exp(-dot(d, d) * 30.0);
            sum += s * w; ws += w; ls += luma(s);
          }
        }
        vec3 bil = sum / ws;
        float sk = max(skin(c), skin(bil));
        o = mix(c, bil, clamp(uSmooth * sk, 0.0, 1.0));
        float l = luma(o);
        float dark = max(ls / 24.0 - l, 0.0);
        o += uShadow * sk * (dark * 1.8 + 0.08 * (1.0 - smoothstep(0.12, 0.65, l)));
      }
      o += uBright * 0.22;
      o = (o - 0.5) * (1.0 + uContrast) + 0.5;
      o = mix(vec3(luma(o)), o, 1.0 + uSat);
      o += vec3(0.06, 0.012, -0.06) * uWarm;
      gl_FragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
    }`;

  let cv = null, gl = null, prog = null, tex = null, U = {}, failed = false;
  let fresh = true, lastW = 0, lastH = 0;
  state.fxBypass = false;

  function init() {
    if (gl || failed) return !!gl;
    try {
      cv = document.createElement('canvas');
      gl = cv.getContext('webgl', { preserveDrawingBuffer: true, alpha: false, antialias: false, premultipliedAlpha: false });
      if (!gl) throw new Error('sem webgl');
      const sh = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      for (const n of ['tex', 'px', 'rad', 'uSmooth', 'uShadow', 'uBright', 'uContrast', 'uSat', 'uWarm']) U[n] = gl.getUniformLocation(prog, n);
      cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; });
      cv.addEventListener('webglcontextrestored', () => { gl = null; failed = false; });
      return true;
    } catch (e) {
      console.warn('Efeitos indisponíveis:', e);
      failed = true; gl = null;
      return false;
    }
  }

  const active = () => {
    const f = state.settings.fx;
    return !state.fxBypass && FX_KEYS.some((k) => f[k]);
  };

  // só reprocessa quando chega um quadro novo da câmera
  function watchFrames() {
    if (!camVideo.requestVideoFrameCallback) return;
    const cb = () => { fresh = true; camVideo.requestVideoFrameCallback(cb); };
    camVideo.requestVideoFrameCallback(cb);
  }
  watchFrames();
  const hasRvfc = !!camVideo.requestVideoFrameCallback;

  function frame() {
    if (!active() || !camVideo.videoWidth || !init()) return null;
    const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
    const k = Math.min(1, 1280 / Math.max(vw, vh));
    const w = Math.round(vw * k), h = Math.round(vh * k);
    if (w !== lastW || h !== lastH) { cv.width = w; cv.height = h; lastW = w; lastH = h; fresh = true; }
    if (!fresh && hasRvfc && !frame.dirty) return cv;
    fresh = false; frame.dirty = false;
    try {
      const f = state.settings.fx;
      gl.viewport(0, 0, w, h);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, camVideo);
      gl.uniform1i(U.tex, 0);
      gl.uniform2f(U.px, 1 / w, 1 / h);
      gl.uniform1f(U.rad, Math.max(1.2, (Math.min(w, h) / 720) * 2.4));
      gl.uniform1f(U.uSmooth, f.smooth / 100);
      gl.uniform1f(U.uShadow, (f.shadow / 100) * 0.7);
      gl.uniform1f(U.uBright, f.bright / 100);
      gl.uniform1f(U.uContrast, (f.contrast / 100) * 0.6);
      gl.uniform1f(U.uSat, f.sat / 100);
      gl.uniform1f(U.uWarm, f.warm / 100);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return cv;
    } catch (e) {
      console.warn(e);
      return null;
    }
  }
  frame.dirty = false;

  return {
    frame,
    supported: () => init(),
    touch: () => { frame.dirty = true; },
  };
})();

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
  if (pip && !camOn && recActive()) { drawWatermark(); return; } // no modo canto, sem câmera não desenha caixa vazia
  drawCameraPanel(cam, pip, camOn, tint);
  drawWatermark();
}

function drawCameraPanel(cam, pip, camOn, tint) {
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

// Marca d'água: logo pequeno e quase transparente no canto superior
// (o lado livre, se a câmera estiver no canto direito). Sem sombra, para não "saltar" da imagem.
function drawWatermark() {
  if (!state.settings.watermark || !wmImg.complete || !wmImg.naturalWidth) return;
  const s = state.settings;
  const h = 84, w = h * (wmImg.naturalWidth / wmImg.naturalHeight);
  let x, y;
  if (s.layout === 'pip') {
    const m = PAD + 22;
    x = s.pipCorner === 'tr' ? m : W - m - w; y = m;
  } else { // canto inferior direito da câmera (longe dos botões da tela)
    const { cam } = layout();
    x = cam.x + cam.w - 24 - w; y = cam.y + cam.h - 24 - h;
  }
  ctx.save();
  ctx.globalAlpha = clamp(s.wmOpacity, 5, 60) / 100;
  ctx.drawImage(wmImg, x, y, w, h);
  ctx.restore();
}

/* ---------------- medidor do microfone ---------------- */
const meterBars = [...document.querySelectorAll('#micMeter i')];
const meterBuf = new Uint8Array(512); // = analyser.fftSize
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

// Fora da aba Gravar (e sem gravar), o quadro não precisa ser redesenhado:
// sobra fôlego para os cortes saírem mais lisos.
const viewRecord = $('#viewRecord');
function loop() {
  if (!viewRecord.hidden || busy()) { draw(); updateMeter(); }
  requestAnimationFrame(loop);
}

/* ---------------- câmera / microfone ---------------- */
async function cameraOn() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Este navegador não permite câmera. Abra pelo link https no Chrome ou Safari.'); return;
  }
  ensureAudio();
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints(), audio: micConstraints() });
    state.camStream = new MediaStream(s.getVideoTracks());
    setMic(new MediaStream(s.getAudioTracks()));
    camVideo.srcObject = state.camStream;
    await camVideo.play().catch(() => {});
    countCameras();
    refreshUi();
    showFrameHint();
  } catch (e) {
    console.error(e);
    toast(e.name === 'NotAllowedError'
      ? 'Permissão negada. Libere câmera e microfone nas configurações do navegador.'
      : 'Não foi possível abrir a câmera.');
  }
}

// quadros por segundo escolhidos (câmera e gravação)
function fps() { return state.settings.fps === '30' ? 30 : 60; }
function camConstraints() {
  return { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: fps() } };
}
// Com o "Tirar ruído" ligado, a redução do próprio celular fica desligada para não processar a voz duas vezes.
function micConstraints() {
  return { echoCancellation: true, noiseSuppression: !state.settings.micNoise, autoGainControl: true };
}
// espelho só faz sentido na câmera frontal
const mirrorOn = () => state.settings.mirror && state.facing === 'user';

/* Câmera traseira: troca só a imagem; o microfone e a gravação continuam
   (dá para trocar até no meio da gravação). */
async function countCameras() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    state.camCount = list.filter((d) => d.kind === 'videoinput').length;
  } catch { state.camCount = 0; }
  refreshUi();
}
async function switchCamera() {
  if (!state.camStream || state.switching) return;
  state.switching = true;
  const prev = state.facing;
  state.facing = prev === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints(), audio: false });
    state.camStream.getTracks().forEach((t) => t.stop());
    state.camStream = s;
    camVideo.srcObject = s;
    await camVideo.play().catch(() => {});
    Object.assign(state.settings, { camZoom: 1, camX: 0, camY: 0 });
    FX.touch();
    toast(state.facing === 'user' ? 'Câmera frontal' : 'Câmera traseira', 1200);
  } catch (e) {
    console.error(e);
    state.facing = prev;
    toast('Não foi possível trocar de câmera.');
  }
  state.switching = false;
  refreshUi();
}
function applyCamFps() {
  const tr = state.camStream?.getVideoTracks()[0];
  tr?.applyConstraints?.({ frameRate: { ideal: fps() } }).catch(() => {});
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
    let actx;
    try { actx = new AC({ sampleRate: 48000 }); } catch { actx = new AC(); } // o RNNoise trabalha em 48 kHz
    const dest = actx.createMediaStreamDestination();
    const vidSrc = actx.createMediaElementSource(mainVideo);
    const duck = actx.createGain();          // abaixa o vídeo enquanto você fala
    const vidGain = actx.createGain();
    const micGain = actx.createGain();
    const monitor = actx.createGain();       // "Ouvir minha voz" (só no fone, não entra na gravação duas vezes)
    monitor.gain.value = 0;
    const analyser = actx.createAnalyser();
    analyser.fftSize = 512;
    vidSrc.connect(duck);
    duck.connect(actx.destination);          // você ouve o vídeo
    duck.connect(vidGain).connect(dest);     // e ele entra na gravação
    micGain.connect(dest);                   // a voz vai para a gravação
    micGain.connect(monitor).connect(actx.destination); // e, se ligado, para o seu fone
    state.audio = { ctx: actx, dest, duck, vidGain, micGain, monitor, micNode: null, analyser, chain: buildMicChain(actx) };
    applyVolumes();
    if (state.micStream) setMic(state.micStream);
    setInterval(duckTick, 50);
    if (state.settings.micNoise) loadRnnoise();
  }
  if (state.audio.ctx.state !== 'running') state.audio.ctx.resume().catch(() => {});
  return state.audio;
}

/* ---------------- melhorar microfone ----------------
   Tirar ruído (RNNoise) → equalizador de voz → compressor + limitador.
   Cada parte liga/desliga sozinha; a cadeia é refeita na hora. */
function buildMicChain(c) {
  const bq = (type, f, gain = 0, Q = 0.9) => { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.gain.value = gain; n.Q.value = Q; return n; };
  const input = c.createGain();
  const hp = bq('highpass', 90, 0, 0.7);        // tira ronco, batida e vento
  const mud = bq('peaking', 320, -2.5, 1);      // menos "abafado"
  const pres = bq('peaking', 3200, 3.5, 0.9);   // voz mais clara
  const air = bq('highshelf', 9000, 1.5);       // um pouco de brilho
  const comp = c.createDynamicsCompressor();     // volume mais parelho
  comp.threshold.value = -26; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
  const makeup = c.createGain(); makeup.gain.value = 1.8;
  const limiter = c.createDynamicsCompressor();  // grito/risada não estoura
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08;
  return { input, hp, mud, pres, air, comp, makeup, limiter, rn: null, rnState: 'off' };
}

function wireMicChain() {
  const a = state.audio; if (!a) return;
  const ch = a.chain, s = state.settings;
  for (const n of [ch.input, ch.rn, ch.hp, ch.mud, ch.pres, ch.air, ch.comp, ch.makeup, ch.limiter]) { try { n?.disconnect(); } catch {} }
  let last = ch.input;
  const to = (n) => { last.connect(n); last = n; };
  if (s.micNoise && ch.rn) to(ch.rn);
  if (s.micEq) { to(ch.hp); to(ch.mud); to(ch.pres); to(ch.air); }
  last.connect(a.analyser);                    // medidor, sugestões e "abaixar vídeo" leem a voz já limpa
  if (s.micComp) { to(ch.comp); to(ch.makeup); to(ch.limiter); }
  last.connect(a.micGain);
}

async function loadRnnoise() {
  const a = state.audio; if (!a) return;
  const ch = a.chain;
  if (ch.rn || ch.rnState === 'loading') return;
  if (a.ctx.sampleRate !== 48000 || !a.ctx.audioWorklet || !window.WebAssembly) {
    ch.rnState = 'unsupported'; updateMicNote(); return;
  }
  ch.rnState = 'loading'; updateMicNote();
  try {
    const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    const [, wasmBinary] = await Promise.all([
      a.ctx.audioWorklet.addModule('assets/vendor/rnnoise/worklet.js'),
      fetch(simd ? 'assets/vendor/rnnoise/rnnoise_simd.wasm' : 'assets/vendor/rnnoise/rnnoise.wasm').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    ]);
    ch.rn = new AudioWorkletNode(a.ctx, '@sapphi-red/web-noise-suppressor/rnnoise', { processorOptions: { maxChannels: 2, wasmBinary } });
    ch.rnState = 'on';
  } catch (e) {
    console.error(e);
    ch.rnState = 'error';
  }
  updateMicNote();
  wireMicChain();
}

function updateMicNote() {
  const el = $('#micNoiseNote'); if (!el) return;
  const st = state.audio?.chain.rnState;
  el.textContent = !state.settings.micNoise ? 'Desligado: usa só a redução do próprio celular.'
    : st === 'loading' ? 'Carregando o filtro…'
    : st === 'unsupported' ? 'Este celular não suporta o filtro; usando a redução do próprio celular.'
    : st === 'error' ? 'Não foi possível carregar o filtro agora (sem internet?). Tente de novo mais tarde.'
    : 'Remove ventilador, ar-condicionado, rua e chiado, deixando só a voz.';
}

function applyMicSettings() {
  const a = state.audio;
  if (state.settings.micNoise && a) loadRnnoise();
  // liga/desliga a redução do próprio celular conforme o RNNoise
  state.micStream?.getAudioTracks().forEach((t) => t.applyConstraints?.({ noiseSuppression: !state.settings.micNoise }).catch(() => {}));
  wireMicChain();
  updateMicNote();
}

// "Ouvir minha voz": você escuta no fone a voz já com os filtros, ao vivo
async function ensureMic() {
  if (state.micStream) return true;
  try {
    setMic(await navigator.mediaDevices.getUserMedia({ audio: micConstraints() }));
    return true;
  } catch { return false; }
}
async function setMonitor(on) {
  const a = ensureAudio();
  if (on && !(await ensureMic())) { toast('Libere o microfone para ouvir sua voz.'); on = false; }
  state.monitoring = on;
  a.monitor.gain.setTargetAtTime(on ? 1 : 0, a.ctx.currentTime, 0.02);
  const b = $('#btnMonitor');
  b.classList.toggle('on', on);
  b.textContent = on ? 'Parar de ouvir' : '🎧 Ouvir minha voz';
  if (on) toast('Use fone: sem ele dá microfonia. Ligue e desligue os filtros para comparar.', 3500);
}

function setMic(stream) {
  state.micStream = stream;
  if (!state.audio) return;
  state.audio.micNode?.disconnect();
  state.audio.micNode = null;
  if (stream && stream.getAudioTracks().length) {
    state.audio.micNode = state.audio.ctx.createMediaStreamSource(stream);
    state.audio.micNode.connect(state.audio.chain.input);
  }
  wireMicChain();
}

/* Abaixar o vídeo quando você fala: compara o nível do microfone com o
   "ruído de fundo" (que se ajusta sozinho) e baixa o vídeo rápido ao falar,
   devolvendo devagar quando você para. */
const duckBuf = new Uint8Array(512);
let duckFloor = 0.01, duckHold = 0, duckTarget = 1;
function duckTick() {
  const a = state.audio;
  if (!a) return;
  let target = 1;
  const s = state.settings;
  if (a.micNode && s.duck && s.volMic > 0 && !mainVideo.paused) {
    a.analyser.getByteTimeDomainData(duckBuf);
    let sum = 0;
    for (let i = 0; i < duckBuf.length; i++) { const d = (duckBuf[i] - 128) / 128; sum += d * d; }
    const rms = Math.sqrt(sum / duckBuf.length);
    duckFloor = rms < duckFloor ? duckFloor * 0.85 + rms * 0.15 : duckFloor * 0.995 + rms * 0.005;
    const now = performance.now();
    if (rms > Math.max(0.025, duckFloor * 3)) duckHold = now + 450;
    if (now < duckHold) target = 1 - s.duckAmt / 100;
  }
  if (target !== duckTarget) {
    duckTarget = target;
    a.duck.gain.setTargetAtTime(target, a.ctx.currentTime, target < 1 ? 0.06 : 0.35);
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
// controles por cima do vídeo: somem sozinhos enquanto toca, voltam com um toque
const vidControls = $('#vidControls');
let ctrlT;
function pokeControls() {
  vidControls.classList.remove('faded');
  clearTimeout(ctrlT);
  if (!mainVideo.paused && !mainVideo.ended) ctrlT = setTimeout(() => vidControls.classList.add('faded'), 2600);
}
vidControls.addEventListener('pointerdown', pokeControls);
vidControls.addEventListener('click', (e) => e.stopPropagation());

$('#ovVid').addEventListener('click', (e) => {
  if (e.target.closest('.pill, .mini') || !state.videoReady) return;
  if (vidControls.classList.contains('faded')) { pokeControls(); return; } // 1º toque só mostra os controles
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
  pokeControls();
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
  if ($('#viewRecord').hidden) { // apertou o REC na aba Meus vídeos: volta para Gravar
    $('.tab[data-view="viewRecord"]').click();
    return;
  }
  if (state.phase === 'countdown') return cancelCountdown();
  if (state.phase === 'idle') return beginRec();
  if (recActive()) return stopRec();
}

async function beginRec() {
  if (!state.videoReady) { toast('Carregue um vídeo primeiro.'); return; }
  if (clipBusy) { toast('Aguarde os cortes terminarem antes de gravar de novo.'); return; }
  const mime = pickMime();
  if (mime === null || !canvas.captureStream) { toast('Este navegador não consegue gravar. Use o Chrome (Android) ou o Safari (iPhone) atualizados.'); return; }
  ensureAudio();
  const sp = await spaceInfo();
  if (sp && sp.minutes < 3 && !confirm(`Pouco espaço no celular: dá para gravar só ${minTxt(sp.minutes)}. A gravação pode parar no meio. Gravar mesmo assim?\n\nDica: em Meus vídeos, apague os que já estão na galeria.`)) return;
  if (!(await ensureMic())) toast('Sem microfone: a gravação terá só o som do vídeo.');
  if (!state.settings.countdown) {
    if (state.settings.headTip && !state.tipShown) { state.tipShown = true; toast('🎧 Dica: use fone de ouvido para não dar eco.', 3000); }
    return startRecNow(mime);
  }

  state.phase = 'countdown';
  refreshUi();
  $('#cdTip').hidden = !state.settings.headTip;
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
  const f = fps();
  const vStream = canvas.captureStream(f);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...audio.dest.stream.getAudioTracks()]);
  // 60 FPS precisa de mais dados por segundo para não perder nitidez
  const vbr = (state.settings.quality === '720' ? 5_000_000 : 9_000_000) * (f === 60 ? 1.5 : 1);
  const opts = { videoBitsPerSecond: vbr, audioBitsPerSecond: 160_000 };
  if (mime) opts.mimeType = mime;

  let rec;
  try { rec = new MediaRecorder(stream, opts); }
  catch {
    try { rec = new MediaRecorder(stream); }
    catch (e2) { console.error(e2); vStream.getTracks().forEach((t) => t.stop()); state.phase = 'idle'; refreshUi(); toast('Não foi possível iniciar a gravação.'); return; }
  }

  const rid = Date.now().toString(36);
  state.rec = { rid, created: Date.now(), type: (rec.mimeType || mime || 'video/webm').split(';')[0], marks: [], loud: [], duration: 0 };
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
    // o vídeo para junto (opção), para não "andar" enquanto a gravação está pausada
    state.vidWasPlaying = state.settings.pauseVidWithRec && !mainVideo.paused && !mainVideo.ended;
    if (state.vidWasPlaying) mainVideo.pause();
    vibrate(20);
  } else if (state.phase === 'paused') {
    rec.resume();
    state.recSegStart = performance.now();
    state.phase = 'recording';
    if (state.vidWasPlaying) mainVideo.play().catch(() => {});
    state.vidWasPlaying = false;
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
    const item = await assembleAndSave(meta, thumb, false);
    const moments = allMoments(item);
    if (state.settings.autoClips && moments.length) {
      moments.forEach((m) => queueClip(item, m.t));
      toast(`Gravação salva ✓ Gerando ${moments.length} corte${moments.length > 1 ? 's' : ''} automaticamente…`, 4000);
    } else {
      toast('Gravação salva em Meus vídeos ✓');
    }
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
    suggestions: detectHighlights(meta.loud, meta.marks), clipsDone: [],
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
  sampleLoudness();
}

/* ---------------- sugestão de momentos (picos da sua voz) ---------------- */
const loudBuf = new Uint8Array(512); // mesmo tamanho do analisador (fftSize)
function sampleLoudness() {
  const a = state.audio;
  if (state.phase !== 'recording' || !state.rec || !a?.micNode) return;
  a.analyser.getByteTimeDomainData(loudBuf);
  let sum = 0;
  for (let i = 0; i < loudBuf.length; i++) { const d = (loudBuf[i] - 128) / 128; sum += d * d; }
  const rms = Math.sqrt(sum / loudBuf.length);
  state.rec.loud.push([Math.round(elapsedMs() / 100) / 10, Math.round(rms * 10000) / 10000]);
}

// Procura os trechos em que a voz ficou bem mais alta que o normal (risada, grito, empolgação).
function detectHighlights(samples, marks, max = 5) {
  if (!samples || samples.length < 40) return [];
  const secs = [];
  for (const [t, v] of samples) {
    const i = Math.floor(t);
    (secs[i] ||= []).push(v);
  }
  const avg = [];
  for (let i = 0; i < secs.length; i++) avg[i] = secs[i] ? secs[i].reduce((a, b) => a + b, 0) / secs[i].length : 0;
  // média móvel de 3 segundos
  const sm = avg.map((_, i) => {
    let s = 0, n = 0;
    for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < avg.length) { s += avg[k]; n++; }
    return s / n;
  });
  const sorted = [...sm].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p85 = sorted[Math.floor(sorted.length * 0.85)];
  const thr = Math.max(median * 2, p85, 0.02);
  const cands = [];
  for (let i = 0; i < sm.length; i++) {
    if (sm[i] < thr) continue;
    let isPeak = true;
    for (let k = Math.max(0, i - 4); k <= Math.min(sm.length - 1, i + 4); k++) if (sm[k] > sm[i]) { isPeak = false; break; }
    if (isPeak) cands.push({ t: i, score: sm[i] / thr });
  }
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.abs(p.t - c.t) < 12)) continue;
    if ((marks || []).some((m) => Math.abs(m - c.t) < 10)) continue; // já existe uma marcação sua ali
    picked.push({ t: c.t, score: Math.round(c.score * 100) / 100 });
  }
  return picked.sort((a, b) => a.t - b.t);
}

/* ---------------- UI geral ---------------- */
function refreshUi() {
  const p = state.phase;
  const camOn = !!state.camStream;
  const active = recActive();
  $('#btnCamOn').hidden = camOn;
  $('#btnCamOff').hidden = !camOn || busy();
  $('#btnFx').hidden = !camOn;
  $('#btnFlip').hidden = !camOn || state.camCount === 1; // some se o aparelho só tem uma câmera
  $('#btnFx').classList.toggle('on', FX_KEYS.some((k) => state.settings.fx[k]));
  ovCam.classList.toggle('framing', camOn);
  vidControls.hidden = !state.videoReady;
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

  // durante a gravação, a barra de baixo troca as abas por Pausar e Marcar
  document.querySelectorAll('.tab[data-view]').forEach((t) => (t.hidden = active));
  $('#btnRecPause').hidden = !active;
  $('#btnMark').hidden = !active;
  $('#btnRecPause .i-rp').hidden = p === 'paused';
  $('#btnRecPause .i-rr').hidden = p !== 'paused';
  $('#recPauseLabel').textContent = p === 'paused' ? 'Continuar' : 'Pausar';
  $('#btnRecPause').setAttribute('aria-label', p === 'paused' ? 'Continuar gravação' : 'Pausar gravação');

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
    const marks = (it.marks?.length || 0) + (it.suggestions?.length || 0);
    const title = it.name ? esc(it.name) : dateLabel(it.created);
    const sub = (it.name ? dateLabel(it.created) + ' · ' : '') + fmtBytes(it.size);
    b.innerHTML = `<div class="thumb" style="${url ? `background-image:url('${url}')` : ''}">${it.clipOf ? '<span class="tag">Corte</span>' : ''}${it.exported ? '<span class="tag ok">✓ Galeria</span>' : ''}<span class="dur">${fmt(it.duration)}</span></div>
      <div class="meta"><b>${title}</b>${sub}${marks ? `<br><span class="marks-n">⚑ ${marks} momento${marks > 1 ? 's' : ''}</span>` : ''}</div>`;
    b.onclick = () => openPlayer(it);
    grid.appendChild(b);
  }
  const sp = await spaceInfo();
  if (sp) {
    $('#storageInfo').textContent = `${fmtBytes(sp.usage)} usados`;
    const warn = $('#spaceWarn');
    warn.hidden = sp.minutes >= LOW_SPACE_MIN;
    if (!warn.hidden) {
      const saved = items.filter((i) => i.exported).length;
      warn.innerHTML = `<b>Pouco espaço no celular:</b> dá para gravar só ${minTxt(sp.minutes)}. `
        + (saved ? `Apague os vídeos que já estão na galeria (marcados <b>✓ Galeria</b>, ${saved} aqui).` : 'Salve na galeria os vídeos importantes e apague-os daqui para liberar espaço.');
    }
  }
}

/* ---------------- espaço no celular ---------------- */
const LOW_SPACE_MIN = 10;
const minTxt = (m) => (m < 1 ? 'menos de 1 min' : `uns ${Math.floor(m)} min`);
// MB por minuto de gravação, conforme a qualidade escolhida
function mbPerMin() {
  const vbr = (state.settings.quality === '720' ? 5 : 9) * (fps() === 60 ? 1.5 : 1);
  return ((vbr + 0.16) * 60) / 8;
}
async function spaceInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return null;
    const free = Math.max(0, est.quota - (est.usage || 0));
    return { usage: est.usage || 0, free, minutes: free / 1e6 / mbPerMin() };
  } catch { return null; }
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
  renderMoments();
  resetTrim(it);
  openSheet('#playerSheet');
}

/* ---------------- corte manual (início e fim) ---------------- */
const trim = { a: 0, b: 0, previewing: false };
const trimDur = () => state.current?.duration || 0;
function resetTrim(it) {
  const d = it.duration || 0;
  trim.a = 0; trim.b = Math.min(d, 30); trim.previewing = false;
  $('#trimBody').hidden = true;
  $('#btnTrimOpen').classList.remove('open');
  renderTrim();
}
function renderTrim() {
  const d = trimDur(); if (!d) return;
  $('#trimA').value = Math.round((trim.a / d) * 1000);
  $('#trimB').value = Math.round((trim.b / d) * 1000);
  const f = $('#trimFill');
  f.style.left = (trim.a / d) * 100 + '%';
  f.style.width = ((trim.b - trim.a) / d) * 100 + '%';
  const len = trim.b - trim.a;
  $('#trimInfo').textContent = `${fmt(trim.a)} – ${fmt(trim.b)} · ${len < 60 ? Math.round(len) + 's' : fmt(len)}`;
  $('#trimMake').disabled = len < 1;
}
function trimHead() {
  const d = trimDur(), v = $('#playerVideo');
  if (!d) return;
  $('#trimHead').style.left = clamp(v.currentTime / d, 0, 1) * 100 + '%';
  if (trim.previewing && v.currentTime >= trim.b) { v.pause(); trim.previewing = false; }
}
$('#playerVideo').addEventListener('timeupdate', trimHead);
$('#playerVideo').addEventListener('pause', () => { trim.previewing = false; });
$('#btnTrimOpen').addEventListener('click', () => {
  const body = $('#trimBody');
  body.hidden = !body.hidden;
  $('#btnTrimOpen').classList.toggle('open', !body.hidden);
  renderTrim(); trimHead();
});
$('#trimA').addEventListener('input', (e) => {
  const d = trimDur();
  trim.a = clamp((e.target.value / 1000) * d, 0, Math.max(0, trim.b - 1));
  $('#playerVideo').currentTime = trim.a;
  renderTrim();
});
$('#trimB').addEventListener('input', (e) => {
  const d = trimDur();
  trim.b = clamp((e.target.value / 1000) * d, Math.min(d, trim.a + 1), d);
  $('#playerVideo').currentTime = trim.b;
  renderTrim();
});
$('#trimSetA').addEventListener('click', () => {
  const d = trimDur(), t = $('#playerVideo').currentTime;
  trim.a = clamp(t, 0, d);
  if (trim.b - trim.a < 1) trim.b = Math.min(d, trim.a + 30);
  if (trim.b - trim.a < 1) trim.a = Math.max(0, trim.b - 1);
  renderTrim();
});
$('#trimSetB').addEventListener('click', () => {
  const d = trimDur(), t = $('#playerVideo').currentTime;
  trim.b = clamp(t, 0, d);
  if (trim.b - trim.a < 1) trim.a = Math.max(0, trim.b - 30);
  if (trim.b - trim.a < 1) trim.b = Math.min(d, trim.a + 1);
  renderTrim();
});
$('#trimPreview').addEventListener('click', () => {
  const v = $('#playerVideo');
  v.currentTime = trim.a;
  v.play().then(() => { trim.previewing = true; }).catch(() => {});
});
$('#trimMake').addEventListener('click', () => {
  const it = state.current; if (!it) return;
  queueClip(it, trim.a, { start: trim.a, end: trim.b });
  toast(`Gerando o corte ${fmt(trim.a)}–${fmt(trim.b)}… ele aparece em Meus vídeos.`, 3500);
});

/* ---------------- momentos e cortes ---------------- */
function allMoments(it) {
  const list = [
    ...(it.marks || []).map((t) => ({ t, kind: 'mark' })),
    ...(it.suggestions || []).map((s) => ({ t: s.t, kind: 'auto' })),
  ];
  return list.sort((a, b) => a.t - b.t);
}
const clipKey = (t) => Math.round(t * 10);
const isClipped = (it, t) => (it.clipsDone || []).includes(clipKey(t));
const isQueued = (it, t) => clipQueue.some((j) => j.item.id === it.id && clipKey(j.t) === clipKey(t));

function renderMoments() {
  const it = state.current;
  const box = $('#playerMarks');
  if (!it || it.clipOf) { box.hidden = true; return; }
  const list = allMoments(it);
  box.hidden = !list.length;
  const wrap = $('#playerChips');
  wrap.innerHTML = '';
  const v = $('#playerVideo');
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'moment ' + m.kind;
    const jump = document.createElement('button');
    jump.className = 'jump';
    jump.innerHTML = `<b>${m.kind === 'mark' ? '⚑' : '✦'} ${fmt(m.t)}</b><span>${m.kind === 'mark' ? 'sua marcação' : 'sugestão automática'}</span>`;
    jump.onclick = () => { v.currentTime = Math.max(0, m.t - 2); v.play().catch(() => {}); };
    const act = document.createElement('button');
    act.className = 'clip-btn';
    if (isClipped(it, m.t)) { act.textContent = '✓ Corte pronto'; act.disabled = true; }
    else if (isQueued(it, m.t)) { act.textContent = 'Na fila…'; act.disabled = true; }
    else { act.textContent = 'Gerar corte'; act.onclick = () => { queueClip(it, m.t); renderMoments(); }; }
    row.append(jump, act);
    wrap.appendChild(row);
  }
  const pending = list.filter((m) => !isClipped(it, m.t) && !isQueued(it, m.t));
  $('#btnAllClips').hidden = pending.length < 2;
  $('#clipLenInfo').textContent = `Cada corte terá ${state.settings.clipLen}s (muda em Configurações).`;
}

$('#btnAllClips').addEventListener('click', () => {
  const it = state.current; if (!it) return;
  allMoments(it).filter((m) => !isClipped(it, m.t) && !isQueued(it, m.t)).forEach((m) => queueClip(it, m.t));
  renderMoments();
});

const clipQueue = [];
let clipBusy = false, clipProgress = 0, clipDoneCount = 0;

function queueClip(item, t, range) {
  if (isQueued(item, t)) return;
  clipQueue.push({ item, t, range });
  updateClipStatus();
  runClips();
}

function updateClipStatus() {
  const total = clipQueue.length + clipDoneCount;
  const txt = clipQueue.length
    ? `Gerando cortes: ${clipDoneCount + 1} de ${total} · ${Math.round(clipProgress * 100)}%`
    : '';
  for (const id of ['#clipStatusP', '#clipStatusL']) {
    const el = $(id);
    el.hidden = !txt;
    el.textContent = txt;
  }
}

async function runClips() {
  if (clipBusy) return;
  clipBusy = true;
  clipDoneCount = 0;
  let ok = 0;
  while (clipQueue.length) {
    const job = clipQueue[0];
    clipProgress = 0;
    updateClipStatus();
    try { await makeClip(job); ok++; }
    catch (e) { console.error(e); toast('Não foi possível gerar um dos cortes.'); }
    clipQueue.shift();
    clipDoneCount++;
    if (state.current && state.current.id === job.item.id) renderMoments();
    renderLibrary();
  }
  clipBusy = false;
  clipDoneCount = 0;
  updateClipStatus();
  if (ok) toast(`${ok} corte${ok > 1 ? 's' : ''} pronto${ok > 1 ? 's' : ''} em Meus vídeos ✓`, 3500);
}

// Toca o trecho da gravação "por trás", sem som, e grava de novo só aquele pedaço.
// Leva mais ou menos o tempo do próprio corte.
async function makeClip({ item, t, range }) {
  const len = Number(state.settings.clipLen) || 30;
  const total = item.duration || 0;
  let start, end;
  if (range) { // corte escolhido à mão (início e fim)
    start = Math.max(0, range.start);
    end = Math.min(total || range.end, range.end);
  } else {
    start = Math.max(0, t - Math.round(len / 3));
    end = Math.min(total || start + len, start + len);
    if (end - start < len && total > len) start = Math.max(0, end - len);
  }
  if (end - start < 1) throw new Error('trecho curto demais');

  const v = document.createElement('video');
  v.className = 'src-media';
  v.playsInline = true;
  v.preload = 'auto';
  const url = URL.createObjectURL(item.blob);
  v.src = url;
  document.body.appendChild(v);
  const cleanup = [];
  cleanup.push(() => { v.pause(); v.remove(); URL.revokeObjectURL(url); });
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('não abriu')); });
    v.currentTime = start;
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 4000); });

    const a = ensureAudio();
    const src = a.ctx.createMediaElementSource(v);
    const dest = a.ctx.createMediaStreamDestination();
    src.connect(dest); // só para o corte, você não ouve nada
    cleanup.push(() => src.disconnect());

    const c = document.createElement('canvas');
    c.width = v.videoWidth || 1080; c.height = v.videoHeight || 1920;
    const cx = c.getContext('2d', { alpha: false });
    cx.drawImage(v, 0, 0, c.width, c.height);
    const vs = c.captureStream(60); // acompanha a gravação original (até 60 FPS)
    cleanup.push(() => vs.getTracks().forEach((tr) => tr.stop()));
    const stream = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = pickMime();
    const opts = { videoBitsPerSecond: (c.width >= 1080 ? 9_000_000 : 5_000_000) * 1.5, audioBitsPerSecond: 160_000 };
    if (mime) opts.mimeType = mime;
    const rec = new MediaRecorder(stream, opts);
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };

    let running = true;
    const drawFrame = () => {
      if (!running) return;
      cx.drawImage(v, 0, 0, c.width, c.height);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(drawFrame);
      else setTimeout(drawFrame, 33);
    };
    rec.start(1000);
    await v.play();
    drawFrame();
    await new Promise((res) => {
      const chk = setInterval(() => {
        clipProgress = clamp((v.currentTime - start) / (end - start), 0, 1);
        updateClipStatus();
        if (v.currentTime >= end - 0.04 || v.ended || v.paused) { clearInterval(chk); res(); }
      }, 100);
    });
    running = false;
    v.pause();
    await new Promise((res) => { rec.onstop = res; rec.stop(); });

    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(parts, { type });
    if (!blob.size) throw new Error('corte vazio');
    const thumb = await new Promise((res) => {
      const tc = document.createElement('canvas'); tc.width = 270; tc.height = 480;
      tc.getContext('2d').drawImage(c, 0, 0, 270, 480);
      tc.toBlob(res, 'image/jpeg', 0.75);
    });
    const clip = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      created: Date.now(), duration: end - start, type, size: blob.size, blob, thumb,
      marks: [], suggestions: [], clipsDone: [],
      name: `Corte ${range ? fmt(start) + '–' + fmt(end) : fmt(t)}${item.name ? ' · ' + item.name : ''}`, clipOf: item.id,
    };
    await DB.put('videos', clip);
    if (!range) {
      item.clipsDone = [...(item.clipsDone || []), clipKey(t)];
      await DB.put('videos', item);
    }
  } finally {
    cleanup.reverse().forEach((f) => { try { f(); } catch {} });
  }
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
      markExported(it);
    } catch (e) {
      if (e.name !== 'AbortError') { console.error(e); toast('Não deu para compartilhar. Use Baixar arquivo.'); }
    }
  } else {
    downloadBlob(it.blob, fileName(it));
    markExported(it);
    toast('Baixando… o vídeo vai para a pasta Downloads.');
  }
}

// marca o vídeo como já salvo fora do app (ajuda a escolher o que apagar quando faltar espaço)
async function markExported(it) {
  if (it.exported) return;
  it.exported = true;
  try { await DB.put('videos', it); renderLibrary(); } catch (e) { console.error(e); }
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
  if (sel === '#settingsSheet' && state.monitoring) setMonitor(false); // não fica se ouvindo sem querer
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
    if ((key === 'quality' || key === 'format' || key === 'fps') && busy()) { toast('Mude isso antes de gravar.'); return; }
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

// painel de efeitos: ajusta ao vivo, com a câmera visível em cima
const FX_SLIDERS = { smooth: ['#fxSmooth', '#vFxSmooth'], shadow: ['#fxShadow', '#vFxShadow'], bright: ['#fxBright', '#vFxBright'],
  contrast: ['#fxContrast', '#vFxContrast'], sat: ['#fxSat', '#vFxSat'], warm: ['#fxWarm', '#vFxWarm'] };

function syncFxUi() {
  const f = state.settings.fx;
  for (const [k, [id, lab]] of Object.entries(FX_SLIDERS)) {
    const el = $(id);
    el.value = f[k];
    setRangeFill(el);
    const v = f[k];
    $(lab).textContent = k === 'smooth' || k === 'shadow' ? (v ? v + '%' : 'sem') : (v > 0 ? '+' + v : String(v));
  }
  const match = Object.entries(FX_PRESETS).find(([, p]) => FX_KEYS.every((k) => p[k] === f[k]));
  $('#fxPresets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', !!match && b.dataset.p === match[0]));
  $('#btnFx').classList.toggle('on', FX_KEYS.some((k) => f[k]));
  FX.touch();
}

function openFx() {
  if (!FX.supported()) { toast('Este celular não suporta os efeitos de câmera.'); return; }
  closeSheet('#settingsSheet');
  if (!state.camStream) toast('Ative a câmera para ver os efeitos.');
  syncFxUi();
  openSheet('#fxSheet');
}

function initFxUi() {
  for (const [k, [id]] of Object.entries(FX_SLIDERS)) {
    $(id).addEventListener('input', (e) => { state.settings.fx[k] = +e.target.value; syncFxUi(); saveSettings(); });
  }
  $('#fxPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.settings.fx = { ...FX_PRESETS[b.dataset.p] };
    syncFxUi(); saveSettings();
  });
  const cmp = $('#fxCompare');
  const hold = (on) => (e) => {
    if (on) { try { cmp.setPointerCapture(e.pointerId); } catch {} }
    state.fxBypass = on; cmp.classList.toggle('holding', on); FX.touch();
  };
  cmp.addEventListener('pointerdown', hold(true));
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) cmp.addEventListener(ev, hold(false));
  cmp.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#btnFx').addEventListener('click', openFx);
  $('#btnOpenFx').addEventListener('click', openFx);
  syncFxUi();
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
  bindSeg('#segFps', 'fps', applyCamFps);
  bindToggle('#sMirror', 'mirror');
  bindToggle('#sBar', 'showBar', positionOverlays);
  bindToggle('#sCountdown', 'countdown');
  bindToggle('#sWatermark', 'watermark');
  bindRange('#sWmOpacity', 'wmOpacity', '#vWmOpacity', (v) => v + '%');
  bindToggle('#sAutoClips', 'autoClips');
  bindToggle('#sPauseVid', 'pauseVidWithRec');
  bindToggle('#sHeadTip', 'headTip');
  const duckField = () => { $('#fieldDuck').hidden = !state.settings.duck; };
  bindToggle('#sDuck', 'duck', duckField);
  bindRange('#sDuckAmt', 'duckAmt', '#vDuckAmt', (v) => v + '%');
  duckField();
  bindToggle('#sMicNoise', 'micNoise', applyMicSettings);
  bindToggle('#sMicEq', 'micEq', applyMicSettings);
  bindToggle('#sMicComp', 'micComp', applyMicSettings);
  updateMicNote();
  $('#btnMonitor').addEventListener('click', () => setMonitor(!state.monitoring));
  initFxUi();
  bindSeg('#segClipLen', 'clipLen', () => state.current && renderMoments());
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
document.querySelectorAll('.tab[data-view]').forEach((t) => t.addEventListener('click', () => {
  if (busy() && t.dataset.view !== 'viewRecord') { toast('Pare a gravação antes de sair desta tela.'); return; }
  document.querySelectorAll('.tab[data-view]').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== t.dataset.view));
  if (t.dataset.view === 'viewLibrary') renderLibrary();
  else fitStage();
}));

/* ---------------- eventos ---------------- */
$('#btnCamOn').addEventListener('click', cameraOn);
$('#btnCamOff').addEventListener('click', cameraOff);
$('#btnFlip').addEventListener('click', switchCamera);
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
$('#pPost').addEventListener('click', shareCurrent); // a lista de apps do celular inclui TikTok e Instagram
$('#pDownload').addEventListener('click', () => {
  if (!state.current) return;
  downloadBlob(state.current.blob, fileName(state.current));
  markExported(state.current);
});
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
    if (saved) state.settings = { ...DEFAULTS, ...saved, fx: { ...DEFAULTS.fx, ...(saved.fx || {}) } };
  } catch (e) { console.error(e); }
  initSettingsUi();
  applyCanvasSize();
  try { await loadBgBlob(await DB.get('kv', 'bgImage')); } catch (e) { console.error(e); }
  fitStage();
  refreshUi();
  requestAnimationFrame(loop);
  recoverInterrupted();
  navigator.storage?.persist?.().catch(() => {});
  spaceInfo().then((sp) => {
    if (sp && sp.minutes < LOW_SPACE_MIN) toast(`Pouco espaço no celular: dá para gravar só ${minTxt(sp.minutes)}. Veja em Meus vídeos.`, 5000);
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
})();
