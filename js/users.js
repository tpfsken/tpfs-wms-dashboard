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

let _userCertCurrent = null;   // currently-open user object

async function loadUsers(){
  const body = document.getElementById('usersBody');
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  const r = await apiGet('/users');
  if(!r){ body.innerHTML = '<div class="empty-state" style="color:var(--red);">Could not load users</div>'; return; }
  const rows = r.rows || [];
  if(!rows.length){
    body.innerHTML = '<div class="empty-state">No users found</div>';
    return;
  }
  body.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Name</th><th>Email</th><th>Role</th>
        <th class="right">Active Certs</th><th></th>
      </tr></thead>
      <tbody>${rows.map(u => `
        <tr class="js-user-row" data-id="${esc(u.id)}" style="cursor:pointer;">
          <td style="font-weight:600;">${esc(u.full_name || '—')}</td>
          <td style="color:var(--text2);">${esc(u.email)}</td>
          <td>${userRoleChip(u)}</td>
          <td class="right" style="font-weight:600;color:${u.active_cert_count > 0 ? 'var(--green)' : 'var(--text2)'};">${esc(u.active_cert_count || 0)}</td>
          <td><button class="btn btn-ghost" style="padding:4px 12px;font-size:12px;">Manage Certs →</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  body.querySelectorAll('.js-user-row').forEach(row => {
    row.addEventListener('click', () => openUserCertModal(row.dataset.id, rows.find(x => x.id === row.dataset.id)));
  });
}

function userRoleChip(u){
  if(u.user_type === 'admin')   return '<span class="chip chip-active">ADMIN</span>';
  if(u.is_supervisor)            return '<span class="chip chip-warning">SUPERVISOR</span>';
  return '<span class="chip" style="background:#2a2a2a;color:#bbb;">OPS</span>';
}

// =============================================================================
// USER CERT MODAL — full cert history for one user, grant + revoke buttons
// =============================================================================

async function openUserCertModal(userId, userObj){
  _userCertCurrent = { id: userId, ...(userObj || {}) };
  document.getElementById('userCertTitle').textContent = userObj?.full_name || userObj?.email || 'User';
  document.getElementById('userCertSub').textContent =
    `${userObj?.email || ''} · ${userObj?.user_type || ''}${userObj?.is_supervisor ? ' · supervisor' : ''}`;
  document.getElementById('grantCertForm').style.display = 'none';
  document.getElementById('userCertModal').style.display = 'flex';
  await renderUserCertList(userId);
}

async function renderUserCertList(userId){
  const list = document.getElementById('userCertList');
  list.innerHTML = '<div class="empty-state">Loading…</div>';
  const r = await apiGet(`/users/${userId}/certs`);
  if(!r){ list.innerHTML = '<div class="empty-state" style="color:var(--red);">Could not load certs</div>'; return; }
  const rows = r.rows || [];
  if(!rows.length){
    list.innerHTML = `<div class="empty-state" style="text-align:center;padding:20px;color:var(--text2);">No certifications on file. Click <strong>+ Grant Cert</strong> to add one.</div>`;
    return;
  }
  list.innerHTML = rows.map(c => {
    const stateColor = c.state === 'active' ? 'var(--green)'
                     : c.state === 'expiring_soon' ? 'var(--amber)'
                     : c.state === 'expired' ? '#cc6600'
                     : c.state === 'revoked' ? 'var(--red)'
                     : 'var(--text2)';
    const stateLabel = c.state.replace('_', ' ').toUpperCase();
    const expiresStr = c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '—';
    const issuedStr  = c.issued_at  ? new Date(c.issued_at).toLocaleDateString()  : '—';
    const modes = (c.covers_modes || []).join(', ');
    const revokeBtn = c.state === 'active' || c.state === 'expiring_soon'
      ? `<button class="btn btn-ghost js-revoke-cert" data-cert-id="${esc(c.id)}" style="padding:4px 10px;font-size:11px;color:var(--red);">Revoke</button>`
      : '';
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;background:var(--panel);">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
          <div style="font-weight:600;">${esc(c.cert_type_display || c.cert_type)}</div>
          <span class="chip" style="background:transparent;color:${stateColor};border:1px solid ${stateColor};font-size:10px;">${esc(stateLabel)}</span>
          <div style="flex:1"></div>
          ${revokeBtn}
        </div>
        <div style="font-size:12px;color:var(--text2);">
          ${c.cert_number ? `Cert # ${esc(c.cert_number)} · ` : ''}
          Issued ${esc(issuedStr)} · Expires ${esc(expiresStr)} · Covers: ${esc(modes)}
        </div>
        ${c.issuing_body ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">Issued by: ${esc(c.issuing_body)}</div>` : ''}
        ${c.revoked_at ? `<div style="font-size:11px;color:var(--red);margin-top:4px;">Revoked ${esc(new Date(c.revoked_at).toLocaleString())}${c.revoked_reason ? ' — ' + esc(c.revoked_reason) : ''}</div>` : ''}
        ${c.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;font-style:italic;">${esc(c.notes)}</div>` : ''}
      </div>`;
  }).join('');

  list.querySelectorAll('.js-revoke-cert').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      revokeUserCert(btn.dataset.certId);
    });
  });
}

async function revokeUserCert(certId){
  const reason = prompt('Reason for revoke (required for audit):');
  if(reason == null) return;
  if(reason.trim().length < 5){ alert('Reason must be at least 5 characters.'); return; }
  const r = await fetch(`${API}/users/${_userCertCurrent.id}/certs/${certId}/revoke`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${T}` },
    body: JSON.stringify({ reason }),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ alert(d.error || 'Revoke failed'); return; }
  renderUserCertList(_userCertCurrent.id);
}

// =============================================================================
// GRANT CERT FORM
// =============================================================================

async function openGrantCertForm(){
  const form = document.getElementById('grantCertForm');
  form.style.display = 'block';
  document.getElementById('grantCertNumber').value = '';
  document.getElementById('grantCertNotes').value  = '';
  document.getElementById('grantCertError').textContent = '';
  // Default issued = today, expires = +1 year (sensible for IATA/IMDG;
  // user can adjust)
  const today = new Date();
  const oneYr = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
  document.getElementById('grantCertIssued').value  = today.toISOString().slice(0, 10);
  document.getElementById('grantCertExpires').value = oneYr.toISOString().slice(0, 10);

  // Populate cert type combo. INTERNAL_SAFETY_LEAD only available to admin.
  const types = await apiGet('/cert-types');
  const opts = (types?.rows || [])
    .filter(t => U?.userType === 'admin' || t.cert_type !== 'INTERNAL_SAFETY_LEAD')
    .map(t => ({ value: t.cert_type, label: t.display_name }));
  initCombo('grantCertTypeWrap', opts, {
    placeholder: 'Select cert type...',
    onChange: (val, label, opt) => {
      // When user picks a cert type, suggest a default validity window.
      // DOT/Forklift = 3 years (1095d), IATA/IMDG = 2 years (730d).
      const days = (val === 'DOT' || val === 'INTERNAL_SAFETY_LEAD') ? 1095
                 : (val === 'IATA_DGR' || val === 'IMDG')             ? 730
                 :                                                       365;
      const issued = new Date(document.getElementById('grantCertIssued').value || Date.now());
      const expires = new Date(issued); expires.setDate(expires.getDate() + days);
      document.getElementById('grantCertExpires').value = expires.toISOString().slice(0, 10);
    },
  });
}

async function submitGrantCert(){
  const err = document.getElementById('grantCertError');
  err.textContent = '';
  const certType = cbVal('grantCertTypeWrap');
  const issued   = document.getElementById('grantCertIssued').value;
  const expires  = document.getElementById('grantCertExpires').value;
  const number   = document.getElementById('grantCertNumber').value.trim();
  const body     = document.getElementById('grantCertBody').value.trim();
  const notes    = document.getElementById('grantCertNotes').value.trim();

  if(!certType){ err.textContent = 'Pick a cert type'; return; }
  if(!issued || !expires){ err.textContent = 'Issued + expires dates are required'; return; }
  if(!body){ err.textContent = 'Issuing body is required (use "Internal" if generated by your training program)'; return; }
  if(new Date(expires) < new Date(issued)){ err.textContent = 'Expires must be on or after Issued'; return; }

  try {
    const r = await fetch(`${API}/users/${_userCertCurrent.id}/certs`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${T}` },
      body: JSON.stringify({
        cert_type: certType,
        cert_number: number || null,
        issuing_body: body,
        issued_at: issued,
        expires_at: expires,
        notes: notes || null,
      }),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Grant failed'; return; }
    document.getElementById('grantCertForm').style.display = 'none';
    renderUserCertList(_userCertCurrent.id);
    // If we just granted to ourselves, refresh the topbar ribbon
    if(_userCertCurrent.id === U?.id && typeof refreshCertExpiryRibbon === 'function'){
      refreshCertExpiryRibbon();
    }
  } catch(e){
    err.textContent = 'Network error';
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
