'use strict';
// =============================================================================
// INTEGRATIONS (client-facing) + the shared CHANNEL PANEL — one renderer, two hosts:
//   Portal home → "Integrations" page   (client admins; entitlement portal.integrations,
//                                        connect / map / disconnect need portal.integrations.manage;
//                                        routes /portal/integrations/...)
//   Settings → Integrations → instance  (ops; js/integrations.js igOpen embeds piOpsPanel;
//                                        routes /integrations/connectors/:id/...)
// The panel shows, for a connected store / channel / SFTP drop: status, last sync,
// orders pulled today, held orders, errors, unmatched SKUs with "Create item" /
// "Link to existing", the shipping-method map, adapter details (Shopify store +
// webhooks; SFTP account, host, folder layout, CSV column mapping, password
// rotation), the recent orders in, and the run log. Everything comes from the API.
// =============================================================================

const _pi = { mode: null, host: null, adapters: [], rows: [], open: null, sftpHost: null, shopifyConfigured: false };

function piBase(id){ return _pi.mode === 'portal' ? `/portal/integrations${id ? '/' + id : ''}` : `/integrations/connectors${id ? '/' + id : ''}`; }
async function piFetch(method, p, body){
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: body == null ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok && d.code === 'PERMISSION_DENIED' && typeof permDeniedToast === 'function') permDeniedToast(d);
  return { ok: r.ok, status: r.status, d };
}
const piWhen = (v) => v ? esc(String(v).slice(0, 16).replace('T', ' ')) : '<span class="ui-muted">never</span>';
const piManagePerm = () => _pi.mode === 'portal' ? 'portal.integrations.manage' : 'integrations.manage';
const piCanManage = () => typeof can === 'function' ? can(piManagePerm()) : true;
const PI_CAT = { channel: 'Sales channel', shipping: 'Shipping', edi: 'EDI', erp: 'Accounting / ERP', generic: 'Files' };
const PI_KINDS = { items: 'Items', orders: 'Orders', receipts: 'Expected receipts' };

/** Leaves the app for Shopify's authorize screen (a function so headless checks can stub it). */
function piNavigate(url){ window.location.assign(url); }

/** Portal: the Integrations page. */
function loadPortalIntegrationsPage(){
  piMount({ mode: 'portal', hostId: 'portalIntegrationsBody' });
}

