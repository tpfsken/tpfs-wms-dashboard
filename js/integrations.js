'use strict';
// =============================================================================
// SETTINGS > INTEGRATIONS — the connector catalog. Available adapters (live
// and coming soon), connected instances with status / last run / errors /
// Sync now / write lock / mappings / run log, and the event outbox. Every
// row comes from the API (src/integrations/routes.js); this file renders and
// posts. The ShipStation instance opens the existing ShipStation panel
// (js/shipstation.js ssiMount) inside the generic instance view — same routes,
// same behaviour.
//   integrations.sync    -> see the catalog, instances, runs, events; Sync now
//   integrations.manage  -> connect, edit, lock / unlock, mappings, disconnect
// =============================================================================

const _ig = { adapters: [], rows: [], events: [], open: null, secretsConfigured: true };

async function igFetch(method, p, body){
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: body == null ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok && d.code === 'PERMISSION_DENIED' && typeof permDeniedToast === 'function') permDeniedToast(d);
  return { ok: r.ok, status: r.status, d };
}
const igWhen = (v) => v ? esc(String(v).slice(0, 16).replace('T', ' ')) : '<span class="ui-muted">never</span>';
const igStatusChip = (s) => s === 'ok' ? uiChip('ACTIVE', 'OK') : s === 'failed' ? uiChip('FAILED', 'FAILED') : s === 'skipped' ? uiChip('DRAFT', 'SKIPPED') : uiChip('DRAFT', String(s || '').toUpperCase());
const igCat = { channel: 'Sales channel', shipping: 'Shipping', edi: 'EDI', erp: 'Accounting / ERP', generic: 'Generic' };

