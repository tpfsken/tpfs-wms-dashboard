// =============================================================================
// USERS — accounts, roles, per-user overrides, hazmat certifications.
//
// Listing / lifecycle (users.manage, or users.onboard for floor accounts):
//   GET  /users?q=&role=&active=      rows + the roles the caller may assign
//   POST /users                        create; temp password shown ONCE
//   PUT  /users/:id                    name / role / client (portal)
//   POST /users/:id/deactivate | /reactivate | /reset-password
// Overrides (users.manage only):
//   GET/PUT /users/:id/overrides       extra / removed permissions vs the role
// Certs (unchanged): GET /users/:id/certs, POST …/certs, POST …/certs/:id/revoke
//
// The API decides what the caller may do (scope + editable per row); the page
// only hides controls so nobody clicks into a 403.
// =============================================================================

'use strict';
let _userCertCurrent = null;   // currently-open user object (certs section)
let _usersData = { rows: [], roles: [], scope: 'onboard' };
let _usersShowInactive = false;
let _usersRoleFilter = '';
let _usersToolbarWired = false;

const ROLE_TONE = { admin: 'info', supervisor: 'warn', floor: 'neutral', portal: 'ok' };
function userRoleChip(u){
  const base = u.baseRole || u.base_role || 'floor';
  const name = u.roleName || u.role_name || u.role || base;
  return `<span class="ui-chip ui-chip-${esc(ROLE_TONE[base] || 'neutral')}" title="${esc(base)} base">${esc(name)}</span>`;
}

const USER_COLS = [
  { key: 'fullName', label: 'Name', render: u =>
      `<div>${esc(u.fullName || '')}${u.overrideCount ? ` <span class="idn-tag idn-tag-primary" title="Has per-user permission overrides">${esc(u.overrideCount)} override${u.overrideCount === 1 ? '' : 's'}</span>` : ''}</div>` +
      (u.mustChangePassword ? '<div class="ui-hint">temp password — must change at next login</div>' : '') },
  { key: 'email', label: 'Email', mono: true },
  { key: '_role', label: 'Role', sortValue: u => `${u.baseRole}|${u.roleName}`, render: u => userRoleChip(u) },
  { key: '_client', label: 'Client', sortValue: u => u.clientCode || '', render: u => u.clientCode
      ? `${uiId(u.clientCode)} <span class="ui-muted">${esc(u.clientName || '')}</span>` : '<span class="ui-muted">—</span>' },
  { key: '_login', label: 'Last login', sortValue: u => u.lastLoginAt || '', render: u => u.lastLoginAt
      ? uiId(fmtTimeShort(u.lastLoginAt)) : '<span class="ui-muted">never</span>' },
  { key: '_status', label: 'Status', sortValue: u => u.isActive ? 0 : 1, render: u => u.isActive
      ? uiChip('ACTIVE', 'active') : uiChip('INACTIVE', 'inactive') },
  { key: 'activeCertCount', label: 'Active certs', num: true, render: u => u.userType === 'client'
      ? '<span class="ui-muted">—</span>' : (Number(u.activeCertCount) > 0 ? uiNum(u.activeCertCount) : '<span class="ui-chip ui-chip-warn">none</span>') },
];

function initUsersToolbar(){
  const host = document.getElementById('usersToolbar');
  if(!host || _usersToolbarWired) return;
  _usersToolbarWired = true;
  host.innerHTML = `
    <input type="search" class="ui-input usr-search" id="usrSearch" placeholder="Search name or email…" autocomplete="off" spellcheck="false">
    <div class="cb-wrap usr-role" id="usrRoleFilterWrap"></div>
    <label class="ui-check"><input type="checkbox" id="usrShowInactive"> Show inactive</label>`;
  host.querySelector('#usrSearch').addEventListener('input', debounce(() => loadUsers(), 350));
  host.querySelector('#usrShowInactive').addEventListener('change', e => { _usersShowInactive = e.target.checked; loadUsers(); });
  initCombo('usrRoleFilterWrap', [{ value: '', label: 'All roles' }], { placeholder: 'All roles', onChange: v => { _usersRoleFilter = v; loadUsers(); } });
}