async function piMount({ mode, hostId }){
  const host = document.getElementById(hostId);
  if(!host) return;
  _pi.mode = mode; _pi.host = host;
  host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint">Connect your store, marketplace or file drop. Orders come in automatically, and shipments and stock levels go back. Items are matched by SKU or barcode; anything that cannot be matched waits here for you.</div>
      <div class="sp-toolbar-actions"><button type="button" class="ui-btn js-pi-refresh">Refresh</button></div>
    </div>
    <div id="piStatus"></div>
    <div class="ui-label">Connected</div>
    <div id="piRows"></div>
    <div id="piDetail"></div>
    <div class="ui-label">Available to connect</div>
    <div id="piCatalog"></div>`;
  host.querySelector('.js-pi-refresh').addEventListener('click', uiBusyHandler(piLoad));
  await piLoad();
  piHandleReturn();
}

/** Back from Shopify's install screen: /?integrations=shopify&connected=1&shop=…&id=… or &error=… */
function piHandleReturn(){
  let q; try { q = new URLSearchParams(location.search); } catch(_) { return; }
  if(q.get('integrations') !== 'shopify') return;
  if(q.get('connected') === '1'){ uiToast(`Shopify store ${q.get('shop') || ''} connected`, 'success'); if(q.get('id')) piOpen(q.get('id')); }
  else if(q.get('error')) uiToast(`Shopify: ${q.get('error')}`, 'error', 9000);
  try { history.replaceState(null, '', location.pathname); } catch(_) {}
}

async function piLoad(){
  const r = await piFetch('GET', '/portal/integrations');
  const rowsEl = _pi.host.querySelector('#piRows');
  if(!r.ok){ rowsEl.innerHTML = uiError(r.d.error || 'Could not load integrations'); _pi.host.querySelector('#piCatalog').innerHTML = ''; return; }
  _pi.adapters = r.d.adapters || []; _pi.rows = r.d.rows || []; _pi.sftpHost = r.d.sftpHost || null; _pi.shopifyConfigured = !!r.d.shopifyConfigured;
  piRenderRows(); piRenderCatalog();
  if(_pi.open){ if(_pi.rows.find(x => x.id === _pi.open)) piOpen(_pi.open); else { _pi.open = null; _pi.host.querySelector('#piDetail').innerHTML = ''; } }
}

function piStatusChip(r){
  if(!r.enabled) return uiChip('CANCELLED', r.lastError && /uninstalled/i.test(r.lastError) ? 'UNINSTALLED' : 'PAUSED');
  if(r.lastError || (r.summary && r.summary.failedRuns24h)) return uiChip('BACKORDERED', 'NEEDS ATTENTION');
  return uiChip('ACTIVE', 'CONNECTED');
}
function piRenderRows(){
  const el = _pi.host.querySelector('#piRows');
  if(!_pi.rows.length){ el.innerHTML = uiEmpty('Nothing connected yet — pick one below.'); return; }
  uiTable(el, {
    columns: [
      { key: 'name', label: 'Integration', render: x => `<div><strong>${esc(x.name)}</strong></div><div class="ui-hint">${esc(x.adapter.name)}${x.settings && x.settings.shop ? ' · ' + esc(x.settings.shop) : ''}</div>` },
      { key: 'status', label: 'Status', render: x => piStatusChip(x) },
      { key: 'lastSyncAt', label: 'Last sync', render: x => piWhen(x.lastSyncAt) },
      { key: 'today', label: 'Orders today', render: x => uiNum(x.summary ? x.summary.ordersToday : 0) },
      { key: 'held', label: 'Waiting on items', render: x => x.summary && x.summary.unmatched ? `<span class="ui-err-text">${esc(x.summary.unmatched)} SKU${x.summary.unmatched === 1 ? '' : 's'} · ${esc(x.summary.held)} order${x.summary.held === 1 ? '' : 's'}</span>` : '<span class="ui-muted">none</span>' },
      { key: 'errors', label: 'Errors (24h)', render: x => x.summary && x.summary.failedRuns24h ? `<span class="ui-err-text">${esc(x.summary.failedRuns24h)}</span>` : '<span class="ui-muted">0</span>' },
      { key: '_o', label: '', render: x => `<button type="button" class="ui-btn js-pi-open" data-id="${esc(x.id)}">${x.id === _pi.open ? 'Refresh' : 'Open'}</button>` },
    ], rows: _pi.rows, rowKey: 'id',
  });
  el.querySelectorAll('.js-pi-open').forEach(b => b.addEventListener('click', uiBusyHandler(() => piOpen(b.dataset.id))));
}
function piRenderCatalog(){
  const el = _pi.host.querySelector('#piCatalog');
  const connectedKeys = new Set(_pi.rows.filter(r => r.enabled).map(r => r.adapterKey));
  if(!_pi.adapters.length){ el.innerHTML = uiEmpty('No integrations are available for your account yet. Ask the warehouse.'); return; }
  el.innerHTML = `<div class="portal-grid">${_pi.adapters.map(a => {
    const dup = connectedKeys.has(a.key) && a.key !== 'sftp_csv';
    const blocked = a.key === 'shopify' && !_pi.shopifyConfigured;
    const note = blocked ? 'Shopify sign-in is not set up on this server yet — ask the warehouse.' : dup ? 'Already connected. Disconnect it first to connect another.' : a.verification === 'mock-verified' ? 'Built to the marketplace\'s published API; the first live seller account is verified with the warehouse.' : '';
    return `<div class="portal-card" style="cursor:default;">
      <span class="portal-card-title">${esc(a.name)} <span class="ui-muted">· ${esc(PI_CAT[a.category] || a.category)}</span></span>
      <span class="portal-card-desc">${esc(a.description || '')}</span>
      ${note ? `<span class="ui-hint">${esc(note)}</span>` : ''}
      <span class="sp-toolbar-actions"><button type="button" class="ui-btn ui-btn-primary js-pi-connect" data-key="${esc(a.key)}" data-perm="${esc(piManagePerm())}" ${dup || blocked ? 'disabled' : ''}>Connect</button></span>
    </div>`; }).join('')}</div>`;
  el.querySelectorAll('.js-pi-connect').forEach(b => b.addEventListener('click', uiBusyHandler(() => piConnect(b.dataset.key))));
  if(typeof applyPermGates === 'function') applyPermGates(el);
}

// ---- connect flows ----------------------------------------------------------------------------
function piConnect(key){
  const a = _pi.adapters.find(x => x.key === key);
  if(!a) return;
  if(a.portalConnect === 'oauth' || key === 'shopify') return piConnectShopify(a);
  if(a.portalConnect === 'sftp' || key === 'sftp_csv') return piConnectSftp(a);
  return piConnectCredentials(a);
}
function piConnectShopify(a){
  uiModal({
    title: 'Connect a Shopify store',
    body: `${uiField({ id: 'piShop', label: 'Store address *', value: '', placeholder: 'your-store.myshopify.com', hint: 'You will be sent to Shopify to approve the connection, then brought back here.' })}
      <div class="ui-hint">The warehouse is added to your store as a fulfillment service with its own location. Orders assigned to that location come here; shipments and stock levels go back to Shopify.</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Continue to Shopify', primary: true, onClick: async (api) => {
      const shop = api.el.querySelector('#piShop').value.trim();
      if(!shop){ uiFieldError(api.el, 'piShop', 'Enter the store address'); return false; }
      const r = await piFetch('POST', '/portal/integrations/shopify/install', { shop, returnTo: 'portalIntegrations' });
      if(!r.ok){ uiToast(r.d.error || 'Could not start the Shopify connection', 'error'); return false; }
      piNavigate(r.d.url);
    } }],
  });
}
function piConnectCredentials(a){
  uiModal({
    title: `Connect ${a.name}`,
    width: 560,
    body: `${(a.auth.fields || []).map(f => uiField({ id: `piC_${f.key}`, label: f.label + (f.required === false ? '' : ' *'), type: f.secret ? 'password' : 'text', placeholder: f.placeholder || '' })).join('')}
      ${(a.settingsFields || []).map(f => uiField({ id: `piS_${f.key}`, label: f.label, value: '' })).join('')}
      <div class="ui-hint">${esc(a.auth.note || 'Credentials are stored encrypted and checked with ' + a.name + ' before the connection is saved.')} The connection starts read-only: orders come in, nothing is sent back until the warehouse enables writes.</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Connect', primary: true, onClick: async (api) => {
      const v = (id) => { const e = api.el.querySelector('#' + id); return e ? e.value.trim() : ''; };
      const credentials = {}; for(const f of a.auth.fields || []){ credentials[f.key] = v('piC_' + f.key); if(!credentials[f.key] && f.required !== false){ uiFieldError(api.el, 'piC_' + f.key, `Enter the ${f.label.toLowerCase()}`); return false; } }
      const settings = {}; for(const f of a.settingsFields || []){ const val = v('piS_' + f.key); if(val) settings[f.key] = val; }
      const r = await piFetch('POST', '/portal/integrations', { adapterKey: a.key, credentials, settings });
      if(!r.ok){ uiToast(r.d.error || 'Could not connect', 'error'); return false; }
      uiToast(`${a.name} connected`, 'success'); _pi.open = r.d.id; piLoad();
    } }],
  });
}
function piConnectSftp(a){
  const hostedOk = !!(_pi.sftpHost && _pi.sftpHost.enabled);
  const m = uiModal({
    title: 'Connect an SFTP / CSV drop',
    width: 600,
    body: `${uiFieldSelect({ id: 'piMode', label: 'Where do the files live?', options: [
        ...(hostedOk ? [{ value: 'hosted', label: 'A folder the warehouse hosts for you (we give you the login)' }] : []),
        { value: 'remote', label: 'Your own SFTP server (you give us the login)' }], value: hostedOk ? 'hosted' : 'remote' })}
      <div id="piSftpRemote"></div>
      ${uiField({ id: 'piS_inventory_export_hours', label: 'Write a stock file every (hours)', value: '24' })}
      <div class="ui-hint">Folders: in/orders, in/items, in/receipts for your files; out/shipments and out/inventory for ours; processed files move to archive/, rows we could not read go to error/ with a reason column.</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Connect', primary: true, onClick: async (api) => {
      const v = (id) => { const e = api.el.querySelector('#' + id); return e ? e.value.trim() : ''; };
      const mode = v('piMode');
      const settings = { mode, inventory_export_hours: v('piS_inventory_export_hours') || '24' };
      let credentials;
      if(mode === 'remote'){
        credentials = { host: v('piC_host'), port: v('piC_port') || '22', username: v('piC_username'), password: v('piC_password'), private_key: v('piC_private_key') };
        settings.remote_path = v('piS_remote_path') || '/';
        if(!credentials.host){ uiFieldError(api.el, 'piC_host', 'Enter the SFTP host'); return false; }
        if(!credentials.username){ uiFieldError(api.el, 'piC_username', 'Enter the username'); return false; }
        if(!credentials.password && !credentials.private_key){ uiFieldError(api.el, 'piC_password', 'Enter a password or a private key'); return false; }
      }
      const r = await piFetch('POST', '/portal/integrations', { adapterKey: a.key, credentials, settings });
      if(!r.ok){ uiToast(r.d.error || 'Could not connect', 'error'); return false; }
      uiToast('SFTP drop connected', 'success'); _pi.open = r.d.id;
      if(r.d.connectInfo && r.d.connectInfo.password) piShowSftpCredentials(r.d.connectInfo);
      piLoad();
    } }],
  });
  const paint = () => {
    const remote = m.el.querySelector('#piMode').value === 'remote';
    m.el.querySelector('#piSftpRemote').innerHTML = remote ? `
      ${uiField({ id: 'piC_host', label: 'SFTP host *', value: '', placeholder: 'sftp.example.com' })}
      <div class="form-row form-row-2">${uiField({ id: 'piC_port', label: 'Port', value: '22' })}${uiField({ id: 'piC_username', label: 'Username *', value: '' })}</div>
      ${uiField({ id: 'piC_password', label: 'Password', type: 'password', value: '' })}
      <div class="ui-field"><label class="ui-label" for="piC_private_key">Private key (PEM) — instead of a password</label><textarea class="ui-input" id="piC_private_key" rows="3"></textarea></div>
      ${uiField({ id: 'piS_remote_path', label: 'Base folder on your server', value: '/', hint: 'The in/, out/, archive/ and error/ folders are created under it.' })}` : `<div class="ui-hint">The login is shown once, right after you connect. Copy it into your file transfer tool.</div>`;
  };
  m.el.querySelector('#piMode').addEventListener('change', paint);
  paint();
}
/** The hosted login, once. */
function piShowSftpCredentials(ci){
  uiModal({
    title: 'Your SFTP login',
    width: 620,
    body: `<div class="ui-banner ui-banner-warn">Copy this password now. It is shown only once — the warehouse stores a hash, not the password. You can issue a new one from the integration page at any time.</div>
      ${uiMeta([
        { k: 'Host', v: esc(ci.host || 'ask the warehouse') + (ci.port ? `<span class="ui-muted"> : ${esc(ci.port)}</span>` : '') },
        { k: 'Username', v: uiId(ci.username) },
        { k: 'Password', v: uiId(ci.password) },
        { k: 'Protocol', v: 'SFTP (SSH), password login' },
      ])}
      <div class="ui-hint">Folders: ${(ci.layout || []).map(esc).join(' · ')}</div>`,
    actions: [{ label: 'Copy password', onClick: async () => { try { await navigator.clipboard.writeText(ci.password); uiToast('Password copied', 'success'); } catch(_) { uiToast('Could not copy — select it and copy by hand', 'error'); } return false; } }, { label: 'I have saved it', primary: true }],
  });
}