async function integrationsMount(){
  const host = document.getElementById('integrationsBody');
  if(!host) return;
  host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint">Connected systems pull orders in and push shipments and inventory out through one worker. Every connector starts write-locked: nothing leaves the WMS until an admin enables writes.</div>
      <div class="sp-toolbar-actions">
        <button type="button" class="ui-btn js-ig-refresh">Refresh</button>
        <button type="button" class="ui-btn ui-btn-primary js-ig-connect" data-perm="integrations.manage">Connect an integration</button>
      </div>
    </div>
    <div class="mg-status" id="igStatus"></div>
    <div class="ui-label">Connected</div>
    <div id="igInstances"></div>
    <div id="igDetail"></div>
    <div class="ui-label">Available</div>
    <div id="igCatalog"></div>
    <div class="ui-label">Recent events</div>
    <div id="igEvents"></div>`;
  host.querySelector('.js-ig-refresh').addEventListener('click', uiBusyHandler(igLoad));
  host.querySelector('.js-ig-connect').addEventListener('click', uiBusyHandler(igConnectDialog));
  if(typeof applyPermGates === 'function') applyPermGates(host);
  await igLoad();
}

function igStatus(msg, tone){
  const el = document.getElementById('igStatus');
  if(el) el.innerHTML = msg ? `<div class="ui-banner ui-banner-${tone || 'info'}">${esc(msg)}</div>` : '';
}

async function igLoad(){
  const [cat, rows, ev] = await Promise.all([igFetch('GET', '/integrations/catalog'), igFetch('GET', '/integrations/connectors'), igFetch('GET', '/integrations/events')]);
  if(!cat.ok){ document.getElementById('igCatalog').innerHTML = uiError(cat.d.error || 'Could not load the catalog'); return; }
  _ig.adapters = cat.d.adapters || []; _ig.secretsConfigured = cat.d.secretsConfigured !== false;
  _ig.rows = rows.ok ? (rows.d.rows || []) : [];
  _ig.events = ev.ok ? (ev.d.rows || []) : [];
  _ig.worker = ev.ok ? ev.d.worker : null;
  igRenderInstances(); igRenderCatalog(); igRenderEvents();
  if(_ig.open){ const still = _ig.rows.find(r => r.id === _ig.open); if(still) igOpen(_ig.open); else { _ig.open = null; document.getElementById('igDetail').innerHTML = ''; } }
}

function igRenderInstances(){
  const el = document.getElementById('igInstances');
  if(!_ig.rows.length){ el.innerHTML = uiEmpty('Nothing connected yet. Pick an integration from the list below.'); return; }
  uiTable(el, {
    columns: [
      { key: 'name', label: 'Connector', render: r => `<div><strong>${esc(r.name)}</strong></div><div class="ui-hint">${esc(r.adapter.name)} · ${esc(r.clientCode ? `${r.clientCode} — ${r.clientName || ''}` : 'whole warehouse')}</div>` },
      { key: 'enabled', label: 'Status', render: r => `${r.enabled ? uiChip('ACTIVE', 'ENABLED') : uiChip('CANCELLED', 'PAUSED')} ${r.writeLocked ? uiChip('DRAFT', 'WRITE LOCK ON') : uiChip('BACKORDERED', 'WRITES ENABLED')}` },
      { key: 'lastSyncAt', label: 'Last sync', render: r => `${igWhen(r.lastSyncAt)}<div class="ui-hint">every ${esc(r.syncIntervalMin)} min</div>` },
      { key: 'lastRun', label: 'Last run', render: r => r.lastRun ? `${igStatusChip(r.lastRun.status)} <span class="ui-muted">${esc(r.lastRun.kind)} · ${esc(r.lastRun.trigger)}</span>` : '<span class="ui-muted">—</span>' },
      { key: 'lastError', label: 'Error', render: r => r.lastError ? `<span class="ui-err-text">${esc(r.lastError)}</span>` : '' },
      { key: '_a', label: '', render: r => `<button type="button" class="ui-btn js-ig-open" data-id="${esc(r.id)}">${_ig.open === r.id ? 'Close' : 'Open'}</button> ${r.adapter.capabilities.some(c => c === 'pullOrders' || c === 'pullItems') ? `<button type="button" class="ui-btn js-ig-sync" data-id="${esc(r.id)}" data-perm="integrations.sync">Sync now</button>` : ''}` },
    ], rows: _ig.rows, rowKey: 'id',
  });
  el.querySelectorAll('.js-ig-open').forEach(b => b.addEventListener('click', uiBusyHandler(async () => { if(_ig.open === b.dataset.id){ _ig.open = null; document.getElementById('igDetail').innerHTML = ''; igRenderInstances(); } else await igOpen(b.dataset.id); })));
  el.querySelectorAll('.js-ig-sync').forEach(b => b.addEventListener('click', uiBusyHandler(() => igSync(b.dataset.id))));
  if(typeof applyPermGates === 'function') applyPermGates(el);
}

function igRenderCatalog(){
  const el = document.getElementById('igCatalog');
  const connectedKeys = new Set(_ig.rows.map(r => r.adapterKey));
  const rows = _ig.adapters.filter(a => a.key !== 'mock' || _ig.rows.some(r => r.adapterKey === 'mock'));
  uiTable(el, {
    columns: [
      { key: 'name', label: 'Integration', render: a => `<div><strong>${esc(a.name)}</strong></div><div class="ui-hint">${esc(a.description || '')}</div>` },
      { key: 'category', label: 'Kind', render: a => esc(igCat[a.category] || a.category) },
      { key: 'capabilities', label: 'Does', render: a => esc(igCaps(a)) },
      { key: 'status', label: 'Status', render: a => a.status === 'live' ? (connectedKeys.has(a.key) ? uiChip('ACTIVE', 'CONNECTED') : uiChip('BACKORDERED', 'AVAILABLE')) : uiChip('DRAFT', 'COMING SOON') },
      { key: '_a', label: '', render: a => a.status === 'live' && (a.scope !== 'tenant' || !connectedKeys.has(a.key)) ? `<button type="button" class="ui-btn js-ig-connect-one" data-key="${esc(a.key)}" data-perm="integrations.manage">Connect</button>` : '' },
    ], rows, rowKey: 'key',
  });
  el.querySelectorAll('.js-ig-connect-one').forEach(b => b.addEventListener('click', uiBusyHandler(() => igConnectDialog(b.dataset.key))));
  if(typeof applyPermGates === 'function') applyPermGates(el);
}
function igCaps(a){
  const m = { pullOrders: 'orders in', pullCancellations: 'cancellations in', pushShipment: 'shipments out', pushOrderStatus: 'order status out', pushInventory: 'inventory out', pullItems: 'items in', pushItems: 'items out', testConnection: 'connection test' };
  const out = (a.capabilities || []).filter(c => m[c]).map(c => m[c]);
  const maps = (a.capabilities || []).filter(c => c.startsWith('mappings.')).map(c => c.slice(9));
  if(maps.length) out.push(`${maps.join(' / ')} mapping`);
  return out.join(', ') || '—';
}

function igRenderEvents(){
  const el = document.getElementById('igEvents');
  const w = _ig.worker;
  const head = w ? `<div class="ui-hint">Worker: ${esc(w.ticks)} tick(s), last ${igWhen(w.lastTickAt)} · ${esc(w.events)} event(s) drained · ${esc(w.deliveries)} webhook deliveries queued · ${esc(w.pushes)} pushes${w.lastError ? ` · <span class="ui-err-text">${esc(w.lastError)}</span>` : ''}</div>` : '';
  if(!_ig.events.length){ el.innerHTML = head + uiEmpty('No events yet. Orders, receipts, inventory changes and item edits appear here as they happen.'); return; }
  el.innerHTML = head + '<div id="igEventsTable"></div>';
  uiTable(el.querySelector('#igEventsTable'), {
    columns: [
      { key: 'created_at', label: 'When', render: r => igWhen(r.created_at) },
      { key: 'event_type', label: 'Event', mono: true },
      { key: 'client_code', label: 'Client', render: r => esc(r.client_code || '—') },
      { key: 'processed_at', label: 'Processed', render: r => r.processed_at ? uiChip('ACTIVE', 'DONE') : r.error ? uiChip('FAILED', 'ERROR') : uiChip('DRAFT', 'PENDING') },
      { key: 'deliveries', label: 'Webhooks', render: r => esc(r.deliveries) },
      { key: 'error', label: 'Error', render: r => esc(r.error || '') },
    ], rows: _ig.events.slice(0, 30), rowKey: 'id',
  });
}

// ---- one instance ----------------------------------------------------------------------------
async function igOpen(id){
  _ig.open = id;
  igRenderInstances();
  const host = document.getElementById('igDetail');
  host.innerHTML = '<div class="ui-hint">Loading…</div>';
  const [det, runs] = await Promise.all([igFetch('GET', `/integrations/connectors/${id}`), igFetch('GET', `/integrations/connectors/${id}/runs`)]);
  if(!det.ok){ host.innerHTML = uiError(det.d.error || 'Could not load'); return; }
  const r = det.d;
  const canManage = typeof can === 'function' ? can('integrations.manage') : true;
  host.innerHTML = `
    <div class="card" style="margin:12px 0;">
      <div class="card-head"><div class="card-title">${esc(r.name)} <span class="ui-muted">· ${esc(r.adapter.name)}</span></div><div style="flex:1"></div>
        ${canManage ? `<button type="button" class="ui-btn js-ig-lock">${r.writeLocked ? 'Enable writes' : 'Lock writes'}</button>
        <button type="button" class="ui-btn js-ig-toggle">${r.enabled ? 'Pause' : 'Resume'}</button>
        <button type="button" class="ui-btn js-ig-edit">Settings</button>
        <button type="button" class="ui-btn ui-btn-danger js-ig-disconnect">Disconnect</button>` : ''}
        ${r.adapter.capabilities.includes('testConnection') && canManage ? '<button type="button" class="ui-btn js-ig-test">Connection test</button>' : ''}
      </div>
      <div class="sp-host">
        ${uiMeta([
          { k: 'Scope', v: esc(r.clientCode ? `${r.clientCode} — ${r.clientName || ''}` : 'whole warehouse') },
          { k: 'Writes', v: r.writeLocked ? `${uiChip('DRAFT', 'WRITE LOCK ON')} <span class="ui-hint">Read-only: nothing is pushed to ${esc(r.adapter.name)}.</span>` : `${uiChip('BACKORDERED', 'WRITES ENABLED')} <span class="ui-hint">Shipments, status and inventory changes are pushed.</span>` },
          { k: 'Sync', v: `${r.enabled ? 'every ' + esc(r.syncIntervalMin) + ' min' : 'paused'} · last ${igWhen(r.lastSyncAt)}` },
          { k: 'Credentials', v: r.adapter.auth.fields.length ? (r.hasCredentials ? 'stored (encrypted)' : '<span class="ui-err-text">missing</span>') : esc(r.adapter.auth.note || 'from the server environment') },
          ...(r.status ? [{ k: 'Connection', v: r.status.error ? `<span class="ui-err-text">${esc(r.status.error)}</span>` : r.status.configured === false ? `<span class="ui-err-text">not configured — ${esc((r.status.missing || []).join(', '))}</span>` : esc(r.status.summary || r.status.detail || 'ok') }] : []),
          ...(r.lastError ? [{ k: 'Last error', v: `<span class="ui-err-text">${esc(r.lastError)}</span>` }] : []),
        ])}
        <div id="igMappings"></div>
        <div id="igAdapterPanel"></div>
        <div class="ui-label">Run log</div>
        <div id="igRuns"></div>
      </div>
    </div>`;
  host.querySelector('.js-ig-lock')?.addEventListener('click', uiBusyHandler(() => igLock(r)));
  host.querySelector('.js-ig-toggle')?.addEventListener('click', uiBusyHandler(async () => { const x = await igFetch('PUT', `/integrations/connectors/${r.id}`, { enabled: !r.enabled }); if(!x.ok) return uiToast(x.d.error || 'Could not change', 'error'); uiToast(r.enabled ? 'Paused' : 'Resumed', 'success'); igLoad(); }));
  host.querySelector('.js-ig-edit')?.addEventListener('click', uiBusyHandler(() => igEditDialog(r)));
  host.querySelector('.js-ig-test')?.addEventListener('click', uiBusyHandler(async () => { igStatus('Testing connection…'); const x = await igFetch('POST', `/integrations/connectors/${r.id}/test`); if(!x.ok){ igStatus(x.d.error || 'Connection failed', 'danger'); return; } igStatus(`Connected — ${x.d.detail || 'ok'}`, 'info'); uiToast(`${r.adapter.name} reachable`, 'success'); igOpen(r.id); }));
  host.querySelector('.js-ig-disconnect')?.addEventListener('click', uiBusyHandler(async () => {
    const ok = await uiConfirm({ title: `Disconnect ${r.name}?`, body: '<p>Mappings and the run log for this connector are removed. Orders it already created stay.</p>', confirmLabel: 'Disconnect', danger: true });
    if(!ok) return;
    const x = await igFetch('DELETE', `/integrations/connectors/${r.id}`); if(!x.ok) return uiToast(x.d.error || 'Could not disconnect', 'error');
    uiToast('Disconnected', 'success'); _ig.open = null; host.innerHTML = ''; igLoad();
  }));
  igRenderRuns(runs.ok ? runs.d.rows : []);
  igRenderMappings(r);
  // adapter-specific panel: ShipStation keeps its own card (stores, service map, review queue, observed weights)
  const panel = host.querySelector('#igAdapterPanel');
  if(r.adapterKey === 'shipstation' && typeof ssiMount === 'function'){
    panel.innerHTML = '<div class="ui-label">ShipStation</div><div id="ssiBody" class="sp-host"></div>';
    ssiMount();
  }
}
function igRenderRuns(rows){
  const el = document.getElementById('igRuns');
  if(!el) return;
  if(!rows.length){ el.innerHTML = uiEmpty('No runs yet.'); return; }
  uiTable(el, {
    columns: [
      { key: 'started_at', label: 'Started', render: r => igWhen(r.started_at) },
      { key: 'kind', label: 'Kind', mono: true },
      { key: 'trigger', label: 'Trigger' },
      { key: 'status', label: 'Status', render: r => igStatusChip(r.status) },
      { key: 'counts', label: 'Counts', render: r => esc(igCounts(r.counts)) },
      { key: 'error', label: 'Error', render: r => esc(r.error || '') },
    ], rows, rowKey: 'id',
  });
}
function igCounts(c){
  if(!c || typeof c !== 'object') return '';
  return Object.entries(c).filter(([k, v]) => ['number', 'string', 'boolean'].includes(typeof v) && k !== 'shipstationRunId').slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' · ');
}
async function igRenderMappings(r){
  const el = document.getElementById('igMappings');
  const kinds = r.mappingKinds || [];
  if(!el || !kinds.length || r.adapterKey === 'shipstation') { if(el) el.innerHTML = ''; return; }   // ShipStation's maps live in its own panel
  el.innerHTML = kinds.map(k => `<div class="ui-label">${esc(k === 'sku' ? 'Item mapping' : k === 'store' ? 'Store → client' : k === 'carrier' ? 'Carrier mapping' : 'Service mapping')}</div><div id="igMap-${esc(k)}"></div>`).join('');
  for(const k of kinds){
    const host = el.querySelector(`#igMap-${k}`);
    const m = await igFetch('GET', `/integrations/connectors/${r.id}/mappings/${k}`);
    const rows = m.ok ? m.d.rows : [];
    host.innerHTML = `<div id="igMapT-${esc(k)}"></div><div class="sp-toolbar-actions"><button type="button" class="ui-btn js-ig-map-add" data-perm="integrations.manage">Add mapping</button></div>`;
    if(rows.length) uiTable(host.querySelector(`#igMapT-${k}`), {
      columns: [
        { key: 'external_value', label: `${esc(r.adapter.name)} value`, mono: true },
        { key: 'external_label', label: 'Label', render: x => esc(x.external_label && x.external_label !== x.external_value ? x.external_label : '') },
        { key: 'internal_label', label: 'WMS', render: x => esc(x.internal_label || x.internal_value || '— unmapped —') },
        { key: '_d', label: '', render: x => `<button type="button" class="ui-btn js-ig-map-del" data-id="${esc(x.id)}" data-perm="integrations.manage">Remove</button>` },
      ], rows, rowKey: 'id',
    });
    else host.querySelector(`#igMapT-${k}`).innerHTML = uiEmpty(k === 'sku' ? 'No item mappings. Items are matched by their identifiers first; add a mapping only for a code that cannot be an identifier.' : 'No mappings yet.');
    host.querySelectorAll('.js-ig-map-del').forEach(b => b.addEventListener('click', uiBusyHandler(async () => { const x = await igFetch('DELETE', `/integrations/connectors/${r.id}/mappings/${k}/${b.dataset.id}`); if(!x.ok) return uiToast(x.d.error || 'Could not remove', 'error'); uiToast('Mapping removed', 'success'); igRenderMappings(r); })));
    host.querySelector('.js-ig-map-add').addEventListener('click', uiBusyHandler(() => igMappingDialog(r, k)));
    if(typeof applyPermGates === 'function') applyPermGates(host);
  }
}
function igMappingDialog(r, kind){
  const clients = (typeof clientsCache !== 'undefined' && clientsCache) ? clientsCache : [];
  const m = uiModal({
    title: `Map a ${kind === 'sku' ? 'item' : kind} value`,
    body: `${uiField({ id: 'igMapExt', label: `${r.adapter.name} value`, value: '' })}
           ${uiField({ id: 'igMapLabel', label: 'Label (optional)', value: '' })}
           ${kind === 'store' ? uiFieldSelect({ id: 'igMapInt', label: 'WMS client', options: [{ value: '', label: '— unmapped —' }, ...clients.map(c => ({ value: c.id, label: `${c.code} — ${c.name}` }))] })
             : kind === 'sku' ? uiField({ id: 'igMapInt', label: 'WMS item id', value: '', hint: 'Paste the item id from the item master (the SKU code alone is matched automatically).' })
             : uiField({ id: 'igMapVal', label: 'WMS carrier / service code', value: '' })}`,
    actions: [{ label: 'Cancel' }, { label: 'Save mapping', primary: true, onClick: async (api) => {
      const v = (id) => { const e = api.el.querySelector('#' + id); return e ? e.value.trim() : ''; };
      const x = await igFetch('PUT', `/integrations/connectors/${r.id}/mappings/${kind}`, { externalValue: v('igMapExt'), label: v('igMapLabel') || undefined, internalId: v('igMapInt') || undefined, internalValue: v('igMapVal') || undefined });
      if(!x.ok){ uiToast(x.d.error || 'Could not save', 'error'); return false; }
      uiToast('Mapping saved', 'success'); igRenderMappings(r);
    } }],
  });
  return m;
}

