// =============================================================================
// CLIENTS — list + detail page with tabs (Profile, KPI/SLA Settings, Current
// Performance). The KPI/SLA Settings tab is where ops sets per-client SLA
// targets that the portal home reads to color cards green/amber/red.
// =============================================================================

let clientsCache   = [];
let _currentClient = null;            // full client row currently being edited
let _kpiCatalog    = null;            // catalog from /kpi-catalog (cached)
let _kpiConfigRows = [];              // working copy edited in the form

async function loadCC(){
  if(clientsCache.length) return;
  const d = await apiGet('/clients');
  if(d) clientsCache = d;
}

// =============================================================================
// LIST VIEW
// =============================================================================

async function loadClients(){
  // Always reset to list view on (re)load
  document.getElementById('cliDetailView').style.display = 'none';
  document.getElementById('cliListView').style.display   = 'block';

  const d = await apiGet('/clients');
  if(!d) return;
  clientsCache = d;

  const body = document.getElementById('clientBody');
  if(!d.length){
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No clients</td></tr>';
    return;
  }

  body.innerHTML = d.map(c => {
    const stChip = c.is_active ? 'chip-success' : 'chip-danger';
    return `
      <tr class="js-cli-row" data-id="${esc(c.id)}" style="cursor:pointer;">
        <td style="font-weight:600;color:var(--blue);">${esc(c.code || '')}</td>
        <td style="font-weight:600;">${esc(c.name || '')}</td>
        <td style="color:var(--text2);">${esc(c.contact_email || '')}</td>
        <td><span class="chip chip-new">${esc(c.client_type || '')}</span></td>
        <td>${esc(c.onboarded_at ? new Date(c.onboarded_at).toLocaleDateString() : '—')}</td>
        <td><span class="chip ${stChip}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
      </tr>`;
  }).join('');

  body.querySelectorAll('.js-cli-row').forEach(row => {
    row.addEventListener('mouseover', () => row.style.background = 'var(--hover)');
    row.addEventListener('mouseout',  () => row.style.background = '');
    row.addEventListener('click', () => openClientDetail(row.dataset.id));
  });
}

// =============================================================================
// DETAIL VIEW
// =============================================================================

async function openClientDetail(id){
  const d = await apiGet(`/clients/${id}`);
  if(!d) return;
  _currentClient = d;

  document.getElementById('cliListView').style.display   = 'none';
  document.getElementById('cliDetailView').style.display = 'block';

  document.getElementById('cliDetailTitle').textContent = d.name || d.code || '—';
  document.getElementById('cliDetailSub').textContent   =
    `${d.code || ''}${d.client_type ? ' · ' + d.client_type : ''}${d.is_active === false ? ' · Inactive' : ''}`;

  // Wire tab strip + tab panels (idempotent — wires once per session)
  wireClientTabs();

  // Default to the Profile tab on open
  switchClientTab('profile');
}

function closeClientDetail(){
  _currentClient = null;
  document.getElementById('cliDetailView').style.display = 'none';
  document.getElementById('cliListView').style.display   = 'block';
}

function reloadClientDetail(){
  if(_currentClient) openClientDetail(_currentClient.id);
}

function wireClientTabs(){
  const tabs = document.querySelectorAll('.cli-tab');
  if(tabs[0] && tabs[0]._wired) return;
  tabs.forEach(t => {
    t._wired = true;
    t.addEventListener('click', () => switchClientTab(t.dataset.tab));
  });

  // Also wire the KPI tab buttons (Save / Reset to defaults). Idempotent.
  const saveBtn = document.getElementById('cliKpiSaveBtn');
  const seedBtn = document.getElementById('cliKpiSeedBtn');
  if(saveBtn && !saveBtn._wired){ saveBtn._wired = true; saveBtn.addEventListener('click', saveClientKpiConfig); }
  if(seedBtn && !seedBtn._wired){ seedBtn._wired = true; seedBtn.addEventListener('click', resetClientKpiConfig); }
}

function switchClientTab(tab){
  document.querySelectorAll('.cli-tab').forEach(t => {
    const active = t.dataset.tab === tab;
    t.style.color           = active ? 'var(--text)' : 'var(--text2)';
    t.style.borderBottomColor = active ? 'var(--blue)' : 'transparent';
  });
  document.querySelectorAll('.cli-panel').forEach(p => {
    p.style.display = p.dataset.tab === tab ? 'block' : 'none';
  });

  if(tab === 'profile')          renderClientProfileTab();
  else if(tab === 'items')       loadClientItemsTab();
  else if(tab === 'kpi')         loadClientKpiTab();
  else if(tab === 'rules')       loadClientRulesTab();
  else if(tab === 'performance') loadClientPerformanceTab();
}

