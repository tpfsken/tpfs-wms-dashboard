'use strict';
// =============================================================================
// SCAN INPUT — the one way a barcode gets into this app.
// -----------------------------------------------------------------------------
//   const si = scanInputMount(containerEl, {
//     placeholder: 'Scan or type…',
//     onScan(raw, meta) {},        // meta.source: 'wedge' | 'camera' | 'typed' | 'paste'
//     autofocus: true,             // grab focus on mount (and after each scan)
//     camera: true,                // show the Camera button
//     typedOk: true,               // also emit slow human typing on Enter
//     sound: true,                 // beep + vibrate on scan (user pref wins)
//   });
//   si.focus(); si.setBusy(bool); si.destroy();
//
// Two capture paths, one callback:
//   1. keyboard-wedge scanners type the code and send Enter. They type FAST:
//      a burst of ≥4 chars with ≤ WEDGE_MAX_GAP_MS between keystrokes. A person
//      typing sits at ~150-300 ms per key, so it is reported as 'typed'.
//   2. the Camera button opens an in-page scanner. Native BarcodeDetector when
//      the browser has it (Chrome/Android), otherwise ZXing from a CDN, loaded
//      on first use only — nothing extra downloads until someone taps Camera.
//
// No emoji; no native dialogs; every class below is defined in app.css.
// =============================================================================

const WEDGE_MIN_CHARS  = 4;
const WEDGE_MAX_GAP_MS = 50;    // average inter-key gap for a burst to count as a scanner (USB ~10 ms, Bluetooth ~30 ms; humans 120 ms+)
const SCAN_SOUND_KEY   = 'tpfs_scan_sound';
const ZXING_CDN        = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

function scanSoundEnabled(){
  try { const v = localStorage.getItem(SCAN_SOUND_KEY); return v == null ? true : v === '1'; } catch { return true; }
}
function scanSoundSet(on){
  try { localStorage.setItem(SCAN_SOUND_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

let _scanAudioCtx = null;
function scanBeep(kind){
  // Vibration is free; audio needs a user gesture to have unlocked the context,
  // which the scan itself (a keypress / tap) always provides.
  if('vibrate' in navigator) navigator.vibrate(kind === 'error' ? [80, 50, 80] : 40);
  if(!scanSoundEnabled()) return;
  try {
    _scanAudioCtx = _scanAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _scanAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = kind === 'error' ? 220 : 1760;
    g.gain.value = 0.05;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (kind === 'error' ? 0.18 : 0.08));
  } catch { /* no audio — vibration already fired */ }
}

/**
 * Pure: classify a completed entry from its keystroke timestamps.
 * Exported for the tester and for unit checks.
 */
function scanClassify(chars, firstTs, lastTs){
  if(chars < WEDGE_MIN_CHARS) return 'typed';
  const gaps = Math.max(chars - 1, 1);
  const avg = (lastTs - firstTs) / gaps;
  return avg <= WEDGE_MAX_GAP_MS ? 'wedge' : 'typed';
}

function scanInputMount(container, opts = {}){
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  const o = { placeholder: 'Scan or type…', autofocus: true, camera: true, typedOk: true, sound: true, onScan: () => {}, ...opts };

  el.classList.add('scan-input');
  el.innerHTML = `
    <div class="scan-input-row">
      <input class="ui-input scan-input-field" type="text" autocomplete="off" autocapitalize="off"
             spellcheck="false" inputmode="text" placeholder="${esc(o.placeholder)}" aria-label="Scan">
      ${o.camera ? '<button type="button" class="ui-btn scan-input-cam">Camera</button>' : ''}
    </div>
    <div class="scan-input-flash" aria-live="polite"></div>`;

  const input = el.querySelector('.scan-input-field');
  const flash = el.querySelector('.scan-input-flash');
  const camBtn = el.querySelector('.scan-input-cam');

  let firstTs = 0, lastTs = 0, busy = false, destroyed = false;

  function showFlash(text, tone){
    flash.textContent = text;
    flash.className = `scan-input-flash scan-input-flash-${tone} scan-input-flash-on`;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => flash.classList.remove('scan-input-flash-on'), 1400);
  }

  function emit(raw, source){
    const v = String(raw || '').trim();
    if(!v || busy || destroyed) return;
    if(source === 'typed' && !o.typedOk) { showFlash('Typed — use a scanner', 'warn'); return; }
    if(o.sound) scanBeep('ok');
    showFlash(`Scanned (${source})`, 'ok');
    input.value = '';
    firstTs = lastTs = 0;
    try { o.onScan(v, { source }); } catch(e) { uiToast(e.message || 'Scan handler failed', 'error'); }
    if(o.autofocus) input.focus();
  }

  input.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){
      e.preventDefault();
      const chars = input.value.length;
      emit(input.value, scanClassify(chars, firstTs, lastTs));
      return;
    }
    if(e.key.length === 1){                      // a printable key
      const now = performance.now();
      if(!input.value.length || !firstTs) firstTs = now;
      lastTs = now;
    }
  });
  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if(text && !/[\r\n]/.test(text)){
      e.preventDefault();
      emit(text, 'paste');
    }
  });

  if(camBtn){
    camBtn.addEventListener('click', () => scanOpenCamera({
      onResult: (raw) => emit(raw, 'camera'),
      onError:  (msg) => { showFlash(msg, 'danger'); if(o.sound) scanBeep('error'); },
    }));
  }

  if(o.autofocus) setTimeout(() => input.focus(), 0);

  return {
    el, input,
    focus(){ input.focus(); },
    setBusy(b){ busy = !!b; input.disabled = !!b; if(camBtn) camBtn.disabled = !!b; },
    destroy(){ destroyed = true; el.innerHTML = ''; el.classList.remove('scan-input'); },
  };
}

