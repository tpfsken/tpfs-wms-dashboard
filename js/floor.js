// =============================================================================
// FLOOR MODE — phone-first ops shell.
// =============================================================================
// Auto-activates for ops users on phones (≤600px viewport) so warehouse
// staff don't get the desktop dashboard on a 6" screen. Three focused
// screens: Orders to Pick, Receive Inbound, Move Inventory. Designed
// for one-handed tablet use with big tap targets and minimal info
// density.
//
// URL params:
//   ?floor=1     — force into floor mode (handy for QA on desktop)
//   ?desktop=1   — force out of floor mode (saved per-session)
//
// Activated by bootFloor() from app.js after auth, in lieu of boot()
// when the floor heuristic matches.
// =============================================================================

function shouldUseFloorMode(){
  // Honor explicit overrides first (sticky for the session)
  const params = new URLSearchParams(location.search);
  if(params.get('floor')   === '1') sessionStorage.setItem('tpfs_mode', 'floor');
  if(params.get('desktop') === '1') sessionStorage.setItem('tpfs_mode', 'desktop');
  const stored = sessionStorage.getItem('tpfs_mode');
  if(stored === 'floor')   return true;
  if(stored === 'desktop') return false;
  // Default heuristic: phone-sized viewport
  return window.matchMedia('(max-width: 600px)').matches;
}

// ---- Text size: Normal / Large. Stored per device; Large by default on
// handhelds narrower than 420px (Zebra TC-series), Normal on tablets.
const FLOOR_TEXT_KEY = 'tpfs_floor_text';
function floorTextSize(){
  let v = null;
  try { v = localStorage.getItem(FLOOR_TEXT_KEY); } catch(_) { /* storage blocked */ }
  if(v === 'normal' || v === 'large') return v;
  return window.innerWidth < 420 ? 'large' : 'normal';
}
function applyFloorTextSize(size){
  document.body.classList.toggle('floor-text-large', size === 'large');
  document.querySelectorAll('.js-floor-textsize').forEach(b => {
    b.textContent = size === 'large' ? 'Aa Large' : 'Aa Normal';
    b.setAttribute('aria-pressed', size === 'large' ? 'true' : 'false');
  });
}
function toggleFloorTextSize(){
  const next = floorTextSize() === 'large' ? 'normal' : 'large';
  try { localStorage.setItem(FLOOR_TEXT_KEY, next); } catch(_) { /* keep it for this page only */ }
  applyFloorTextSize(next);
  uiToast(next === 'large' ? 'Large text' : 'Normal text', 'success');
}

function bootFloor(){
  document.body.classList.add('floor-mode');
  applyFloorTextSize(floorTextSize());
  document.querySelectorAll('.js-floor-textsize').forEach(b => {
    if(b._wired) return;
    b._wired = true;
    b.addEventListener('click', toggleFloorTextSize);
  });

  if(U){
    document.getElementById('floorUserLine').textContent =
      (U.fullName || U.email || '') + ' · Operations';
  }

  // Wire the 3 home cards to navigate to their target pages
  document.querySelectorAll('.floor-card').forEach(c => {
    if(c._wired || !c.dataset.target) return;
    c._wired = true;
    c.addEventListener('click', () => navigateTo(c.dataset.target));
  });

  // Clock helper from app.js still runs in the background; not displayed
  // here, the floor home doesn't have a clock.

  navigateTo('floorHome');
  loadFloorHomeCounts();
}

function exitFloorMode(){
  // Persist the user's choice for this session
  sessionStorage.setItem('tpfs_mode', 'desktop');
  document.body.classList.remove('floor-mode');
  // Boot the regular dashboard so the user gets the full experience
  if(typeof boot === 'function') boot();
}

// =============================================================================
// FLOOR HOME — counts on each card so the user knows what's pending
// =============================================================================

