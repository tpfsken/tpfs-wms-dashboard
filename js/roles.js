'use strict';
// =============================================================================
// ROLES & PERMISSIONS — Settings card (admin, settings.roles).
// =============================================================================
// GET /settings/roles                 -> catalog, roles (system + custom), defaults,
//                                        overrides, effective per role key
// PUT /settings/roles                 { changes: [{ role, key, allowed: true|false|null }] }
// POST /settings/roles/custom         { name, base_role, copy_from? }
// PUT  /settings/roles/custom/:key    { name }        DELETE /settings/roles/custom/:key
//
// Grid: one row per permission grouped by module; one column per role. Admin
// is fixed (always on, locked). Every configurable role (system supervisor /
// floor and every custom role) gets checkboxes; a cell that differs from the
// role's BASE default shows an "override" tag. Portal is not shown (no ops
// permissions). Custom role headers carry rename / delete.

let _rolesGrid = null;      // last GET payload
let _rolesDirty = {};       // `${role}|${key}` -> true|false|null (null = back to default)

async function loadRolesCard(){
  const host = document.getElementById('rolesBody');
  if(!host) return;
  host.innerHTML = uiSpinner('Loading roles…');
  const d = await apiGet('/settings/roles');
  if(!d){ host.innerHTML = uiError('Could not load roles (admin only)'); return; }
  _rolesGrid = d;
  _rolesDirty = {};
  renderRolesGrid();
}

function _roleRow(key){ return (_rolesGrid.roles || []).find(r => r.key === key); }
function _roleDefault(key, perm){ const r = _roleRow(key); return !!r && (_rolesGrid.defaults[r.base_role] || []).includes(perm); }
function _roleEffective(role, key){
  const dirty = _rolesDirty[`${role}|${key}`];
  if(dirty === true || dirty === false) return dirty;
  if(dirty === null) return _roleDefault(role, key);
  return (_rolesGrid.effective[role] || []).includes(key);
}
function _roleIsOverride(role, key){ return _roleEffective(role, key) !== _roleDefault(role, key); }