// ---- instance detail -------------------------------------------------------------------------
async function piOpen(id){
  _pi.open = id;
  piRenderRows();
  const host = _pi.host.querySelector('#piDetail');
  host.innerHTML = uiSpinner('Loading…');
  const r = await piFetch('GET', piBase(id));
  if(!r.ok){ host.innerHTML = uiError(r.d.error || 'Could not load'); return; }
  const det = r.d;
  const canManage = piCanManage();
  host.innerHTML = `<div class="card" style="margin:12px 0;">
    <div class="card-head"><div class="card-title">${esc(det.name)} <span class="ui-muted">· ${esc(det.adapter.name)}</span></div><div style="flex:1"></div>
      ${canManage ? `<button type="button" class="ui-btn js-pi-sync">Sync now</button>
      <button type="button" class="ui-btn js-pi-toggle">${det.enabled ? 'Pause' : 'Resume'}</button>
      <button type="button" class="ui-btn ui-btn-danger js-pi-disconnect">Disconnect</button>` : ''}
      <button type="button" class="ui-btn js-pi-close">Close</button>
    </div>
    <div class="sp-host" id="piPanel"></div>
  </div>`;
  host.querySelector('.js-pi-close').addEventListener('click', () => { _pi.open = null; host.innerHTML = ''; piRenderRows(); });
  host.querySelector('.js-pi-sync')?.addEventListener('click', uiBusyHandler(async () => {
    const x = await piFetch('POST', `${piBase(id)}/sync`); if(!x.ok) return uiToast(x.d.error || 'Sync failed', 'error');
    uiToast(x.d.status === 'failed' ? `Sync finished with errors — ${x.d.error || 'see the run log'}` : 'Sync complete', x.d.status === 'failed' ? 'error' : 'success'); piLoad();
  }));
  host.querySelector('.js-pi-toggle')?.addEventListener('click', uiBusyHandler(async () => { const x = await piFetch('PUT', piBase(id), { enabled: !det.enabled }); if(!x.ok) return uiToast(x.d.error || 'Could not change', 'error'); uiToast(det.enabled ? 'Paused' : 'Resumed', 'success'); piLoad(); }));
  host.querySelector('.js-pi-disconnect')?.addEventListener('click', uiBusyHandler(async () => {
    const ok = await uiConfirm({ title: `Disconnect ${det.name}?`, body: `<p>Orders stop coming in from ${esc(det.adapter.name)} and nothing more is sent back. Orders already in the warehouse are not affected.${det.adapterKey === 'shopify' ? ' Remove the app in Shopify as well to fully uninstall it.' : ''}</p>`, confirmLabel: 'Disconnect', danger: true });
    if(!ok) return;
    const x = await piFetch('DELETE', piBase(id)); if(!x.ok) return uiToast(x.d.error || 'Could not disconnect', 'error');
    uiToast('Disconnected', 'success'); _pi.open = null; host.innerHTML = ''; piLoad();
  }));
  piChannelPanel(host.querySelector('#piPanel'), det, { id, refresh: () => piOpen(id) });
}

