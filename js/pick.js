'use strict';
// =============================================================================
// SCAN-TO-PICK — floor mode (Step 4a, single order).
// -----------------------------------------------------------------------------
// Entered from the floor pick list ("Scan pick"). Generates the order's pick
// tasks, then walks them in sequence:
//   header   order · client · task N of M
//   directive "GO TO A-12-03" -> (after the location scan) "PICK <SKU> QTY 4"
//            with the SKU photo when one exists
//   counter  "SCANNED 2 / 4" + the UID list for unit-controlled items
//   banner   the server's verbatim rejection, error beep, clears on next scan
//   Exception sheet (six types, qty / note, optional photo)
//   Confirm  enabled only when the server says complete; auto-advances
//
// Every gate is the server's (POST /pick-tasks/:id/scan). This file never
// decides whether a scan counts — it shows what came back.
// =============================================================================

const FP_EXCEPTION_TYPES = [
  { value: 'not_found',              label: 'Not found in location' },
  { value: 'short',                  label: 'Short — fewer than required' },
  { value: 'wrong_item_in_location', label: 'Wrong item in location' },
  { value: 'damaged',                label: 'Damaged' },
  { value: 'wont_scan',              label: "Label won't scan" },
  { value: 'uid_unrecognized',       label: 'UID not recognised' },
];

const _fp = { orderId: null, tasks: [], idx: 0, input: null, photoCache: {}, packMode: false, packageId: null, packageNumber: null,
  // continuous picking: the server hands out one task at a time (GET /pick-queue/next) and claims it
  queue: { active: false, next: null, remaining: null, source: null } };
const FP_DONE_FLASH_MS = 2000;

// Floor home "Start picking": straight into the queue, no order list.
async function fpStartQueue(){
  _fp.queue = { active: true, next: null, remaining: null, source: null };
  _fp.orderId = null; _fp.tasks = []; _fp.idx = 0; _fp.packageId = null; _fp.packageNumber = null;
  navigateTo('floorPick');
  document.getElementById('floorPickBody').innerHTML = uiSpinner('Finding your next pick…');
  const n = await fpFetchNext(null, null);
  fpApplyNext(n);
}

async function fpFetchNext(orderId, afterTaskId){
  const qs = new URLSearchParams();
  if(orderId) qs.set('order', orderId);
  if(afterTaskId) qs.set('after', afterTaskId);
  const r = await fetch(`${API}/pick-queue/next${qs.toString() ? '?' + qs.toString() : ''}`, { headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return { error: d.error || 'Could not fetch the next pick' };
  return d;
}

function fpApplyNext(n){
  const body = document.getElementById('floorPickBody');
  if(n.error){ body.innerHTML = uiError(n.error); return; }
  _fp.queue.active = true;
  _fp.queue.next = n.next || null;
  _fp.queue.remaining = n.remaining || null;
  _fp.queue.source = n.source || null;
  if(!n.task){
    _fp.orderId = null; _fp.tasks = []; _fp.idx = 0;
    body.innerHTML = `
      <div class="fp-done">
        <div class="fp-done-mark">✓</div>
        <div class="fp-done-title">Nothing left to pick</div>
        <div class="ui-hint">No open pick tasks in your wave or for this warehouse.</div>
        <button type="button" class="ui-btn ui-btn-primary js-fp-back">Back to orders</button>
      </div>`;
    body.querySelector('.js-fp-back').addEventListener('click', () => navigateTo('floorPickList'));
    return;
  }
  if(n.task.orderId !== _fp.orderId){ _fp.packageId = null; _fp.packageNumber = null; }
  _fp.orderId = n.task.orderId;
  _fp.tasks = [n.task];
  _fp.idx = 0;
  fpRender();
}

// 2-second "ORDER 105384 DONE ✓" between orders.
function fpFlashDone(orderNumber){
  const body = document.getElementById('floorPickBody');
  if(_fp.input){ _fp.input.destroy(); _fp.input = null; }
  body.innerHTML = `<div class="fp-flash"><div class="fp-flash-title">ORDER ${esc(orderNumber)} DONE ✓</div><div class="fp-flash-sub">Next pick loading…</div></div>`;
  if('vibrate' in navigator) navigator.vibrate([40, 60, 40]);
  return new Promise(res => setTimeout(res, FP_DONE_FLASH_MS));
}

// Pause: hand the current task back to the queue and return to the list. The
// queue itself lives on the server — "Start picking" resumes it.
async function fpPause(){
  const t = fpTask();
  if(t && !['picked', 'short'].includes(t.status)){
    await fetch(`${API}/pick-queue/release`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ taskId: t.id }) }).catch(() => {});
  }
  _fp.queue.active = false;
  if(_fp.input){ _fp.input.destroy(); _fp.input = null; }
  navigateTo('floorPickList');
}

