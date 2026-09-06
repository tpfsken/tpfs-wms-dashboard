// =============================================================================
// EXCALIBUR CATCH-UP — WMS-live clients that still have an Excalibur mapping.
//
// Client → Profile tab card (integrations.excalibur_keying):
//   GET    /clients/:id/excalibur-catchup            un-keyed shipments since go-live + drift
//   POST   /clients/:id/excalibur-catchup/mark       { order_ids, excalibur_doc_no? }
//   DELETE /clients/:id/excalibur-catchup/mark       { order_ids }
//   GET    /clients/:id/excalibur-catchup/export.csv
// Dashboard tile: GET /excalibur-catchup/summary (count across clients).
// The card only shows for a live client with a mapping — the API answers 409
// for anything else and the card stays hidden.
// =============================================================================

'use strict';

let _ecData = null;
const _ecSelected = new Set();

function _ecFetch(path, opts = {}){ return fetch(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${T}`, ...(opts.headers || {}) } }); }

async function _ecDownload(path, fallbackName){
  const r = await _ecFetch(path);
  if(!r.ok){ const d = await r.json().catch(() => ({})); if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Download failed', 'error'); return false; }
  const blob = await r.blob();
  const name = ((r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/** Called from renderClientProfileTab. Hidden unless the client is live, mapped, and the user may key. */
async function loadClientCatchupCard(){
  const card = document.getElementById('cliCatchupCard');
  const c = typeof _currentClient !== 'undefined' ? _currentClient : null;
  if(!card) return;
  card.style.display = 'none';
  if(!c || (c.system_of_record || 'wms') !== 'wms' || !can('integrations.excalibur_keying')) return;
  const r = await _ecFetch(`/clients/${c.id}/excalibur-catchup`);
  if(r.status === 409 || r.status === 404) return;                       // not live + mapped: no card
  const d = await r.json().catch(() => null);
  if(!r.ok || !d){ card.style.display = 'block'; document.getElementById('cliCatchupBody').innerHTML = uiError((d && d.error) || 'Could not load the Excalibur catch-up'); return; }
  _ecData = d; _ecSelected.clear();
  card.style.display = 'block';
  renderClientCatchupCard();
}

function _ecLinesSummary(o){
  return o.lines.map(l => `${l.sku} × ${l.qty}${l.lot ? ` (lot ${l.lot})` : ''}${l.serials.length ? ` [${l.serials.length} serial${l.serials.length === 1 ? '' : 's'}]` : ''}`).join(' · ');
}

function renderClientCatchupCard(){
  const d = _ecData; const host = document.getElementById('cliCatchupBody'); const count = document.getElementById('cliCatchupCount');
  if(!host || !d) return;
  if(count) count.textContent = `${d.unkeyed} un-keyed shipment${d.unkeyed === 1 ? '' : 's'} · ${d.units} unit${d.units === 1 ? '' : 's'} · since ${d.client.wentLiveAt ? fmtTimeShort(d.client.wentLiveAt) : 'go-live'} · Excalibur client ${d.client.excaliburCode}`;
  const sel = _ecSelected.size;
  const lc = d.client.lastCheck;
  const fields = d.client.matchFields || ['HeaderReference'];
  host.innerHTML = `
    <div class="roles-toolbar ec-check">
      <span class="ui-hint">${lc ? `Last checked ${esc(fmtTimeShort(lc.at))}: ${esc(lc.fetched || 0)} posted Excalibur shipment${(lc.fetched || 0) === 1 ? '' : 's'} since go-live, ${esc(lc.matched || 0)} matched on that check, ${esc(lc.unmatchedTotal || 0)} not in the WMS.` : 'Not checked against Excalibur yet.'} Matching reads Excalibur only — nothing is written there.</span>
      <span style="flex:1"></span>
      <label class="ui-label" for="ecMatchField">Order # is keyed into</label>
      <select class="ui-input ii-select js-ec-field" id="ecMatchField">${fields.map(f => `<option value="${esc(f)}"${f === d.client.matchField ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select>
      <button type="button" class="ui-btn ui-btn-primary js-ec-check">Check now</button>
    </div>
    <div class="roles-toolbar">
      <span class="ui-hint">Shipments the WMS completed since ${esc(d.client.code)} went live with no matching posted shipment in Excalibur. Auto-match removes them as Excalibur catches up; tick and press Mark keyed for anything keyed by hand.</span>
      <span style="flex:1"></span>
      <button type="button" class="ui-btn js-ec-export" ${d.unkeyed ? '' : 'disabled'}>Export CSV</button>
      <button type="button" class="ui-btn js-ec-mark" ${sel ? '' : 'disabled'}>Mark keyed${sel ? ` (${sel})` : ''}</button>
    </div>
    ${d.unkeyed ? `<div class="roles-grid-wrap" style="max-height:44vh;">
      <table class="ui-table ec-table">
        <thead><tr><th><input type="checkbox" class="js-ec-all" ${sel && sel === d.rows.length ? 'checked' : ''} title="Select all"></th><th>Order #</th><th>Shipped</th><th>Customer</th><th>Carrier / tracking</th><th>Pkgs</th><th>Lines</th></tr></thead>
        <tbody>${d.rows.map(o => `<tr data-id="${esc(o.orderId)}">
          <td><input type="checkbox" class="js-ec-row" data-id="${esc(o.orderId)}" ${_ecSelected.has(o.orderId) ? 'checked' : ''}></td>
          <td class="ui-mono">${esc(o.orderNumber)}${o.externalOrderNumber ? `<div class="ui-hint">${esc(o.externalOrderNumber)}</div>` : ''}</td>
          <td>${uiId(fmtTimeShort(o.shippedAt))}</td>
          <td>${esc(o.customer || '')}${o.shipTo ? `<div class="ui-hint">${esc(o.shipTo)}</div>` : ''}</td>
          <td>${esc(o.carrier || '')}${o.tracking.length ? `<div class="ui-hint ui-mono">${o.tracking.map(esc).join('<br>')}</div>` : ''}</td>
          <td class="ui-num">${esc(o.packages.length)}</td>
          <td class="ui-hint">${esc(_ecLinesSummary(o))}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : uiEmpty('Everything shipped since go-live has been keyed into Excalibur.')}
    <div class="ec-drift">${_ecDriftLine(d)}</div>
    ${d.unmatched && d.unmatched.length ? `<div class="ec-unmatched">
      <div class="ii-history-title">In Excalibur, not in WMS (${esc(d.unmatchedTotal || d.unmatched.length)})</div>
      <div class="ui-hint" style="margin-bottom:6px;">Posted Excalibur shipments for this client since go-live whose ${esc(d.client.matchField)} matches no WMS order. Keyed twice, keyed under another client, or the order number went into a different field.</div>
      <table class="ui-table ec-table"><thead><tr><th>Excalibur doc</th><th>Date</th><th>${esc(d.client.matchField)}</th><th>Consignee</th><th>Carrier / PRO</th><th>Qty</th></tr></thead>
        <tbody>${d.unmatched.map(u => `<tr><td class="ui-mono">${esc(u.document)}</td><td>${uiId(fmtTimeShort(u.docDate))}</td><td class="ui-mono">${esc(u.reference || '')}</td><td>${esc(u.consignee || '')}${u.city ? `<div class="ui-hint">${esc(u.city)}</div>` : ''}</td><td>${esc(u.carrier || '')}${u.proNumber ? `<div class="ui-hint ui-mono">${esc(u.proNumber)}</div>` : ''}</td><td class="ui-num">${esc(u.qty == null ? '' : u.qty)}</td></tr>`).join('')}</tbody></table>
    </div>` : ''}
    ${d.keyedRecent && d.keyedRecent.length ? `<details class="ec-recent"><summary>Recently keyed (${d.keyedRecent.length})</summary>
      <table class="ui-table ec-table"><tbody>${d.keyedRecent.map(o => `<tr>
        <td class="ui-mono">${esc(o.orderNumber)}</td><td>${uiId(fmtTimeShort(o.keyed.at))}</td><td>${esc(o.keyed.by || '')}${o.keyed.source === 'auto' ? ` <span class="idn-tag idn-tag-primary" title="matched on ${esc(o.keyed.matchedBy || '')}">auto</span>` : ''}</td><td class="ui-mono">${esc(o.keyed.excaliburDocNo || '')}</td>
        <td><button type="button" class="ui-btn js-ec-unmark" data-id="${esc(o.orderId)}" data-num="${esc(o.orderNumber)}">Unmark</button></td></tr>`).join('')}</tbody></table></details>` : ''}`;
  host.querySelectorAll('.js-ec-row').forEach(cb => cb.addEventListener('change', () => { if(cb.checked) _ecSelected.add(cb.dataset.id); else _ecSelected.delete(cb.dataset.id); renderClientCatchupCard(); }));
  host.querySelector('.js-ec-all')?.addEventListener('change', (e) => { _ecSelected.clear(); if(e.target.checked) d.rows.forEach(o => _ecSelected.add(o.orderId)); renderClientCatchupCard(); });
  host.querySelector('.js-ec-export').addEventListener('click', uiBusyHandler(() => _ecDownload(`/clients/${d.client.id}/excalibur-catchup/export.csv`, `excalibur-catchup-${d.client.code}.csv`)));
  host.querySelector('.js-ec-check').addEventListener('click', uiBusyHandler(() => checkCatchupNow()));
  host.querySelector('.js-ec-field').addEventListener('change', uiBusyHandler(async (e) => {
    const r = await _ecFetch(`/clients/${d.client.id}/excalibur-catchup/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ match_field: e.target.value }) });
    const res = await r.json().catch(() => ({}));
    if(!r.ok){ uiToast(res.error || 'Could not save', 'error'); return false; }
    uiToast(`Matching on ${res.matchField} — press Check now to re-match`);
    d.client.matchField = res.matchField;
  }));
  host.querySelector('.js-ec-mark').addEventListener('click', uiBusyHandler(() => markCatchupKeyed()));
  host.querySelectorAll('.js-ec-unmark').forEach(b => b.addEventListener('click', uiBusyHandler(() => unmarkCatchupKeyed(b.dataset.id, b.dataset.num))));
}

function _ecDriftLine(d){
  const dr = d.drift;
  if(!dr) return '';
  if(!dr.available) return `<span class="ui-hint">Excalibur drift unavailable — ${esc(dr.reason || 'no live comparison')}.</span>`;
  if(dr.explained) return `<span class="ui-chip ui-chip-ok">Drift explained</span> <span class="ui-hint">Excalibur holds ${esc(dr.excaliburQty)} units vs ${esc(dr.wmsQty)} in the WMS; the difference is exactly the ${esc(d.units)} units shipped but not keyed yet.</span>`;
  const bad = (dr.bySku || []).filter(r => !r.explained).slice(0, 6);
  return `<div class="ui-banner ui-banner-warn"><strong>Drift does not match the un-keyed shipments</strong> for ${esc(dr.unexplained)} SKU${dr.unexplained === 1 ? '' : 's'}: ${bad.map(r => `${esc(r.sku)} (Excalibur − WMS = ${esc(r.gap)}, un-keyed ${esc(r.unkeyed)})`).join('; ')}${dr.unexplained > bad.length ? '; …' : ''}. Something besides keying is off — check adjustments or receipts in Excalibur.</div>`;
}

async function checkCatchupNow(){
  const d = _ecData; if(!d) return false;
  const r = await _ecFetch(`/clients/${d.client.id}/excalibur-catchup/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const res = await r.json().catch(() => ({}));
  if(!r.ok){ if(res.code === 'PERMISSION_DENIED') permDeniedToast(res); else uiToast(res.error || 'Check failed', 'error'); return false; }
  if(res.available === false){ uiToast(`Excalibur could not be read — ${res.reason || 'unavailable'}`, 'error', 6000); return false; }
  uiToast(`Checked Excalibur: ${res.fetched} posted shipment${res.fetched === 1 ? '' : 's'}, ${res.matched} newly matched, ${res.unmatched.length} not in the WMS`);
  await loadClientCatchupCard();
  if(typeof loadCatchupTile === 'function') loadCatchupTile();
}

async function markCatchupKeyed(){
  const d = _ecData; if(!d || !_ecSelected.size) return false;
  const docNo = await uiPrompt({ title: `Mark ${_ecSelected.size} shipment${_ecSelected.size === 1 ? '' : 's'} as keyed in Excalibur`, label: 'Excalibur document # (optional)', value: '', confirmLabel: 'Mark keyed' });
  if(docNo == null) return false;
  const r = await _ecFetch(`/clients/${d.client.id}/excalibur-catchup/mark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [..._ecSelected], excalibur_doc_no: String(docNo).trim() || undefined }) });
  const res = await r.json().catch(() => ({}));
  if(!r.ok){ if(res.code === 'PERMISSION_DENIED') permDeniedToast(res); else uiToast(res.error || 'Could not mark', 'error'); return false; }
  uiToast(`${res.marked.length} shipment${res.marked.length === 1 ? '' : 's'} marked keyed`);
  await loadClientCatchupCard();
  if(typeof loadCatchupTile === 'function') loadCatchupTile();
}

async function unmarkCatchupKeyed(orderId, orderNumber){
  const d = _ecData; if(!d) return false;
  const ok = await uiConfirm({ title: `Unmark ${orderNumber}?`, body: 'It goes back on the un-keyed list.', confirmLabel: 'Unmark' });
  if(!ok) return false;
  const r = await _ecFetch(`/clients/${d.client.id}/excalibur-catchup/mark`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [orderId] }) });
  const res = await r.json().catch(() => ({}));
  if(!r.ok){ if(res.code === 'PERMISSION_DENIED') permDeniedToast(res); else uiToast(res.error || 'Could not unmark', 'error'); return false; }
  uiToast(`${orderNumber} back on the list`);
  await loadClientCatchupCard();
  if(typeof loadCatchupTile === 'function') loadCatchupTile();
}

// ---- dashboard tile ------------------------------------------------------------------------------
async function loadCatchupTile(){
  const row = document.getElementById('catchupTileRow');
  if(!row) return;
  if(!can('integrations.excalibur_keying')){ row.innerHTML = ''; row.style.display = 'none'; return; }
  const d = await apiGet('/excalibur-catchup/summary');
  if(!d || !d.migrated || !d.clients.length){ row.innerHTML = ''; row.style.display = 'none'; return; }
  row.style.display = '';
  row.className = 'ui-tiles';
  const worst = d.clients.filter(c => c.unkeyed > 0).slice(0, 3).map(c => `${c.code} ${c.unkeyed}`).join(' · ');
  uiSwapHtml(row, uiTile({ label: 'Excalibur catch-up', value: d.total, tone: d.total > 0 ? 'warn' : 'ok',
    sub: d.total ? `un-keyed shipments · ${worst}` : `all shipments keyed for ${d.clients.length} live client${d.clients.length === 1 ? '' : 's'}` }));
}