// ----- PROFILE TAB -----

function renderClientProfileTab(){
  const c = _currentClient;
  if(!c) return;
  const body = document.getElementById('cliProfileBody');
  const typeLabel = c.client_type === 'BOTH' ? 'B2B + B2C'
                  : c.client_type === 'B2C'  ? 'B2C'
                  : c.client_type === 'B2B'  ? 'B2B'
                  : (c.client_type || '—');
  const row = (l, v) => `
    <div style="display:grid;grid-template-columns:160px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <div style="color:var(--text2);font-weight:600;">${esc(l)}</div>
      <div>${esc(v ?? '—')}</div>
    </div>`;
  body.innerHTML =
    row('Code',           c.code) +
    row('Name',           c.name) +
    row('Type',           typeLabel) +
    row('Contact Name',   c.contact_name) +
    row('Contact Email',  c.contact_email) +
    row('Phone',          c.contact_phone) +
    row('Hazmat',         c.hazmat_enabled ? 'Enabled' : 'No') +
    row('Onboarded',      c.onboarded_at ? new Date(c.onboarded_at).toLocaleDateString() : null) +
    row('Status',         c.is_active ? 'Active' : 'Inactive');

  // Hazmat panel — show when toggled on. Per-item info (UN #, hazard
  // class, packing group) lives on the SKU; only the emergency
  // contact + notes are stored at the client level.
  const hazPanel = document.getElementById('cliHazmatPanel');
  if(c.hazmat_enabled){
    hazPanel.style.display = 'block';
    const hc = c.hazmat_config || {};
    const fields = [
      ['Emergency Contact', hc.emergency_contact],
      ['Notes',             hc.notes],
    ];
    document.getElementById('cliHazmatBody').innerHTML = fields.map(([l, v]) => `
      <div style="display:grid;grid-template-columns:200px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <div style="color:var(--text2);font-weight:600;">${esc(l)}</div>
        <div>${esc(v ?? '—')}</div>
      </div>`).join('') + `
      <div style="margin-top:14px;padding:10px 14px;background:var(--bg);border-radius:6px;font-size:12px;color:var(--text2);">
        Per-item hazmat fields (UN #, hazard class, packing group, ground-only flag) are set on each SKU. Items added under this client require those fields.
      </div>`;
  } else {
    hazPanel.style.display = 'none';
  }

  // Wire Edit button on Profile tab — idempotent
  const editBtn = document.getElementById('cliEditBtn');
  if(editBtn && !editBtn._wired){
    editBtn._wired = true;
    editBtn.addEventListener('click', () => openClientFormModal(_currentClient));
  }
}

// =============================================================================
// NEW / EDIT CLIENT MODAL
// =============================================================================
// Same modal handles both Create (when client is null) and Edit.

let _editingClientId = null;   // null for new, string id for edit

function openClientFormModal(client){
  _editingClientId = client?.id || null;

  document.getElementById('clientFormTitle').textContent = client ? 'Edit Client' : 'New Client';
  document.getElementById('cfSubmitBtn').textContent     = client ? 'Save Changes' : 'Create Client';
  document.getElementById('cfError').textContent         = '';

  // Pre-fill (or clear)
  document.getElementById('cfCode').value         = client?.code         || '';
  document.getElementById('cfName').value         = client?.name         || '';
  document.getElementById('cfContactName').value  = client?.contact_name || '';
  document.getElementById('cfContactEmail').value = client?.contact_email|| '';
  document.getElementById('cfContactPhone').value = client?.contact_phone|| '';
  document.getElementById('cfHazmat').checked     = !!client?.hazmat_enabled;

  const hc = client?.hazmat_config || {};
  document.getElementById('cfHazEmergency').value = hc.emergency_contact || '';
  document.getElementById('cfHazNotes').value     = hc.notes             || '';

  // Set the type toggle
  setClientFormType(client?.client_type || 'B2B');

  // Wire toggle buttons + hazmat-block visibility (idempotent)
  const wrap = document.getElementById('cfTypeToggle');
  if(!wrap._wired){
    wrap._wired = true;
    wrap.querySelectorAll('.js-cf-type').forEach(btn =>
      btn.addEventListener('click', () => setClientFormType(btn.dataset.type))
    );
  }
  const haz = document.getElementById('cfHazmat');
  if(!haz._wired){
    haz._wired = true;
    haz.addEventListener('change', () => {
      document.getElementById('cfHazmatBlock').style.display = haz.checked ? 'block' : 'none';
    });
  }
  document.getElementById('cfHazmatBlock').style.display = haz.checked ? 'block' : 'none';

  document.getElementById('clientFormModal').style.display = 'flex';
  document.getElementById('cfCode').focus?.();
}