async function loadFloorHomeCounts(){
  // "Orders to Pick" = orders with allocations not yet picked
  try {
    const r = await apiGet('/orders?status=ALLOCATED,PICKING&limit=200');
    const rows = r?.data || r?.rows || r || [];
    const n = rows.length;
    document.getElementById('floorPickCount').textContent =
      n === 0 ? 'nothing to pick — caught up' :
      n === 1 ? '1 order ready to pick' :
                `${n} orders ready to pick`;
  } catch(_) { /* leave the dash placeholder */ }

  // "Receive Inbound" = open receipts
  try {
    const r = await apiGet('/inbound/receipts?status=OPEN&limit=200');
    const rows = r?.data || r?.rows || r || [];
    const n = rows.length;
    document.getElementById('floorInboundCount').textContent =
      n === 0 ? 'nothing to receive' :
      n === 1 ? '1 receipt open' :
                `${n} receipts open`;
  } catch(_) { /* leave the dash placeholder */ }
}

// =============================================================================
// ORDERS TO PICK — list of orders ready to pick. Tap → mobile picker.
// =============================================================================

async function loadFloorPickList(){
  const body = document.getElementById('floorPickListBody');
  body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text2);">Loading…</div>';

  const r = await apiGet('/orders?status=ALLOCATED,PICKING&limit=200');
  if(!r){
    body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--red);">Could not load orders</div>';
    return;
  }
  // Show every ALLOCATED/PICKING order. Two visual states:
  //   pending_picks_count > 0 → "X picks ready" (tap to pick)
  //   pending_picks_count = 0 → "Ready to complete" (tap → Complete Picking)
  // This way the floor app stays self-sufficient — pickers can finish
  // their own work without bouncing to desktop just to mark complete.
  const rows = r?.data || r?.rows || r || [];

  if(!rows.length){
    body.innerHTML = `
      <div style="padding:48px 18px;text-align:center;">
        <div style="font-size:48px;margin-bottom:12px;">✓</div>
        <div style="font-size:16px;font-weight:600;">All caught up</div>
        <div style="font-size:13px;color:var(--text2);margin-top:6px;">No orders waiting to be picked.</div>
      </div>`;
    return;
  }

  // Sort by required_ship_date ASC (most urgent first)
  rows.sort((a, b) => {
    const da = a.required_ship_date ? Date.parse(a.required_ship_date) : Infinity;
    const db = b.required_ship_date ? Date.parse(b.required_ship_date) : Infinity;
    return da - db;
  });

  const today = new Date(); today.setHours(0,0,0,0);

  // Get the current user id from the JWT-derived U so we can tell
  // "locked by me" vs "locked by someone else".
  const myId = (typeof U !== 'undefined' && U) ? U.id : null;

  body.innerHTML = rows.map(o => {
    const ship = o.required_ship_date ? new Date(o.required_ship_date) : null;
    const overdue = ship && ship < today;
    const dueLabel = ship
      ? (overdue
          ? `<span style="color:var(--red);font-weight:700;">⚠ past due ${ship.toLocaleDateString()}</span>`
          : `due ${ship.toLocaleDateString()}`)
      : '';
    const lineCount = o.line_count || 0;
    const totalUnits = o.total_units || 0;
    const pendingPicks = Number(o.pending_picks_count || 0);
    const readyToComplete = pendingPicks === 0 && o.status === 'PICKING';

    // Lock check: held by someone else AND fresh (<30 min) → disable
    const lockedAt = o.picking_started_at ? new Date(o.picking_started_at) : null;
    const lockFresh = lockedAt && (Date.now() - lockedAt.getTime() < 30 * 60 * 1000);
    const lockedByOther = o.picking_user_id && o.picking_user_id !== myId && lockFresh;
    const lockedByMe    = o.picking_user_id && o.picking_user_id === myId && lockFresh;

    const lockBanner = lockedByOther
      ? `<div style="margin-top:8px;padding:6px 10px;background:#3a2c00;color:#ffd591;border-radius:6px;font-size:12px;font-weight:600;">Locked · picking by ${esc(o.picking_user_name || 'another user')}</div>`
      : lockedByMe
        ? `<div style="margin-top:8px;padding:6px 10px;background:#1f4d2e;color:#a3ffb3;border-radius:6px;font-size:12px;font-weight:600;">▶ You're picking this — tap to resume</div>`
        : '';

    const opacity = lockedByOther ? 0.55 : 1;
    return `
      <button class="js-floor-pick-row" data-id="${esc(o.id)}" data-locked="${lockedByOther ? '1' : '0'}" style="display:block;width:100%;text-align:left;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;color:var(--text);cursor:${lockedByOther ? 'not-allowed' : 'pointer'};opacity:${opacity};">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="font-size:15px;font-weight:700;color:var(--blue);">${esc(o.order_number || '')}</div>
          <span class="chip ${o.status === 'PICKING' ? 'chip-active' : 'chip-warning'}" style="font-size:10px;">${esc(o.status)}</span>
          <div style="flex:1"></div>
          <div style="font-size:18px;color:var(--text2);">${lockedByOther ? '•' : '›'}</div>
        </div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px;">${esc(o.customer_name || o.client_name || '')}</div>
        <div style="font-size:12px;color:var(--text2);display:flex;gap:10px;flex-wrap:wrap;">
          ${readyToComplete
            ? `<span style="color:var(--green);font-weight:600;">✓ Ready to complete</span>`
            : `<span style="color:var(--blue);font-weight:600;">${esc(pendingPicks)} pick${pendingPicks === 1 ? '' : 's'} ready</span>`}
          <span>· ${esc(lineCount)} ${lineCount === 1 ? 'line' : 'lines'} · ${esc(totalUnits)} units</span>
          ${dueLabel ? `<span>· ${dueLabel}</span>` : ''}
        </div>
        ${lockBanner}
      </button>
      ${lockedByOther ? '' : `<button type="button" class="ui-btn ui-btn-primary floor-scanpick js-floor-scanpick" data-id="${esc(o.id)}">Scan pick ${esc(o.order_number || '')}</button>`}`;
  }).join('');

  body.querySelectorAll('.js-floor-scanpick').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openFloorPick(b.dataset.id); }));

  body.querySelectorAll('.js-floor-pick-row').forEach(row => {
    row.addEventListener('click', () => {
      if(row.dataset.locked === '1'){
        // Locked by someone else — bounce with a buzz
        if('vibrate' in navigator) navigator.vibrate([60, 60, 60]);
        return;
      }
      // Re-uses the existing mobile picker — same UI everyone tested
      openMobilePicker(row.dataset.id);
    });
  });
}