async function openFloorPick(orderId){
  _fp.queue = { active: false, next: null, remaining: null, source: null };
  _fp.orderId = orderId;
  _fp.tasks = [];
  _fp.idx = 0;
  _fp.packageId = null;
  _fp.packageNumber = null;
  navigateTo('floorPick');
  const body = document.getElementById('floorPickBody');
  body.innerHTML = uiSpinner('Building pick tasks…');
  const r = await fetch(`${API}/orders/${orderId}/pick-tasks/generate`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ body.innerHTML = uiError(d.error || 'Could not build pick tasks'); return; }
  _fp.tasks = d.tasks || [];
  _fp.idx = Math.max(0, _fp.tasks.findIndex(t => !['picked'].includes(t.status)));
  fpRender();
}

function loadFloorPick(){
  // Reached through navigateTo('floorPick') — openFloorPick has already set
  // state. A cold visit (no order) just says so.
  if(!_fp.orderId){
    document.getElementById('floorPickBody').innerHTML = uiEmpty('Open an order from Orders to Pick.');
  }
  document.querySelectorAll('#page-floorPick .js-floor-back').forEach(b => {
    if(b._wired) return;
    b._wired = true;
    b.addEventListener('click', () => navigateTo('floorPickList'));
  });
}

function fpTask(){ return _fp.tasks[_fp.idx] || null; }

