'use strict';
// =============================================================================
// API & WEBHOOKS — one renderer, two hosts:
//   Clients → client → "API & webhooks" tab   (ops, clients.api_manage; routes /clients/:id/...)
//   Portal home → "API & webhooks" page        (client admins, portal.api_keys; routes /portal/...)
// Keys: name, prefix, scopes, last used, expiry, revoke; Create key shows the
// plaintext ONCE with a copy button. Webhooks: subscriptions with delivery log,
// retry, test send, pause / resume, delete. Everything comes from the API.
// =============================================================================

const _aa = { mode: null, clientId: null, host: null, keys: [], hooks: [], scopes: [], events: [], docsUrl: null, baseUrl: null, openHook: null };

function aaBase(){ return _aa.mode === 'portal' ? '/portal' : `/clients/${_aa.clientId}`; }
async function aaFetch(method, p, body){
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: body == null ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok && d.code === 'PERMISSION_DENIED' && typeof permDeniedToast === 'function') permDeniedToast(d);
  return { ok: r.ok, status: r.status, d };
}
const aaWhen = (v) => v ? esc(String(v).slice(0, 16).replace('T', ' ')) : '<span class="ui-muted">never</span>';

/** Ops: Clients → API & webhooks tab. */
function loadClientApiTab(){
  if(typeof _currentClient === 'undefined' || !_currentClient) return;
  aaMount({ mode: 'ops', clientId: _currentClient.id, hostId: 'cliApiBody' });
}
/** Portal: the API & webhooks page. */
function loadPortalApiPage(){
  aaMount({ mode: 'portal', clientId: null, hostId: 'portalApiBody' });
}

