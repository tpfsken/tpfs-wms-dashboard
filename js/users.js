// =============================================================================
// USERS & CERTS — admin/supervisor management of warehouse staff +
// their hazmat certifications. Grants are PIN-less for v1 (we already
// gate at the role layer); revokes are admin-only (route enforces).
//
// Listing: GET /users (admin/supervisor)
// Per-user: GET /users/:id/certs   — full history (active + expired + revoked)
//           POST /users/:id/certs  — grant
//           POST /users/:id/certs/:certId/revoke — admin only
// Cert types: GET /cert-types — populates the grant form's dropdown
// =============================================================================

'use strict';
let _userCertCurrent = null;   // currently-open user object

const USER_COLS = [
  { key: 'full_name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: '_role', label: 'Role', sortValue: u => u.user_type === 'admin' ? 0 : u.is_supervisor ? 1 : 2,
    render: u => userRoleChip(u) },
  // A hazmat picker with no live cert is the thing this page exists to catch.
  { key: 'active_cert_count', label: 'Active certs', num: true, render: u => Number(u.active_cert_count) > 0
      ? uiNum(u.active_cert_count)
      : '<span class="ui-chip ui-chip-warn">none</span>' },
];

async function loadUsers(){
  uiTableLoading('usersBody', USER_COLS);
  const r = await apiGet('/users');
  if(r === null) return uiTableError('usersBody', USER_COLS, 'Could not load users', loadUsers);
  const rows = r.rows || [];

  uiTable('usersBody', {
    columns: USER_COLS, rows, rowKey: 'id',
    sortable: true,
    onRowClick: u => openUserCertModal(u.id, u),
    empty: 'No users.',
  });
}

function userRoleChip(u){
  if(u.user_type === 'admin') return '<span class="ui-chip ui-chip-info">ADMIN</span>';
  if(u.is_supervisor)         return '<span class="ui-chip ui-chip-warn">SUPERVISOR</span>';
  return '<span class="ui-chip ui-chip-neutral">OPS</span>';
}

// =============================================================================
// USER CERT MODAL — full cert history for one user, grant + revoke buttons
// =============================================================================

let CERT_M = null;   // open user-cert uiModal

// Cert state -> the frozen tone scale. Expiring-soon is the one that matters:
// it's the only state you can still act on before someone is uncertified.
const CERT_TONE = {
  active: 'ok', expiring_soon: 'warn', expired: 'danger', revoked: 'neutral',
};

async function openUserCertModal(userId, userObj){
  _userCertCurrent = { id: userId, ...(userObj || {}) };

  CERT_M = uiModal({
    title: userObj?.full_name || userObj?.email || 'User',
    width: 720,
    body: `
      <div class="ui-hint" style="margin-bottom:12px;">
        ${esc(userObj?.email || '')} · ${esc(userObj?.user_type || '')}${userObj?.is_supervisor ? ' · supervisor' : ''}
      </div>
      <div class="item-sec-head">
        <div class="ui-label">Certifications</div>
        <span style="flex:1"></span>
        <button class="ui-btn ui-btn-primary" id="certGrantBtn">Grant cert</button>
      </div>
      <div id="userCertList"></div>
      <div id="grantCertForm" style="display:none;"></div>`,
    actions: [
      // For floor staff with no work email, this is the ONLY recovery path —
      // an emailed reset link is useless to a picker holding a scanner. Issues
      // a temp password, shown once, and forces a change at their next login.
      { label: 'Reset password', onClick: async () => {
        await pwAdminReset(userId, userObj?.full_name || userObj?.email);
        return false;   // keep the user modal open behind it
      } },
      { label: 'Close' },
    ],
    onClose: () => { CERT_M = null; },
  });

  document.getElementById('certGrantBtn').addEventListener('click', uiBusyHandler(openGrantCertForm));
  await renderUserCertList(userId);
}

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
    .filter(t => U?.userType === 'admin' || t.cert_type !== 'INTERNAL_SAFETY_LEAD')
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
