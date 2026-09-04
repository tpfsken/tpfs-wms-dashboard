'use strict';
// =============================================================================
// SCAN INPUT — the one way a barcode gets into this app.
// -----------------------------------------------------------------------------
//   const si = scanInputMount(containerEl, {
//     placeholder: 'Scan or type…',
//     keyboard: 'none' | 'text',     // 'none' (default): no on-screen keyboard; a Type button opens it for one entry
//     keepFocus: true,               // focus trap: refocus (preventScroll) after blur / scan / re-enable / page visible, never mid-gesture
//     onScan(raw, meta) {},        // meta.source: 'wedge' | 'camera' | 'typed' | 'paste'; meta.format: 'QR_CODE' | 'CODE_128' | … | null
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

// type="search" + a non-credential name: Chrome's password manager otherwise reads a
// lone text field as a username box and floats the saved-login bar over it on every focus.
let _scanInputSeq = 0;
function scanInputMount(container, opts = {}){
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  // keyboard: 'none' keeps the on-screen keyboard down on handhelds — wedge scans
  // land as keystrokes regardless, physical keyboards and paste are unaffected.
  // The Type button flips inputmode to 'text' for one manual entry.
  const o = { placeholder: 'Scan or type…', autofocus: true, camera: true, typedOk: true, sound: true, keyboard: 'none', keepFocus: true, onScan: () => {}, ...opts };

  el.classList.add('scan-input');
  el.innerHTML = `
    <div class="scan-input-row">
      <input class="ui-input scan-input-field" type="search" name="scan-code" id="scan-code-${++_scanInputSeq}"
             autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"
             inputmode="${o.keyboard === 'text' ? 'text' : 'none'}" placeholder="${esc(o.placeholder)}" aria-label="Scan a label">
      ${o.keyboard === 'text' ? '' : '<button type="button" class="ui-btn scan-input-type" aria-label="Type manually">Type</button>'}
      ${o.camera ? '<button type="button" class="ui-btn scan-input-cam">Camera</button>' : ''}
    </div>
    <div class="scan-input-flash" aria-live="polite"></div>`;

  const input = el.querySelector('.scan-input-field');
  const flash = el.querySelector('.scan-input-flash');
  const camBtn = el.querySelector('.scan-input-cam');
  const typeBtn = el.querySelector('.scan-input-type');

  let firstTs = 0, lastTs = 0, busy = false, destroyed = false, manual = false;

  // ---- keyboard mode --------------------------------------------------------
  // manual = the operator asked for the keyboard; it reverts after Enter or blur.
  function setManual(on){
    manual = !!on;
    if(o.keyboard !== 'text') input.setAttribute('inputmode', manual ? 'text' : 'none');
    if(typeBtn) typeBtn.classList.toggle('scan-input-type-on', manual);
  }

  // ---- focus trap -------------------------------------------------------------
  // The field must own focus so a wedge scan always lands: refocus after blur
  // (unless something else focusable took it — a modal, the qty box), after
  // every scan, when the field is re-enabled, and when the page comes back.
  // Touch / scroll / wheel mark the page as "in the user's hands": a refocus then
  // would fight the gesture (and any scroll-into-view snaps the page back up).
  let lastInteract = 0, retry = null;
  const INTERACT_QUIET_MS = 1500;
  function onInteract(){ lastInteract = performance.now(); }
  for(const ev of ['touchstart', 'touchmove', 'scroll', 'wheel', 'pointerdown'])
    document.addEventListener(ev, onInteract, { capture: true, passive: true });
  function interacting(){ return performance.now() - lastInteract < INTERACT_QUIET_MS; }

  function wantsFocus(){
    if(destroyed || busy || !o.keepFocus || !o.autofocus) return false;
    if(document.visibilityState !== 'visible') return false;
    if(!el.isConnected || !input.offsetParent) return false;          // hidden or removed
    if(document.querySelector('.ui-overlay, .scan-cam')) return false; // a dialog or the camera owns the screen
    const a = document.activeElement;
    return !a || a === document.body || a === input;
  }
  function refocus(){
    if(destroyed) return;
    clearTimeout(retry); retry = null;
    if(interacting()){
      // Wait out the gesture, then try once more — a wedge scan needs the field.
      retry = setTimeout(refocus, INTERACT_QUIET_MS - (performance.now() - lastInteract) + 20);
      return;
    }
    if(wantsFocus()) input.focus({ preventScroll: true });
  }
  function onBlur(){ if(manual) setManual(false); setTimeout(refocus, 0); }
  function onVisible(){ if(document.visibilityState === 'visible') setTimeout(refocus, 50); }
  input.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);

  function showFlash(text, tone){
    flash.textContent = text;
    flash.className = `scan-input-flash scan-input-flash-${tone} scan-input-flash-on`;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => flash.classList.remove('scan-input-flash-on'), 1400);
  }

  function emit(raw, source, format){
    const v = String(raw || '').trim();
    if(!v || busy || destroyed) return;
    if(source === 'typed' && !o.typedOk) { showFlash('Typed — use a scanner', 'warn'); return; }
    if(o.sound) scanBeep('ok');
    showFlash(`Scanned (${source})`, 'ok');
    input.value = '';
    firstTs = lastTs = 0;
    if(manual) setManual(false);
    try { o.onScan(v, { source, format: format || null }); } catch(e) { uiToast(e.message || 'Scan handler failed', 'error'); }
    if(o.autofocus) input.focus({ preventScroll: true });
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

  if(typeBtn){
    typeBtn.addEventListener('click', () => {
      // A user gesture on the button, then focus with inputmode=text, opens the keyboard.
      setManual(!manual);
      if(manual){ input.focus({ preventScroll: true }); showFlash('Keyboard on — Enter to submit', 'warn'); }
      else input.focus({ preventScroll: true });
    });
  }
  if(camBtn){
    camBtn.addEventListener('click', uiBusyHandler(() => scanOpenCamera({
      onResult: (raw, format) => emit(raw, 'camera', format),
      onError:  (msg) => { showFlash(msg, 'danger'); if(o.sound) scanBeep('error'); },
    })));
  }

  if(o.autofocus) setTimeout(() => input.focus({ preventScroll: true }), 0);

  return {
    el, input,
    focus(){ input.focus({ preventScroll: true }); },
    // Disabling the field drops focus; re-enabling takes it back.
    setBusy(b){ busy = !!b; input.disabled = !!b; if(camBtn) camBtn.disabled = !!b; if(typeBtn) typeBtn.disabled = !!b; if(!busy) setTimeout(refocus, 0); },
    destroy(){
      destroyed = true;
      clearTimeout(retry);
      for(const ev of ['touchstart', 'touchmove', 'scroll', 'wheel', 'pointerdown']) document.removeEventListener(ev, onInteract, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      el.innerHTML = ''; el.classList.remove('scan-input');
    },
  };
}

// =============================================================================
// CAMERA SCANNER — capture-first, with continuous scanning underneath.
// -----------------------------------------------------------------------------
// Real-phone findings this is built around:
//   * a label with a QR AND a 1D code produced a false 1D read ("2") — so a
//     frame is decoded 2D-first, a 1D read must be >= SCAN_1D_MIN_CHARS and
//     identical in two consecutive frames, and QR / DataMatrix fire at once
//     (they carry error correction).
//   * continuous scanning was hard to trigger — so CAPTURE is the primary
//     control: one full-resolution still (ImageCapture.takePhoto where
//     available, else the video drawn at native size) decoded with
//     TRY_HARDER. "No barcode found — try closer" keeps the camera open.
//   * 1080p, continuous focus, zoom slider and torch when the track has them,
//     tap the video to refocus.
// Native BarcodeDetector still runs the continuous loop when it reports every
// format we need, with the same gating, and hands over to ZXing after
// NATIVE_FALLBACK_MS without a result. The corner label names the decoder.
// Layering: above .ui-overlay (10050), below toasts (10100). Fixed + scrollable.
// =============================================================================
const SCAN_FORMATS_NATIVE   = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'data_matrix', 'code_39', 'itf'];
// The native detector is trusted only if it reports all of these; anything
// less and ZXing (which decodes all of them) is used from the start.
const SCAN_FORMATS_REQUIRED = ['qr_code', 'code_128', 'ean_13', 'upc_a', 'data_matrix'];
const NATIVE_FALLBACK_MS    = 3000;   // native produced nothing in this long -> ZXing takes over
const SCAN_1D_MIN_CHARS     = 6;      // shorter 1D reads are noise
const SCAN_2D_FORMATS       = ['QR_CODE', 'DATA_MATRIX'];
const SCAN_LIVE_INTERVAL_MS = 180;    // continuous ZXing decode cadence
const SCAN_LIVE_MAX_PX      = 1280;   // long side of the frame used for continuous decoding
const SCAN_STILL_MAX_PX     = 2560;   // long side for a captured still (full res above this is slow to decode)

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