async function loadUsers(){
  // The filter bar is part of the page chrome: it renders before, and
  // independently of, the list — a toolbar hiccup must never blank the table.
  try { initUsersToolbar(); } catch(e){ console.error('[users] toolbar', e); }
  uiTableLoading('usersBody', USER_COLS);
  const qs = new URLSearchParams({ active: _usersShowInactive ? 'all' : 'true' });
  const q = (document.getElementById('usrSearch')?.value || '').trim();
  if(q) qs.set('q', q);
  if(_usersRoleFilter) qs.set('role', _usersRoleFilter);
  const r = await apiGet(`/users?${qs.toString()}`);
  if(r === null) return uiTableError('usersBody', USER_COLS, 'Could not load users', loadUsers);
  _usersData = { rows: Array.isArray(r.rows) ? r.rows : [], roles: Array.isArray(r.roles) ? r.roles : [], scope: r.scope || 'onboard' };
  // Role filter options follow the tenant's roles (system + custom).
  const cur = cbVal('usrRoleFilterWrap');
  initCombo('usrRoleFilterWrap', [{ value: '', label: 'All roles' }].concat((r.roles || []).map(x => ({ value: x.key, label: x.name }))),
    { placeholder: 'All roles', value: cur, onChange: v => { _usersRoleFilter = v; loadUsers(); } });
  uiTable('usersBody', {
    columns: USER_COLS, rows: _usersData.rows, rowKey: 'id',
    sortable: true, patch: true,
    onRowClick: u => openUserModal(u.id),
    empty: q || _usersRoleFilter ? 'No users match that filter.' : 'No users yet — use Add user.',
  });
}

function _assignableRoles(){ return (_usersData.roles || []).filter(r => r.assignable); }

// =============================================================================
// ADD USER
// =============================================================================
async function openAddUserModal(){
  if(!_usersData.roles.length) await loadUsers();
  const roleOpts = _assignableRoles().map(r => ({ value: r.key, label: `${r.name}${r.is_system ? '' : ' (custom, ' + r.base_role + ')'}` }));
  if(!roleOpts.length) return uiToast('No roles you may assign', 'error');
  const m = uiModal({
    title: 'Add user',
    width: 560,
    body: `
      ${uiField({ id: 'nuName', label: 'Full name *', placeholder: 'e.g. Maria Lopez' })}
      ${uiField({ id: 'nuEmail', label: 'Email (login) *', type: 'email', placeholder: 'maria@tpfswarehouse.com', hint: 'Floor staff without email: any unique address works as a login name, e.g. maria@floor.local' })}
      <div class="ui-field" data-field="nuRoleWrap">
        <label class="ui-label">Role *</label>
        <div class="cb-wrap" id="nuRoleWrap"></div>
        <div class="ui-field-err" style="display:none;"></div>
      </div>
      <div class="ui-field" data-field="nuClientWrap" id="nuClientField" hidden>
        <label class="ui-label">Client (portal users) *</label>
        <div class="cb-wrap" id="nuClientWrap"></div>
        <div class="ui-field-err" style="display:none;"></div>
      </div>
      <div class="ui-banner ui-banner-info">A temporary password is generated and shown once. The user must set their own password at first login.</div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Create user', primary: true, onClick: async (api) => {
        const name = api.el.querySelector('#nuName').value.trim();
        const email = api.el.querySelector('#nuEmail').value.trim().toLowerCase();
        const role = cbVal('nuRoleWrap');
        const isPortal = (_usersData.roles.find(r => r.key === role) || {}).base_role === 'portal';
        const clientId = isPortal ? cbVal('nuClientWrap') : '';
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        uiFieldError(api.el, 'nuName', name.length >= 2 ? '' : 'Full name is required');
        uiFieldError(api.el, 'nuEmail', emailOk ? '' : 'A valid email is required');
        uiFieldError(api.el, 'nuRoleWrap', role ? '' : 'Pick a role');
        uiFieldError(api.el, 'nuClientWrap', (!isPortal || clientId) ? '' : 'Portal users need a client');
        if(name.length < 2 || !role || (isPortal && !clientId) || !emailOk) return false;
        const r = await fetch(`${API}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
          body: JSON.stringify({ email, fullName: name, role, clientId: clientId || undefined }) });
        const d = await r.json().catch(() => ({}));
        if(!r.ok){
          if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not create the user', 'error');
          if(/email|exists/i.test(d.error || '')) uiFieldError(api.el, 'nuEmail', d.error);
          return false;
        }
        uiToast(`${d.user.fullName} created`);
        loadUsers();
        pwShowTempPassword(d.user.fullName, d.tempPassword);
      } },
    ],
  });
  initCombo('nuRoleWrap', roleOpts, { placeholder: 'Select a role…', onChange: async (v) => {
    const isPortal = (_usersData.roles.find(r => r.key === v) || {}).base_role === 'portal';
    document.getElementById('nuClientField').hidden = !isPortal;
    if(isPortal && typeof loadCC === 'function'){
      await loadCC();
      initCombo('nuClientWrap', clientsCache.map(c => ({ value: String(c.id), label: `${c.code} — ${c.name}` })), { placeholder: 'Pick a client…' });
    }
  } });
  return m;
}