function fpRender(){
  const body = document.getElementById('floorPickBody');
  const t = fpTask();
  if(!t){
    body.innerHTML = `
      <div class="fp-done">
        <div class="fp-done-mark">✓</div>
        <div class="fp-done-title">All tasks picked</div>
        <div class="ui-hint">Every line of this order has been picked. Complete picking from Orders to Pick.</div>
        <button type="button" class="ui-btn ui-btn-primary js-fp-back">Back to orders</button>
      </div>`;
    body.querySelector('.js-fp-back').addEventListener('click', () => navigateTo('floorPickList'));
    return;
  }
  const needLoc = !t.locationConfirmed;
  const tapMode = t.rules.location_mode !== 'scan';
  const closed = ['picked', 'short'].includes(t.status);
  body.innerHTML = `
    <div class="fp-head">
      <div class="fp-head-order">${uiId(t.orderNumber)} <span class="ui-muted">·</span> ${esc(t.clientCode)}</div>
      <div class="fp-head-n">Task ${esc(t.sequence)} of ${esc(t.taskCount)}</div>
    </div>
    <label class="ui-check fp-packmode"><input type="checkbox" id="fpPackMode" ${_fp.packMode ? 'checked' : ''}> Pack as you pick${_fp.packageNumber ? ' — <span class="ui-id">' + esc(_fp.packageNumber) + '</span>' : ''}</label>
    <div class="fp-directive ${needLoc ? 'fp-directive-loc' : 'fp-directive-item'}">
      ${needLoc
        ? `<div class="fp-directive-label">GO TO</div><div class="fp-directive-main">${esc(t.locationCode)}</div>
           ${tapMode ? '<button type="button" class="ui-btn ui-btn-primary fp-here js-fp-here">I\'M HERE</button>' : '<div class="ui-hint">Scan the bin label</div>'}`
        : `<div class="fp-directive-label">PICK <span class="fp-directive-loc-ok">✓ ${esc(t.locationCode)}</span></div>
           <div class="fp-directive-main">${esc(t.skuCode)}</div>
           <div class="fp-directive-sub">${esc(t.skuName || '')}${t.lotNumber ? ` · LOT ${esc(t.lotNumber)}${t.lotConfirmed ? ' ✓' : ''}` : ''}${t.lpNumber && t.cartonCode ? ` · ${esc(t.lpNumber)}` : ''}</div>
           ${t.cartonCode || t.lpNumber ? `<div class="fp-directive-carton"><span class="fp-directive-carton-label">${t.cartonCode ? 'CARTON' : 'LP'}</span> ${esc(t.cartonCode || t.lpNumber)}</div>` : ''}
           <div class="fp-directive-qty">QTY ${esc(t.qtyRequired)}</div>
           <div class="fp-photo" id="fpPhoto" hidden></div>`}
    </div>
    ${_fp.queue.active && (_fp.queue.next || _fp.queue.remaining) ? `<div class="fp-queue-next">${_fp.queue.next ? `Next: order ${esc(_fp.queue.next.orderNumber)}` : 'Last order in the queue'}${_fp.queue.remaining ? ` · ${esc(_fp.queue.remaining.orders)} order${_fp.queue.remaining.orders === 1 ? '' : 's'} left` : ''}</div>` : ''}
    <div class="fp-counter ${t.complete ? 'fp-counter-done' : ''}">SCANNED ${esc(t.qtyPicked)} / ${esc(t.qtyRequired)}${t.openShort ? ' <span class="ui-chip ui-chip-warn">SHORT</span>' : ''}${t.openExceptions ? ' <span class="ui-chip ui-chip-danger">EXCEPTION</span>' : ''}</div>
    ${t.unitControl !== 'none' ? `<div class="fp-uids">${t.uids.length ? t.uids.map(u => `<span class="ui-id fp-uid">${esc(u)}</span>`).join('') : '<span class="ui-muted">No units scanned yet</span>'}</div>` : ''}
    <div class="fp-banner" id="fpBanner" hidden></div>
    <div id="fpScan" ${needLoc && tapMode ? 'hidden' : ''}></div>
    <div class="fp-actions">
      ${_fp.queue.active ? '<button type="button" class="ui-btn js-fp-pause">Pause</button>' : ''}
      <button type="button" class="ui-btn js-fp-exception" ${closed ? 'disabled' : ''}>Exception</button>
      ${!t.rules.require_item_scan && !needLoc && !closed ? '<button type="button" class="ui-btn js-fp-count">Count</button>' : ''}
      <button type="button" class="ui-btn ui-btn-primary fp-confirm js-fp-confirm" ${t.complete && !closed ? '' : 'disabled'}>${closed ? 'Picked' : `Confirm ${esc(t.qtyPicked)} / ${esc(t.qtyRequired)}`}</button>
    </div>`;

  if(_fp.input) _fp.input.destroy();
  _fp.input = scanInputMount(document.getElementById('fpScan'), {
    placeholder: needLoc ? `Scan bin label ${t.locationCode}` : (t.unitControl !== 'none' ? 'Scan unit label' : 'Scan item'),
    autofocus: true,
    onScan: (raw, meta) => fpScan(raw, meta),
  });
  body.querySelector('#fpPackMode').addEventListener('change', (e) => { _fp.packMode = e.target.checked; });
  const hereBtn = body.querySelector('.js-fp-here');
  if(hereBtn) hereBtn.addEventListener('click', fpHere);
  body.querySelector('.js-fp-exception').addEventListener('click', fpOpenException);
  const pause = body.querySelector('.js-fp-pause');
  if(pause) pause.addEventListener('click', fpPause);
  const cnt = body.querySelector('.js-fp-count');
  if(cnt) cnt.addEventListener('click', fpCount);
  body.querySelector('.js-fp-confirm').addEventListener('click', fpConfirm);
  if(!needLoc) fpLoadPhoto(t.skuId);
}