/** Ops: Settings → Integrations → instance. Fetches the channel detail and renders the same panel. */
async function piOpsPanel(id, hostEl){
  _pi.mode = 'ops';
  hostEl.innerHTML = uiSpinner('Loading…');
  const r = await piFetch('GET', `/integrations/connectors/${id}/channel`);
  if(!r.ok){ hostEl.innerHTML = uiError(r.d.error || 'Could not load'); return; }
  piChannelPanel(hostEl, r.d, { id, refresh: () => piOpsPanel(id, hostEl) });
}

/** The shared panel. det = the channel detail; ctx = { id, refresh }. */
function piChannelPanel(host, det, ctx){
  const sm = det.summary || {};
  const canManage = piCanManage();
  host.innerHTML = `
    ${det.lastError ? `<div class="ui-banner ui-banner-danger">${esc(det.lastError)}</div>` : ''}
    ${uiMeta([
      { k: 'Status', v: piStatusChip(det) },
      { k: 'Last sync', v: piWhen(det.lastSyncAt) + (det.enabled ? `<span class="ui-muted"> · every ${esc(det.syncIntervalMin)} min</span>` : '') },
      { k: 'Orders today', v: uiNum(sm.ordersToday || 0) + (sm.lastImportedAt ? `<span class="ui-muted"> · last ${piWhen(sm.lastImportedAt)}</span>` : '') },
      { k: 'Waiting on items', v: sm.held ? `<span class="ui-err-text">${esc(sm.held)} order${sm.held === 1 ? '' : 's'} held</span>` : '<span class="ui-muted">none</span>' },
      { k: 'Errors (24h)', v: sm.failedRuns24h ? `<span class="ui-err-text">${esc(sm.failedRuns24h)} failed run${sm.failedRuns24h === 1 ? '' : 's'}</span>` : '<span class="ui-muted">none</span>' },
      { k: 'Sending back', v: det.writeLocked ? `${uiChip('DRAFT', 'OFF')} <span class="ui-hint">Read-only until the warehouse enables writes.</span>` : `${uiChip('ACTIVE', 'ON')} <span class="ui-hint">Shipments and stock levels are sent.</span>` },
    ])}
    <div id="piAdapter"></div>
    <div class="ui-label">Items we could not match</div>
    <div id="piUnmatched"></div>
    <div class="ui-label">Shipping methods</div>
    <div id="piShipping"></div>
    <div class="ui-label">Recent orders in</div>
    <div id="piInbox"></div>
    <div class="ui-label">Run log</div>
    <div id="piRuns"></div>`;
  piRenderAdapter(host.querySelector('#piAdapter'), det, ctx, canManage);
  piRenderUnmatched(host.querySelector('#piUnmatched'), det, ctx, canManage);
  piRenderShipping(host.querySelector('#piShipping'), det, ctx, canManage);
  piRenderInbox(host.querySelector('#piInbox'), det);
  piRenderRuns(host.querySelector('#piRuns'), det);
  if(typeof applyPermGates === 'function') applyPermGates(host);
}