// =============================================================================
// RECEIVE INBOUND — list of open receipts. Tap → opens detail view (basic
// for now; full receive flow can layer on top).
// =============================================================================

async function loadFloorInbound(){
  const body = document.getElementById('floorInboundBody');
  body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text2);">Loading…</div>';

  const r = await apiGet('/inbound/receipts?status=OPEN&limit=200');
  if(!r){
    body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--red);">Could not load receipts</div>';
    return;
  }
  const rows = r?.data || r?.rows || r || [];
  if(!rows.length){
    body.innerHTML = `
      <div style="padding:48px 18px;text-align:center;">
        <div style="font-size:48px;margin-bottom:12px;">—</div>
        <div style="font-size:16px;font-weight:600;">No open receipts</div>
        <div style="font-size:13px;color:var(--text2);margin-top:6px;">Create a new receipt on the desktop view to start receiving.</div>
      </div>`;
    return;
  }

  body.innerHTML = rows.map(r => {
    const exp = r.expected_arrival ? new Date(r.expected_arrival).toLocaleDateString() : '—';
    return `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="font-size:15px;font-weight:700;color:var(--blue);">${esc(r.receipt_number || r.po_number || '')}</div>
          <span class="chip chip-active" style="font-size:10px;">${esc(r.status || 'OPEN')}</span>
        </div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px;">${esc(r.supplier_name || r.client_name || '')}</div>
        <div style="font-size:12px;color:var(--text2);">Expected: ${esc(exp)}</div>
      </div>`;
  }).join('') + `
    <div style="margin-top:14px;padding:14px;background:var(--bg);border-radius:10px;font-size:13px;color:var(--text2);text-align:center;">
      Full receive flow (tap a receipt → scan LP / qty / location) is coming next. For now use the desktop Receiving page to add lines.
    </div>`;
}