async function igSync(id){
  igStatus('Syncing…');
  const x = await igFetch('POST', `/integrations/connectors/${id}/sync`);
  if(!x.ok){ igStatus(x.d.error || 'Sync failed', 'danger'); uiToast(x.d.error || 'Sync failed', 'error'); return; }
  igStatus(`Synced — ${igCounts(x.d.counts) || 'nothing to do'}`, 'info');
  uiToast('Sync complete', 'success');
  igLoad();
}
async function igLock(r){
  const locking = !r.writeLocked;
  const ok = await uiConfirm({
    title: locking ? `Lock writes to ${r.adapter.name}?` : `Enable writes to ${r.adapter.name}?`,
    body: locking ? '<p>Nothing is pushed until writes are enabled again. Pulls keep running.</p>' : `<p>Shipments, order status and inventory changes are sent to ${esc(r.adapter.name)} from now on. Check the mappings first.</p>`,
    confirmLabel: locking ? 'Lock writes' : 'Enable writes', danger: !locking,
  });
  if(!ok) return;
  const x = await igFetch('PUT', `/integrations/connectors/${r.id}/lock`, { locked: locking });
  if(!x.ok) return uiToast(x.d.error || 'Could not change the write lock', 'error');
  uiToast(locking ? 'Write lock on' : 'Writes enabled', 'success');
  igLoad();
}