function setClientFormType(type){
  document.getElementById('cfType').value = type;
  document.querySelectorAll('.js-cf-type').forEach(btn => {
    const active = btn.dataset.type === type;
    btn.style.background = active ? 'var(--blue)' : 'transparent';
    btn.style.color      = active ? 'var(--white, #fff)' : 'var(--text)';
  });
}

async function submitClientForm(){
  const err = document.getElementById('cfError');
  err.textContent = '';

  const body = {
    code:           document.getElementById('cfCode').value.trim().toUpperCase(),
    name:           document.getElementById('cfName').value.trim(),
    client_type:    document.getElementById('cfType').value,
    contact_name:   document.getElementById('cfContactName').value.trim() || null,
    contact_email:  document.getElementById('cfContactEmail').value.trim() || null,
    contact_phone:  document.getElementById('cfContactPhone').value.trim() || null,
    hazmat_enabled: document.getElementById('cfHazmat').checked,
  };

  if(!body.code) { err.textContent = 'Client code is required'; return; }
  if(!body.name) { err.textContent = 'Client name is required'; return; }

  // Build hazmat_config only when hazmat is on. Per-item info (UN #,
  // hazard class, packing group) is set on the SKU, not here — only
  // the emergency contact + notes belong on the client record.
  if(body.hazmat_enabled){
    body.hazmat_config = {
      emergency_contact: document.getElementById('cfHazEmergency').value.trim() || null,
      notes:             document.getElementById('cfHazNotes').value.trim() || null,
    };
  } else {
    body.hazmat_config = null;
  }

  const submitBtn = document.getElementById('cfSubmitBtn');
  submitBtn.disabled = true;
  try {
    const url = _editingClientId
      ? `${API}/clients/${_editingClientId}`
      : `${API}/clients`;
    const method = _editingClientId ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method, headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Save failed'; return; }

    closeModal('clientFormModal');
    // Refresh the list and jump straight to the new/edited client's
    // detail page so ops can dial in the SLA targets right away.
    clientsCache = []; await loadCC();
    await loadClients();
    openClientDetail(d.id);
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    submitBtn.disabled = false;
  }
}

// ----- KPI / SLA SETTINGS TAB -----

async function loadClientKpiTab(){
  if(!_currentClient) return;
  const body   = document.getElementById('cliKpiBody');
  const status = document.getElementById('cliKpiStatus');
  status.textContent = '';
  body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;">Loading…</div>';

  // Catalog is the same regardless of client — cache after first call.
  if(!_kpiCatalog) _kpiCatalog = await apiGet('/kpi-catalog');
  const config = await apiGet(`/clients/${_currentClient.id}/kpi-config`);
  if(!config){
    body.innerHTML = '<div style="color:var(--red);padding:20px;">Could not load KPI config</div>';
    return;
  }
  _kpiConfigRows = config;
  renderClientKpiTab();
}