// =============================================================================
// MOVE INVENTORY — search LP, pick destination location, confirm move.
// Phase 1: stub UI with a clear "coming next" so the home card isn't dead.
// Phase 2: wire to a new POST /inventory/move endpoint.
// =============================================================================

function loadFloorMove(){
  document.getElementById('floorMoveBody').innerHTML = `
    <div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;">
      <div style="font-size:48px;margin-bottom:14px;">—</div>
      <div style="font-size:16px;font-weight:600;margin-bottom:8px;">Move Inventory — coming next</div>
      <div style="font-size:13px;color:var(--text2);line-height:1.5;">
        Scan an LP, scan a destination location, tap Move. Updates location on the LP and the inventory row in one shot. Will land in the next push.
      </div>
    </div>`;
}

// =============================================================================
// SCAN TEST — read-only. A floor user proves a label resolves, nothing else.
// ScanInput (js/scan.js) -> POST /scan/resolve with the user's client
// context (portal users are pinned server-side; ops pick a client) -> the
// same trace display the profile builder uses (spRenderTrace).
// =============================================================================
let _fstInput = null;

async function loadFloorScanTest(){
  const body = document.getElementById('floorScanTestBody');
  const isOps = !U || U.userType !== 'client';
  body.innerHTML = `
    ${isOps ? `<div class="ui-field"><label class="ui-label">Client</label><div class="cb-wrap" id="fstClientWrap"></div>
                 <div class="ui-hint">Optional. Without a client only tenant-wide profiles and exact LP / location lookups apply.</div></div>` : ''}
    <div id="fstInput"></div>
    <div class="sp-trace" id="fstTrace">${uiEmpty('Scan a label to see how it resolves.')}</div>`;

  document.querySelectorAll('#page-floorScanTest .js-floor-home').forEach(b => {
    if(b._wired) return;
    b._wired = true;
    b.addEventListener('click', () => navigateTo('floorHome'));
  });

  if(isOps){
    let clients = [];
    try {
      const d = await apiGet('/clients');
      clients = (d?.rows || d?.data || d || []).filter(c => c.is_active !== false);
    } catch(_) { /* combo stays empty */ }
    initCombo('fstClientWrap', clients.map(c => ({ value: c.id, label: `${c.code} — ${c.name}` })), { placeholder: 'Any client' });
  }

  if(_fstInput) _fstInput.destroy();
  _fstInput = scanInputMount(document.getElementById('fstInput'), {
    placeholder: 'Scan a label',
    autofocus: true,
    onScan: (raw, meta) => floorScanTestRun(raw, meta),
  });
}

async function floorScanTestRun(raw, meta){
  const box = document.getElementById('fstTrace');
  const clientId = (U && U.userType === 'client') ? U.clientId : (cbVal('fstClientWrap') || null);
  box.innerHTML = uiSpinner('Resolving…');
  _fstInput.setBusy(true);
  try {
    const r = await fetch(`${API}/scan/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
      body: JSON.stringify({ raw, clientId, workflow: 'pick' }),
    });
    const d = await r.json();
    if(!r.ok){ box.innerHTML = uiError(d.error || 'Scan failed'); return; }
    // /scan/resolve returns the result, not the builder's step trace; build
    // the same shape from what it does return so the display is identical.
    const trace = [{ step: 'raw', ok: true, out: d.raw }];
    if(d.via) trace.push({ step: 'matched by', ok: true, out: d.via === 'profile' ? `profile ${d.profileId}` : d.via });
    if(d.parsed && Object.keys(d.parsed).length) trace.push({ step: 'map', ok: true, out: d.parsed });
    trace.push(d.ok
      ? { step: 'resolve', ok: true, out: { type: d.type, entity: d.entity, validation: d.validation } }
      : { step: 'resolve', ok: false, out: d.detail ? `${d.reason}: ${d.detail}` : (d.reason || 'no match') });
    spRenderTrace(box, { trace, result: d }, meta);
    if(!d.ok && typeof scanBeep === 'function') scanBeep('error');
  } catch(_) {
    box.innerHTML = uiError('Network error');
  } finally {
    _fstInput.setBusy(false);
    _fstInput.focus();
  }
}
