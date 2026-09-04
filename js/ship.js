'use strict';
// =============================================================================
// PACK & SHIP STATION — floor mode (Step 5).
// -----------------------------------------------------------------------------
//   opening   one big ScanInput: "SCAN ORDER, PACKAGE, PALLET OR UNIT"
//   order     header (order · client · ship-to) + EXPECTED / VERIFIED / REMAINING
//   package   the open package and its contents; New package; scan units in;
//             Close (weight + dims); Get label (existing rate/buy path);
//             tracking shown; Void
//   ship      the server's checklist (green / red), then
//             "SHIPMENT VERIFIED — OK TO LOAD"
// Every decision is the server's (POST /ship/open, /packages/:id/scan,
// /orders/:id/ship). This file never judges a scan.
// =============================================================================

const _fs = { view: null, input: null, pkgId: null, qty: 1, renderedOrderId: null,
  // continuous Pack & Ship: after Ship the station flashes and returns to the scan box; the wave the packer
  // is working (from the last opened / shipped order) stays on screen with "Next in wave"
  wave: null, lastOrderId: null };
const FS_SHIPPED_FLASH_MS = 2000;

function loadFloorShip(){
  document.querySelectorAll('#page-floorShip .js-floor-home').forEach(b => {
    if(b._wired) return;
    b._wired = true;
    b.addEventListener('click', () => { _fs.view = null; _fs.pkgId = null; navigateTo('floorHome'); });
  });
  if(!_fs.view) fsRenderOpening();
  else fsRender();
}

/** Entered from the Pick screen (pack-as-you-pick) with an order already known. */
async function fsOpenOrder(orderId){
  navigateTo('floorShip');
  const d = await apiGet(`/orders/${orderId}/pack`);
  if(!d){ fsRenderOpening('Could not load that order'); return; }
  _fs.view = d;
  _fs.pkgId = d.openPackage ? d.openPackage.id : null;
  fsRender();
}

function fsRenderOpening(msg){
  const body = document.getElementById('floorShipBody');
  const w = _fs.wave;
  body.innerHTML = `
    <div class="fs-opening">
      <div class="fs-opening-title">SCAN ORDER, LABEL OR UNIT</div>
      <div id="fsOpenScan"></div>
      ${w ? `<div class="fs-wave">Wave ${esc(w.waveNumber)} · ${esc(w.shipped)} of ${esc(w.total)} shipped${w.next ? ` · next ${esc(w.next.orderNumber)}` : ' · done'}</div>
        <div class="fs-wave-actions">${w.next ? '<button type="button" class="ui-btn ui-btn-primary js-fs-wave-next">Next in wave</button>' : ''}<button type="button" class="ui-btn js-fs-wave-clear">Leave wave</button></div>` : ''}
      <div class="fp-banner" id="fsBanner" ${msg ? '' : 'hidden'}>${esc(msg || '')}</div>
    </div>`;
  if(_fs.input) _fs.input.destroy();
  _fs.input = scanInputMount(document.getElementById('fsOpenScan'), { placeholder: 'Scan to open', autofocus: true, onScan: (raw) => fsOpen(raw) });
  const nx = body.querySelector('.js-fs-wave-next'); if(nx) nx.addEventListener('click', uiBusyHandler(fsNextInWave));
  const cl = body.querySelector('.js-fs-wave-clear'); if(cl) cl.addEventListener('click', () => { _fs.wave = null; _fs.lastOrderId = null; fsRenderOpening(); });
  _fs.renderedOrderId = null;
  uiScrollTop(body);
}