function renderClientKpiTab(){
  const body = document.getElementById('cliKpiBody');
  if(!_kpiConfigRows.length){
    body.innerHTML = '<div class="empty-state" style="padding:24px;">No metrics in catalog</div>';
    return;
  }

  const unitLabel = (u) => u === 'pct' ? '%' : u === 'hours' ? 'hrs' : u === 'minutes' ? 'min' : '';
  const dirLabel  = (d) => d === 'higher_is_better' ? 'Higher is better'
                       : d === 'lower_is_better'  ? 'Lower is better'
                       : 'Informational';

  body.innerHTML = `
    <div style="overflow:auto;">
      <table class="data-table" style="margin:0;">
        <thead>
          <tr>
            <th style="width:60px;text-align:center;">On</th>
            <th>Metric</th>
            <th style="width:140px;">Direction</th>
            <th style="width:140px;">Target</th>
            <th style="width:140px;">Warning</th>
          </tr>
        </thead>
        <tbody>
          ${_kpiConfigRows.map((r, i) => {
            const isInfo = r.direction === 'info';
            return `
              <tr>
                <td style="text-align:center;">
                  <input type="checkbox" class="js-kpi-enabled" data-idx="${esc(i)}" ${r.enabled ? 'checked' : ''}
                         style="width:18px;height:18px;cursor:pointer;">
                </td>
                <td>
                  <div style="font-weight:600;">${esc(r.label)}</div>
                  <div style="font-size:11px;color:var(--text2);margin-top:2px;">${esc(r.description || '')}</div>
                </td>
                <td><span style="font-size:12px;color:var(--text2);">${esc(dirLabel(r.direction))}</span></td>
                <td>
                  ${isInfo
                    ? '<span style="color:var(--muted);font-size:12px;">—</span>'
                    : `<input type="number" step="0.1" class="form-input js-kpi-target" data-idx="${esc(i)}"
                              value="${r.target_value == null ? '' : esc(r.target_value)}"
                              style="width:90px;padding:6px 8px;font-size:13px;">
                       <span style="font-size:11px;color:var(--text2);margin-left:4px;">${esc(unitLabel(r.unit))}</span>`}
                </td>
                <td>
                  ${isInfo
                    ? '<span style="color:var(--muted);font-size:12px;">—</span>'
                    : `<input type="number" step="0.1" class="form-input js-kpi-warning" data-idx="${esc(i)}"
                              value="${r.warning_threshold == null ? '' : esc(r.warning_threshold)}"
                              style="width:90px;padding:6px 8px;font-size:13px;">
                       <span style="font-size:11px;color:var(--text2);margin-left:4px;">${esc(unitLabel(r.unit))}</span>`}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  // Wire input changes — keep _kpiConfigRows in sync as the user edits
  body.querySelectorAll('.js-kpi-enabled').forEach(cb => {
    cb.addEventListener('change', e => {
      _kpiConfigRows[parseInt(e.target.dataset.idx)].enabled = e.target.checked;
    });
  });
  body.querySelectorAll('.js-kpi-target').forEach(inp => {
    inp.addEventListener('input', e => {
      const v = e.target.value.trim();
      _kpiConfigRows[parseInt(e.target.dataset.idx)].target_value = v === '' ? null : Number(v);
    });
  });
  body.querySelectorAll('.js-kpi-warning').forEach(inp => {
    inp.addEventListener('input', e => {
      const v = e.target.value.trim();
      _kpiConfigRows[parseInt(e.target.dataset.idx)].warning_threshold = v === '' ? null : Number(v);
    });
  });
}

async function saveClientKpiConfig(){
  if(!_currentClient) return;
  const status = document.getElementById('cliKpiStatus');
  status.style.color = 'var(--text2)';
  status.textContent = 'Saving…';

  const rows = _kpiConfigRows.map((r, i) => ({
    metric_key:        r.metric_key,
    enabled:           !!r.enabled,
    display_order:     i,
    target_value:      r.target_value,
    warning_threshold: r.warning_threshold,
    custom_label:      r.custom_label || null,
  }));

  try {
    const r = await fetch(`${API}/clients/${_currentClient.id}/kpi-config`, {
      method:  'PUT',
      headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body:    JSON.stringify({ rows }),
    });
    const d = await r.json();
    if(!r.ok){
      status.style.color = 'var(--red)';
      status.textContent = d.error || 'Save failed';
      return;
    }
    _kpiConfigRows = d;
    status.style.color = 'var(--green)';
    status.textContent = '✓ Saved — portal home will reflect the new targets on next refresh';
    setTimeout(() => { status.textContent = ''; }, 4000);
  } catch(e){
    status.style.color = 'var(--red)';
    status.textContent = 'Network error';
  }
}

async function resetClientKpiConfig(){
  if(!_currentClient) return;
  if(!confirm('Reset all KPI / SLA settings on this client to the catalog defaults?')) return;

  const status = document.getElementById('cliKpiStatus');
  status.style.color = 'var(--text2)';
  status.textContent = 'Resetting…';

  try {
    const r = await fetch(`${API}/clients/${_currentClient.id}/kpi-config/seed`, {
      method:  'POST',
      headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body:    JSON.stringify({}),
    });
    const d = await r.json();
    if(!r.ok){
      status.style.color = 'var(--red)';
      status.textContent = d.error || 'Reset failed';
      return;
    }
    // After seed, reload from server to get the merged defaults shown in the form.
    await loadClientKpiTab();
    status.style.color = 'var(--green)';
    status.textContent = '✓ Reset to defaults';
    setTimeout(() => { status.textContent = ''; }, 4000);
  } catch(e){
    status.style.color = 'var(--red)';
    status.textContent = 'Network error';
  }
}

// ----- CURRENT PERFORMANCE TAB -----

