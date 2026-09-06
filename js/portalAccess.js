// =============================================================================
// PORTAL ACCESS — two surfaces that share the portal permission catalog.
//
// Ops side (Clients → client → "Portal access" tab; permission clients.portal_access):
//   GET/PUT /clients/:id/portal-features   entitlement switches per client.
//   A switch is what the CLIENT is allowed at all; the portal role decides
//   which of its users get it. Off here beats any role.
//
// Portal side (page-portalUsers; portal.users.manage — role AND entitlement):
//   GET/POST /portal/users, PUT /portal/users/:id,
//   POST /portal/users/:id/{deactivate,reactivate,reset-password}
//   A client admin manages the accounts of their own company only; the API
//   pins the client from the JWT, this page never sends one.
// =============================================================================

'use strict';

// Display grouping for the 12 portal keys (the catalog has one group, "Portal").
const PA_GROUPS = [
  { name: 'Orders',                keys: ['portal.orders.view', 'portal.orders.create', 'portal.orders.cancel', 'portal.returns'] },
  { name: 'Inventory & receiving', keys: ['portal.inventory.view', 'portal.receipts.view'] },
  { name: 'Documents & reports',   keys: ['portal.documents', 'portal.reports.run', 'portal.invoices.view'] },
  { name: 'Account',               keys: ['portal.users.manage', 'portal.api_keys', 'portal.notifications'] },
];

let _paData = null;      // last GET /clients/:id/portal-features
let _paDirty = {};       // key -> enabled (differs from server)

function _paGrouped(features){
  const byKey = Object.fromEntries(features.map(f => [f.key, f]));
  const groups = PA_GROUPS.map(g => ({ name: g.name, rows: g.keys.map(k => byKey[k]).filter(Boolean) }));
  const placed = new Set(PA_GROUPS.flatMap(g => g.keys));
  const rest = features.filter(f => !placed.has(f.key));
  if(rest.length) groups.push({ name: 'Other', rows: rest });
  return groups.filter(g => g.rows.length);
}

async function loadClientPortalTab(){
  const host = document.getElementById('cliPortalBody');
  const c = typeof _currentClient !== 'undefined' ? _currentClient : null;
  if(!host || !c) return;
  host.innerHTML = uiSpinner('Loading portal access…');
  const d = await apiGet(`/clients/${c.id}/portal-features`);
  if(!d){ host.innerHTML = uiError('Could not load portal access'); return; }
  _paData = d; _paDirty = {};
  renderClientPortalTab();
}