/** Normalise a decoder's format name to ZXing's upper-snake spelling. */
function scanFormatName(ZX, v){
  if(v == null) return null;
  if(typeof v === 'number' && ZX && ZX.BarcodeFormat) return ZX.BarcodeFormat[v] || String(v);
  return String(v).toUpperCase();
}

/**
 * The false-positive gate. Pure; one instance per overlay.
 *   accept({ text, format }) -> true when the read may fire.
 * 2D fires at once. 1D must be >= SCAN_1D_MIN_CHARS and repeat in the next
 * frame with the same text + format.
 */
function scanGate(){
  let last = null;
  return {
    accept(r){
      if(!r || !r.text) return false;
      if(SCAN_2D_FORMATS.includes(r.format)) return true;
      if(r.text.length < SCAN_1D_MIN_CHARS){ last = null; return false; }
      if(last && last.text === r.text && last.format === r.format){ last = null; return true; }
      last = { text: r.text, format: r.format };
      return false;
    },
    reset(){ last = null; },
  };
}

/** ZXing readers: a 2D-only one tried first, then 1D. TRY_HARDER on both. */
function scanMakeReaders(ZX){
  const F = ZX.BarcodeFormat, H = ZX.DecodeHintType;
  const mk = (formats) => {
    const hints = new Map();
    hints.set(H.POSSIBLE_FORMATS, formats);
    hints.set(H.TRY_HARDER, true);
    hints.set(H.ASSUME_GS1, true);            // FNC1 comes through as GS (0x1D)
    return new ZX.BrowserMultiFormatReader(hints);
  };
  return {
    twoD: mk([F.QR_CODE, F.DATA_MATRIX]),
    oneD: mk([F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_39, F.ITF]),
  };
}