async function loadClientPerformanceTab(){
  if(!_currentClient) return;
  const body = document.getElementById('cliPerformanceBody');
  body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;">Loading…</div>';

  // Two parallel fetches — performance metrics + SLA rules — so the
  // Current Performance tab shows both sides of the SLA at once
  // (measurable targets above, rule-based fees below).
  const [d, rules] = await Promise.all([
    apiGet(`/clients/${_currentClient.id}/performance`),
    apiGet(`/clients/${_currentClient.id}/sla-rules`),
  ]);
  if(!d){
    body.innerHTML = '<div style="color:var(--red);padding:20px;">Could not load performance data</div>';
    return;
  }

  const unitLabel = (u) => u === 'pct' ? '%' : u === 'hours' ? 'hrs' : u === 'minutes' ? 'min' : '';
  const fmtVal = (v, u) => v == null ? '—' : `${Number(v).toLocaleString()}${unitLabel(u)}`;
  const statusChip = (s) => s === 'good'  ? '<span class="chip chip-success">✓ Meeting target</span>'
                          : s === 'warn'  ? '<span class="chip chip-warning">⚠ Warning</span>'
                          : s === 'breach' ? '<span class="chip chip-danger">✕ Below SLA</span>'
                          : '<span class="chip chip-new">Info</span>';
  const valColor = (s) => s === 'good' ? 'var(--green)' : s === 'warn' ? 'var(--amber)' : s === 'breach' ? 'var(--red)' : 'var(--text)';

  // Top section — measurable targets
  const targetsHtml = d.items?.length ? `
    <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;color:var(--text2);margin-bottom:8px;">Measured KPIs</div>
    <table class="data-table" style="margin:0 0 24px 0;">
      <thead>
        <tr>
          <th>Metric</th>
          <th class="right">Current</th>
          <th class="right">Target</th>
          <th class="right">Warning</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${d.items.map(it => `
          <tr>
            <td style="font-weight:600;">${esc(it.label)}</td>
            <td class="right" style="font-weight:700;color:${valColor(it.status)};">${esc(fmtVal(it.value, it.unit))}</td>
            <td class="right" style="color:var(--text2);">${esc(fmtVal(it.target_value, it.unit))}</td>
            <td class="right" style="color:var(--text2);">${esc(fmtVal(it.warning_threshold, it.unit))}</td>
            <td>${statusChip(it.status)}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<div class="empty-state" style="padding:14px 0;">No metrics enabled — enable some on the KPI / SLA Targets tab</div>';

  // Bottom section — operational rules + exception fees
  const rulesHtml = rules?.length ? `
    <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;color:var(--text2);margin-bottom:8px;">SLA Rules &amp; Exception Fees</div>
    <table class="data-table" style="margin:0;">
      <thead>
        <tr>
          <th>Rule</th>
          <th>Value</th>
          <th>Exception</th>
          <th class="right">Fee</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        ${rules.map(r => {
          const value = r.rule_value
            ? `${esc(r.rule_value)}${r.unit ? ' ' + esc(r.unit) : ''}`
            : '<span style="color:var(--muted);">—</span>';
          const fee = r.exception_charge_amount != null
            ? `$${Number(r.exception_charge_amount).toFixed(2)}`
            : '<span style="color:var(--muted);">—</span>';
          return `
            <tr>
              <td style="font-weight:600;">${esc(r.rule_label || '')}</td>
              <td style="color:var(--blue);font-weight:600;">${value}</td>
              <td style="color:var(--text2);">${esc(r.exception_charge_label || '—')}</td>
              <td class="right" style="font-weight:700;color:${r.exception_charge_amount != null ? 'var(--amber)' : 'var(--muted)'};">${fee}</td>
              <td style="color:var(--text2);font-size:12px;">${esc(r.notes || '')}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>` : '';

  body.innerHTML = targetsHtml + rulesHtml;
}

// =============================================================================
// SLA RULES TAB — ad-hoc operational policy (cut-off times, lead times,
// weekend handling, etc.). Distinct from the measurable KPIs in the
// KPI/SLA Targets tab. Each row is editable inline; quick-add chips at
// the top let ops drop in common ones with one click.
// =============================================================================

let _slaPresets = null;   // cached /sla-rule-presets response
let _slaRules   = [];     // currently shown rules for the active client

async function loadClientRulesTab(){
  if(!_currentClient) return;
  const body = document.getElementById('cliRulesBody');
  body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;">Loading…</div>';

  // Cache presets — they're identical across all clients
  if(!_slaPresets) _slaPresets = (await apiGet('/sla-rule-presets')) || [];
  const rules = await apiGet(`/clients/${_currentClient.id}/sla-rules`);
  if(!rules){
    body.innerHTML = '<div style="color:var(--red);padding:20px;">Could not load SLA rules</div>';
    return;
  }
  _slaRules = rules;

  // Wire the + Add Rule button (free-form custom rule)
  const addBtn = document.getElementById('cliRuleAddBtn');
  if(addBtn && !addBtn._wired){
    addBtn._wired = true;
    addBtn.addEventListener('click', () => addCustomSlaRule());
  }

  renderSlaRulePresets();
  renderSlaRulesBody();
}

function renderSlaRulePresets(){
  const wrap = document.getElementById('cliRulePresets');
  // Hide presets that already have a saved rule for this client
  const existing = new Set(_slaRules.map(r => r.rule_key));
  const remaining = _slaPresets.filter(p => !existing.has(p.key));

  if(!remaining.length){
    wrap.innerHTML = '<div style="color:var(--muted);font-size:12px;">All presets in use — use + Add Rule for a custom one</div>';
    return;
  }
  wrap.innerHTML =
    '<div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;font-weight:600;width:100%;margin-bottom:4px;">Quick add</div>' +
    remaining.map(p => `
      <button class="btn btn-ghost js-sla-preset" data-key="${esc(p.key)}"
              style="padding:6px 12px;font-size:12px;">+ ${esc(p.label)}</button>
    `).join('');

  wrap.querySelectorAll('.js-sla-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = _slaPresets.find(p => p.key === btn.dataset.key);
      if(!preset) return;
      // Add a draft row (unsaved) so the user can fill in the value.
      _slaRules.push({
        id: null, rule_key: preset.key, rule_label: preset.label,
        rule_value: '', unit: preset.unit, notes: '', _draft: true,
        _placeholder: preset.placeholder,
        // Pre-fill the exception charge label so ops just types the dollar amount.
        exception_charge_label: preset.default_charge_label || '',
        exception_charge_amount: null,
      });
      renderSlaRulePresets();
      renderSlaRulesBody();
    });
  });
}

function addCustomSlaRule(){
  // Generate a unique key for the custom rule
  const key = 'custom_' + Date.now().toString(36);
  _slaRules.push({
    id: null, rule_key: key, rule_label: '', rule_value: '',
    unit: '', notes: '', _draft: true, _custom: true,
    exception_charge_label: '', exception_charge_amount: null,
  });
  renderSlaRulesBody();
}

function renderSlaRulesBody(){
  const body = document.getElementById('cliRulesBody');
  if(!_slaRules.length){
    body.innerHTML = '<div class="empty-state" style="padding:24px;text-align:center;">No SLA rules yet — add one above</div>';
    return;
  }

  body.innerHTML = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">
      Charges are billed when an order falls outside the SLA. They become billing_charges automatically (next phase) — for now they're recorded so the SLA doc shows the rate.
    </div>
    <table class="data-table" style="margin:0;">
      <thead>
        <tr>
          <th style="width:22%;">Rule</th>
          <th style="width:14%;">Value</th>
          <th style="width:10%;">Unit</th>
          <th style="width:18%;">Exception Charge</th>
          <th style="width:14%;" class="right">Charge $</th>
          <th>Notes</th>
          <th style="width:140px;text-align:right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${_slaRules.map((r, i) => {
          const draft = r._draft;
          const labelInput = r._custom
            ? `<input class="form-input js-sla-label" data-idx="${esc(i)}" value="${esc(r.rule_label || '')}" placeholder="Custom rule name" style="width:100%;padding:6px 8px;font-size:13px;">`
            : `<div style="font-weight:600;font-size:13px;">${esc(r.rule_label || '')}</div>`;
          return `
            <tr>
              <td>${labelInput}</td>
              <td>
                <input class="form-input js-sla-value" data-idx="${esc(i)}"
                       value="${esc(r.rule_value || '')}"
                       placeholder="${esc(r._placeholder || '')}"
                       style="width:100%;padding:6px 8px;font-size:13px;">
              </td>
              <td>
                <input class="form-input js-sla-unit" data-idx="${esc(i)}"
                       value="${esc(r.unit || '')}"
                       style="width:100%;padding:6px 8px;font-size:13px;">
              </td>
              <td>
                <input class="form-input js-sla-charge-label" data-idx="${esc(i)}"
                       value="${esc(r.exception_charge_label || '')}"
                       placeholder="e.g. Rush Fee"
                       style="width:100%;padding:6px 8px;font-size:13px;">
              </td>
              <td>
                <input type="number" step="0.01" min="0" class="form-input js-sla-charge-amount" data-idx="${esc(i)}"
                       value="${r.exception_charge_amount == null ? '' : esc(r.exception_charge_amount)}"
                       placeholder="0.00"
                       style="width:100%;padding:6px 8px;font-size:13px;text-align:right;">
              </td>
              <td>
                <input class="form-input js-sla-notes" data-idx="${esc(i)}"
                       value="${esc(r.notes || '')}"
                       style="width:100%;padding:6px 8px;font-size:13px;">
              </td>
              <td style="text-align:right;white-space:nowrap;">
                <button class="btn btn-primary js-sla-save" data-idx="${esc(i)}"
                        style="padding:4px 12px;font-size:12px;">${draft ? 'Save' : 'Update'}</button>
                <button class="btn btn-ghost js-sla-rm" data-idx="${esc(i)}"
                        style="padding:4px 10px;font-size:12px;color:var(--red);">✕</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  // Sync edits into the working set
  body.querySelectorAll('.js-sla-label').forEach(inp => inp.addEventListener('input', e =>
    _slaRules[parseInt(e.target.dataset.idx)].rule_label = e.target.value));
  body.querySelectorAll('.js-sla-value').forEach(inp => inp.addEventListener('input', e =>
    _slaRules[parseInt(e.target.dataset.idx)].rule_value = e.target.value));
  body.querySelectorAll('.js-sla-unit').forEach(inp => inp.addEventListener('input', e =>
    _slaRules[parseInt(e.target.dataset.idx)].unit = e.target.value));
  body.querySelectorAll('.js-sla-notes').forEach(inp => inp.addEventListener('input', e =>
    _slaRules[parseInt(e.target.dataset.idx)].notes = e.target.value));
  body.querySelectorAll('.js-sla-charge-label').forEach(inp => inp.addEventListener('input', e =>
    _slaRules[parseInt(e.target.dataset.idx)].exception_charge_label = e.target.value));
  body.querySelectorAll('.js-sla-charge-amount').forEach(inp => inp.addEventListener('input', e => {
    const v = e.target.value.trim();
    _slaRules[parseInt(e.target.dataset.idx)].exception_charge_amount = v === '' ? null : Number(v);
  }));

  body.querySelectorAll('.js-sla-save').forEach(btn => btn.addEventListener('click', () =>
    saveSlaRule(parseInt(btn.dataset.idx))));
  body.querySelectorAll('.js-sla-rm').forEach(btn => btn.addEventListener('click', () =>
    deleteSlaRule(parseInt(btn.dataset.idx))));
}