// =============================================================================
// USER DETAIL — account, overrides, certifications
// =============================================================================
let CERT_M = null;   // open user modal (certs section lives inside it)

async function openUserModal(userId){
  const u = (_usersData.rows || []).find(x => x.id === userId);
  if(!u) return uiToast('Reload the list and try again', 'error');
  _userCertCurrent = { id: userId, full_name: u.fullName, email: u.email, user_type: u.userType, is_supervisor: u.baseRole === 'supervisor' || u.baseRole === 'admin' };
  const isPortal = u.userType === 'client';
  const canEdit = !!u.editable;
  const canOverrides = can('users.manage') && !isPortal && u.baseRole !== 'admin';
  const roleOpts = _assignableRoles().filter(r => (r.base_role === 'portal') === isPortal)
    .map(r => ({ value: r.key, label: `${r.name}${r.is_system ? '' : ' (custom, ' + r.base_role + ')'}` }));
  if(!roleOpts.some(o => o.value === u.role)) roleOpts.unshift({ value: u.role, label: u.roleName });

  CERT_M = uiModal({
    title: u.fullName || u.email,
    width: 760,
    body: `
      ${uiMeta([
        { k: 'Email', v: uiId(u.email) },
        { k: 'Role', v: userRoleChip(u) },
        { k: 'Status', v: u.isActive ? uiChip('ACTIVE', 'active') : uiChip('INACTIVE', `inactive since ${esc(u.deactivatedAt ? fmtTimeShort(u.deactivatedAt) : '—')}`) },
        { k: 'Last login', v: u.lastLoginAt ? uiId(fmtTimeShort(u.lastLoginAt)) : '<span class="ui-muted">never</span>' },
        ...(isPortal ? [{ k: 'Client', v: `${uiId(u.clientCode || '')} <span class="ui-muted">${esc(u.clientName || '')}</span>` }] : []),
        { k: 'Created', v: u.createdAt ? uiId(fmtTimeShort(u.createdAt)) : '<span class="ui-muted">—</span>' },
      ])}
      ${canEdit ? `
      <div class="eo-section">
        <div class="item-sec-head"><div class="ui-label">Account</div></div>
        <div class="ui-field-row">
          ${uiField({ id: 'euName', label: 'Full name', value: u.fullName || '' })}
          <div class="ui-field" data-field="euRoleWrap">
            <label class="ui-label">Role</label>
            <div class="cb-wrap" id="euRoleWrap"></div>
            <div class="ui-field-err" style="display:none;"></div>
          </div>
        </div>
        ${isPortal ? `<div class="ui-field" data-field="euClientWrap"><label class="ui-label">Client</label><div class="cb-wrap" id="euClientWrap"></div><div class="ui-field-err" style="display:none;"></div></div>` : ''}
        <div class="usr-actions">
          <button type="button" class="ui-btn ui-btn-primary js-usr-save">Save changes</button>
          ${u.isActive && u.id !== U?.id ? '<button type="button" class="ui-btn js-usr-reset">Reset password</button>' : ''}
          ${u.isActive ? '<button type="button" class="ui-btn js-usr-signout" title="Revoke every active session of this account — they must sign in again everywhere">Sign out everywhere</button>' : ''}
          <span style="flex:1"></span>
          ${u.id === U?.id ? '<span class="ui-hint">This is you — role and status are changed by another admin.</span>'
            : (u.isActive ? '<button type="button" class="ui-btn ui-btn-danger js-usr-deactivate">Deactivate</button>'
                          : '<button type="button" class="ui-btn js-usr-reactivate">Reactivate</button>')}
        </div>
      </div>` : ''}
      ${canOverrides ? `
      <div class="eo-section">
        <div class="item-sec-head">
          <div class="ui-label">Permission overrides</div>
          <span class="ui-hint">on top of the ${esc(u.roleName)} role · admin only</span>
          <span style="flex:1"></span>
          <button type="button" class="ui-btn js-usr-ovr-toggle">Edit overrides</button>
        </div>
        <div id="usrOverridesBody"></div>
      </div>` : ''}
      ${!isPortal ? `
      <div class="eo-section">
        <div class="item-sec-head">
          <div class="ui-label">Certifications</div>
          <span style="flex:1"></span>
          <button class="ui-btn" id="certGrantBtn">Grant cert</button>
        </div>
        <div id="userCertList"></div>
      </div>` : ''}`,
    actions: [{ label: 'Close' }],
    onClose: () => { CERT_M = null; },
  });
  const el = CERT_M.el;

  if(canEdit){
    initCombo('euRoleWrap', roleOpts, { placeholder: 'Role', value: u.role });
    if(isPortal && typeof loadCC === 'function'){
      await loadCC();
      initCombo('euClientWrap', clientsCache.map(c => ({ value: String(c.id), label: `${c.code} — ${c.name}` })), { placeholder: 'Client', value: u.clientId ? String(u.clientId) : '' });
    }
    el.querySelector('.js-usr-save').addEventListener('click', uiBusyHandler(async () => {
      const body = { fullName: el.querySelector('#euName').value.trim() };
      const role = cbVal('euRoleWrap'); if(role && role !== u.role) body.role = role;
      if(isPortal){ const c = cbVal('euClientWrap'); if(c && c !== String(u.clientId)) body.clientId = c; }
      const r = await fetch(`${API}/users/${u.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not save', 'error'); return false; }
      uiToast(d.changed && d.changed.length ? `Saved (${d.changed.join(', ')})` : 'Nothing to save');
      CERT_M.close(); loadUsers();
    }));
    el.querySelector('.js-usr-reset')?.addEventListener('click', uiBusyHandler(async () => { await pwAdminReset(u.id, u.fullName || u.email); return false; }));
    el.querySelector('.js-usr-signout')?.addEventListener('click', uiBusyHandler(() => signOutEverywhere(u)));
    el.querySelector('.js-usr-deactivate')?.addEventListener('click', uiBusyHandler(() => setUserActive(u, false)));
    el.querySelector('.js-usr-reactivate')?.addEventListener('click', uiBusyHandler(() => setUserActive(u, true)));
  }
  if(canOverrides){
    el.querySelector('.js-usr-ovr-toggle').addEventListener('click', uiBusyHandler(() => renderUserOverrides(u.id, el)));
    renderUserOverridesSummary(u.id);
  }
  if(!isPortal){
    document.getElementById('certGrantBtn').addEventListener('click', uiBusyHandler(openGrantCertForm));
    await renderUserCertList(userId);
  }
}

async function signOutEverywhere(u){
  const self = u.id === U?.id;
  const ok = await uiConfirm({
    title: `Sign ${self ? 'yourself' : (u.fullName || u.email)} out everywhere?`,
    body: self ? 'Every device signed in as you, including this one, is signed out at once. You will land on the login screen.'
               : 'Every tablet, phone or browser signed in as this account is signed out at once. They can sign in again with their password.',
    confirmLabel: 'Sign out everywhere', danger: true,
  });
  if(!ok) return false;
  const r = await fetch(`${API}/users/${u.id}/sign-out-everywhere`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}' });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not sign the account out', 'error'); return false; }
  if(self){ try { sessionStorage.clear(); } catch(_) {} location.reload(); return; }
  uiToast(`${u.fullName || u.email} signed out everywhere`);
}

async function setUserActive(u, active){
  const ok = await uiConfirm({
    title: active ? `Reactivate ${u.fullName || u.email}?` : `Deactivate ${u.fullName || u.email}?`,
    body: active ? 'They can sign in again with their existing password.'
                 : 'They are signed out within a minute and cannot sign in until reactivated. Their history stays.',
    confirmLabel: active ? 'Reactivate' : 'Deactivate', danger: !active,
  });
  if(!ok) return false;
  const r = await fetch(`${API}/users/${u.id}/${active ? 'reactivate' : 'deactivate'}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}' });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not change status', 'error'); return false; }
  uiToast(active ? 'Reactivated' : 'Deactivated — signed out within a minute', active ? 'success' : 'error');
  if(CERT_M) CERT_M.close();
  if(!active){
    _usersShowInactive = true;
    const cb = document.getElementById('usrShowInactive'); if(cb) cb.checked = true;
  }
  loadUsers();
}

// ---- overrides ---------------------------------------------------------------

async function renderUserOverridesSummary(userId){
  const host = document.getElementById('usrOverridesBody');
  if(!host) return;
  const d = await apiGet(`/users/${userId}/overrides`);
  if(!d){ host.innerHTML = uiError('Could not load overrides'); return; }
  const tag = (k, tone) => `<span class="idn-tag ${tone}">${esc(k)}</span>`;
  host.innerHTML = (!d.extra.length && !d.removed.length)
    ? '<div class="ui-hint">No overrides — this user has exactly the role\'s permissions.</div>'
    : `<div class="usr-ovr-summary">
         ${d.extra.length ? `<div><span class="ui-label">Extra</span> ${d.extra.map(k => tag(k, 'idn-tag-primary')).join(' ')}</div>` : ''}
         ${d.removed.length ? `<div><span class="ui-label">Removed</span> ${d.removed.map(k => tag(k, 'usr-tag-removed')).join(' ')}</div>` : ''}
       </div>`;
}

async function renderUserOverrides(userId, scopeEl){
  const host = document.getElementById('usrOverridesBody');
  host.innerHTML = uiSpinner('Loading…');
  const d = await apiGet(`/users/${userId}/overrides`);
  if(!d){ host.innerHTML = uiError('Could not load overrides'); return; }
  const ovr = Object.fromEntries(d.overrides.map(o => [o.key, o.allowed]));
  const groups = [];
  for(const p of d.permissions){ let g = groups.find(x => x.name === p.group); if(!g){ g = { name: p.group, rows: [] }; groups.push(g); } g.rows.push(p); }
  const roleHas = new Set(d.roleEffective);
  host.innerHTML = `
    <div class="ui-hint" style="margin-bottom:8px;">Inherit = whatever the ${esc(d.role.name)} role says. Allow / Deny wins over the role. Locked keys stay admin-only.</div>
    <div class="roles-grid-wrap"><table class="ui-table roles-grid">
      <thead><tr><th>Permission</th><th class="roles-col">${esc(d.role.name)}</th><th class="roles-col">Override</th><th class="roles-col">Effective</th></tr></thead>
      <tbody>${groups.map(g => `
        <tr class="roles-group"><td colspan="4">${esc(g.name)}</td></tr>
        ${g.rows.map(p => {
          const o = ovr[p.key];
          const eff = o === true ? true : o === false ? false : roleHas.has(p.key);
          return `<tr data-key="${esc(p.key)}">
            <td><div>${esc(p.label)}</div><div class="ui-hint ui-mono">${esc(p.key)}</div></td>
            <td class="roles-col">${roleHas.has(p.key) ? '<span class="roles-lock">✓</span>' : '<span class="ui-muted">—</span>'}</td>
            <td class="roles-col">${p.locked ? '<span class="roles-lock-off">—</span>'
              : `<select class="ui-input usr-ovr-sel js-usr-ovr" data-key="${esc(p.key)}">
                   <option value="inherit"${o == null ? ' selected' : ''}>Inherit</option>
                   <option value="allow"${o === true ? ' selected' : ''}>Allow</option>
                   <option value="deny"${o === false ? ' selected' : ''}>Deny</option>
                 </select>`}</td>
            <td class="roles-col">${eff ? '<span class="roles-lock">✓</span>' : '<span class="ui-muted">—</span>'}</td>
          </tr>`; }).join('')}`).join('')}
      </tbody></table></div>
    <div class="usr-actions"><button type="button" class="ui-btn ui-btn-primary js-usr-ovr-save">Save overrides</button>
      <button type="button" class="ui-btn js-usr-ovr-cancel">Cancel</button></div>`;
  host.querySelector('.js-usr-ovr-cancel').addEventListener('click', uiBusyHandler(() => renderUserOverridesSummary(userId)));
  host.querySelector('.js-usr-ovr-save').addEventListener('click', uiBusyHandler(async () => {
    const changes = [];
    host.querySelectorAll('.js-usr-ovr').forEach(sel => {
      const want = sel.value === 'inherit' ? null : sel.value === 'allow';
      const had = ovr[sel.dataset.key] == null ? null : ovr[sel.dataset.key];
      if(want !== had) changes.push({ key: sel.dataset.key, allowed: want });
    });
    if(!changes.length) return uiToast('No override changes', 'error');
    const r = await fetch(`${API}/users/${userId}/overrides`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ changes }) });
    const d2 = await r.json().catch(() => ({}));
    if(!r.ok){ if(d2.code === 'PERMISSION_DENIED') permDeniedToast(d2); else uiToast(d2.error || 'Could not save overrides', 'error'); return false; }
    uiToast(`${changes.length} override${changes.length === 1 ? '' : 's'} saved`);
    renderUserOverridesSummary(userId);
    loadUsers();
  }));
}