// =============================================================================
// CAMERA SCANNER — full-screen overlay, one result, then it closes.
// Layering: above .ui-overlay (10050) so a modal can host a ScanInput; below
// toasts (10100). Fixed + scrollable per CLAUDE.md rule 3.
// =============================================================================
const SCAN_FORMATS_NATIVE   = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'data_matrix', 'code_39'];
// The native detector is trusted only if it reports all of these; anything
// less and ZXing (which decodes all of them) is used from the start.
const SCAN_FORMATS_REQUIRED = ['qr_code', 'code_128', 'ean_13', 'upc_a', 'data_matrix'];
const NATIVE_FALLBACK_MS    = 3000;   // native produced nothing in this long -> ZXing takes over

let _zxingLoading = null;
function scanLoadZXing(){
  if(window.ZXing) return Promise.resolve(window.ZXing);
  if(_zxingLoading) return _zxingLoading;
  _zxingLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ZXING_CDN;
    s.async = true;
    s.onload = () => window.ZXing ? resolve(window.ZXing) : reject(new Error('ZXing did not initialise'));
    s.onerror = () => reject(new Error('Could not load the barcode library (offline?)'));
    document.head.appendChild(s);
  });
  return _zxingLoading;
}

async function scanOpenCamera({ onResult, onError }){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    onError && onError('Camera not available in this browser (needs HTTPS)');
    return;
  }
  const ov = document.createElement('div');
  ov.className = 'scan-cam';
  ov.innerHTML = `
    <div class="scan-cam-head">
      <div class="scan-cam-title">Point the camera at a barcode</div>
      <button type="button" class="ui-btn scan-cam-close" aria-label="Close">✕ Close</button>
    </div>
    <div class="scan-cam-stage">
      <video class="scan-cam-video" playsinline muted autoplay></video>
      <div class="scan-cam-reticle"></div>
    </div>
    <div class="scan-cam-status ui-muted">Starting camera…</div>
    <div class="scan-cam-decoder" aria-label="Decoder">—</div>`;
  document.body.appendChild(ov);
  const video  = ov.querySelector('.scan-cam-video');
  const status = ov.querySelector('.scan-cam-status');
  const label  = ov.querySelector('.scan-cam-decoder');
  let stream = null, raf = 0, zxReader = null, closed = false;

  function close(){
    if(closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    clearTimeout(nativeTimer);
    try { if(zxReader) zxReader.reset(); } catch { /* already stopped */ }
    if(stream) stream.getTracks().forEach(t => t.stop());
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  const onKey = (e) => { if(e.key === 'Escape'){ e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.querySelector('.scan-cam-close').addEventListener('click', close);

  function found(raw){
    if(closed) return;
    close();
    onResult(raw);
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch(e) {
    close();
    onError && onError(e && e.name === 'NotAllowedError' ? 'Camera permission denied' : 'Could not start the camera');
    return;
  }

  // ---- decoder selection ---------------------------------------------------
  // Native BarcodeDetector only when it reports EVERY format we rely on;
  // Windows Chrome advertises the API but decodes nothing, so a native run
  // that produces no result within NATIVE_FALLBACK_MS hands over to ZXing
  // on its own. The corner label says which decoder is live.
  let nativeTimer = 0, decoder = null;
  function setDecoder(name){ decoder = name; label.textContent = name; }

  async function startZXing(reasonNote){
    if(closed) return;
    cancelAnimationFrame(raf);
    clearTimeout(nativeTimer);
    setDecoder(reasonNote ? 'zxing (' + reasonNote + ')' : 'zxing');
    status.textContent = 'Loading barcode library…';
    let ZX;
    try { ZX = await scanLoadZXing(); } catch(e) { close(); onError && onError(e.message); return; }
    if(closed) return;
    try {
      const hints = new Map();
      hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
        ZX.BarcodeFormat.QR_CODE, ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8,
        ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E, ZX.BarcodeFormat.DATA_MATRIX, ZX.BarcodeFormat.CODE_39,
      ]);
      hints.set(ZX.DecodeHintType.ASSUME_GS1, true);     // FNC1 comes through as GS (0x1D)
      hints.set(ZX.DecodeHintType.TRY_HARDER, true);
      zxReader = new ZX.BrowserMultiFormatReader(hints, 300);
      status.textContent = 'Scanning…';
      await zxReader.decodeFromStream(stream, video, (result) => {
        if(result && result.getText) found(result.getText());
      });
    } catch(e) {
      close();
      onError && onError('Barcode library failed to start');
    }
  }

  async function nativeUsable(){
    if(!('BarcodeDetector' in window) || typeof window.BarcodeDetector.getSupportedFormats !== 'function') return null;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const missing = SCAN_FORMATS_REQUIRED.filter(f => !supported.includes(f));
      if(missing.length) return null;
      return SCAN_FORMATS_NATIVE.filter(f => supported.includes(f));
    } catch { return null; }
  }

  const formats = await nativeUsable();
  if(!formats){ await startZXing(); return; }

  // Path A: native, with the timed hand-over.
  let det;
  try { det = new window.BarcodeDetector({ formats }); } catch { await startZXing(); return; }
  setDecoder('native');
  status.textContent = 'Scanning…';
  nativeTimer = setTimeout(() => { if(!closed && decoder === 'native') startZXing('fallback'); }, NATIVE_FALLBACK_MS);
  const tick = async () => {
    if(closed || decoder !== 'native') return;
    try {
      if(video.readyState >= 2){
        const codes = await det.detect(video);
        if(codes && codes.length && codes[0].rawValue){ clearTimeout(nativeTimer); found(codes[0].rawValue); return; }
      }
    } catch { /* a frame failed; keep going */ }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