async function saveSlaRule(idx){
  const r = _slaRules[idx];
  if(!r) return;
  if(!r.rule_label || !r.rule_label.trim()){
    alert('Rule name is required');
    return;
  }
  // For custom rules, regenerate rule_key from the label so it's stable
  if(r._custom && r.rule_key.startsWith('custom_')){
    r.rule_key = 'custom_' + r.rule_label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
  }
  try {
    const res = await fetch(`${API}/clients/${_currentClient.id}/sla-rules`, {
      method:'POST', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        rule_key:                r.rule_key,
        rule_label:              r.rule_label,
        rule_value:              r.rule_value,
        unit:                    r.unit,
        notes:                   r.notes,
        display_order:           idx,
        exception_charge_label:  r.exception_charge_label || null,
        exception_charge_amount: r.exception_charge_amount,
      }),
    });
    const d = await res.json();
    if(!res.ok){ alert(d.error || 'Save failed'); return; }
    // Reload from server so we get the canonical row + clear _draft flags
    await loadClientRulesTab();
  } catch(e){ alert('Network error'); }
}

// =============================================================================
// ITEM MASTER TAB — full SKU catalog for the active client. Powered by
// /clients/:id/skus (broader than the 50-row /skus search). Click a row
// to edit; + Add Item opens the New Item modal pre-filled with this
// client.
// =============================================================================