function renderClientPortalTab(){
  const host = document.getElementById('cliPortalBody');
  const d = _paData;
  if(!host || !d) return;
  const dirtyCount = Object.keys(_paDirty).length;
  const users = `${d.portalUserCount} portal user${d.portalUserCount === 1 ? '' : 's'}${d.portalUserCount ? ` (${d.portalActiveUserCount} active)` : ''}`;
  host.innerHTML = `
    ${!d.migrated ? '<div class="ui-banner ui-banner-warn">Portal features are not available yet — the database update (095) has not been applied.</div>' : ''}
    ${d.client.status !== 'active' ? `<div class="ui-banner ui-banner-danger">This client is ${esc(d.client.status)} — portal logins are refused regardless of these switches.</div>` : ''}
    <div class="roles-toolbar">
      <span class="ui-hint">What ${esc(d.client.code)} may use in the portal. A feature that is off here is off for every portal user of this client, whatever their portal role. ${esc(users)}.</span>
      <span style="flex:1"></span>
      <span class="ui-hint js-pa-dirty">${dirtyCount ? esc(dirtyCount + ' unsaved change' + (dirtyCount === 1 ? '' : 's')) : ''}</span>
      <button type="button" class="ui-btn js-pa-preview" data-mode="view" data-perm="clients.portal_preview" ${d.client.status === 'active' ? '' : 'disabled'} title="${d.client.status === 'active' ? 'Open this client\'s portal in a new tab, read-only, as they see it (60 minutes, audited)' : 'Only an active client can be previewed'}">View portal (read-only)</button>
      <button type="button" class="ui-btn js-pa-preview" data-mode="act" data-perm="clients.portal_act" ${d.client.status === 'active' ? '' : 'disabled'} title="${d.client.status === 'active' ? 'Open this client\'s portal in a new tab and act as them — place orders, create their users (60 minutes, audited)' : 'Only an active client can be previewed'}">Act as client</button>
      <button type="button" class="ui-btn js-pa-reload">Discard</button>
      <button type="button" class="ui-btn ui-btn-primary js-pa-save" ${dirtyCount && d.migrated ? '' : 'disabled'}>Save changes</button>
    </div>
    <div class="pa-grid">
      ${_paGrouped(d.features).map(g => `
        <div class="pa-group">
          <div class="pa-group-title">${esc(g.name)}</div>
          ${g.rows.map(f => {
            const on = (f.key in _paDirty) ? _paDirty[f.key] : f.enabled;
            const meta = f.reserved ? 'no portal screen uses this yet'
                       : (on !== f.default ? `changed from the default${f.updatedBy ? ` by ${f.updatedBy}` : ''}${f.updatedAt ? ` · ${fmtTimeShort(f.updatedAt)}` : ''}` : `default ${f.default ? 'on' : 'off'}`);
            return `<label class="pa-switch${f.reserved ? ' pa-switch-reserved' : ''}">
              <input type="checkbox" class="js-pa-sw" data-key="${esc(f.key)}" ${on ? 'checked' : ''} ${d.migrated ? '' : 'disabled'}>
              <span class="pa-switch-track"><span class="pa-switch-knob"></span></span>
              <span class="pa-switch-text"><span class="pa-switch-label">${esc(f.label)}${(f.key in _paDirty) ? ' <span class="idn-tag idn-tag-primary">unsaved</span>' : ''}</span>
                <span class="ui-hint ui-mono">${esc(f.key)}</span><span class="ui-hint">${esc(meta)}</span></span>
            </label>`; }).join('')}
        </div>`).join('')}
    </div>`;
  host.querySelectorAll('.js-pa-sw').forEach(sw => sw.addEventListener('change', () => {
    const f = d.features.find(x => x.key === sw.dataset.key);
    if(sw.checked === f.enabled) delete _paDirty[f.key]; else _paDirty[f.key] = sw.checked;
    renderClientPortalTab();
  }));
  host.querySelector('.js-pa-reload').addEventListener('click', uiBusyHandler(() => loadClientPortalTab()));
  host.querySelector('.js-pa-save').addEventListener('click', uiBusyHandler(() => saveClientPortalTab()));
  host.querySelectorAll('.js-pa-preview').forEach(b => b.addEventListener('click', uiBusyHandler(() => openPortalPreview(b.dataset.mode === 'act' ? 'act' : 'view'))));
  if(typeof applyPermGates === 'function') applyPermGates(host);
}

/**
 * "View portal as client": mint a 60-minute preview token for this client and
 * open the portal in a new tab. The tab is opened synchronously (popup
 * blockers) and pointed at ?portalPreview=1 once the token is in the one-shot
 * localStorage handoff that js/app.js consumes on load.
 */
