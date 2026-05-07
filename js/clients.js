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

  if(tab === 'profile')      renderClientProfileTab();
  else if(tab === 'kpi')     loadClientKpiTab();
  else if(tab === 'performance') loadClientPerformanceTab();
}

// ----- PROFILE TAB -----

function renderClientProfileTab(){
  const c = _currentClient;
  if(!c) return;
  const body = document.getElementById('cliProfileBody');
  const row = (l, v) => `
    <div style="display:grid;grid-template-columns:160px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <div style="color:var(--text2);font-weight:600;">${esc(l)}</div>
      <div>${esc(v ?? '—')}</div>
    </div>`;
  body.innerHTML =
    row('Code',           c.code) +
    row('Name',           c.name) +
    row('Type',           c.client_type) +
    row('Contact Name',   c.contact_name) +
    row('Contact Email',  c.contact_email) +
    row('Phone',          c.contact_phone) +
    row('Onboarded',      c.onboarded_at ? new Date(c.onboarded_at).toLocaleDateString() : null) +
    row('Status',         c.is_active ? 'Active' : 'Inactive');
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

  const d = await apiGet(`/clients/${_currentClient.id}/performance`);
  if(!d){
    body.innerHTML = '<div style="color:var(--red);padding:20px;">Could not load performance data</div>';
    return;
  }

  if(!d.items?.length){
    body.innerHTML = '<div class="empty-state" style="padding:24px;">No metrics enabled — enable some on the KPI / SLA Settings tab</div>';
    return;
  }

  const unitLabel = (u) => u === 'pct' ? '%' : u === 'hours' ? 'hrs' : u === 'minutes' ? 'min' : '';
  const fmtVal = (v, u) => v == null ? '—' : `${Number(v).toLocaleString()}${unitLabel(u)}`;
  const statusChip = (s) => s === 'good'  ? '<span class="chip chip-success">✓ Meeting target</span>'
                          : s === 'warn'  ? '<span class="chip chip-warning">⚠ Warning</span>'
                          : s === 'breach' ? '<span class="chip chip-danger">✕ Below SLA</span>'
                          : '<span class="chip chip-new">Info</span>';
  const valColor = (s) => s === 'good' ? 'var(--green)' : s === 'warn' ? 'var(--amber)' : s === 'breach' ? 'var(--red)' : 'var(--text)';

  body.innerHTML = `
    <table class="data-table" style="margin:0;">
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
    </table>`;
}