function piRenderAdapter(el, det, ctx, canManage){
  if(det.shopify){
    const sh = det.shopify;
    el.innerHTML = `<div class="ui-label">Shopify</div>${uiMeta([
      { k: 'Store', v: sh.shop ? `<a href="https://${esc(sh.shop)}/admin" target="_blank" rel="noopener">${esc(sh.shop)}</a>` : '—' },
      { k: 'Warehouse location', v: sh.locationId ? uiId(sh.locationId) : '<span class="ui-err-text">not registered</span>' },
      { k: 'Webhooks', v: sh.webhooks && sh.webhooks.length ? `${esc(sh.webhooks.length)} subscribed <span class="ui-hint">${sh.webhooks.map(esc).join(', ')}</span>` : '<span class="ui-err-text">none</span>' },
      { k: 'Installed', v: piWhen(sh.installedAt) + (sh.uninstalledAt ? ` <span class="ui-err-text">· uninstalled ${piWhen(sh.uninstalledAt)}</span>` : '') },
    ])}`;
    return;
  }
  if(det.sftp){
    const s = det.sftp; const acct = s.account;
    const tpl = (kind) => (det.csvTemplates || []).find(t => t.kind === kind);
    el.innerHTML = `<div class="ui-label">SFTP</div>${uiMeta([
      { k: 'Mode', v: s.mode === 'remote' ? `your server <span class="ui-muted">${esc((det.settings && det.settings.remote_path) || '/')}</span>` : 'warehouse-hosted drop' },
      ...(s.mode !== 'remote' ? [
        { k: 'Host', v: s.host ? `${uiId(s.host)}<span class="ui-muted"> : ${esc(s.port)}</span>` : '<span class="ui-err-text">not published — ask the warehouse</span>' },
        { k: 'Username', v: acct ? uiId(acct.username) : '<span class="ui-err-text">no account</span>' },
        { k: 'Last login', v: acct ? piWhen(acct.last_login_at) : '—' },
        { k: 'Password', v: `set ${piWhen(acct && (acct.rotated_at || acct.created_at))} ${canManage ? '<button type="button" class="ui-btn js-pi-rotate">Issue a new password</button>' : ''}` },
      ] : []),
      { k: 'Folders', v: `<span class="ui-hint">${(s.layout || []).map(esc).join(' · ')}</span>` },
    ])}
    <div class="ui-label">CSV columns</div>
    <div class="ui-hint">Files are read with these column mappings. Without a saved mapping the column names are guessed from common headings; a file whose required columns cannot be found is moved to error/ with the reason.</div>
    <div id="piCsvT"></div>`;
    uiTable(el.querySelector('#piCsvT'), {
      columns: [
        { key: 'kind', label: 'File type', render: k => `<strong>${esc(PI_KINDS[k])}</strong><div class="ui-hint">in/${esc(k)}</div>` },
        { key: 'mapping', label: 'Saved mapping', render: k => { const t = tpl(k); return t ? `${esc(Object.keys(t.mapping || {}).length)} columns · saved ${piWhen(t.updated_at)}` : '<span class="ui-muted">none — headings are guessed</span>'; } },
        { key: '_e', label: '', render: k => canManage ? `<button type="button" class="ui-btn js-pi-csv" data-kind="${esc(k)}">${tpl(k) ? 'Edit mapping' : 'Set mapping'}</button>` : '' },
      ], rows: ['items', 'orders', 'receipts'], rowKey: null,
    });
    el.querySelectorAll('.js-pi-csv').forEach(b => b.addEventListener('click', uiBusyHandler(() => piCsvMappingDialog(det, ctx, b.dataset.kind, tpl(b.dataset.kind)))));
    el.querySelector('.js-pi-rotate')?.addEventListener('click', uiBusyHandler(async () => {
      const ok = await uiConfirm({ title: 'Issue a new SFTP password?', body: '<p>The current password stops working immediately. Update it in your file transfer tool.</p>', confirmLabel: 'Issue new password', danger: true });
      if(!ok) return;
      const x = await piFetch('POST', `${piBase(ctx.id)}/sftp-credentials`); if(!x.ok) return uiToast(x.d.error || 'Could not issue a password', 'error');
      piShowSftpCredentials(x.d); ctx.refresh();
    }));
    return;
  }
  if(det.adapterKey === 'walmart'){
    el.innerHTML = `<div class="ui-label">Walmart</div>${uiMeta([
      { k: 'Ship node', v: det.settings && det.settings.ship_node ? uiId(det.settings.ship_node) : '<span class="ui-muted">not set — inventory is sent without a ship node</span>' },
      { k: 'Market', v: esc((det.settings && det.settings.market) || 'us') },
      { k: 'Verification', v: det.adapter.verification === 'mock-verified' ? `${uiChip('DRAFT', 'MOCK-VERIFIED')} <span class="ui-hint">Built to Walmart's published API; the first live account is confirmed with the warehouse.</span>` : 'live' },
    ])}`;
    return;
  }
  el.innerHTML = '';
}

function piRenderUnmatched(el, det, ctx, canManage){
  const rows = det.unmatched || [];
  if(!rows.length){ el.innerHTML = uiEmpty('Every SKU received so far matched an item.'); return; }
  uiTable(el, {
    columns: [
      { key: 'externalSku', label: `SKU as ${esc(det.adapter.name)} sends it`, mono: true },
      { key: 'name', label: 'Name', render: x => esc(x.name || '') },
      { key: 'barcode', label: 'Barcode', render: x => x.barcode ? uiId(x.barcode) : '' },
      { key: 'lastSeenAt', label: 'Last seen', render: x => piWhen(x.lastSeenAt) },
      { key: '_a', label: '', render: x => canManage ? `<button type="button" class="ui-btn ui-btn-primary js-pi-create" data-id="${esc(x.id)}">Create item</button> <button type="button" class="ui-btn js-pi-link" data-id="${esc(x.id)}">Link to existing</button>` : '' },
    ], rows, rowKey: 'id',
  });
  el.querySelectorAll('.js-pi-create').forEach(b => b.addEventListener('click', uiBusyHandler(() => piCreateItemDialog(det, ctx, rows.find(x => x.id === b.dataset.id)))));
  el.querySelectorAll('.js-pi-link').forEach(b => b.addEventListener('click', uiBusyHandler(() => piLinkItemDialog(det, ctx, rows.find(x => x.id === b.dataset.id)))));
}
function piCreateItemDialog(det, ctx, u){
  uiModal({
    title: 'Create this item',
    body: `${uiField({ id: 'piNewSku', label: 'SKU code *', value: u.externalSku })}
      ${uiField({ id: 'piNewName', label: 'Name *', value: u.name || '' })}
      ${uiField({ id: 'piNewUpc', label: 'Barcode (UPC)', value: u.barcode && /^\d{12}$/.test(u.barcode) ? u.barcode : '' })}
      ${uiField({ id: 'piNewWeight', label: 'Weight (lbs)', value: '' })}
      <div class="ui-hint">The item is added to your item master and the held orders that use it are imported.</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Create item', primary: true, onClick: async (api) => {
      const v = (id) => api.el.querySelector('#' + id).value.trim();
      if(!v('piNewSku')){ uiFieldError(api.el, 'piNewSku', 'Enter a SKU code'); return false; }
      if(!v('piNewName')){ uiFieldError(api.el, 'piNewName', 'Enter a name'); return false; }
      const r = await piFetch('POST', `${piBase(ctx.id)}/unmatched/${u.id}`, { action: 'create', item: { sku: v('piNewSku'), name: v('piNewName'), upc: v('piNewUpc') || undefined, weight_lbs: v('piNewWeight') ? Number(v('piNewWeight')) : undefined } });
      if(!r.ok){ uiToast(r.d.error || 'Could not create the item', 'error'); return false; }
      uiToast(r.d.requeued ? `Item created — ${r.d.requeued} held order${r.d.requeued === 1 ? '' : 's'} queued for import` : 'Item created', 'success'); ctx.refresh();
    } }],
  });
}
function piLinkItemDialog(det, ctx, u){
  uiModal({
    title: `Link "${u.externalSku}" to an existing item`,
    body: `${uiField({ id: 'piLinkCode', label: 'Your SKU code *', value: '', placeholder: 'the code in your item master', hint: `From now on "${u.externalSku}" from ${det.adapter.name} means this item.` })}`,
    actions: [{ label: 'Cancel' }, { label: 'Link', primary: true, onClick: async (api) => {
      const code = api.el.querySelector('#piLinkCode').value.trim();
      if(!code){ uiFieldError(api.el, 'piLinkCode', 'Enter the SKU code'); return false; }
      const r = await piFetch('POST', `${piBase(ctx.id)}/unmatched/${u.id}`, { action: 'link', skuCode: code });
      if(!r.ok){ uiToast(r.d.error || 'Could not link', 'error'); return false; }
      uiToast(r.d.requeued ? `Linked — ${r.d.requeued} held order${r.d.requeued === 1 ? '' : 's'} queued for import` : 'Linked', 'success'); ctx.refresh();
    } }],
  });
}