// =============================================================================
// CERTIFICATIONS (unchanged behaviour) — full history, grant, revoke
// =============================================================================

// Cert state -> the frozen tone scale. Expiring-soon is the one that matters:
// it's the only state you can still act on before someone is uncertified.
const CERT_TONE = {
  active: 'ok', expiring_soon: 'warn', expired: 'danger', revoked: 'neutral',
};

async function renderUserCertList(userId){
  const list = document.getElementById('userCertList');
  if(!list) return;
  list.innerHTML = uiSpinner('Loading certifications…');
  const r = await apiGet(`/users/${userId}/certs`);
  if(!r){ list.innerHTML = uiError('Could not load certifications'); return; }
  const rows = r.rows || [];
  if(!rows.length){
    list.innerHTML = uiEmpty('No certifications on file — use Grant cert to add one.');
    return;
  }

  list.innerHTML = rows.map(c => {
    const canRevoke = c.state === 'active' || c.state === 'expiring_soon';
    return `
      <div class="cert-card">
        <div class="cert-card-head">
          <strong>${esc(c.cert_type_display || c.cert_type)}</strong>
          ${uiChip(c.state, (c.state || '').replace('_', ' '))}
          <span style="flex:1"></span>
          ${canRevoke ? `<button class="ui-btn ui-btn-danger js-revoke-cert" data-cert-id="${esc(c.id)}">Revoke</button>` : ''}
        </div>
        <div class="ui-hint">
          ${c.cert_number ? `Cert # ${esc(c.cert_number)} · ` : ''}
          Issued ${esc(c.issued_at ? new Date(c.issued_at).toLocaleDateString() : '—')} ·
          Expires ${esc(c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '—')}
          ${(c.covers_modes || []).length ? ` · Covers ${esc((c.covers_modes || []).join(', '))}` : ''}
          ${c.issuing_body ? ` · ${esc(c.issuing_body)}` : ''}
        </div>
        ${c.revoked_at ? `<div class="ui-banner ui-banner-danger" style="margin:8px 0 0;">
          Revoked ${esc(fmtTimeShort(c.revoked_at))}${c.revoked_reason ? ` — ${esc(c.revoked_reason)}` : ''}</div>` : ''}
        ${c.notes ? `<div class="ui-hint" style="font-style:italic;">${esc(c.notes)}</div>` : ''}
      </div>`;
  }).join('');

  list.querySelectorAll('.js-revoke-cert').forEach(btn =>
    btn.addEventListener('click', uiBusyHandler(e => {
      e.stopPropagation();
      revokeUserCert(btn.dataset.certId, rows.find(x => x.id === btn.dataset.certId));
    })));
}

// UI_STATUS_MAP additions live in ui.js; cert states map through CERT_TONE for
// anything the shared map doesn't know.
function certChipTone(state){ return CERT_TONE[state] || 'neutral'; }

async function revokeUserCert(certId, cert){
  const who = _userCertCurrent?.full_name || _userCertCurrent?.email || 'this user';
  uiModal({
    title: `Revoke ${cert?.cert_type_display || cert?.cert_type || 'certification'}?`,
    width: 520,
    body:
      `<div class="ui-banner ui-banner-danger">
         <strong>${esc(who)}</strong> will no longer be certified for
         ${esc((cert?.covers_modes || []).join(', ') || 'this mode')}. If they are mid-shift on
         hazmat work, that work has to stop. The revocation is permanent and audited.
       </div>` +
      uiField({ id: 'revReason', label: 'Reason',
                placeholder: 'e.g. cert suspended by issuer pending re-test',
                hint: 'Recorded against the certification. Minimum 5 characters.' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Revoke certification', danger: true, onClick: async (m) => {
          const reason = m.el.querySelector('#revReason').value.trim();
          uiFieldError(m.el, 'revReason', reason.length >= 5 ? '' : 'At least 5 characters');
          if(reason.length < 5) return false;

          const r = await fetch(`${API}/users/${_userCertCurrent.id}/certs/${certId}/revoke`, {
            method:'POST',
            headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${T}` },
            body: JSON.stringify({ reason }),
          });
          const d = await r.json().catch(() => ({}));
          if(!r.ok){ uiFieldError(m.el, 'revReason', d.error || 'Revoke failed'); return false; }
          uiToast('Certification revoked', 'error');
          renderUserCertList(_userCertCurrent.id);
          // If it was ours, the topbar cert ribbon is now wrong.
          if(_userCertCurrent.id === U?.id && typeof refreshCertExpiryRibbon === 'function'){
            refreshCertExpiryRibbon();
          }
        } },
    ],
  });
}

