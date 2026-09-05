'use strict';
// =============================================================================
// ROLES & PERMISSIONS — Settings card (admin, settings.roles).
// =============================================================================
// GET /settings/roles  -> catalog, defaults, overrides, effective per role
// PUT /settings/roles  { changes: [{ role, key, allowed: true|false|null }] }
//
// Grid: one row per permission grouped by module; columns Admin (always on,
// locked), Supervisor, Floor. A cell that differs from the role's default
// shows an "override" tag; Reset row puts it back to defaults (allowed:null).
// The two locked keys render as locked cells for supervisor and floor.

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

function _roleEffective(role, key){
  const dirty = _rolesDirty[`${role}|${key}`];
  if(dirty === true || dirty === false) return dirty;
  if(dirty === null) return _rolesGrid.defaults[role].includes(key);
  return _rolesGrid.effective[role].includes(key);
}
function _roleIsOverride(role, key){
  const eff = _roleEffective(role, key);
  return eff !== _rolesGrid.defaults[role].includes(key);
}

function renderRolesGrid(){
  const host = document.getElementById('rolesBody');
  const g = _rolesGrid;
  if(!g.migrated){
    host.innerHTML = `<div class="ui-banner ui-banner-warn">Roles are not configurable until migration 093 (users.role / role_permissions) has been applied to the database. Everyone runs on the defaults until then.</div>`;
    return;
  }
  const groups = [];
  for(const p of g.permissions){
    let grp = groups.find(x => x.name === p.group);
    if(!grp){ grp = { name: p.group, rows: [] }; groups.push(grp); }
    grp.rows.push(p);
  }
  const dirtyCount = Object.keys(_rolesDirty).length;
  host.innerHTML = `
    <div class="roles-toolbar">
      <span class="ui-hint">Admin always has everything. Supervisor and Floor start from the defaults in the code; tick or untick to override for this warehouse. Locked rows are admin-only.</span>
      <span style="flex:1"></span>
      <span class="ui-hint js-roles-dirty">${dirtyCount ? esc(dirtyCount + ' unsaved change' + (dirtyCount === 1 ? '' : 's')) : ''}</span>
      <button type="button" class="ui-btn js-roles-reload">Discard</button>
      <button type="button" class="ui-btn ui-btn-primary js-roles-save" ${dirtyCount ? '' : 'disabled'}>Save changes</button>
    </div>
    <div class="roles-grid-wrap">
      <table class="ui-table roles-grid">
        <thead><tr><th>Permission</th><th class="roles-col">Admin</th><th class="roles-col">Supervisor</th><th class="roles-col">Floor</th><th></th></tr></thead>
        <tbody>
          ${groups.map(grp => `
            <tr class="roles-group"><td colspan="5">${esc(grp.name)}</td></tr>
            ${grp.rows.map(p => `
              <tr data-key="${esc(p.key)}">
                <td><div>${esc(p.label)}</div><div class="ui-hint ui-mono">${esc(p.key)}</div></td>
                <td class="roles-col"><span class="roles-lock" title="Admin always has this">✓</span></td>
                ${['supervisor', 'floor'].map(role => {
                  const eff = _roleEffective(role, p.key);
                  const ov = _roleIsOverride(role, p.key);
                  return `<td class="roles-col">
                    ${p.locked
                      ? '<span class="roles-lock roles-lock-off" title="Admin-only — cannot be granted">🔒</span>'.replace('🔒', '—')
                      : `<label class="roles-cell"><input type="checkbox" class="js-roles-cb" data-role="${esc(role)}" data-key="${esc(p.key)}" ${eff ? 'checked' : ''}>${ov ? '<span class="idn-tag idn-tag-primary">override</span>' : ''}</label>`}
                  </td>`;
                }).join('')}
                <td>${(!p.locked && (['supervisor','floor'].some(r => _roleIsOverride(r, p.key)))) ? `<button type="button" class="ui-btn js-roles-reset" data-key="${esc(p.key)}" title="Back to the defaults for this permission">Reset</button>` : ''}</td>
              </tr>`).join('')}
          `).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('.js-roles-cb').forEach(cb => cb.addEventListener('change', () => {
    const role = cb.dataset.role, key = cb.dataset.key;
    const def = _rolesGrid.defaults[role].includes(key);
    const cur = _rolesGrid.effective[role].includes(key);
    const want = cb.checked;
    const k = `${role}|${key}`;
    if(want === cur) delete _rolesDirty[k];
    else _rolesDirty[k] = (want === def) ? null : want;   // equal to the default = remove the override
    renderRolesGrid();
  }));
  host.querySelectorAll('.js-roles-reset').forEach(b => b.addEventListener('click', uiBusyHandler(() => {
    for(const role of ['supervisor', 'floor']){
      const k = `${role}|${b.dataset.key}`;
      const def = _rolesGrid.defaults[role].includes(b.dataset.key);
      const cur = _rolesGrid.effective[role].includes(b.dataset.key);
      if(cur !== def) _rolesDirty[k] = null; else delete _rolesDirty[k];
    }
    renderRolesGrid();
  })));
  host.querySelector('.js-roles-reload').addEventListener('click', uiBusyHandler(() => loadRolesCard()));
  host.querySelector('.js-roles-save').addEventListener('click', uiBusyHandler(() => saveRolesGrid()));
}

async function saveRolesGrid(){
  const changes = Object.entries(_rolesDirty).map(([k, allowed]) => {
    const [role, key] = k.split('|');
    return { role, key, allowed };
  });
  if(!changes.length) return uiToast('Nothing to save', 'error');
  const r = await fetch(`${API}/settings/roles`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ changes }),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){
    if(d.code === 'PERMISSION_DENIED') permDeniedToast(d);
    else uiToast(d.error || 'Could not save roles', 'error');
    return false;
  }
  _rolesGrid = d;
  _rolesDirty = {};
  renderRolesGrid();
  uiToast(`${changes.length} permission change${changes.length === 1 ? '' : 's'} saved — users see it within a minute`);
  if(typeof loadMe === 'function') loadMe();     // the admin's own gates (unchanged, but cheap)
}