function piRenderShipping(el, det, ctx, canManage){
  const rows = det.shipping || [];
  el.innerHTML = `<div id="piShipT"></div>${canManage ? '<div class="sp-toolbar-actions"><button type="button" class="ui-btn js-pi-ship-add">Add a method</button></div>' : ''}`;
  if(!rows.length) el.querySelector('#piShipT').innerHTML = uiEmpty(`No shipping methods seen yet. Methods appear here as ${det.adapter.name} sends them; map each to the carrier service the warehouse should use.`);
  else uiTable(el.querySelector('#piShipT'), {
    columns: [
      { key: 'method', label: `Method as ${esc(det.adapter.name)} sends it`, mono: true },
      { key: 'carrier', label: 'Ships as', render: x => x.mapped ? `${esc(x.carrier)}${x.service && x.service !== x.carrier ? ' / ' + esc(x.service) : ''}` : `<span class="ui-err-text">not mapped — the warehouse picks</span>` },
      { key: '_a', label: '', render: x => canManage ? `<button type="button" class="ui-btn js-pi-ship-edit" data-id="${esc(x.id)}">${x.mapped ? 'Change' : 'Map'}</button> <button type="button" class="ui-btn js-pi-ship-del" data-id="${esc(x.id)}">Remove</button>` : '' },
    ], rows, rowKey: 'id',
  });
  el.querySelectorAll('.js-pi-ship-edit').forEach(b => b.addEventListener('click', uiBusyHandler(() => piShippingDialog(det, ctx, rows.find(x => x.id === b.dataset.id)))));
  el.querySelector('.js-pi-ship-add')?.addEventListener('click', uiBusyHandler(() => piShippingDialog(det, ctx, null)));
  el.querySelectorAll('.js-pi-ship-del').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const x = await piFetch('DELETE', _pi.mode === 'portal' ? `${piBase(ctx.id)}/shipping-map/${b.dataset.id}` : `${piBase(ctx.id)}/mappings/service/${b.dataset.id}`);
    if(!x.ok) return uiToast(x.d.error || 'Could not remove', 'error');
    uiToast('Removed', 'success'); ctx.refresh();
  })));
}
function piShippingDialog(det, ctx, row){
  uiModal({
    title: row ? `Ship "${row.method}" as` : 'Add a shipping method',
    body: `${uiField({ id: 'piShipMethod', label: `Method as ${det.adapter.name} sends it *`, value: row ? row.method : '', placeholder: 'e.g. Standard, Express, or * for any' })}
      ${uiField({ id: 'piShipCarrier', label: 'Carrier *', value: row && row.carrier ? row.carrier : '', placeholder: 'ups, fedex, usps' })}
      ${uiField({ id: 'piShipService', label: 'Service', value: row && row.service ? row.service : '', placeholder: 'ups_ground, fedex_2day, usps_priority', hint: 'Leave blank to let the warehouse pick the service for that carrier.' })}`,
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async (api) => {
      const v = (id) => api.el.querySelector('#' + id).value.trim();
      if(!v('piShipMethod')){ uiFieldError(api.el, 'piShipMethod', 'Enter the method'); return false; }
      if(!v('piShipCarrier')){ uiFieldError(api.el, 'piShipCarrier', 'Enter the carrier'); return false; }
      const r = await piFetch('PUT', `${piBase(ctx.id)}/shipping-map`, { externalValue: v('piShipMethod'), carrier: v('piShipCarrier'), service: v('piShipService') });
      if(!r.ok){ uiToast(r.d.error || 'Could not save', 'error'); return false; }
      uiToast('Shipping method mapped', 'success'); ctx.refresh();
    } }],
  });
}