function renderRolesGrid(){
  const host = document.getElementById('rolesBody');
  const g = _rolesGrid;
  if(!g.migrated){
    host.innerHTML = `<div class="ui-banner ui-banner-warn">Roles are not configurable until migrations 093/094 (users.role / roles / role_permissions) have been applied to the database. Everyone runs on the defaults until then.</div>`;
    return;
  }
  const cols = (g.roles || []).filter(r => r.base_role !== 'portal');   // admin first, then supervisor, floor, customs
  const configurable = cols.filter(r => r.configurable).map(r => r.key);
  const groups = [];
  for(const p of g.permissions){
    let grp = groups.find(x => x.name === p.group);
    if(!grp){ grp = { name: p.group, rows: [] }; groups.push(grp); }
    grp.rows.push(p);
  }
  const dirtyCount = Object.keys(_rolesDirty).length;
  const header = (r) => `<th class="roles-col">
      <div class="roles-head">${esc(r.name)}${r.is_system ? '' : ` <span class="ui-hint">custom · ${esc(r.base_role)}</span>`}</div>
      ${r.is_system ? '' : `<div class="roles-head-acts">
        <button type="button" class="ui-btn js-role-rename" data-key="${esc(r.key)}" title="Rename">Rename</button>
        <button type="button" class="ui-btn js-role-delete" data-key="${esc(r.key)}" title="${r.user_count ? esc(r.user_count + ' user(s) hold this role') : 'Delete'}" ${r.user_count ? 'disabled' : ''}>Delete</button>
      </div>`}
      ${r.user_count != null ? `<div class="ui-hint">${esc(r.user_count)} user${r.user_count === 1 ? '' : 's'}</div>` : ''}
    </th>`;
  host.innerHTML = `
    <div class="roles-toolbar">
      <span class="ui-hint">Admin always has everything. Every other role starts from its base (Supervisor or Floor) defaults; tick or untick to override for this warehouse. Locked rows are admin-only.</span>
      <span style="flex:1"></span>
      <span class="ui-hint js-roles-dirty">${dirtyCount ? esc(dirtyCount + ' unsaved change' + (dirtyCount === 1 ? '' : 's')) : ''}</span>
      <button type="button" class="ui-btn js-role-new">+ New role</button>
      <button type="button" class="ui-btn js-roles-reload">Discard</button>
      <button type="button" class="ui-btn ui-btn-primary js-roles-save" ${dirtyCount ? '' : 'disabled'}>Save changes</button>
    </div>
    <div class="roles-grid-wrap">
      <table class="ui-table roles-grid">
        <thead><tr><th>Permission</th>${cols.map(header).join('')}<th></th></tr></thead>
        <tbody>
          ${groups.map(grp => `
            <tr class="roles-group"><td colspan="${cols.length + 2}">${esc(grp.name)}</td></tr>
            ${grp.rows.map(p => `
              <tr data-key="${esc(p.key)}">
                <td><div>${esc(p.label)}</div><div class="ui-hint ui-mono">${esc(p.key)}</div></td>
                ${cols.map(r => {
                  if(!r.configurable) return `<td class="roles-col"><span class="roles-lock" title="Admin always has this">✓</span></td>`;
                  if(p.locked) return `<td class="roles-col"><span class="roles-lock roles-lock-off" title="Admin-only — cannot be granted">—</span></td>`;
                  const eff = _roleEffective(r.key, p.key), ov = _roleIsOverride(r.key, p.key);
                  return `<td class="roles-col"><label class="roles-cell"><input type="checkbox" class="js-roles-cb" data-role="${esc(r.key)}" data-key="${esc(p.key)}" ${eff ? 'checked' : ''}>${ov ? '<span class="idn-tag idn-tag-primary">override</span>' : ''}</label></td>`;
                }).join('')}
                <td>${(!p.locked && configurable.some(k => _roleIsOverride(k, p.key))) ? `<button type="button" class="ui-btn js-roles-reset" data-key="${esc(p.key)}" title="Back to the defaults for this permission">Reset</button>` : ''}</td>
              </tr>`).join('')}
          `).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('.js-roles-cb').forEach(cb => cb.addEventListener('change', () => {
    const role = cb.dataset.role, key = cb.dataset.key;
    const def = _roleDefault(role, key);
    const cur = (_rolesGrid.effective[role] || []).includes(key);
    const want = cb.checked;
    const k = `${role}|${key}`;
    if(want === cur) delete _rolesDirty[k];
    else _rolesDirty[k] = (want === def) ? null : want;   // equal to the default = remove the override
    renderRolesGrid();
  }));
  host.querySelectorAll('.js-roles-reset').forEach(b => b.addEventListener('click', uiBusyHandler(() => {
    for(const role of configurable){
      const k = `${role}|${b.dataset.key}`;
      const def = _roleDefault(role, b.dataset.key);
      const cur = (_rolesGrid.effective[role] || []).includes(b.dataset.key);
      if(cur !== def) _rolesDirty[k] = null; else delete _rolesDirty[k];
    }
    renderRolesGrid();
  })));
  host.querySelector('.js-roles-reload').addEventListener('click', uiBusyHandler(() => loadRolesCard()));
  host.querySelector('.js-roles-save').addEventListener('click', uiBusyHandler(() => saveRolesGrid()));
  host.querySelector('.js-role-new').addEventListener('click', uiBusyHandler(() => openNewRoleModal()));
  host.querySelectorAll('.js-role-rename').forEach(b => b.addEventListener('click', uiBusyHandler(() => renameRole(b.dataset.key))));
  host.querySelectorAll('.js-role-delete').forEach(b => b.addEventListener('click', uiBusyHandler(() => deleteRole(b.dataset.key))));
}

async function saveRolesGrid(){
  const changes = Object.entries(_rolesDirty).map(([k, allowed]) => { const [role, key] = k.split('|'); return { role, key, allowed }; });
  if(!changes.length) return uiToast('Nothing to save', 'error');
  const r = await fetch(`${API}/settings/roles`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ changes }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Could not save roles', 'error'); return false; }
  _rolesGrid = d; _rolesDirty = {};
  renderRolesGrid();
  uiToast(`${changes.length} permission change${changes.length === 1 ? '' : 's'} saved — users see it within a minute`);
  if(typeof loadMe === 'function') loadMe();
}

// ---- custom roles ----------------------------------------------------------------

async function openNewRoleModal(){
  const sources = (_rolesGrid.roles || []).filter(r => r.base_role !== 'admin' && r.base_role !== 'portal');
  const m = uiModal({
    title: 'New role',
    width: 520,
    body: `
      ${uiField({ id: 'nrName', label: 'Name *', placeholder: 'e.g. CSR, Dock lead, Inventory control' })}
      ${uiFieldSelect({ id: 'nrBase', label: 'Base role *', options: [{ value: 'floor', label: 'Floor — starts from the floor defaults' }, { value: 'supervisor', label: 'Supervisor — starts from the supervisor defaults' }], value: 'floor',
                        hint: 'Sets the defaults the new role starts from and who may assign it (floor roles can be assigned by supervisors with Onboard).' })}
      ${uiFieldSelect({ id: 'nrCopy', label: 'Copy permissions from', options: [{ value: '', label: '— base defaults only —' }].concat(sources.map(r => ({ value: r.key, label: r.name }))), value: '',
                        hint: 'Copies that role\'s current effective permissions as overrides on top of the base.' })}`,
    actions: [
      { label: 'Cancel' },
      { label: 'Create role', primary: true, onClick: async (api) => {
        const name = api.el.querySelector('#nrName').value.trim();
        uiFieldError(api.el, 'nrName', name.length >= 2 ? '' : 'At least 2 characters');
        if(name.length < 2) return false;
        const body = { name, base_role: api.el.querySelector('#nrBase').value, copy_from: api.el.querySelector('#nrCopy').value || undefined };
        const r = await fetch(`${API}/settings/roles/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if(!r.ok){ if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiFieldError(api.el, 'nrName', d.error || 'Could not create the role'); return false; }
        uiToast(`Role "${d.name}" created${d.overrides_copied ? ` (${d.overrides_copied} permission difference${d.overrides_copied === 1 ? '' : 's'} copied)` : ''}`);
        loadRolesCard();
      } },
    ],
  });
  return m;
}

async function renameRole(key){
  const r0 = _roleRow(key);
  const name = await uiPrompt({ title: `Rename ${r0?.name || key}`, label: 'Name', value: r0?.name || '', confirmLabel: 'Rename' });
  if(name == null) return;
  const r = await fetch(`${API}/settings/roles/custom/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ name: String(name).trim() }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not rename', 'error');
  uiToast(`Renamed to "${d.name}"`);
  loadRolesCard();
}

async function deleteRole(key){
  const r0 = _roleRow(key);
  const ok = await uiConfirm({ title: `Delete role "${r0?.name || key}"?`, body: 'Its permission overrides are removed. Users holding it must be moved to another role first — the API refuses otherwise.', confirmLabel: 'Delete role', danger: true });
  if(!ok) return;
  const r = await fetch(`${API}/settings/roles/custom/${encodeURIComponent(key)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not delete', 'error');
  uiToast('Role deleted', 'error');
  loadRolesCard();
}