function fpBanner(msg, tone){
  const b = document.getElementById('fpBanner');
  if(!b) return;
  if(!msg){ b.hidden = true; b.textContent = ''; return; }
  b.textContent = msg;
  b.className = `fp-banner fp-banner-${tone || 'danger'}`;
  b.hidden = false;
}

function fpApply(task){
  _fp.tasks[_fp.idx] = task;
}

async function fpScan(raw, meta){
  const t = fpTask();
  if(!t) return;
  fpBanner(null);
  _fp.input.setBusy(true);
  try {
    const r = await fetch(`${API}/pick-tasks/${t.id}/scan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
      body: JSON.stringify({ raw }),
    });
    const d = await r.json().catch(() => ({}));
    if(!r.ok){ fpBanner(d.error || 'Scan failed', 'danger'); scanBeep('error'); return; }
    if(d.task) fpApply(d.task);
    fpRender();
    if(d.accepted){
      if(d.partial){
        fpBanner(`${d.message}${d.units ? ' — ' + d.units.join(', ') : ''}`, 'warn');
      } else if(d.reason === 'location_ok' || d.reason === 'lot_ok' || d.reason === 'carton_ok'){
        fpBanner(d.message, 'ok');
      }
    } else {
      fpBanner(d.message || 'Rejected', 'danger');
      scanBeep('error');
    }
  } catch(_) {
    fpBanner('Network error', 'danger');
  } finally {
    if(_fp.input){ _fp.input.setBusy(false); _fp.input.focus(); }
  }
}

// Tap mode's location step. The server records the tap and opens the item
// step; every later unit / carton scan is still checked against its recorded
// location server-side.
async function fpHere(){
  const t = fpTask();
  if(!t) return;
  const r = await fetch(`${API}/pick-tasks/${t.id}/here`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fpBanner(d.error || 'Could not confirm location', 'danger'); scanBeep('error'); return; }
  fpApply(d);
  if('vibrate' in navigator) navigator.vibrate(30);
  fpRender();
}

async function fpCount(){
  const t = fpTask();
  const v = await uiPrompt({ title: `How many ${t.skuCode} did you pick?`, label: `0 to ${t.qtyRequired}`, value: String(t.qtyRequired), type: 'number' });
  if(v == null) return;
  const r = await fetch(`${API}/pick-tasks/${t.id}/count`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ qty: Number(v) }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fpBanner(d.error || 'Count refused', 'danger'); scanBeep('error'); return; }
  fpApply(d);
  fpRender();
  uiToast(`Counted ${d.qtyPicked} / ${d.qtyRequired}`, 'success');
}

async function fpConfirm(){
  const t = fpTask();
  if(!t) return;
  const btn = document.querySelector('#floorPickBody .js-fp-confirm');
  if(btn) btn.disabled = true;
  // Pack as you pick: open the package on the first confirm, then every
  // confirmed task lands in it (server-side, via package_id).
  if(_fp.packMode && !_fp.packageId){
    const pr = await fetch(`${API}/orders/${_fp.orderId}/packages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}' });
    const pd = await pr.json().catch(() => ({}));
    if(!pr.ok){ fpBanner(pd.error || 'Could not open a package', 'danger'); scanBeep('error'); if(btn) btn.disabled = false; return; }
    _fp.packageId = pd.id; _fp.packageNumber = pd.packageNumber;
  }
  const r = await fetch(`${API}/pick-tasks/${t.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify(_fp.packMode && _fp.packageId ? { package_id: _fp.packageId } : {}) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fpBanner(d.error || 'Confirm refused', 'danger'); scanBeep('error'); if(btn) btn.disabled = false; return; }
  fpApply(d.task);
  uiToast(`Task ${t.sequence} picked — ${d.task.qtyPicked} / ${d.task.qtyRequired}${d.packed ? ' · packed into ' + d.packed.packageNumber : ''}`, 'success');
  if('vibrate' in navigator) navigator.vibrate(40);
  // Auto-advance to the next open task; in pack mode the last task jumps to Pack & Ship.
  const next = _fp.tasks.findIndex((x, i) => i > _fp.idx && !['picked', 'short'].includes(x.status));
  _fp.idx = next === -1 ? _fp.tasks.length : next;
  if(next === -1 && _fp.packMode && _fp.packageId && typeof fsOpenOrder === 'function'){ fsOpenOrder(_fp.orderId); return; }
  if(next !== -1){ fpRender(); return; }
  // Last local task done: continuous picking. Ask the server for the next task
  // (rest of this order first, then the wave / assigned / oldest ready orders).
  // A different order (or nothing) means this order is done: flash, then GO TO.
  const n = await fpFetchNext(_fp.orderId, t.id);
  if(n.error){ fpRender(); fpBanner(n.error, 'danger'); return; }
  if(!n.task || n.task.orderId !== _fp.orderId) await fpFlashDone(t.orderNumber);
  fpApplyNext(n);
}

function fpOpenException(){
  const t = fpTask();
  if(!t) return;
  const m = uiModal({
    title: `Exception — task ${t.sequence}`,
    body: `
      ${uiFieldSelect({ id: 'fpExType', label: 'What happened?', options: FP_EXCEPTION_TYPES })}
      ${uiField({ id: 'fpExQty', label: 'Quantity actually available / affected', type: 'number', value: String(t.qtyPicked), hint: 'Required for Short: units that are really there.' })}
      ${uiField({ id: 'fpExNote', label: 'Note', placeholder: 'What the picker sees' })}
      <div class="ui-field"><label class="ui-label">Photo (optional)</label>
        <input class="ui-input" type="file" id="fpExPhoto" accept="image/*" capture="environment"></div>
      <div class="ui-hint">A supervisor resolves exceptions from the queue. Inventory is never adjusted by this.</div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Raise exception', danger: true, onClick: async (api) => {
          const type = api.el.querySelector('#fpExType').value;
          const qty  = api.el.querySelector('#fpExQty').value.trim();
          const note = api.el.querySelector('#fpExNote').value.trim();
          const file = api.el.querySelector('#fpExPhoto').files[0];
          uiFieldError(api.el, 'fpExNote', '');
          uiFieldError(api.el, 'fpExQty', '');
          if(type !== 'short' && !note){ uiFieldError(api.el, 'fpExNote', 'Required'); return false; }
          if(type === 'short' && qty === ''){ uiFieldError(api.el, 'fpExQty', 'Required for Short'); return false; }
          const fd = new FormData();
          fd.append('type', type);
          if(qty !== '') fd.append('qty', qty);
          if(note) fd.append('note', note);
          if(file) fd.append('photo', file);
          const r = await fetch(`${API}/pick-tasks/${t.id}/exception`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd });
          const d = await r.json().catch(() => ({}));
          if(!r.ok){ uiToast(d.error || 'Could not raise the exception', 'error'); return false; }
          fpApply(d.task);
          fpRender();
          uiToast('Exception raised — supervisor notified', 'success');
        } },
    ],
  });
  return m;
}

// SKU photo: first image attachment on the SKU, via the presigned URL route.
async function fpLoadPhoto(skuId){
  const host = document.getElementById('fpPhoto');
  if(!host) return;
  try {
    if(!(skuId in _fp.photoCache)){
      const list = await apiGet(`/skus/${skuId}/attachments`);
      const rows = list?.rows || list?.data || list || [];
      const img = rows.find(a => /^image\//.test(a.mime_type || ''));
      let url = null;
      if(img){
        const u = await apiGet(`/skus/${skuId}/attachments/${img.id}/url`);
        url = u && (u.url || u.signedUrl) || null;
      }
      _fp.photoCache[skuId] = url;
    }
    const url = _fp.photoCache[skuId];
    if(url){
      host.innerHTML = `<img class="fp-photo-img" alt="Product photo">`;
      host.querySelector('img').src = url;
      host.hidden = false;
    }
  } catch(_) { /* no photo — the directive stands on its own */ }
}