async function openPortalPreview(mode = 'view'){
  const c = _paData && _paData.client;
  if(!c) return;
  const w = window.open('', '_blank');
  if(w){ try { w.document.write('<title>Portal preview</title><p style="font:14px system-ui;padding:24px;">Preparing the portal preview…</p>'); } catch(_) {} }
  const r = await fetch(`${API}/clients/${c.id}/portal-session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ mode }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){
    if(w) w.close();
    if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not start the portal preview', 'error');
    return false;
  }
  try { localStorage.setItem('tpfs_preview_handoff', JSON.stringify({ token: d.token, user: d.user })); }
  catch(_) { if(w) w.close(); uiToast('Could not hand the preview to a new tab (browser storage is blocked)', 'error'); return false; }
  const url = `${location.pathname}?portalPreview=1`;
  if(w) w.location.href = url; else window.open(url, '_blank');
  uiToast(`${mode === 'act' ? 'Acting as' : 'Viewing'} ${c.code} in a new tab — it ends after 60 minutes or when you press End there`);
}

async function saveClientPortalTab(){
  const changes = Object.entries(_paDirty).map(([key, enabled]) => ({ key, enabled }));
  if(!changes.length) return uiToast('Nothing to save', 'error');
  const r = await fetch(`${API}/clients/${_paData.client.id}/portal-features`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ changes }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not save portal access', 'error'); return false; }
  _paData = d; _paDirty = {};
  renderClientPortalTab();
  uiToast(`${changes.length} portal feature${changes.length === 1 ? '' : 's'} saved — portal users see it within a minute`);
}

// =============================================================================
// PORTAL: Users of my company (page-portalUsers)
// =============================================================================

let _puData = { rows: [], roles: [] };

const PU_COLS = [
  { key: 'fullName', label: 'Name', render: u => `${esc(u.fullName || '')}${u.self ? ' <span class="idn-tag">you</span>' : ''}${u.mustChangePassword ? '<div class="ui-hint">temp password — must change at next login</div>' : ''}` },
  { key: 'email', label: 'Email', mono: true },
  { key: 'roleName', label: 'Role', render: u => `<span class="ui-chip ui-chip-ok">${esc(u.roleName || u.role)}</span>` },
  { key: '_status', label: 'Status', sortValue: u => u.isActive ? 0 : 1, render: u => u.isActive ? uiChip('ACTIVE', 'active') : uiChip('INACTIVE', 'inactive') },
  { key: '_login', label: 'Last login', sortValue: u => u.lastLoginAt || '', render: u => u.lastLoginAt ? uiId(fmtTimeShort(u.lastLoginAt)) : '<span class="ui-muted">never</span>' },
];

async function loadPortalUsers(){
  const host = document.getElementById('portalUsersBody');
  if(!host) return;
  uiTableLoading('portalUsersBody', PU_COLS);
  const r = await apiGet('/portal/users');
  if(r === null) return uiTableError('portalUsersBody', PU_COLS, 'Could not load your company\'s users', loadPortalUsers);
  _puData = { rows: Array.isArray(r.rows) ? r.rows : [], roles: Array.isArray(r.roles) ? r.roles : [] };
  uiTable('portalUsersBody', {
    columns: PU_COLS, rows: _puData.rows, rowKey: 'id', sortable: true, patch: true,
    onRowClick: u => openPortalUserModal(u.id),
    empty: 'No users yet — use Add user.',
  });
}

function _puRoleOpts(){ return _puData.roles.map(r => ({ value: r.key, label: r.name })); }

async function openAddPortalUserModal(){
  if(!_puData.roles.length) await loadPortalUsers();
  const opts = _puRoleOpts();
  if(!opts.length) return uiToast('No portal roles available', 'error');
  const m = uiModal({
    title: 'Add user',
    width: 520,
    body: `
      ${uiField({ id: 'puName', label: 'Full name *' })}
      ${uiField({ id: 'puEmail', label: 'Email (login) *', type: 'email' })}
      ${uiFieldSelect({ id: 'puRole', label: 'Role *', options: opts, value: opts.some(o => o.value === 'client_viewer') ? 'client_viewer' : opts[0].value,
                        hint: 'Client admin: everything your company is entitled to, including managing users. Client viewer: read-only.' })}
      <div class="ui-banner ui-banner-info">A temporary password is generated and shown once. The new user must set their own password at first login.</div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Create user', primary: true, onClick: async (api) => {
        const name = api.el.querySelector('#puName').value.trim();
        const email = api.el.querySelector('#puEmail').value.trim().toLowerCase();
        const role = api.el.querySelector('#puRole').value;
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        uiFieldError(api.el, 'puName', name.length >= 2 ? '' : 'Full name is required');
        uiFieldError(api.el, 'puEmail', emailOk ? '' : 'A valid email is required');
        if(name.length < 2 || !emailOk) return false;
        const r = await fetch(`${API}/portal/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ email, fullName: name, role }) });
        const d = await r.json().catch(() => ({}));
        if(!r.ok){
          if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not create the user', 'error');
          if(/exists/i.test(d.error || '')) uiFieldError(api.el, 'puEmail', d.error);
          return false;
        }
        uiToast(`${d.user.fullName} created`);
        loadPortalUsers();
        pwShowTempPassword(d.user.fullName, d.tempPassword);
      } },
    ],
  });
  return m;
}

async function openPortalUserModal(userId){
  const u = _puData.rows.find(x => x.id === userId);
  if(!u) return uiToast('Reload the list and try again', 'error');
  const opts = _puRoleOpts();
  if(!opts.some(o => o.value === u.role)) opts.unshift({ value: u.role, label: u.roleName || u.role });
  const m = uiModal({
    title: u.fullName || u.email,
    width: 560,
    body: `
      ${uiMeta([
        { k: 'Email', v: uiId(u.email) },
        { k: 'Role', v: `<span class="ui-chip ui-chip-ok">${esc(u.roleName || u.role)}</span>` },
        { k: 'Status', v: u.isActive ? uiChip('ACTIVE', 'active') : uiChip('INACTIVE', 'inactive') },
        { k: 'Last login', v: u.lastLoginAt ? uiId(fmtTimeShort(u.lastLoginAt)) : '<span class="ui-muted">never</span>' },
      ])}
      ${u.self ? '<div class="ui-hint">This is you — another client admin changes your role or status.</div>' : `
      <div class="eo-section">
        <div class="ui-field-row">
          ${uiField({ id: 'peName', label: 'Full name', value: u.fullName || '' })}
          ${uiFieldSelect({ id: 'peRole', label: 'Role', options: opts, value: u.role })}
        </div>
        <div class="usr-actions">
          <button type="button" class="ui-btn ui-btn-primary js-pu-save">Save changes</button>
          ${u.isActive ? '<button type="button" class="ui-btn js-pu-reset">Reset password</button>' : ''}
          <span style="flex:1"></span>
          ${u.isActive ? '<button type="button" class="ui-btn ui-btn-danger js-pu-deactivate">Deactivate</button>' : '<button type="button" class="ui-btn js-pu-reactivate">Reactivate</button>'}
        </div>
      </div>`}`,
    actions: [{ label: 'Close' }],
  });
  const el = m.el;
  const post = async (path, body) => {
    const r = await fetch(`${API}${path}`, { method: body === undefined ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify(body === undefined ? {} : body) });
    const d = await r.json().catch(() => ({}));
    if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Request failed', 'error'); return null; }
    return d;
  };
  el.querySelector('.js-pu-save')?.addEventListener('click', uiBusyHandler(async () => {
    const body = { fullName: el.querySelector('#peName').value.trim() };
    const role = el.querySelector('#peRole').value; if(role !== u.role) body.role = role;
    const d = await post(`/portal/users/${u.id}`, body); if(!d) return false;
    uiToast(d.changed && d.changed.length ? 'Saved' : 'Nothing to save');
    m.close(); loadPortalUsers();
  }));
  el.querySelector('.js-pu-reset')?.addEventListener('click', uiBusyHandler(async () => {
    const ok = await uiConfirm({ title: `Reset ${u.fullName || u.email}'s password?`, body: 'Their current password stops working. You will be shown a temporary one to pass on.', confirmLabel: 'Reset password' });
    if(!ok) return false;
    const r = await fetch(`${API}/portal/users/${u.id}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not reset', 'error'); return false; }
    return pwShowTempPassword(d.user?.fullName || u.fullName, d.tempPassword);
  }));
  const flip = (active) => uiBusyHandler(async () => {
    const ok = await uiConfirm({ title: active ? `Reactivate ${u.fullName || u.email}?` : `Deactivate ${u.fullName || u.email}?`,
      body: active ? 'They can sign in again with their existing password.' : 'They are signed out within a minute and cannot sign in until reactivated.',
      confirmLabel: active ? 'Reactivate' : 'Deactivate', danger: !active });
    if(!ok) return false;
    const d = await post(`/portal/users/${u.id}/${active ? 'reactivate' : 'deactivate'}`); if(!d) return false;
    uiToast(active ? 'Reactivated' : 'Deactivated', active ? 'success' : 'error');
    m.close(); loadPortalUsers();
  });
  el.querySelector('.js-pu-deactivate')?.addEventListener('click', flip(false));
  el.querySelector('.js-pu-reactivate')?.addEventListener('click', flip(true));
  return m;
}