/** "Next in wave": the next unshipped order of the wave the packer is working (picked ones first). */
async function fsNextInWave(){
  if(!_fs.wave) return false;
  const r = await fetch(`${API}/waves/${_fs.wave.id}/next${_fs.lastOrderId ? '?after=' + encodeURIComponent(_fs.lastOrderId) : ''}`, { headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Could not read the wave', 'error'); return false; }
  _fs.wave = d;
  if(!d.next){ uiToast(`Wave ${d.waveNumber} — nothing left to ship`, 'success'); fsRenderOpening(); return; }
  return fsOpenOrder(d.next.id);
}

/** After Ship: 2-second flash, then back to the scan box — the next scan opens the next order. */
function fsFlashShipped(sd){
  const body = document.getElementById('floorShipBody');
  if(_fs.input){ _fs.input.destroy(); _fs.input = null; }
  const trk = (sd.trackings || []).map(t => t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-3)}` : t).join(' · ');
  body.innerHTML = `<div class="fp-flash"><div class="fp-flash-title">SHIPPED ✓ ${esc(sd.orderNumber || '')}${trk ? ' · ' + esc(trk) : ''}</div><div class="fp-flash-sub">${sd.wave ? `Wave ${esc(sd.wave.waveNumber)} · ${esc(sd.wave.shipped)} of ${esc(sd.wave.total)} shipped` : 'Scan the next order, label or unit'}</div></div>`;
  uiScrollTop(body);
  if('vibrate' in navigator) navigator.vibrate([40, 40, 40]);
  return new Promise(res => setTimeout(res, FS_SHIPPED_FLASH_MS));
}

async function fsOpen(raw){
  const r = await fetch(`${API}/ship/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ raw, orderId: _fs.view ? _fs.view.order.id : null }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fsBanner(d.error || 'Scan failed', 'danger'); scanBeep('error'); return; }
  if(!d.accepted){
    if(d.view) { _fs.view = d.view; _fs.pkgId = d.view.openPackage ? d.view.openPackage.id : null; fsRender(); }
    fsBanner(d.message, d.reason === 'order_shipped' ? 'warn' : 'danger');
    scanBeep('error');
    return;
  }
  _fs.view = d.view;
  _fs.pkgId = d.view.openPackage ? d.view.openPackage.id : null;
  fsRender();
  fsBanner(d.message, 'ok');
}

function fsBanner(msg, tone){
  const b = document.getElementById('fsBanner');
  if(!b) return;
  if(!msg){ b.hidden = true; b.textContent = ''; return; }
  b.textContent = msg;
  b.className = `fp-banner fp-banner-${tone || 'danger'}`;
  b.hidden = false;
}

function fsPkg(){ return _fs.view && _fs.pkgId ? _fs.view.packages.find(p => p.id === _fs.pkgId) : null; }