/** Decode one canvas: 2D first, then 1D. Returns { text, format } or null. */
function scanDecodeCanvas(ZX, readers, canvas){
  for(const r of [readers.twoD, readers.oneD]){
    try {
      const res = r.decodeFromCanvas(canvas);
      if(res && res.getText && res.getText()) return { text: res.getText(), format: scanFormatName(ZX, res.getBarcodeFormat()) };
    } catch(_) { /* NotFoundException — try the next reader */ }
  }
  return null;
}

/** Draw the video's current frame to a canvas, capped at maxPx on the long side. */
function scanGrabFrame(video, canvas, maxPx){
  const vw = video.videoWidth, vh = video.videoHeight;
  if(!vw || !vh) return false;
  const scale = Math.min(1, maxPx / Math.max(vw, vh));
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
  return true;
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
      <div class="scan-cam-title">Point at the barcode, then Capture</div>
      <button type="button" class="ui-btn scan-cam-close" aria-label="Close">✕ Close</button>
    </div>
    <div class="scan-cam-stage">
      <video class="scan-cam-video" playsinline muted autoplay></video>
      <div class="scan-cam-reticle"></div>
      <div class="scan-cam-decoder" aria-label="Decoder">—</div>
    </div>
    <div class="scan-cam-controls">
      <button type="button" class="ui-btn scan-cam-torch" hidden aria-pressed="false">Torch</button>
      <label class="scan-cam-zoom" hidden><span class="ui-muted">Zoom</span><input type="range" class="scan-cam-zoom-range"></label>
      <button type="button" class="scan-cam-capture" aria-label="Capture">CAPTURE</button>
    </div>
    <div class="scan-cam-status ui-muted">Starting camera…</div>`;
  document.body.appendChild(ov);
  const video      = ov.querySelector('.scan-cam-video');
  const status     = ov.querySelector('.scan-cam-status');
  const label      = ov.querySelector('.scan-cam-decoder');
  const torchBtn   = ov.querySelector('.scan-cam-torch');
  const zoomWrap   = ov.querySelector('.scan-cam-zoom');
  const zoomRange  = ov.querySelector('.scan-cam-zoom-range');
  const captureBtn = ov.querySelector('.scan-cam-capture');
  const work = document.createElement('canvas');

  let stream = null, track = null, raf = 0, liveTimer = 0, nativeTimer = 0, closed = false;
  let decoder = '', ZX = null, readers = null, capturing = false;
  const gate = scanGate();

  function setDecoder(name){ decoder = name; label.textContent = name; }
  function setStatus(text, tone){
    status.textContent = text;
    status.className = 'scan-cam-status ' + (tone === 'bad' ? 'scan-cam-status-bad' : tone === 'ok' ? 'scan-cam-status-ok' : 'ui-muted');
  }

  function close(){
    if(closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    clearTimeout(liveTimer);
    clearTimeout(nativeTimer);
    if(stream) stream.getTracks().forEach(t => t.stop());
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  const onKey = (e) => { if(e.key === 'Escape'){ e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.querySelector('.scan-cam-close').addEventListener('click', close);

  function found(r){
    if(closed || !r || !r.text) return;
    close();
    onResult(r.text, r.format || null);
  }

  // ---- camera ----------------------------------------------------------------
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch(e) {
    close();
    onError && onError(e && e.name === 'NotAllowedError' ? 'Camera permission denied' : 'Could not start the camera');
    return;
  }
  track = stream.getVideoTracks()[0];
  const caps = (track && typeof track.getCapabilities === 'function') ? (track.getCapabilities() || {}) : {};

  async function applyAdvanced(c){
    try { await track.applyConstraints({ advanced: [c] }); return true; } catch(_) { return false; }
  }
  const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
  async function refocus(){
    // Re-applying the focus constraint nudges the camera into a fresh focus
    // sweep; a single-shot pass first where the device offers one.
    if(focusModes.includes('single-shot')) await applyAdvanced({ focusMode: 'single-shot' });
    if(focusModes.includes('continuous')) await applyAdvanced({ focusMode: 'continuous' });
    gate.reset();
  }
  if(focusModes.includes('continuous')) await applyAdvanced({ focusMode: 'continuous' });
  video.addEventListener('click', uiBusyHandler(refocus));

  if(caps.zoom && typeof caps.zoom.min === 'number' && caps.zoom.max > caps.zoom.min){
    zoomWrap.hidden = false;
    zoomRange.min = caps.zoom.min; zoomRange.max = caps.zoom.max; zoomRange.step = caps.zoom.step || 0.1;
    const cur = (track.getSettings && track.getSettings().zoom) || caps.zoom.min;
    zoomRange.value = cur;
    zoomRange.addEventListener('input', () => applyAdvanced({ zoom: Number(zoomRange.value) }));
  }
  if(caps.torch){
    torchBtn.hidden = false;
    let torchOn = false;
    torchBtn.addEventListener('click', uiBusyHandler(async () => {
      torchOn = !torchOn;
      if(!(await applyAdvanced({ torch: torchOn }))){ torchOn = !torchOn; setStatus('Torch not available', 'bad'); return; }
      torchBtn.classList.toggle('scan-cam-torch-on', torchOn);
      torchBtn.setAttribute('aria-pressed', String(torchOn));
    }));
  }

  // ---- ZXing (always loaded: Capture needs it even when native is live) ------
  async function ensureZXing(){
    if(readers) return true;
    try { ZX = await scanLoadZXing(); readers = scanMakeReaders(ZX); return true; }
    catch(e){ setStatus(e.message, 'bad'); return false; }
  }

  // ---- CAPTURE: one full-resolution still ------------------------------------
  async function captureStill(){
    if(capturing || closed) return;
    capturing = true;
    captureBtn.disabled = true;
    setStatus('Reading…');
    try {
      if(!(await ensureZXing())) return;
      const still = document.createElement('canvas');
      let drawn = false;
      if(window.ImageCapture && track){
        try {
          const blob = await new window.ImageCapture(track).takePhoto();
          const bmp = await createImageBitmap(blob);
          const scale = Math.min(1, SCAN_STILL_MAX_PX / Math.max(bmp.width, bmp.height));
          still.width = Math.round(bmp.width * scale); still.height = Math.round(bmp.height * scale);
          still.getContext('2d').drawImage(bmp, 0, 0, still.width, still.height);
          drawn = true;
        } catch(_) { /* takePhoto unsupported or busy — fall back to the frame */ }
      }
      if(!drawn) drawn = scanGrabFrame(video, still, SCAN_STILL_MAX_PX);
      if(!drawn){ setStatus('Camera has no frame yet', 'bad'); return; }
      const r = scanDecodeCanvas(ZX, readers, still);
      if(r && (SCAN_2D_FORMATS.includes(r.format) || r.text.length >= SCAN_1D_MIN_CHARS)){
        setStatus(`${r.format}: ${r.text}`, 'ok');
        found(r);
      } else {
        setStatus('No barcode found — try closer', 'bad');
        if('vibrate' in navigator) navigator.vibrate([60, 40, 60]);
      }
    } finally {
      capturing = false;
      captureBtn.disabled = false;
    }
  }
  captureBtn.addEventListener('click', uiBusyHandler(captureStill));

  // ---- continuous: ZXing frame loop ------------------------------------------
  async function startZXingLive(reasonNote){
    if(closed) return;
    cancelAnimationFrame(raf);
    clearTimeout(nativeTimer);
    setDecoder(reasonNote ? 'zxing (' + reasonNote + ')' : 'zxing');
    setStatus('Loading barcode library…');
    if(!(await ensureZXing())) return;
    if(closed) return;
    setStatus('Scanning… tap Capture for a still');
    const step = () => {
      if(closed || decoder.indexOf('zxing') !== 0) return;
      if(!capturing && scanGrabFrame(video, work, SCAN_LIVE_MAX_PX)){
        const r = scanDecodeCanvas(ZX, readers, work);
        if(r && gate.accept(r)){ found(r); return; }
      }
      liveTimer = setTimeout(step, SCAN_LIVE_INTERVAL_MS);
    };
    liveTimer = setTimeout(step, SCAN_LIVE_INTERVAL_MS);
  }

  // ---- continuous: native BarcodeDetector, same gate, timed hand-over --------
  async function nativeUsable(){
    if(!('BarcodeDetector' in window) || typeof window.BarcodeDetector.getSupportedFormats !== 'function') return null;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if(SCAN_FORMATS_REQUIRED.some(f => !supported.includes(f))) return null;
      return SCAN_FORMATS_NATIVE.filter(f => supported.includes(f));
    } catch { return null; }
  }
  const formats = await nativeUsable();
  if(!formats){ await startZXingLive(); return; }
  let det;
  try { det = new window.BarcodeDetector({ formats }); } catch { await startZXingLive(); return; }
  setDecoder('native');
  setStatus('Scanning… tap Capture for a still');
  ensureZXing();                                   // warm up for Capture in the background
  nativeTimer = setTimeout(() => { if(!closed && decoder === 'native') startZXingLive('fallback'); }, NATIVE_FALLBACK_MS);
  const tick = async () => {
    if(closed || decoder !== 'native') return;
    try {
      if(!capturing && video.readyState >= 2){
        const codes = (await det.detect(video)) || [];
        // Prefer the 2D read when a frame holds several barcodes.
        const norm = codes.filter(c => c.rawValue).map(c => ({ text: c.rawValue, format: scanFormatName(null, c.format) }));
        const pick = norm.find(c => SCAN_2D_FORMATS.includes(c.format)) || norm[0];
        if(pick && gate.accept(pick)){ clearTimeout(nativeTimer); found(pick); return; }
      }
    } catch { /* a frame failed; keep going */ }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