async function aaMount({ mode, clientId, hostId }){
  const host = document.getElementById(hostId);
  if(!host) return;
  _aa.mode = mode; _aa.clientId = clientId; _aa.host = host;
  host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint">API keys let ${mode === 'portal' ? 'your' : 'the client\'s'} systems read and write ${mode === 'portal' ? 'your' : 'their'} items, inventory, orders, shipments and receipts. Webhooks send signed events to a URL as things happen. <a id="aaDocsLink" href="#" target="_blank" rel="noopener">API documentation</a></div>
      <div class="sp-toolbar-actions">
        <button type="button" class="ui-btn js-aa-refresh">Refresh</button>
        <button type="button" class="ui-btn ui-btn-primary js-aa-newkey">Create key</button>
        <button type="button" class="ui-btn js-aa-newhook">Add webhook</button>
      </div>
    </div>
    <div class="ui-label">API keys</div>
    <div id="aaKeys"></div>
    <div class="ui-label">Webhooks</div>
    <div id="aaHooks"></div>
    <div id="aaHookDetail"></div>`;
  host.querySelector('.js-aa-refresh').addEventListener('click', uiBusyHandler(aaLoad));
  host.querySelector('.js-aa-newkey').addEventListener('click', uiBusyHandler(aaCreateKeyDialog));
  host.querySelector('.js-aa-newhook').addEventListener('click', uiBusyHandler(aaHookDialog));
  await aaLoad();
}

async function aaLoad(){
  const [keys, hooks, meta] = await Promise.all([aaFetch('GET', `${aaBase()}/api-keys`), aaFetch('GET', `${aaBase()}/webhooks`), _aa.mode === 'portal' ? aaFetch('GET', '/portal/api-scopes') : Promise.resolve({ ok: true, d: {} })]);
  const keysEl = _aa.host.querySelector('#aaKeys');
  if(!keys.ok){ keysEl.innerHTML = uiError(keys.d.error || 'Could not load keys'); _aa.host.querySelector('#aaHooks').innerHTML = ''; return; }
  _aa.keys = keys.d.rows || []; _aa.scopes = keys.d.scopes || (meta.d && meta.d.scopes) || [];
  _aa.hooks = hooks.ok ? (hooks.d.rows || []) : []; _aa.events = (hooks.ok && hooks.d.events) || (meta.d && meta.d.events) || [];
  _aa.docsUrl = (meta.d && meta.d.docsUrl) || `${API}/v1/docs`; _aa.baseUrl = (meta.d && meta.d.baseUrl) || `${API}/v1`;
  const link = _aa.host.querySelector('#aaDocsLink'); if(link) link.href = _aa.docsUrl;
  aaRenderKeys(); aaRenderHooks();
  if(_aa.openHook){ if(_aa.hooks.find(h => h.id === _aa.openHook)) aaOpenHook(_aa.openHook); else { _aa.openHook = null; _aa.host.querySelector('#aaHookDetail').innerHTML = ''; } }
}

// ---- keys -----------------------------------------------------------------------------------
function aaRenderKeys(){
  const el = _aa.host.querySelector('#aaKeys');
  if(!_aa.keys.length){ el.innerHTML = uiEmpty('No API keys yet — use Create key.'); return; }
  uiTable(el, {
    columns: [
      { key: 'name', label: 'Name', render: k => `<div><strong>${esc(k.name)}</strong></div><div class="ui-hint">${esc(k.createdByName ? 'by ' + k.createdByName : '')}</div>` },
      { key: 'prefix', label: 'Key prefix', render: k => `${uiId(k.prefix)}<div class="ui-hint">prefix only — the full key was shown once, at creation</div>` },
      { key: 'scopes', label: 'Scopes', render: k => (k.scopes || []).map(s => `<span class="ui-chip">${esc(s)}</span>`).join(' ') },
      { key: 'status', label: 'Status', render: k => k.status === 'active' ? uiChip('ACTIVE', 'ACTIVE') : k.status === 'expired' ? uiChip('DRAFT', 'EXPIRED') : uiChip('CANCELLED', 'REVOKED') },
      { key: 'lastUsedAt', label: 'Last used', render: k => aaWhen(k.lastUsedAt) },
      { key: 'expiresAt', label: 'Expires', render: k => k.expiresAt ? aaWhen(k.expiresAt) : '<span class="ui-muted">never</span>' },
      { key: '_a', label: '', render: k => k.status === 'active' ? `<button type="button" class="ui-btn ui-btn-danger js-aa-revoke" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>` : '' },
    ], rows: _aa.keys, rowKey: 'id',
  });
  el.querySelectorAll('.js-aa-revoke').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const ok = await uiConfirm({ title: `Revoke "${b.dataset.name}"?`, body: '<p>Every request made with this key is refused from now on. This cannot be undone — create a new key instead.</p>', confirmLabel: 'Revoke key', danger: true });
    if(!ok) return;
    const r = await aaFetch('POST', `${aaBase()}/api-keys/${b.dataset.id}/revoke`);
    if(!r.ok) return uiToast(r.d.error || 'Could not revoke', 'error');
    uiToast('Key revoked', 'success'); aaLoad();
  })));
}
function aaCreateKeyDialog(){
  const scopes = _aa.scopes.length ? _aa.scopes : ['items:read', 'items:write', 'inventory:read', 'orders:read', 'orders:write', 'receipts:read', 'receipts:write', 'shipments:read', 'webhooks:manage'];
  const m = uiModal({
    title: 'Create an API key',
    width: 560,
    body: `${uiField({ id: 'aakName', label: 'Name *', value: '', placeholder: 'e.g. ERP integration' })}
      <div class="ui-label">Scopes *</div>
      <div class="ui-field-row" style="flex-wrap:wrap;">${scopes.map(s => `<label class="ui-label" style="min-width:45%;"><input type="checkbox" class="js-aak-scope" value="${esc(s)}" ${/:read$/.test(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('')}</div>
      ${uiField({ id: 'aakExpires', label: 'Expires (optional)', type: 'date', value: '' })}
      <div class="ui-hint">The key is shown once, on the next screen. Store it in your system's secret store.</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Create key', primary: true, onClick: async (api) => {
      const name = api.el.querySelector('#aakName').value.trim();
      const picked = [...api.el.querySelectorAll('.js-aak-scope:checked')].map(x => x.value);
      const exp = api.el.querySelector('#aakExpires').value;
      if(!name){ uiFieldError(api.el, 'aakName', 'Enter a name for the key'); return false; }
      if(!picked.length){ uiToast('Pick at least one scope', 'error'); return false; }
      const r = await aaFetch('POST', `${aaBase()}/api-keys`, { name, scopes: picked, expiresAt: exp ? new Date(exp + 'T23:59:59').toISOString() : undefined });
      if(!r.ok){ uiToast(r.d.error || 'Could not create the key', 'error'); return false; }
      aaShowKeyOnce(r.d);
      aaLoad();
    } }],
  });
  return m;
}
/** The plaintext, once. Closing is deliberate — there is no way back to it. */
function aaShowKeyOnce(k){
  const m = uiModal({
    title: 'Your new API key',
    width: 620,
    body: `<div class="ui-banner ui-banner-warn">Copy this key now. It is shown only once — the WMS stores a hash, not the key. The list will show only the prefix (${esc(k.prefix)}), which is not usable on its own.</div>
      ${uiMeta([{ k: 'Name', v: esc(k.name) }, { k: 'Scopes', v: (k.scopes || []).map(s => `<span class="ui-chip">${esc(s)}</span>`).join(' ') }])}
      <div class="ui-field"><label class="ui-label">Key</label><input class="ui-input" id="aaPlainKey" readonly value="${esc(k.key)}" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;"></div>
      <div class="usr-actions"><button type="button" class="ui-btn ui-btn-primary js-aa-copy">Copy key</button><span class="ui-hint" id="aaCopied"></span></div>
      <div class="ui-hint" style="margin-top:12px;">Use it as <code>Authorization: Bearer &lt;key&gt;</code> against <code>${esc(_aa.baseUrl || '')}</code>. See the <a href="${esc(_aa.docsUrl || '#')}" target="_blank" rel="noopener">API documentation</a>.</div>`,
    actions: [{ label: 'I have copied it', primary: true }],
  });
  m.el.querySelector('.js-aa-copy').addEventListener('click', uiBusyHandler(async () => {
    const input = m.el.querySelector('#aaPlainKey');
    let ok = false;
    try { await navigator.clipboard.writeText(input.value); ok = true; } catch(_) { try { input.select(); ok = document.execCommand('copy'); } catch(__) { ok = false; } }
    m.el.querySelector('#aaCopied').textContent = ok ? 'Copied' : 'Select the key and copy it by hand';
  }));
  return m;
}

// ---- webhooks ---------------------------------------------------------------------------------
function aaRenderHooks(){
  const el = _aa.host.querySelector('#aaHooks');
  if(!_aa.hooks.length){ el.innerHTML = uiEmpty('No webhooks yet — use Add webhook to receive events at your URL.'); return; }
  uiTable(el, {
    columns: [
      { key: 'url', label: 'URL', render: h => `<div>${uiId(h.url)}</div>${h.description ? `<div class="ui-hint">${esc(h.description)}</div>` : ''}` },
      { key: 'events', label: 'Events', render: h => (h.events || []).map(e => `<span class="ui-chip">${esc(e)}</span>`).join(' ') },
      { key: 'active', label: 'Status', render: h => h.active ? uiChip('ACTIVE', 'ACTIVE') : `${uiChip('CANCELLED', 'PAUSED')}${h.pauseReason ? `<div class="ui-hint">${esc(h.pauseReason)}</div>` : ''}` },
      { key: 'lastDelivery', label: 'Last delivery', render: h => h.lastDelivery ? `${h.lastDelivery.status === 'delivered' ? uiChip('ACTIVE', 'DELIVERED') : h.lastDelivery.status === 'dead' ? uiChip('FAILED', 'DEAD') : uiChip('DRAFT', String(h.lastDelivery.status).toUpperCase())} <span class="ui-muted">${aaWhen(h.lastDelivery.created_at)}</span>` : '<span class="ui-muted">—</span>' },
      { key: 'consecutiveFailures', label: 'Failures', render: h => h.consecutiveFailures ? `<span class="ui-err-text">${esc(h.consecutiveFailures)} in a row</span>` : '0' },
      { key: '_a', label: '', render: h => `<button type="button" class="ui-btn js-aa-hook-open" data-id="${esc(h.id)}">${_aa.openHook === h.id ? 'Close' : 'Deliveries'}</button> <button type="button" class="ui-btn js-aa-hook-test" data-id="${esc(h.id)}">Test</button> <button type="button" class="ui-btn js-aa-hook-toggle" data-id="${esc(h.id)}" data-active="${h.active ? '1' : ''}">${h.active ? 'Pause' : 'Resume'}</button> <button type="button" class="ui-btn ui-btn-danger js-aa-hook-del" data-id="${esc(h.id)}">Delete</button>` },
    ], rows: _aa.hooks, rowKey: 'id',
  });
  el.querySelectorAll('.js-aa-hook-open').forEach(b => b.addEventListener('click', uiBusyHandler(async () => { if(_aa.openHook === b.dataset.id){ _aa.openHook = null; _aa.host.querySelector('#aaHookDetail').innerHTML = ''; aaRenderHooks(); } else await aaOpenHook(b.dataset.id); })));
  el.querySelectorAll('.js-aa-hook-test').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const r = await aaFetch('POST', `${aaBase()}/webhooks/${b.dataset.id}/test`);
    if(!r.ok) return uiToast(r.d.error || 'Test failed', 'error');
    uiToast(r.d.status === 'delivered' ? `Delivered (HTTP ${r.d.code}, ${r.d.ms} ms)` : `Not delivered — ${r.d.error || 'no response'}`, r.d.status === 'delivered' ? 'success' : 'error', 6000);
    aaLoad();
  })));
  el.querySelectorAll('.js-aa-hook-toggle').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const r = await aaFetch('PUT', `${aaBase()}/webhooks/${b.dataset.id}`, { active: !b.dataset.active });
    if(!r.ok) return uiToast(r.d.error || 'Could not change', 'error');
    uiToast(b.dataset.active ? 'Paused' : 'Resumed', 'success'); aaLoad();
  })));
  el.querySelectorAll('.js-aa-hook-del').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const ok = await uiConfirm({ title: 'Delete this webhook?', body: '<p>No more events are sent to it and its delivery history is removed.</p>', confirmLabel: 'Delete', danger: true });
    if(!ok) return;
    const r = await aaFetch('DELETE', `${aaBase()}/webhooks/${b.dataset.id}`);
    if(!r.ok) return uiToast(r.d.error || 'Could not delete', 'error');
    uiToast('Webhook deleted', 'success'); aaLoad();
  })));
}
function aaHookDialog(){
  const events = _aa.events.length ? _aa.events : ['order.created', 'order.allocated', 'order.shipped', 'order.cancelled', 'receipt.created', 'receipt.posted', 'inventory.adjusted', 'item.created', 'item.updated'];
  const m = uiModal({
    title: 'Add a webhook',
    width: 560,
    body: `${uiField({ id: 'aahUrl', label: 'URL *', value: '', placeholder: 'https://example.com/wms-events', hint: 'https only, reachable from the internet (no private or local addresses).' })}
      <div class="ui-label">Events *</div>
      <div class="ui-field-row" style="flex-wrap:wrap;">${events.map(e => `<label class="ui-label" style="min-width:45%;"><input type="checkbox" class="js-aah-event" value="${esc(e)}" ${e === 'order.shipped' ? 'checked' : ''}> ${esc(e)}</label>`).join('')}</div>
      ${uiField({ id: 'aahSecret', label: 'Signing secret (optional)', value: '', hint: 'Leave blank to have one generated. Shown once.' })}
      ${uiField({ id: 'aahDesc', label: 'Description (optional)', value: '' })}`,
    actions: [{ label: 'Cancel' }, { label: 'Add webhook', primary: true, onClick: async (api) => {
      const url = api.el.querySelector('#aahUrl').value.trim();
      const picked = [...api.el.querySelectorAll('.js-aah-event:checked')].map(x => x.value);
      if(!url){ uiFieldError(api.el, 'aahUrl', 'Enter the URL'); return false; }
      if(!picked.length){ uiToast('Pick at least one event', 'error'); return false; }
      const r = await aaFetch('POST', `${aaBase()}/webhooks`, { url, events: picked, secret: api.el.querySelector('#aahSecret').value.trim() || undefined, description: api.el.querySelector('#aahDesc').value.trim() || undefined });
      if(!r.ok){ if(r.d.field === 'url') uiFieldError(api.el, 'aahUrl', r.d.error || 'URL refused'); else uiToast(r.d.error || 'Could not add the webhook', 'error'); return false; }
      aaShowSecretOnce(r.d);
      aaLoad();
    } }],
  });
  return m;
}
function aaShowSecretOnce(h){
  const m = uiModal({
    title: 'Webhook added',
    width: 620,
    body: `<div class="ui-banner ui-banner-warn">Copy the signing secret now — it is shown only once.</div>
      ${uiMeta([{ k: 'URL', v: uiId(h.url) }, { k: 'Events', v: (h.events || []).map(e => `<span class="ui-chip">${esc(e)}</span>`).join(' ') }])}
      <div class="ui-field"><label class="ui-label">Signing secret</label><input class="ui-input" id="aaPlainSecret" readonly value="${esc(h.secret || '')}" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;"></div>
      <div class="usr-actions"><button type="button" class="ui-btn ui-btn-primary js-aa-copy">Copy secret</button><span class="ui-hint" id="aaCopied"></span></div>
      <div class="ui-hint" style="margin-top:12px;">Each delivery carries <code>X-WMS-Signature: v1=&lt;hmac-sha256 of "&lt;X-WMS-Timestamp&gt;.&lt;body&gt;"&gt;</code>. Reject anything older than five minutes.</div>`,
    actions: [{ label: 'I have copied it', primary: true }],
  });
  m.el.querySelector('.js-aa-copy').addEventListener('click', uiBusyHandler(async () => {
    const input = m.el.querySelector('#aaPlainSecret');
    let ok = false;
    try { await navigator.clipboard.writeText(input.value); ok = true; } catch(_) { try { input.select(); ok = document.execCommand('copy'); } catch(__) { ok = false; } }
    m.el.querySelector('#aaCopied').textContent = ok ? 'Copied' : 'Select the secret and copy it by hand';
  }));
  return m;
}
async function aaOpenHook(id){
  _aa.openHook = id;
  aaRenderHooks();
  const host = _aa.host.querySelector('#aaHookDetail');
  host.innerHTML = '<div class="ui-hint">Loading…</div>';
  const r = await aaFetch('GET', `${aaBase()}/webhooks/${id}/deliveries`);
  if(!r.ok){ host.innerHTML = uiError(r.d.error || 'Could not load deliveries'); return; }
  const rows = r.d.rows || [];
  host.innerHTML = `<div class="card" style="margin:12px 0;"><div class="card-head"><div class="card-title">Deliveries</div></div><div class="sp-host" id="aaDeliveries"></div></div>`;
  const el = host.querySelector('#aaDeliveries');
  if(!rows.length){ el.innerHTML = uiEmpty('No deliveries yet. Use Test to send one now.'); return; }
  uiTable(el, {
    columns: [
      { key: 'created_at', label: 'When', render: d => aaWhen(d.created_at) },
      { key: 'event_type', label: 'Event', mono: true },
      { key: 'status', label: 'Status', render: d => d.status === 'delivered' ? uiChip('ACTIVE', 'DELIVERED') : d.status === 'dead' ? uiChip('FAILED', 'DEAD-LETTERED') : d.attempt ? uiChip('DRAFT', `RETRY ${d.attempt}`) : uiChip('DRAFT', 'PENDING') },
      { key: 'response_code', label: 'Response', render: d => d.response_code ? `${esc(d.response_code)}${d.response_ms != null ? ` <span class="ui-muted">${esc(d.response_ms)} ms</span>` : ''}` : '<span class="ui-muted">—</span>' },
      { key: 'next_retry_at', label: 'Next try', render: d => d.status === 'pending' && d.attempt ? aaWhen(d.next_retry_at) : '' },
      { key: 'error', label: 'Error', render: d => d.error ? `<span class="ui-err-text">${esc(d.error)}</span>` : '' },
      { key: '_a', label: '', render: d => (d.status === 'dead' || (d.status === 'pending' && d.attempt)) ? `<button type="button" class="ui-btn js-aa-retry" data-id="${esc(d.id)}">Retry now</button>` : '' },
    ], rows, rowKey: 'id',
  });
  el.querySelectorAll('.js-aa-retry').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const x = await aaFetch('POST', `${aaBase()}/webhooks/${id}/deliveries/${b.dataset.id}/retry`);
    if(!x.ok) return uiToast(x.d.error || 'Could not retry', 'error');
    uiToast('Retry queued — it goes out within a few seconds', 'success'); setTimeout(() => aaOpenHook(id), 2500);
  })));
}
