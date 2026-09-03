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

const _fp = { orderId: null, tasks: [], idx: 0, input: null, photoCache: {} };

async function openFloorPick(orderId){
  _fp.orderId = orderId;
  _fp.tasks = [];
  _fp.idx = 0;
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
  const needLoc = t.rules.require_location_scan && !t.locationConfirmed;
  const closed = ['picked', 'short'].includes(t.status);
  body.innerHTML = `
    <div class="fp-head">
      <div class="fp-head-order">${uiId(t.orderNumber)} <span class="ui-muted">·</span> ${esc(t.clientCode)}</div>
      <div class="fp-head-n">Task ${esc(t.sequence)} of ${esc(t.taskCount)}</div>
    </div>
    <div class="fp-directive ${needLoc ? 'fp-directive-loc' : 'fp-directive-item'}">
      ${needLoc
        ? `<div class="fp-directive-label">GO TO</div><div class="fp-directive-main">${esc(t.locationCode)}</div>`
        : `<div class="fp-directive-label">PICK <span class="fp-directive-loc-ok">✓ ${esc(t.locationCode)}</span></div>
           <div class="fp-directive-main">${esc(t.skuCode)}</div>
           <div class="fp-directive-sub">${esc(t.skuName || '')}${t.lotNumber ? ` · LOT ${esc(t.lotNumber)}${t.lotConfirmed ? ' ✓' : ''}` : ''}${t.lpNumber ? ` · ${esc(t.lpNumber)}` : ''}</div>
           <div class="fp-directive-qty">QTY ${esc(t.qtyRequired)}</div>
           <div class="fp-photo" id="fpPhoto" hidden></div>`}
    </div>
    <div class="fp-counter ${t.complete ? 'fp-counter-done' : ''}">SCANNED ${esc(t.qtyPicked)} / ${esc(t.qtyRequired)}${t.openShort ? ' <span class="ui-chip ui-chip-warn">SHORT</span>' : ''}${t.openExceptions ? ' <span class="ui-chip ui-chip-danger">EXCEPTION</span>' : ''}</div>
    ${t.unitControl !== 'none' ? `<div class="fp-uids">${t.uids.length ? t.uids.map(u => `<span class="ui-id fp-uid">${esc(u)}</span>`).join('') : '<span class="ui-muted">No units scanned yet</span>'}</div>` : ''}
    <div class="fp-banner" id="fpBanner" hidden></div>
    <div id="fpScan"></div>
    <div class="fp-actions">
      <button type="button" class="ui-btn js-fp-exception" ${closed ? 'disabled' : ''}>Exception</button>
      ${!t.rules.require_item_scan && !needLoc && !closed ? '<button type="button" class="ui-btn js-fp-count">Count</button>' : ''}
      <button type="button" class="ui-btn ui-btn-primary fp-confirm js-fp-confirm" ${t.complete && !closed ? '' : 'disabled'}>${closed ? 'Picked' : `Confirm ${esc(t.qtyPicked)} / ${esc(t.qtyRequired)}`}</button>
    </div>`;

  if(_fp.input) _fp.input.destroy();
  _fp.input = scanInputMount(document.getElementById('fpScan'), {
    placeholder: needLoc ? `Scan location ${t.locationCode}` : (t.unitControl !== 'none' ? 'Scan unit label' : 'Scan item'),
    autofocus: true,
    onScan: (raw, meta) => fpScan(raw, meta),
  });
  body.querySelector('.js-fp-exception').addEventListener('click', fpOpenException);
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
  const r = await fetch(`${API}/pick-tasks/${t.id}/confirm`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fpBanner(d.error || 'Confirm refused', 'danger'); scanBeep('error'); if(btn) btn.disabled = false; return; }
  fpApply(d.task);
  uiToast(`Task ${t.sequence} picked — ${d.task.qtyPicked} / ${d.task.qtyRequired}`, 'success');
  if('vibrate' in navigator) navigator.vibrate(40);
  // Auto-advance to the next open task.
  const next = _fp.tasks.findIndex((x, i) => i > _fp.idx && !['picked', 'short'].includes(x.status));
  _fp.idx = next === -1 ? _fp.tasks.length : next;
  fpRender();
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
