'use strict';
// =============================================================================
// SETTINGS > INTEGRATIONS > SHIPSTATION — connect test, warehouse, store -> client
// map, requested-service -> carrier/service map, Sync now, last sync, review
// queue (unmapped stores, unmatched SKUs, cancel conflicts). Every count comes
// from the API; this file renders and posts.
// =============================================================================

const _ssi = { cfg: null, stores: [], svc: [], runs: [], review: [], carriers: [], services: {} };

async function ssiMount(){
  const host = document.getElementById('ssiBody');
  if(!host) return;
  host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint">ShipStation is the order source. Orders pull every 5 minutes, on ShipStation webhooks, and on Sync now. Labels printed in ShipStation before picking arrive as pre-labeled packages; the WMS ship gate still decides when an order is shipped.</div>
      <div class="sp-toolbar-actions">
        <button type="button" class="ui-btn js-ssi-test">Connect test</button>
        <button type="button" class="ui-btn ui-btn-primary js-ssi-sync">Sync now</button>
      </div>
    </div>
    <div class="mg-status" id="ssiStatus"></div>
    <div class="ui-field-row">
      <div class="ui-field"><label class="ui-label">Connection</label><div id="ssiConn" class="ui-muted">…</div></div>
      <div class="ui-field"><label class="ui-label">Writes to ShipStation</label><div id="ssiWrites" class="ui-muted">…</div></div>
      <div class="ui-field"><label class="ui-label">Last sync</label><div id="ssiLast" class="ui-muted">…</div></div>
    </div>
    <div class="ui-label">Stores → WMS client</div>
    <div id="ssiStores"></div>
    <div class="ui-label">Requested service → carrier / service</div>
    <div id="ssiSvc"></div>
    <div class="ui-label">Review queue</div>
    <div id="ssiReview"></div>
    <div class="ui-label">Recent syncs</div>
    <div id="ssiRuns"></div>`;
  host.querySelector('.js-ssi-test').addEventListener('click', uiBusyHandler(ssiTest));
  host.querySelector('.js-ssi-sync').addEventListener('click', uiBusyHandler(ssiSync));
  await ssiLoad();
}

function ssiStatus(msg, tone){
  const el = document.getElementById('ssiStatus');
  if(el) el.innerHTML = msg ? `<div class="ui-banner ui-banner-${tone || 'info'}">${esc(msg)}</div>` : '';
}
async function ssiFetch(method, p, body){
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: body == null ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

async function ssiLoad(){
  const [cfg, stores, svc, runs, review] = await Promise.all([ssiFetch('GET', '/shipstation/config'), ssiFetch('GET', '/shipstation/stores'), ssiFetch('GET', '/shipstation/service-map'), ssiFetch('GET', '/shipstation/runs'), ssiFetch('GET', '/shipstation/review')]);
  _ssi.cfg = cfg.d; _ssi.stores = stores.d.rows || []; _ssi.svc = svc.d.rows || []; _ssi.runs = runs.d.rows || []; _ssi.review = review.d.rows || [];
  const conn = document.getElementById('ssiConn');
  if(!cfg.ok){ conn.innerHTML = uiError(cfg.d.error || 'Could not load'); return; }
  const c = cfg.d;
  conn.innerHTML = `${c.configured ? uiChip('ACTIVE', 'CONFIGURED') : uiChip('FAILED', 'NOT CONFIGURED')} ${c.config ? uiChip(c.config.active ? 'ACTIVE' : 'FAILED', c.config.active ? 'SYNCING THIS WAREHOUSE' : 'PAUSED') : `<button type="button" class="ui-btn js-ssi-connect">Sync into this warehouse</button>`}
    <div class="ui-hint">${esc(c.summary || '')}${c.missing && c.missing.length ? ' — set ' + esc(c.missing.join(', ')) + ' in Railway' : ''} · poll every ${esc(c.pollMinutes)} min</div>`;
  const cb = conn.querySelector('.js-ssi-connect'); if(cb) cb.addEventListener('click', uiBusyHandler(async () => { const r = await ssiFetch('PUT', '/shipstation/config', {}); if(!r.ok) return uiToast(r.d.error || 'Could not connect', 'error'); uiToast('ShipStation will sync into this warehouse', 'success'); ssiLoad(); }));
  ssiRenderWrites(c);
  const last = _ssi.runs[0];
  document.getElementById('ssiLast').innerHTML = last
    ? `${uiChip(last.status === 'ok' ? 'ACTIVE' : last.status === 'failed' ? 'FAILED' : 'DRAFT', last.status.toUpperCase())} <span class="ui-muted">${esc(String(last.started_at || '').slice(0, 16).replace('T', ' '))} · ${esc(last.trigger)}</span>
       ${last.counts ? `<div class="ui-hint">seen ${esc(last.counts.ordersSeen ?? 0)} · created ${esc(last.counts.created ?? 0)} · updated ${esc(last.counts.updated ?? 0)} · pre-labeled ${esc(last.counts.preLabeled ?? 0)} · waves ${esc(last.counts.waves ?? 0)} · allocated ${esc(last.counts.allocated ?? 0)}${last.counts.errors ? ` · <span class="ui-err-text">errors ${esc(last.counts.errors)}</span>` : ''}</div>` : ''}${last.error ? `<div class="ui-err-text">${esc(last.error)}</div>` : ''}`
    : '<span class="ui-muted">never</span>';
  ssiRenderStores(); ssiRenderSvc(); ssiRenderReview(); ssiRenderRuns();
}

// Write lock: while OFF nothing non-GET (labels, voids, webhook subscriptions) reaches ShipStation.
function ssiRenderWrites(c){
  const el = document.getElementById('ssiWrites');
  if(!el) return;
  if(!c.config){ el.innerHTML = '<span class="ui-muted">Connect a warehouse first</span>'; return; }
  const on = c.writesEnabled === true;
  el.innerHTML = `${on ? uiChip('BACKORDERED', 'WRITES ENABLED') : uiChip('DRAFT', 'WRITE LOCK ON')}
    <button type="button" class="ui-btn js-ssi-writes">${on ? 'Lock writes' : 'Enable writes'}</button>
    <div class="ui-hint">${on ? 'Labels, voids and webhook subscriptions are sent to ShipStation.' : 'Read-only: orders and labels sync in, but no label, void or webhook subscription is sent. Pack & Ship shows why.'}</div>`;
  el.querySelector('.js-ssi-writes').addEventListener('click', uiBusyHandler(async () => {
    const ok = await uiConfirm({
      title: on ? 'Turn the ShipStation write lock on?' : 'Enable writes to ShipStation?',
      body: on ? '<p>Pack &amp; Ship will refuse to create or void labels and no webhook can be subscribed until writes are enabled again.</p>'
               : '<p>Pack &amp; Ship will create real labels (charged to the ShipStation account) and void labels in ShipStation. Make sure store mapping and the service map are right first.</p>',
      confirmLabel: on ? 'Lock writes' : 'Enable writes', danger: !on,
    });
    if(!ok) return;
    const r = await ssiFetch('PUT', '/shipstation/writes', { enabled: !on });
    if(!r.ok) return uiToast(r.d.error || 'Could not change the write lock', 'error');
    uiToast(r.d.writesEnabled ? 'ShipStation writes enabled' : 'ShipStation write lock is on', 'success');
    ssiLoad();
  }));
}

function ssiRenderStores(){
  const clients = (typeof clientsCache !== 'undefined' && clientsCache) ? clientsCache : [];
  const el = document.getElementById('ssiStores');
  if(!_ssi.stores.length){ el.innerHTML = uiEmpty('No stores yet — run Connect test or Sync now.'); return; }
  uiTable(el, {
    columns: [
      { key: 'store_id', label: 'Store', mono: true },
      { key: 'store_name', label: 'Name' },
      { key: 'marketplace', label: 'Marketplace' },
      { key: 'active', label: 'Active', render: r => r.active ? uiChip('ACTIVE', 'ACTIVE') : uiChip('CANCELLED', 'INACTIVE') },
      { key: '_client', label: 'WMS client', render: r => `<select class="ui-input js-ssi-store" data-store="${esc(r.store_id)}"><option value="">— unmapped (queued) —</option>${clients.map(c => `<option value="${esc(c.id)}" ${r.client_id === c.id ? 'selected' : ''}>${esc(c.code)} — ${esc(c.name)}</option>`).join('')}</select>` },
    ], rows: _ssi.stores, rowKey: 'store_id',
  });
  el.querySelectorAll('.js-ssi-store').forEach(sel => sel.addEventListener('change', async () => {
    const r = await ssiFetch('PUT', `/shipstation/stores/${encodeURIComponent(sel.dataset.store)}`, { clientId: sel.value || null });
    if(!r.ok) return uiToast(r.d.error || 'Could not map store', 'error');
    uiToast(`Store ${sel.dataset.store} ${sel.value ? 'mapped' : 'unmapped'}`, 'success');
    ssiLoad();
  }));
}

function ssiRenderSvc(){
  const el = document.getElementById('ssiSvc');
  const clients = (typeof clientsCache !== 'undefined' && clientsCache) ? clientsCache : [];
  const rows = _ssi.svc;
  el.innerHTML = `<div id="ssiSvcTable"></div>
    <div class="sp-toolbar-actions"><button type="button" class="ui-btn js-ssi-svc-add">Add mapping</button></div>`;
  if(rows.length) uiTable(el.querySelector('#ssiSvcTable'), {
    columns: [
      { key: 'client_code', label: 'Client', render: r => esc(r.client_code || 'all clients') },
      { key: 'requested_service', label: 'Requested service', render: r => r.requested_service === '*' ? '<span class="ui-muted">any</span>' : esc(r.requested_service) },
      { key: 'carrier_code', label: 'Carrier', mono: true },
      { key: 'service_code', label: 'Service', mono: true },
      { key: 'package_code', label: 'Package', mono: true },
      { key: '_del', label: '', render: r => `<button type="button" class="ui-btn js-ssi-svc-del" data-id="${esc(r.id)}">Remove</button>` },
    ], rows, rowKey: 'id',
  });
  else el.querySelector('#ssiSvcTable').innerHTML = uiEmpty('No mappings. Label-at-pack clients need one per requested service, or a "*" catch-all.');
  el.querySelectorAll('.js-ssi-svc-del').forEach(b => b.addEventListener('click', uiBusyHandler(async () => { const r = await ssiFetch('DELETE', `/shipstation/service-map/${b.dataset.id}`); if(!r.ok) return uiToast(r.d.error || 'Could not remove', 'error'); uiToast('Mapping removed', 'success'); ssiLoad(); })));
  el.querySelector('.js-ssi-svc-add').addEventListener('click', uiBusyHandler(async () => {
    if(!_ssi.carriers.length){ const c = await ssiFetch('GET', '/shipstation/carriers'); _ssi.carriers = c.ok ? (c.d.rows || []) : []; }
    const m = uiModal({
      title: 'Map a requested service',
      body: `${uiFieldSelect({ id: 'ssiSvcClient', label: 'Client', options: [{ value: '', label: 'All clients (default)' }, ...clients.map(c => ({ value: c.id, label: `${c.code} — ${c.name}` }))] })}
             ${uiField({ id: 'ssiSvcReq', label: 'Requested service (as ShipStation sends it, or * for any)', value: '' })}
             ${uiFieldSelect({ id: 'ssiSvcCarrier', label: 'Carrier', options: [{ value: '', label: '— pick —' }, ..._ssi.carriers.map(c => ({ value: c.code, label: `${c.name} (${c.code})` }))] })}
             ${uiFieldSelect({ id: 'ssiSvcService', label: 'Service', options: [{ value: '', label: 'pick a carrier first' }] })}
             ${uiField({ id: 'ssiSvcPkg', label: 'Package code', value: 'package' })}`,
      actions: [{ label: 'Cancel' }, { label: 'Save mapping', primary: true, onClick: async (api) => {
        const v = (id) => api.el.querySelector('#' + id).value;
        const r = await ssiFetch('POST', '/shipstation/service-map', { clientId: v('ssiSvcClient') || null, requestedService: v('ssiSvcReq'), carrierCode: v('ssiSvcCarrier'), serviceCode: v('ssiSvcService'), packageCode: v('ssiSvcPkg') });
        if(!r.ok){ uiToast(r.d.error || 'Could not save', 'error'); return false; }
        uiToast('Mapping saved', 'success'); ssiLoad();
      } }],
    });
    m.el.querySelector('#ssiSvcCarrier').addEventListener('change', async (e) => {
      const code = e.target.value; const sel = m.el.querySelector('#ssiSvcService');
      if(!code){ sel.innerHTML = '<option value="">pick a carrier first</option>'; return; }
      if(!_ssi.services[code]){ const s = await ssiFetch('GET', `/shipstation/carriers/${encodeURIComponent(code)}/services`); _ssi.services[code] = s.ok ? (s.d.rows || []) : []; }
      sel.innerHTML = _ssi.services[code].map(s => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('') || '<option value="">no services</option>';
    });
  }));
}

function ssiRenderReview(){
  const el = document.getElementById('ssiReview');
  if(!_ssi.review.length){ el.innerHTML = uiEmpty('Nothing to review.'); return; }
  const label = { unmapped_store: 'Unmapped store', unmatched_sku: 'SKU not in item master', cancel_conflict: 'Cancelled after picking started', changed_after_pick: 'Changed after picking / sync error', label_attach_failed: 'Label could not be attached' };
  uiTable(el, {
    columns: [
      { key: 'kind', label: 'Kind', render: r => uiChip(r.kind === 'unmapped_store' ? 'DRAFT' : r.kind === 'unmatched_sku' ? 'BACKORDERED' : 'FAILED', label[r.kind] || r.kind) },
      { key: '_what', label: 'What', render: r => esc(r.kind === 'unmapped_store' ? `store ${r.detail.storeId} ${r.detail.storeName || ''} (e.g. ${r.detail.orderNumber || ''})` : r.kind === 'unmatched_sku' ? `${r.detail.sku || '(no sku)'} — ${r.detail.name || ''}` : r.detail.error || r.detail.wmsStatus || '') },
      { key: 'order_number', label: 'Order', mono: true, render: r => esc(r.order_number || r.detail.orderNumber || '') },
      { key: 'created_at', label: 'Since', render: r => esc(String(r.created_at || '').slice(0, 16).replace('T', ' ')) },
      { key: '_res', label: '', render: r => `<button type="button" class="ui-btn js-ssi-resolve" data-id="${esc(r.id)}">Resolved</button>` },
    ], rows: _ssi.review, rowKey: 'id',
  });
  el.querySelectorAll('.js-ssi-resolve').forEach(b => b.addEventListener('click', uiBusyHandler(async () => { const r = await ssiFetch('POST', `/shipstation/review/${b.dataset.id}/resolve`); if(!r.ok) return uiToast(r.d.error || 'Could not resolve', 'error'); uiToast('Marked resolved', 'success'); ssiLoad(); })));
}

function ssiRenderRuns(){
  const el = document.getElementById('ssiRuns');
  if(!_ssi.runs.length){ el.innerHTML = uiEmpty('No syncs yet.'); return; }
  uiTable(el, {
    columns: [
      { key: 'started_at', label: 'Started', render: r => esc(String(r.started_at || '').slice(0, 16).replace('T', ' ')) },
      { key: 'trigger', label: 'Trigger' },
      { key: 'status', label: 'Status', render: r => uiChip(r.status === 'ok' ? 'ACTIVE' : r.status === 'failed' ? 'FAILED' : 'DRAFT', r.status.toUpperCase()) },
      { key: '_c', label: 'Created / updated / pre-labeled / flagged', render: r => esc(r.counts ? `${r.counts.created ?? 0} / ${r.counts.updated ?? 0} / ${r.counts.preLabeled ?? 0} / ${r.counts.flagged ?? 0}` : '') },
      { key: 'error', label: 'Error', render: r => esc(r.error || '') },
    ], rows: _ssi.runs, rowKey: 'id',
  });
}

async function ssiTest(){
  ssiStatus('Testing connection…');
  const r = await ssiFetch('POST', '/shipstation/test');
  if(!r.ok){ ssiStatus((r.d.error || 'Connection failed') + (r.d.config ? ' | ' + r.d.config : ''), 'danger'); return; }
  ssiStatus(`Connected — ${r.d.stores} store(s) visible (${r.d.ms} ms)`, 'info');
  uiToast('ShipStation reachable', 'success');
  await ssiFetch('POST', '/shipstation/stores/refresh');
  ssiLoad();
}
async function ssiSync(){
  ssiStatus('Syncing…');
  const r = await ssiFetch('POST', '/shipstation/sync');
  if(!r.ok){ ssiStatus(r.d.error || 'Sync failed', 'danger'); uiToast(r.d.error || 'Sync failed', 'error'); return; }
  const c = r.d.counts || {};
  ssiStatus(`Synced — ${c.ordersSeen ?? 0} seen · ${c.created ?? 0} created · ${c.updated ?? 0} updated · ${c.preLabeled ?? 0} pre-labeled package(s) · ${c.waves ?? 0} wave(s) · ${c.allocated ?? 0} allocated${c.unmappedStore ? ` · ${c.unmappedStore} from unmapped stores` : ''}${c.flagged ? ` · ${c.flagged} need SKU mapping` : ''}${c.errors ? ` · ${c.errors} error(s)` : ''}`, c.errors ? 'warn' : 'info');
  uiToast('Sync complete', 'success');
  ssiLoad();
}