function fsRender(){
  const v = _fs.view;
  const body = document.getElementById('floorShipBody');
  if(!v){ fsRenderOpening(); return; }
  // A different order on screen (opened from a label / order scan): back to the top, old result gone.
  if(_fs.renderedOrderId !== v.order.id){ _fs.renderedOrderId = v.order.id; uiScrollTop(body); }
  if(v.order.wave) _fs.wave = v.order.wave;   // the wave this order belongs to follows the packer to the scan box
  const o = v.order, c = v.counts;
  const pkg = fsPkg();
  const shipTo = [o.shipTo.name, o.shipTo.line1, [o.shipTo.city, o.shipTo.state, o.shipTo.postal].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const shipped = o.status === 'SHIPPED';
  const ssLocked = v.order.labelProvider === 'shipstation' && v.order.shipstationWritesEnabled === false;
  // Every box needs a label, and (client rule, default on) the label must be scanned at the bench —
  // a label the office printed is attached by the sync but not verified until the packer scans it.
  const requireScan = !(v.order.shipRules && v.order.shipRules.require_label_scan === false);
  const boxes = (v.packages || []).filter(p => p.status !== 'voided' && p.status !== 'shipped');
  const unlabeled = boxes.filter(p => p.status !== 'open' && !p.trackingNumber);
  const unverified = requireScan ? boxes.filter(p => p.trackingNumber && !p.labelVerified) : [];
  const needsLabel = (unlabeled.length > 0 || unverified.length > 0) && (v.lines || []).some(l => l.packagedQty > 0);
  // ship-ready: everything packed into labeled, scanned boxes -> READY — Ship
  const readyToShip = !!v.order.allShipReady && boxes.length > 0 && boxes.every(p => p.status === 'labeled' && (!requireScan || p.labelVerified)) && (v.lines || []).every(l => l.pickedQty > 0 && l.packagedQty >= l.pickedQty);
  body.innerHTML = `
    <div class="fp-head">
      <div class="fp-head-order">${uiId(o.orderNumber)} <span class="ui-muted">·</span> ${esc(o.clientCode)} ${uiChip(o.status)}</div>
      <button type="button" class="ui-btn js-fs-switch">Other order</button>
    </div>
    <div class="fs-shipto">${esc(shipTo || 'No ship-to address')}${o.proNumber ? ` · PRO ${uiId(o.proNumber)}` : ''}</div>
    <div class="fs-counts">
      <div class="fs-count"><div class="fs-count-label">EXPECTED</div><div class="fs-count-num">${esc(c.expected)}</div></div>
      <div class="fs-count fs-count-ok"><div class="fs-count-label">VERIFIED</div><div class="fs-count-num">${esc(c.verified)}</div></div>
      <div class="fs-count ${c.remaining ? 'fs-count-warn' : 'fs-count-ok'}"><div class="fs-count-label">REMAINING</div><div class="fs-count-num">${esc(c.remaining)}</div></div>
    </div>
    <div class="fs-lines">${v.lines.map(l => `
      <div class="fs-line ${l.packagedQty >= l.pickedQty && l.pickedQty > 0 ? 'fs-line-done' : ''}">
        <span class="ui-id">${esc(l.skuCode)}</span>${l.lotNumber ? ` <span class="ui-muted">lot ${esc(l.lotNumber)}</span>` : ''}${l.cartons ? ` <span class="fs-line-carton">${esc(l.cartons)}</span>` : ''}${l.shipsAsIs ? ' ' + uiChip('ACTIVE', 'SHIPS AS-IS') : ''}
        <span class="fs-line-n">${esc(l.packagedQty)} / ${esc(l.pickedQty)}${l.pendingAllocations ? ' <span class="ui-chip ui-chip-warn">PICKING</span>' : ''}</span>
      </div>`).join('')}</div>
    <div class="fp-banner" id="fsBanner" hidden></div>

    <div class="ui-group fs-pkg">
      <div class="sp-editor-head">
        <div class="ui-dialog-title">${pkg ? `${esc(pkg.packageNumber)} ${uiChip(pkg.status === 'open' ? 'NEW' : pkg.status === 'closed' ? 'PACKED' : pkg.status === 'labeled' ? 'ALLOCATED' : pkg.status === 'shipped' ? 'SHIPPED' : 'CANCELLED', pkg.status.toUpperCase())}` : 'No open package'}</div>
        <div class="sp-toolbar-actions">
          ${!shipped && !v.order.allShipReady ? '<button type="button" class="ui-btn ui-btn-primary js-fs-newpkg">New package</button>' : ''}
        </div>
      </div>
      <div class="ui-group-body">
        ${pkg ? `
          <div class="fs-contents">${pkg.contents.length ? pkg.contents.map(x => `<span class="ui-id fp-uid">${esc(x.uid || x.skuCode)}${x.qty > 1 ? ' ×' + esc(x.qty) : ''}</span>`).join('') : '<span class="ui-muted">Empty — scan units into it</span>'}</div>
          ${pkg.trackingNumber ? `<div class="fs-tracking">${esc(pkg.carrierCode || '')} ${esc(pkg.serviceLevel || '')} · ${uiId(pkg.trackingNumber)} ${pkg.labelVerified ? uiChip('ACTIVE', 'LABEL VERIFIED') : (pkg.labelPrinted ? uiChip('DRAFT', 'LABEL PRINTED — SCAN IT') : (requireScan ? uiChip('DRAFT', 'SCAN LABEL') : ''))}${pkg.labelBatch ? ` <span class="ui-muted">batch ${esc(pkg.labelBatch)}</span>` : ''}</div>` : (v.order.labelProvider === 'shipstation' && v.order.labelMode === 'label_first' ? '<div class="ui-hint">Label first: the office prints this label in ShipStation. Scan the printed label to attach it, or ask for one.</div>' : '')}
          ${pkg.status === 'open' ? `
            <div class="fs-scanrow">
              <div id="fsPkgScan" class="fs-scan"></div>
              <label class="fs-qty"><span class="ui-muted">Qty</span><input class="ui-input" type="number" min="1" id="fsQty" value="${esc(_fs.qty)}"></label>
            </div>
            <div class="fp-actions">
              <button type="button" class="ui-btn js-fs-void">Void</button>
              <button type="button" class="ui-btn ui-btn-primary fp-confirm js-fs-close" ${pkg.unitCount ? '' : 'disabled'}>Close package</button>
            </div>` : ''}
          ${pkg.status === 'closed' && !pkg.trackingNumber && v.order.labelProvider === 'shipstation' ? `
            <div class="fp-directive fp-directive-loc">
              <div class="fp-directive-label">SCAN SHIPPING LABEL</div>
              <div class="fp-directive-main">${esc(pkg.packageNumber)}</div>
              <div class="ui-hint">Scan the label printed in ShipStation — it attaches to this box. Ship stays off until every box has a label.</div>
            </div>` : ''}
          ${pkg.status === 'closed' ? `
            <div class="fp-actions">
              <button type="button" class="ui-btn js-fs-reopen">Reopen</button>
              <button type="button" class="ui-btn js-fs-void">Void</button>
              ${v.order.labelProvider === 'shipstation'
                ? `<button type="button" class="ui-btn js-fs-attach">Attach printed label</button>
                   ${v.order.labelMode === 'label_at_pack' ? `<button type="button" class="ui-btn ui-btn-primary fp-confirm js-fs-sslabel" ${ssLocked ? 'disabled title="ShipStation write lock is on"' : ''}>Get label</button>` : ''}${ssLocked ? '<div class="ui-hint fs-locked">ShipStation write lock is on — enable writes under Settings → Integrations</div>' : ''}`
                : '<button type="button" class="ui-btn ui-btn-primary fp-confirm js-fs-label">Get label</button>'}
            </div>` : ''}
          ${pkg.status === 'labeled' ? `
            <div class="fp-actions">
              ${pkg.labelProvider === 'shipstation'
                ? `${pkg.hasPdf ? '<button type="button" class="ui-btn js-fs-reprint">Re-print</button>' : '<span class="ui-hint">Printed in ShipStation — re-print there</span>'}
                   <button type="button" class="ui-btn js-fs-voidlabel" ${ssLocked ? 'disabled title="ShipStation write lock is on"' : ''}>Void label</button>${ssLocked ? '<div class="ui-hint fs-locked">ShipStation write lock is on — enable writes under Settings → Integrations</div>' : ''}`
                : '<button type="button" class="ui-btn js-fs-void">Void (refund label)</button>'}
            </div>` : ''}
        ` : (shipped ? '<div class="ui-hint">This order has shipped.</div>' : (v.order.allShipReady ? '<div class="ui-hint">Ship-ready order: scan the unit — it packs and closes its own box.</div>' : '<div class="ui-hint">Scan the first unit to start a package, or tap New package.</div>'))}
      </div>
    </div>

    <div class="fs-pkglist">${v.packages.filter(p => !pkg || p.id !== pkg.id).map(p => `
      <button type="button" class="fs-pkgrow js-fs-pick" data-id="${esc(p.id)}">
        <span class="ui-id">${esc(p.packageNumber)}</span> <span class="ui-muted">${esc(p.unitCount)} unit${p.unitCount === 1 ? '' : 's'}</span>
        ${uiChip(p.status === 'open' ? 'NEW' : p.status === 'closed' ? 'PACKED' : p.status === 'labeled' ? 'ALLOCATED' : 'SHIPPED', p.status.toUpperCase())}
        ${p.trackingNumber ? `<span class="ui-id">${esc(p.trackingNumber)}</span> ${p.labelVerified ? uiChip('ACTIVE', 'LABEL VERIFIED') : (requireScan && p.status !== 'shipped' ? uiChip('DRAFT', 'SCAN LABEL') : '')}` : ''}
      </button>`).join('')}</div>

    ${!shipped && needsLabel ? `
      <div class="fp-directive fp-directive-loc">
        <div class="fp-directive-label">SCAN SHIPPING LABEL</div>
        <div class="fp-directive-main">${esc([...unlabeled, ...unverified].map(p => p.packageNumber).join(' · '))}</div>
        <div class="ui-hint">${unverified.length ? 'The label is printed — put it on the box and scan its tracking barcode to verify it.' : 'Scan the label printed in ShipStation — it attaches to the box.'}${boxes.length > 1 ? ' One scan per box.' : ''}</div>
      </div>` : ''}
    ${!shipped && readyToShip ? `
      <div class="fp-directive fp-directive-item">
        <div class="fp-directive-label">READY</div>
        <div class="fp-directive-main">Ship</div>
        <div class="ui-hint">Every unit is in a labeled box.</div>
      </div>` : ''}
    ${shipped
      ? `<div class="fs-verified">SHIPPED${v.verification ? ` · verified ${esc(String(v.verification.verifiedAt || '').slice(0, 16).replace('T', ' '))}` : ''}</div>`
      : `<button type="button" class="ui-btn ui-btn-primary fs-shipbtn js-fs-ship" ${needsLabel ? 'disabled title="Scan the shipping label first"' : ''}>${needsLabel ? 'Ship — scan the shipping label first' : 'Ship — verify checklist'}</button>`}`;

  body.querySelector('.js-fs-switch').addEventListener('click', () => { _fs.view = null; _fs.pkgId = null; fsRenderOpening(); });
  const np = body.querySelector('.js-fs-newpkg'); if(np) np.addEventListener('click', uiBusyHandler(fsNewPackage));
  const cl = body.querySelector('.js-fs-close'); if(cl) cl.addEventListener('click', fsClosePackage);
  const ro = body.querySelector('.js-fs-reopen'); if(ro) ro.addEventListener('click', uiBusyHandler(() => fsPkgAction('reopen')));
  const vd = body.querySelector('.js-fs-void'); if(vd) vd.addEventListener('click', uiBusyHandler(fsVoidPackage));
  const lb = body.querySelector('.js-fs-label'); if(lb) lb.addEventListener('click', uiBusyHandler(fsGetLabel));
  const sl = body.querySelector('.js-fs-sslabel'); if(sl) sl.addEventListener('click', uiBusyHandler(fsGetShipStationLabel));
  const at = body.querySelector('.js-fs-attach'); if(at) at.addEventListener('click', uiBusyHandler(fsAttachLabel));
  const rp = body.querySelector('.js-fs-reprint'); if(rp) rp.addEventListener('click', uiBusyHandler(fsReprint));
  const vl = body.querySelector('.js-fs-voidlabel'); if(vl) vl.addEventListener('click', uiBusyHandler(fsVoidLabel));
  const sb = body.querySelector('.js-fs-ship'); if(sb) sb.addEventListener('click', uiBusyHandler(fsShip));
  body.querySelectorAll('.js-fs-pick').forEach(b => b.addEventListener('click', () => { _fs.pkgId = b.dataset.id; fsRender(); }));
  const qty = body.querySelector('#fsQty'); if(qty) qty.addEventListener('change', () => { _fs.qty = Math.max(1, parseInt(qty.value, 10) || 1); });

  if(_fs.input) _fs.input.destroy();
  const scanHost = body.querySelector('#fsPkgScan');
  if(scanHost){
    _fs.input = scanInputMount(scanHost, { placeholder: 'Scan unit or item into this package', autofocus: true, onScan: (raw) => fsScanIntoPackage(raw) });
  } else {
    // No open package: a scan re-opens / switches the order instead.
    const host = document.createElement('div');
    host.className = 'fs-scan';
    body.querySelector('.fs-pkg').after(host);
    _fs.input = scanInputMount(host, { placeholder: 'Scan order, package, pallet or unit', autofocus: true, onScan: (raw) => fsOpen(raw) });
  }
}

async function fsRefresh(){
  if(!_fs.view) return;
  const d = await apiGet(`/orders/${_fs.view.order.id}/pack`);
  if(d){ _fs.view = d; if(_fs.pkgId && !d.packages.find(p => p.id === _fs.pkgId)) _fs.pkgId = d.openPackage ? d.openPackage.id : null; }
  fsRender();
}

async function fsNewPackage(){
  const r = await fetch(`${API}/orders/${_fs.view.order.id}/packages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}' });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fsBanner(d.error || 'Could not start a package', 'danger'); scanBeep('error'); return; }
  _fs.pkgId = d.id;
  await fsRefresh();
  uiToast(`${d.packageNumber} opened`, 'success');
}

async function fsScanIntoPackage(raw){
  const pkg = fsPkg();
  // No open box yet but an order is on screen: an item scan opens the first box itself (the
  // server decides); an order / tracking scan still switches orders.
  if(!pkg && !(_fs.view && _fs.view.order)) return fsOpen(raw);
  fsBanner(null);
  _fs.input.setBusy(true);
  try {
    const url = pkg ? `${API}/packages/${pkg.id}/scan` : `${API}/orders/${_fs.view.order.id}/pack-scan`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ raw, qty: _fs.qty }) });
    const d = await r.json().catch(() => ({}));
    if(!r.ok){ fsBanner(d.error || 'Scan failed', 'danger'); scanBeep('error'); return; }
    if(d.reason === 'not_an_item'){ _fs.input.setBusy(false); return fsOpen(raw); }
    if(d.view){ _fs.view = d.view; _fs.pkgId = d.view.openPackage ? d.view.openPackage.id : _fs.pkgId; }
    fsRender();
    if(d.accepted) fsBanner(d.message, 'ok');
    else { fsBanner(d.message || 'Rejected', 'danger'); scanBeep('error'); }
  } catch(_) { fsBanner('Network error', 'danger'); }
  finally { if(_fs.input){ _fs.input.setBusy(false); _fs.input.focus(); } }
}

function fsClosePackage(){
  const pkg = fsPkg();
  if(!pkg) return;
  uiModal({
    title: `Close ${pkg.packageNumber}`,
    body: `${uiField({ id: 'fsW', label: 'Weight (lbs)', type: 'number', value: pkg.weightLbs || '' })}
           <div class="ui-field-row sp-row-3">
             ${uiField({ id: 'fsL', label: 'Length (in)', type: 'number', value: pkg.lengthIn || '' })}
             ${uiField({ id: 'fsWd', label: 'Width (in)', type: 'number', value: pkg.widthIn || '' })}
             ${uiField({ id: 'fsH', label: 'Height (in)', type: 'number', value: pkg.heightIn || '' })}
           </div>`,
    actions: [{ label: 'Cancel' }, { label: 'Close package', primary: true, onClick: async (api) => {
      const v = (id) => api.el.querySelector('#' + id).value;
      if(!Number(v('fsW'))){ uiFieldError(api.el, 'fsW', 'Weight is required'); return false; }
      const r = await fetch(`${API}/packages/${pkg.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
        body: JSON.stringify({ weightLbs: Number(v('fsW')), lengthIn: Number(v('fsL')) || null, widthIn: Number(v('fsWd')) || null, heightIn: Number(v('fsH')) || null }) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok){ uiToast(d.error || 'Could not close', 'error'); return false; }
      uiToast(`${pkg.packageNumber} closed`, 'success');
      await fsRefresh();
    } }],
  });
}