// ---- connect / edit -----------------------------------------------------------------------------
function igCredentialFields(a, prefix){
  return (a.auth.fields || []).map(f => uiField({ id: `${prefix}${f.key}`, label: f.label + (f.required === false ? '' : ' *'), type: f.secret ? 'password' : 'text', placeholder: f.placeholder || '' })).join('')
    + (a.auth.note ? `<div class="ui-hint">${esc(a.auth.note)}</div>` : '');
}
function igSettingsFields(a, prefix, current){
  return (a.settingsFields || []).map(f => f.type === 'boolean'
    ? `<label class="ui-label"><input type="checkbox" id="${prefix}${f.key}" ${current && current[f.key] ? 'checked' : ''}> ${esc(f.label)}</label>`
    : uiField({ id: `${prefix}${f.key}`, label: f.label, value: current && current[f.key] != null ? String(current[f.key]) : '' })).join('');
}
function igConnectDialog(adapterKey){
  const live = _ig.adapters.filter(a => a.status === 'live' && a.key !== 'mock');
  if(!_ig.secretsConfigured) return uiToast('Secret storage is not configured on the server (INTEGRATIONS_KEY) — credentials cannot be saved yet', 'error');
  const clients = (typeof clientsCache !== 'undefined' && clientsCache) ? clientsCache : [];
  const m = uiModal({
    title: 'Connect an integration',
    width: 560,
    body: `${uiFieldSelect({ id: 'igcAdapter', label: 'Integration', options: live.map(a => ({ value: a.key, label: `${a.name} — ${igCat[a.category] || a.category}` })), value: adapterKey || (live[0] && live[0].key) || '' })}
           <div id="igcScope"></div>
           ${uiField({ id: 'igcName', label: 'Name (optional)', value: '' })}
           <div id="igcCreds"></div>
           <div id="igcSettings"></div>
           ${uiField({ id: 'igcInterval', label: 'Sync every (minutes)', value: '' })}
           <div class="ui-hint">The connector starts write-locked. Enable writes from its panel once the mappings look right.</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Connect', primary: true, onClick: async (api) => {
      const a = _ig.adapters.find(x => x.key === api.el.querySelector('#igcAdapter').value);
      const v = (id) => { const e = api.el.querySelector('#' + id); return e ? (e.type === 'checkbox' ? e.checked : e.value.trim()) : ''; };
      const credentials = {}; for(const f of a.auth.fields || []) credentials[f.key] = v('igcC_' + f.key);
      const settings = {}; for(const f of a.settingsFields || []) settings[f.key] = v('igcS_' + f.key);
      const body = { adapterKey: a.key, name: v('igcName') || undefined, clientId: v('igcClient') || undefined, credentials: (a.auth.fields || []).length ? credentials : undefined, settings, syncIntervalMin: v('igcInterval') ? Number(v('igcInterval')) : undefined };
      const x = await igFetch('POST', '/integrations/connectors', body);
      if(!x.ok){ uiToast(x.d.error || 'Could not connect', 'error'); return false; }
      uiToast(`${a.name} connected`, 'success'); _ig.open = x.d.id; igLoad();
    } }],
  });
  const paint = () => {
    const a = _ig.adapters.find(x => x.key === m.el.querySelector('#igcAdapter').value);
    if(!a) return;
    m.el.querySelector('#igcScope').innerHTML = a.scope === 'tenant' ? '<div class="ui-hint">Connected once for the whole warehouse.</div>' : uiFieldSelect({ id: 'igcClient', label: 'Client *', options: [{ value: '', label: '— pick —' }, ...clients.map(c => ({ value: c.id, label: `${c.code} — ${c.name}` }))] });
    m.el.querySelector('#igcCreds').innerHTML = igCredentialFields(a, 'igcC_');
    m.el.querySelector('#igcSettings').innerHTML = igSettingsFields(a, 'igcS_', {});
    m.el.querySelector('#igcInterval').value = String(a.defaultIntervalMin || 5);
  };
  m.el.querySelector('#igcAdapter').addEventListener('change', paint);
  paint();
  return m;
}
function igEditDialog(r){
  const a = r.adapter;
  const m = uiModal({
    title: `${r.name} — settings`,
    width: 560,
    body: `${uiField({ id: 'igeName', label: 'Name', value: r.name })}
           ${uiField({ id: 'igeInterval', label: 'Sync every (minutes)', value: String(r.syncIntervalMin) })}
           ${igSettingsFields(a, 'igeS_', r.settings)}
           ${(a.auth.fields || []).length ? `<div class="ui-label">Replace credentials (leave blank to keep)</div>${igCredentialFields(a, 'igeC_')}` : ''}`,
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async (api) => {
      const v = (id) => { const e = api.el.querySelector('#' + id); return e ? (e.type === 'checkbox' ? e.checked : e.value.trim()) : ''; };
      const body = { name: v('igeName'), syncIntervalMin: Number(v('igeInterval')) };
      const settings = {}; for(const f of a.settingsFields || []) settings[f.key] = v('igeS_' + f.key); if(Object.keys(settings).length) body.settings = settings;
      const creds = {}; let any = false; for(const f of a.auth.fields || []){ const val = v('igeC_' + f.key); if(val){ creds[f.key] = val; any = true; } } if(any) body.credentials = creds;
      const x = await igFetch('PUT', `/integrations/connectors/${r.id}`, body);
      if(!x.ok){ uiToast(x.d.error || 'Could not save', 'error'); return false; }
      uiToast('Saved', 'success'); igLoad();
    } }],
  });
  return m;
}