// =============================================================================
// GRANT CERT FORM
// =============================================================================

async function openGrantCertForm(){
  const today = new Date();
  const oneYr = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());

  const m = uiModal({
    title: `Grant certification — ${_userCertCurrent?.full_name || _userCertCurrent?.email || ''}`,
    width: 560,
    body: `
      <div class="ui-field" data-field="grantCertTypeWrap">
        <label class="ui-label">Certification *</label>
        <div class="cb-wrap" id="grantCertTypeWrap"></div>
        <div class="ui-hint">Picking a type sets the usual validity window — override it if the certificate says otherwise.</div>
        <div class="ui-field-err" style="display:none;"></div>
      </div>
      <div class="ui-field-row">
        ${uiField({ id: 'grantCertIssued', label: 'Issued *', type: 'date',
                    value: today.toISOString().slice(0, 10) })}
        ${uiField({ id: 'grantCertExpires', label: 'Expires *', type: 'date',
                    value: oneYr.toISOString().slice(0, 10) })}
      </div>
      ${uiField({ id: 'grantCertBody', label: 'Issuing body *',
                  placeholder: 'e.g. IATA, or "Internal" for your own training program' })}
      ${uiField({ id: 'grantCertNumber', label: 'Certificate #' })}
      ${uiField({ id: 'grantCertNotes', label: 'Notes' })}`,
    actions: [
      { label: 'Cancel' },
      { label: 'Grant', primary: true, onClick: submitGrantCert },
    ],
  });

  // INTERNAL_SAFETY_LEAD is admin-only to grant.
  const types = await apiGet('/cert-types');
  const opts = (types?.rows || [])
    .filter(t => U?.userType === 'admin' || U?.role === 'admin' || t.cert_type !== 'INTERNAL_SAFETY_LEAD')
    .map(t => ({ value: t.cert_type, label: t.display_name }));

  initCombo('grantCertTypeWrap', opts, {
    placeholder: 'Select a certification…',
    onChange: (val) => {
      // Usual validity windows: DOT / internal 3 years, IATA & IMDG 2 years,
      // everything else 1. Ops can still override — the certificate wins.
      const days = (val === 'DOT' || val === 'INTERNAL_SAFETY_LEAD') ? 1095
                 : (val === 'IATA_DGR' || val === 'IMDG')            ? 730
                 :                                                      365;
      const issued  = new Date(document.getElementById('grantCertIssued').value || Date.now());
      const expires = new Date(issued);
      expires.setDate(expires.getDate() + days);
      document.getElementById('grantCertExpires').value = expires.toISOString().slice(0, 10);
    },
  });
  return m;
}