async function fsPkgAction(action){
  const pkg = fsPkg();
  if(!pkg) return;
  const r = await fetch(`${API}/packages/${pkg.id}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fsBanner(d.error || `${action} failed`, 'danger'); scanBeep('error'); return; }
  await fsRefresh();
}

async function fsVoidPackage(){
  const pkg = fsPkg();
  if(!pkg) return;
  const go = await uiConfirm({ title: `Void ${pkg.packageNumber}?`, message: pkg.trackingNumber ? 'The label will be refunded. Its units go back to picked.' : 'Its units go back to picked.', confirmLabel: 'Void', danger: true });
  if(!go) return;
  await fsPkgAction('void');
  uiToast(`${pkg.packageNumber} voided`, 'success');
}

async function fsGetLabel(){
  const pkg = fsPkg();
  if(!pkg) return;
  const r = await fetch(`${API}/packages/${pkg.id}/label`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}' });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fsBanner(d.error || 'Could not get rates', 'danger'); scanBeep('error'); return; }
  const rates = d.rates || [];
  uiModal({
    title: `Label for ${pkg.packageNumber}`,
    body: rates.length ? `<div class="fs-rates">${rates.map(x => `
      <label class="fs-rate"><input type="radio" name="fsRate" value="${esc(x.rateId)}"> <span>${esc(x.carrierDisplay || x.carrier)} ${esc(x.service)}</span>
        <span class="fs-rate-price">${uiMoney(x.rate)}</span>${x.deliveryDays ? `<span class="ui-muted">${esc(x.deliveryDays)}d</span>` : ''}</label>`).join('')}</div>` : uiEmpty('No rates returned'),
    actions: [{ label: 'Cancel' }, { label: 'Buy label', primary: true, onClick: async (api) => {
      const sel = api.el.querySelector('input[name="fsRate"]:checked');
      if(!sel){ uiToast('Pick a service', 'error'); return false; }
      const b = await fetch(`${API}/packages/${pkg.id}/label`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ rateId: sel.value }) });
      const bd = await b.json().catch(() => ({}));
      if(!b.ok){ uiToast(bd.error || 'Label purchase failed', 'error'); return false; }
      uiToast(`Label bought — ${bd.package.trackingNumber}`, 'success');
      await fsRefresh();
    } }],
  });
}

// ---- ShipStation label paths (source=shipstation orders) -----------------------------
async function fsGetShipStationLabel(){
  const pkg = fsPkg();
  if(!pkg) return;
  const carriers = await apiGet('/shipstation/carriers');
  const rows = carriers?.rows || [];
  const m = uiModal({
    title: `ShipStation label for ${pkg.packageNumber}`,
    body: `<div class="ui-hint">Default: the carrier/service mapped for "${esc(_fs.view.order.requestedService || 'no requested service')}". Override below if the packer needs a different service.</div>
           ${uiFieldSelect({ id: 'fsSsCarrier', label: 'Carrier (override)', options: [{ value: '', label: 'Use mapped service' }, ...rows.map(c => ({ value: c.code, label: `${c.name} (${c.code})` }))] })}
           ${uiFieldSelect({ id: 'fsSsService', label: 'Service (override)', options: [{ value: '', label: 'Use mapped service' }] })}`,
    actions: [{ label: 'Cancel' }, { label: 'Create label', primary: true, onClick: async (api) => {
      const carrierCode = api.el.querySelector('#fsSsCarrier').value || undefined, serviceCode = api.el.querySelector('#fsSsService').value || undefined;
      if((carrierCode && !serviceCode) || (!carrierCode && serviceCode)){ uiToast('Pick both a carrier and a service, or neither', 'error'); return false; }
      const r = await fetch(`${API}/packages/${pkg.id}/shipstation-label`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ carrierCode, serviceCode }) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok){ uiToast(d.error || 'Label creation failed', 'error'); return false; }
      uiToast(`Label created — ${d.trackingNumber}`, 'success');
      await fsRefresh();
      fsReprint();
    } }],
  });
  m.el.querySelector('#fsSsCarrier').addEventListener('change', async (e) => {
    const code = e.target.value; const sel = m.el.querySelector('#fsSsService');
    if(!code){ sel.innerHTML = '<option value="">Use mapped service</option>'; return; }
    const s = await apiGet(`/shipstation/carriers/${encodeURIComponent(code)}/services`);
    sel.innerHTML = (s?.rows || []).map(x => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('') || '<option value="">no services</option>';
  });
}

async function fsReprint(){
  const pkg = fsPkg();
  if(!pkg) return;
  const r = await fetch(`${API}/packages/${pkg.id}/label.pdf`, { headers: { Authorization: `Bearer ${T}` } });
  if(!r.ok){ const d = await r.json().catch(() => ({})); uiToast(d.error || 'No stored PDF for this label', 'error'); return; }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if(!w) uiToast('Pop-up blocked — allow pop-ups to print the label', 'error');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function fsVoidLabel(){
  const pkg = fsPkg();
  if(!pkg) return;
  const reason = await uiPrompt({ title: `Void label ${pkg.trackingNumber}?`, label: 'Reason', placeholder: 'wrong service / box changed / order cancelled', confirmLabel: 'Void label' });
  if(!reason) return;
  const r = await fetch(`${API}/packages/${pkg.id}/void-label`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ reason }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Void failed', 'error'); return; }
  uiToast('Label voided in ShipStation', 'success');
  await fsRefresh();
}

async function fsAttachLabel(){
  const pkg = fsPkg();
  if(!pkg) return;
  const tracking = await uiPrompt({ title: `Attach a printed label to ${pkg.packageNumber}`, label: 'Scan or type the tracking number', placeholder: '1Z… / 9400… / FedEx', confirmLabel: 'Attach' });
  if(!tracking) return;
  const r = await fetch(`${API}/packages/${pkg.id}/attach-label`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ tracking: String(tracking).trim() }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fsBanner(d.error || 'Could not attach the label', 'danger'); scanBeep('error'); return; }
  uiToast(`Attached ${d.trackingNumber}`, 'success');
  await fsRefresh();
}

async function fsShip(){
  const v = _fs.view;
  const r = await fetch(`${API}/orders/${v.order.id}/ship`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ dryRun: true }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ fsBanner(d.error || 'Could not verify', 'danger'); return; }
  const list = (items) => items.map(i => `<div class="fs-check ${i.pass ? 'fs-check-ok' : 'fs-check-bad'}"><span class="fs-check-mark">${i.pass ? '✓' : '✕'}</span><span>${esc(i.label)}${i.detail ? `<div class="ui-hint">${esc(i.detail)}</div>` : ''}</span></div>`).join('');
  const m = uiModal({
    title: d.pass ? 'Ready to ship' : 'Not ready to ship',
    body: `<div class="fs-checklist" id="fsChecklist">${list(d.items)}</div>`,
    actions: [{ label: 'Close' }, ...(d.pass ? [{ label: 'SHIP', primary: true, onClick: async (api) => {
      const s = await fetch(`${API}/orders/${v.order.id}/ship`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ verified: true }) });
      const sd = await s.json().catch(() => ({}));
      if(!s.ok){
        if(sd.checklist) api.el.querySelector('#fsChecklist').innerHTML = list(sd.checklist.items);
        uiToast(sd.error || 'Ship refused', 'error');
        scanBeep('error');
        return false;
      }
      // continuous: close the checklist, flash SHIPPED for 2 s, then the station is back at the scan box,
      // focused and scrolled to the top — the next sword or label opens the next order, no tap needed
      api.close();
      const orderId = v.order.id;
      if(sd.wave) _fs.wave = sd.wave;
      _fs.lastOrderId = orderId;
      await fsFlashShipped(sd);
      if(_fs.view && _fs.view.order.id === orderId){ _fs.view = null; _fs.pkgId = null; fsRenderOpening(); }
      return true;
    } }] : [])],
  });
  return m;
}