async function piCsvMappingDialog(det, ctx, kind, tpl){
  const f = await piFetch('GET', `${piBase(ctx.id)}/csv-fields/${kind}`);
  if(!f.ok) return uiToast(f.d.error || 'Could not load the column list', 'error');
  const fields = f.d.fields || [];
  let headers = (tpl && tpl.headers) || [];
  let mapping = (tpl && tpl.mapping) || {};
  const m = uiModal({
    title: `${PI_KINDS[kind]} file — column mapping`,
    width: 680,
    body: `<div class="ui-field"><label class="ui-label" for="piCsvHeaders">Your file's header row</label><textarea class="ui-input" id="piCsvHeaders" rows="2" placeholder="Paste the first line of your CSV, e.g. Order No,Cust PO,Deliver To,…">${esc(headers.join(','))}</textarea>
        <div class="ui-hint">Then pick what each of your columns means. Required: ${fields.filter(x => x.required).map(x => esc(x.label)).join(', ')}.</div></div>
      <div id="piCsvGrid"></div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save mapping', primary: true, onClick: async (api) => {
      const out = {}; api.el.querySelectorAll('.js-pi-col').forEach(sel => { if(sel.value) out[sel.dataset.header] = sel.value; });
      const r = await piFetch('PUT', `${piBase(ctx.id)}/csv-mapping/${kind}`, { headers, mapping: out });
      if(!r.ok){ uiToast(r.d.error || 'Could not save the mapping', 'error'); return false; }
      uiToast('Column mapping saved', 'success'); ctx.refresh();
    } }],
  });
  const paint = () => {
    const grid = m.el.querySelector('#piCsvGrid');
    if(!headers.length){ grid.innerHTML = uiEmpty('Paste your header row above.'); return; }
    const opts = [{ value: '', label: '— ignore this column —' }, ...fields.map(x => ({ value: x.key, label: x.label + (x.required ? ' *' : '') }))];
    grid.innerHTML = headers.map(h => `<div class="form-row form-row-2" style="align-items:center;"><div>${uiId(h)}</div>${uiFieldSelect({ id: '', label: '', options: opts, value: mapping[h] || '' }).replace('<select class="ui-input" id="">', `<select class="ui-input js-pi-col" data-header="${esc(h)}">`)}</div>`).join('');
  };
  m.el.querySelector('#piCsvHeaders').addEventListener('input', (e) => {
    headers = e.target.value.split(/\r?\n/)[0].split(',').map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
    // keep a guess for unmapped headers: exact label / key matches only
    for(const h of headers) if(!mapping[h]){ const hit = fields.find(x => x.key === h.toLowerCase().replace(/\s+/g, '_') || x.label.toLowerCase() === h.toLowerCase()); if(hit) mapping[h] = hit.key; }
    paint();
  });
  m.el.addEventListener('change', (e) => { if(e.target.classList.contains('js-pi-col')) mapping[e.target.dataset.header] = e.target.value; });
  paint();
}

function piRenderInbox(el, det){
  const rows = det.inbox || [];
  if(!rows.length){ el.innerHTML = uiEmpty('No orders received yet.'); return; }
  const chip = (s) => s === 'imported' ? uiChip('ACTIVE', 'IMPORTED') : s === 'held' ? uiChip('BACKORDERED', 'HELD') : s === 'pending' ? uiChip('DRAFT', 'PENDING') : s === 'rejected' ? uiChip('CANCELLED', 'REJECTED') : uiChip('CANCELLED', 'FAILED');
  uiTable(el, {
    columns: [
      { key: 'external_id', label: `${esc(det.adapter.name)} reference`, render: x => `${uiId(x.external_ref || x.external_id)}${x.external_ref && x.external_ref !== x.external_id ? `<div class="ui-hint">${esc(x.external_id)}</div>` : ''}` },
      { key: 'kind', label: 'Kind', render: x => esc(x.kind === 'cancel' ? 'cancellation' : x.kind) },
      { key: 'status', label: 'Status', render: x => chip(x.status) },
      { key: 'order_number', label: 'Warehouse order', render: x => x.order_number ? uiId(x.order_number) : '' },
      { key: 'error', label: 'Note', render: x => x.error ? `<span class="${x.status === 'imported' ? 'ui-muted' : 'ui-err-text'}">${esc(x.error)}</span>` : '' },
      { key: 'updated_at', label: 'When', render: x => piWhen(x.updated_at || x.created_at) },
    ], rows, rowKey: 'id',
  });
}
function piRenderRuns(el, det){
  const rows = det.runs || [];
  if(!rows.length){ el.innerHTML = uiEmpty('No runs yet.'); return; }
  uiTable(el, {
    columns: [
      { key: 'started_at', label: 'When', render: x => piWhen(x.started_at) },
      { key: 'kind', label: 'What', render: x => esc(String(x.kind || '').replace('webhook:', 'webhook ').replace(/_/g, ' ')) + `<span class="ui-muted"> · ${esc(x.trigger || '')}</span>` },
      { key: 'status', label: 'Result', render: x => x.status === 'ok' ? uiChip('ACTIVE', 'OK') : x.status === 'running' ? uiChip('DRAFT', 'RUNNING') : uiChip('CANCELLED', 'FAILED') },
      { key: 'counts', label: 'Detail', render: x => x.error ? `<span class="ui-err-text">${esc(x.error)}</span>` : esc(Object.entries(x.counts || {}).filter(([k, v]) => !['log', 'fileLog'].includes(k) && (typeof v === 'number' || typeof v === 'string')).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')) },
    ], rows, rowKey: 'id',
  });
}