// uiModal action — returning false keeps the modal open.
async function submitGrantCert(m){
  const v = (id) => document.getElementById(id).value.trim();
  const certType = cbVal('grantCertTypeWrap');
  const issued   = v('grantCertIssued');
  const expires  = v('grantCertExpires');
  const body     = v('grantCertBody');

  uiFieldError(m.el, 'grantCertTypeWrap', certType ? '' : 'Pick a certification');
  uiFieldError(m.el, 'grantCertIssued', issued ? '' : 'Required');
  uiFieldError(m.el, 'grantCertExpires', expires ? '' : 'Required');
  uiFieldError(m.el, 'grantCertBody', body
    ? '' : 'Required — use "Internal" if your own training program issued it');
  if(!certType || !issued || !expires || !body) return false;

  if(new Date(expires) < new Date(issued)){
    uiFieldError(m.el, 'grantCertExpires', 'Expiry is before the issue date');
    return false;
  }
  // A certificate that expired before it was even entered certifies nobody.
  if(new Date(expires) < new Date()){
    const ok = await uiConfirm({
      title: 'This certificate is already expired',
      body: `It expires <strong>${esc(expires)}</strong>, which is in the past. It will be recorded as EXPIRED and won't certify anyone for hazmat work.`,
      confirmLabel: 'Record it anyway',
    });
    if(!ok) return false;
  }

  try {
    const r = await fetch(`${API}/users/${_userCertCurrent.id}/certs`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${T}` },
      body: JSON.stringify({
        cert_type: certType,
        cert_number: v('grantCertNumber') || null,
        issuing_body: body,
        issued_at: issued,
        expires_at: expires,
        notes: v('grantCertNotes') || null,
      }),
    });
    const d = await r.json();
    if(!r.ok){ uiToast(d.error || 'Grant failed', 'error'); return false; }

    uiToast('Certification granted');
    renderUserCertList(_userCertCurrent.id);
    loadUsers();
    // If we granted to ourselves, the topbar expiry ribbon is now stale.
    if(_userCertCurrent.id === U?.id && typeof refreshCertExpiryRibbon === 'function'){
      refreshCertExpiryRibbon();
    }
  } catch(e){
    uiToast('Network error — the certification was not granted', 'error');
    return false;
  }
}

// =============================================================================
// SKU COMPLIANCE AUDIT PANEL — shown in the inventory.js item edit modal.
// Read-only feed of every change to hazmat / compliance fields on the SKU.
// =============================================================================

async function loadSkuComplianceAudit(skuId){
  const block = document.getElementById('itemAuditBlock');
  if(!block || !skuId) return;
  block.style.display = 'block';
  const body  = document.getElementById('itemAuditBody');
  const count = document.getElementById('itemAuditCount');
  body.innerHTML = '<div class="empty-state" style="font-size:12px;">Loading…</div>';
  const r = await apiGet(`/skus/${skuId}/compliance-audit`);
  if(!r){ body.innerHTML = '<div class="empty-state" style="color:var(--red);font-size:12px;">Could not load audit</div>'; return; }
  const rows = r.rows || [];
  count.textContent = rows.length ? `(${rows.length} change${rows.length === 1 ? '' : 's'})` : '(none)';
  if(!rows.length){
    body.innerHTML = '<div class="empty-state" style="font-size:11px;padding:8px;">No compliance changes recorded yet for this SKU.</div>';
    return;
  }
  body.innerHTML = rows.map(a => {
    const ts = new Date(a.created_at).toLocaleString();
    const sourceColor = a.change_source === 'sds_auto'     ? 'var(--green)'
                      : a.change_source === 'sds_reviewer' ? 'var(--blue)'
                      : a.change_source === 'manual'        ? 'var(--amber)'
                      : 'var(--text2)';
    return `
      <div style="border-left:2px solid ${sourceColor};padding:6px 0 6px 10px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--blue);">${esc(a.field_key)}</span>
          <span style="color:${sourceColor};font-size:10px;font-weight:700;text-transform:uppercase;">${esc(a.change_source)}</span>
          <div style="flex:1"></div>
          <span style="font-size:10px;color:var(--muted);">${esc(ts)}</span>
        </div>
        <div style="font-size:11px;margin-top:2px;">
          <span style="color:var(--muted);">${esc(a.old_value || '(none)')}</span>
          <span style="color:#ffb380;margin:0 6px;">→</span>
          <span style="color:var(--text);">${esc(a.new_value || '(none)')}</span>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">
          ${a.actor_email ? esc(a.actor_email) : 'system'}${a.actor_role_at_time ? ' · ' + esc(a.actor_role_at_time) : ''}${a.reason ? ' · ' + esc(a.reason) : ''}
        </div>
      </div>`;
  }).join('');
}

function toggleSkuAuditPanel(){
  const body = document.getElementById('itemAuditBody');
  const tog  = document.getElementById('itemAuditToggle');
  if(!body) return;
  const open = body.style.display === '';
  body.style.display = open ? 'none' : '';
  if(tog) tog.textContent = open ? '▾ Show' : '▴ Hide';
}