let _cliItemsSearchDebounce = null;

async function loadClientItemsTab(){
  if(!_currentClient) return;
  // Wire search + add button (idempotent)
  const search = document.getElementById('cliItemsSearch');
  if(search && !search._wired){
    search._wired = true;
    search.addEventListener('input', () => {
      clearTimeout(_cliItemsSearchDebounce);
      _cliItemsSearchDebounce = setTimeout(() => fetchClientItems(search.value.trim()), 300);
    });
  }
  const addBtn = document.getElementById('cliItemsAddBtn');
  if(addBtn && !addBtn._wired){
    addBtn._wired = true;
    addBtn.addEventListener('click', async () => {
      // Open the existing New Item modal, then preselect this client.
      // openItemFormModal lives in inventory.js — relies on globals.
      await openItemFormModal();
      const cid = String(_currentClient.id);
      cbSet('itemClientWrap', cid,
        `${_currentClient.code || ''} — ${_currentClient.name || ''}`);
      // Trigger the hazmat hint logic
      if(typeof onItemClientChange === 'function') onItemClientChange();
    });
  }
  fetchClientItems(search?.value.trim() || '');
}

async function fetchClientItems(searchTerm){
  const body  = document.getElementById('cliItemsBody');
  const count = document.getElementById('cliItemsCount');
  body.innerHTML = '<tr><td colspan="7" class="empty-state">Loading…</td></tr>';

  let url = `/clients/${_currentClient.id}/skus?limit=500`;
  if(searchTerm) url += `&search=${encodeURIComponent(searchTerm)}`;
  const rows = await apiGet(url);
  if(!rows){
    body.innerHTML = '<tr><td colspan="7" class="empty-state">Could not load items</td></tr>';
    return;
  }
  if(count) count.textContent = rows.length ? `· ${rows.length} item${rows.length === 1 ? '' : 's'}` : '';

  if(!rows.length){
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No items yet — click + Add Item to create one</td></tr>';
    return;
  }

  body.innerHTML = rows.map(r => {
    const tracking = [];
    if(r.is_lot_tracked)    tracking.push('<span class="chip chip-new" style="font-size:10px;">Lot</span>');
    if(r.is_expiry_tracked) tracking.push('<span class="chip chip-new" style="font-size:10px;">Exp</span>');
    if(r.is_hazmat) {
      const txt = r.hazard_class
        ? `⚠ Hazmat ${esc(r.un_number || '')} · Cl ${esc(r.hazard_class)}`
        : '⚠ Hazmat';
      tracking.push(`<span class="chip chip-danger" style="font-size:10px;">${txt}</span>`);
    }
    if(r.attachment_count > 0) {
      tracking.push(`<span class="chip chip-warning" style="font-size:10px;">📎 ${r.attachment_count}</span>`);
    }
    return `
      <tr class="js-cli-item-row" data-id="${esc(r.id)}" style="cursor:pointer;">
        <td style="font-weight:600;color:var(--blue);">${esc(r.sku_code || '')}</td>
        <td>
          <div>${esc(r.name || '')}</div>
          ${r.special_handling_instructions ? `<div style="font-size:11px;color:var(--amber);margin-top:2px;">📋 ${esc(r.special_handling_instructions)}</div>` : ''}
        </td>
        <td><span class="chip" style="font-size:11px;">${esc(r.sku_type || '')}</span></td>
        <td style="color:var(--text2);">${esc(r.uom || '')}</td>
        <td class="right" style="font-weight:600;color:${Number(r.qty_available) > 0 ? 'var(--green)' : 'var(--muted)'};">${esc(Number(r.qty_available || 0).toLocaleString())}</td>
        <td>${tracking.join(' ')}</td>
        <td style="text-align:right;"><button class="btn btn-ghost js-cli-item-edit" data-id="${esc(r.id)}" style="padding:3px 10px;font-size:12px;">Edit</button></td>
      </tr>`;
  }).join('');

  // Hover + click — both row and edit button open the item modal
  body.querySelectorAll('.js-cli-item-row').forEach(row => {
    row.addEventListener('mouseover', () => row.style.background = 'var(--hover)');
    row.addEventListener('mouseout',  () => row.style.background = '');
    row.addEventListener('click', () => openItemFormModal(row.dataset.id));
  });
  body.querySelectorAll('.js-cli-item-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openItemFormModal(btn.dataset.id);
    });
  });
}

async function deleteSlaRule(idx){
  const r = _slaRules[idx];
  if(!r) return;
  // Drafts that haven't been saved yet — just remove locally
  if(!r.id){
    _slaRules.splice(idx, 1);
    renderSlaRulePresets();
    renderSlaRulesBody();
    return;
  }
  if(!confirm(`Remove SLA rule "${r.rule_label}"?`)) return;
  try {
    const res = await fetch(`${API}/clients/${_currentClient.id}/sla-rules/${r.id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${T}`},
    });
    if(!res.ok){
      const d = await res.json().catch(() => ({}));
      alert(d.error || 'Delete failed');
      return;
    }
    await loadClientRulesTab();
  } catch(e){ alert('Network error'); }
}
