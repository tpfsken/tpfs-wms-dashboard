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

const CLI_COLS = [
  { key: '_sel', label: '', render: c => `<input type="checkbox" class="js-cli-sel" data-id="${esc(c.id)}" aria-label="Select ${esc(c.code)}" ${_cliSel.has(c.id) ? 'checked' : ''}>` },
  { key: 'code', label: 'Code', mono: true },
  { key: 'name', label: 'Client' },
  { key: 'contact_email', label: 'Contact' },
  { key: 'client_type', label: 'Type', render: c =>
      `<span class="ui-chip ui-chip-neutral">${esc(c.client_type || '—')}</span>` },
  // Both of these change how every SKU under the client behaves — worth seeing
  // from the list rather than opening each client to find out.
  { key: '_flags', label: 'Flags', sortable: false, render: c =>
      (c.hazmat_enabled ? '<span class="ui-chip ui-chip-danger">HAZMAT</span> ' : '') +
      (c.lot_tracking_enabled ? '<span class="ui-chip ui-chip-info">LOT</span>' : '') ||
      '<span class="ui-muted">—</span>' },
  { key: '_onboarded', label: 'Onboarded', sortValue: c => c.onboarded_at, render: c => c.onboarded_at
      ? uiId(new Date(c.onboarded_at).toLocaleDateString()) : '<span class="ui-muted">—</span>' },
  { key: '_status', label: 'Status', sortValue: c => cliStatusOf(c), render: c => cliStatusChip(c) },
];
const _cliSel = new Set();
let _cliShowInactive = false;
const cliStatusOf = (c) => c.status || (c.is_active === false ? 'inactive' : 'active');
function cliStatusChip(c){
  const st = cliStatusOf(c);
  const asOf = c.status_as_of ? String(c.status_as_of).slice(0, 10) : '';
  return uiChip(st.toUpperCase(), st.toUpperCase()) + (st !== 'active' && asOf ? ` <span class="ui-muted">${esc(asOf)}</span>` : '');
}
function cliRenderBulk(){
  const host = document.getElementById('cliBulkBar');
  if(!host) return;
  const n = _cliSel.size;
  host.hidden = n === 0;
  host.innerHTML = n ? `<span class="ord-bulk-count">${esc(n)} selected</span>
    <button type="button" class="ui-btn js-cli-bulk-clear">Clear</button>
    <button type="button" class="ui-btn ui-btn-danger js-cli-bulk-inactive">Set inactive</button>` : '';
  if(!n) return;
  host.querySelector('.js-cli-bulk-clear').addEventListener('click', uiBusyHandler(() => { _cliSel.clear(); return loadClients(); }));
  host.querySelector('.js-cli-bulk-inactive').addEventListener('click', uiBusyHandler(cliBulkInactive));
}
async function cliBulkInactive(){
  const ids = [..._cliSel];
  if(!ids.length) return false;
  const codes = ids.map(id => (clientsCache.find(c => c.id === id) || {}).code || id.slice(0, 8));
  const note = await uiPrompt({ title: `Set ${ids.length} client${ids.length === 1 ? '' : 's'} inactive?`, label: 'Note (optional)', placeholder: 'e.g. no pieces migrated', value: '' });
  if(note == null) return false;
  const r = await fetch(`${API}/clients/bulk-status`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ clientIds: ids, status: 'inactive', note: note || null }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Could not change status', 'error'); return false; }
  _cliSel.clear();
  uiToast(`${(d.changed || []).length} set inactive${(d.refused || []).length ? ` · ${d.refused.length} refused: ${d.refused.map(x => x.why).join('; ')}` : ''} (${codes.slice(0, 5).join(', ')}${codes.length > 5 ? '…' : ''})`, (d.refused || []).length ? 'warning' : 'success');
  clientsCache = []; await loadCC();
  await loadClients();
}
function cliWireSelection(){
  const wrap = document.getElementById('cliListWrap');
  if(!wrap) return;
  wrap.querySelectorAll('.js-cli-sel').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => { if(cb.checked) _cliSel.add(cb.dataset.id); else _cliSel.delete(cb.dataset.id); cliRenderBulk(); });
  });
  cliRenderBulk();
}
function cliToggleInactive(cb){
  _cliShowInactive = !!cb.checked;
  _cliSel.clear();
  return loadClients();
}

async function loadClients(){
  // Always reset to list view on (re)load
  document.getElementById('cliDetailView').style.display = 'none';
  document.getElementById('cliListView').style.display   = 'block';

  uiTableLoading('cliListWrap', CLI_COLS);
  const d = await apiGet(_cliShowInactive ? '/clients?all=1' : '/clients');
  if(d === null) return uiTableError('cliListWrap', CLI_COLS, 'Could not load clients', loadClients);
  if(!_cliShowInactive) clientsCache = d;      // the shared cache stays active-only: every picker reads it

  // A 3PL has tens of clients, not thousands — this list is small enough to
  // sort locally (no onSort) without lying about what's on screen.
  uiTable('cliListWrap', {
    columns: CLI_COLS, rows: d, rowKey: 'id',
    sortable: true,
    onRowClick: c => openClientDetail(c.id),
    empty: _cliShowInactive ? 'No clients.' : 'No active clients. Tick "Show inactive" to see the rest.',
  });
  cliWireSelection();
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
    `${d.code || ''}${d.client_type ? ' · ' + d.client_type : ''}${cliStatusOf(d) !== 'active' ? ' · ' + cliStatusOf(d).toUpperCase() + (d.status_as_of ? ' since ' + String(d.status_as_of).slice(0, 10) : '') : ''}`;
  cliRenderReactivate(d);

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

// The tab strip was a third bespoke tab system (.cli-tab, styled by poking
// element.style on every click). It's uiTabs now — the one tab system.
const CLI_TABS = [
  { id: 'profile',     label: 'Profile' },
  { id: 'items',       label: 'Item master' },
  { id: 'ratecard',    label: 'Rate card' },
  { id: 'kpi',         label: 'KPI / SLA targets' },
  { id: 'rules',       label: 'SLA rules' },
  { id: 'performance', label: 'Performance' },
  { id: 'scanning',    label: 'Scanning' },
  { id: 'portal',      label: 'Portal access' },
];

function wireClientTabs(){
  uiTabs('cliTabs', CLI_TABS.filter(t => (t.id !== 'ratecard' || can('billing.view')) && (t.id !== 'portal' || can('clients.portal_access'))), { active: 'profile', onChange: switchClientTab });   // rate card = billing data; portal access = admin switch

  // KPI tab buttons (Save / Reset to defaults). Idempotent.
  const saveBtn = document.getElementById('cliKpiSaveBtn');
  const seedBtn = document.getElementById('cliKpiSeedBtn');
  if(saveBtn && !saveBtn._wired){ saveBtn._wired = true; saveBtn.addEventListener('click', uiBusyHandler(saveClientKpiConfig)); }
  if(seedBtn && !seedBtn._wired){ seedBtn._wired = true; seedBtn.addEventListener('click', uiBusyHandler(resetClientKpiConfig)); }
}

function switchClientTab(tab){
  // Keep the strip in step when something OTHER than a tab click drives the
  // switch (e.g. the accrual screen deep-links into a client's rate card).
  document.querySelectorAll('#cliTabs .ui-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.cli-panel').forEach(p => {
    p.style.display = p.dataset.tab === tab ? 'block' : 'none';
  });

  if(tab === 'profile')          renderClientProfileTab();
  else if(tab === 'items')       loadClientItemsTab();
  else if(tab === 'kpi')         loadClientKpiTab();
  else if(tab === 'rules')       loadClientRulesTab();
  else if(tab === 'ratecard')    loadClientRateCardTab();
  else if(tab === 'performance') loadClientPerformanceTab();
  else if(tab === 'scanning')    spMountClientTab();
  else if(tab === 'portal')      loadClientPortalTab();
}

// ----- PROFILE TAB -----

function renderClientProfileTab(){
  const c = _currentClient;
  if(!c) return;
  const typeLabel = c.client_type === 'BOTH' ? 'B2B + B2C' : (c.client_type || '—');

  document.getElementById('cliProfileBody').innerHTML = uiMeta([
    { k: 'Code', v: uiId(c.code) },
    { k: 'Name', v: esc(c.name || '—') },
    { k: 'Type', v: esc(typeLabel) },
    { k: 'Contact', v: esc(c.contact_name || '—') },
    { k: 'Email', v: esc(c.contact_email || '—') },
    { k: 'Phone', v: esc(c.contact_phone || '—') },
    { k: 'Hazmat', v: c.hazmat_enabled
        ? '<span class="ui-chip ui-chip-danger">ENABLED</span>'
        : '<span class="ui-muted">No</span>' },
    { k: 'Lot tracking', v: c.lot_tracking_enabled
        ? '<span class="ui-chip ui-chip-info">MANDATORY — all SKUs</span>'
        : '<span class="ui-muted">Per-item</span>' },
    { k: 'Picking', v: esc(`${(c.pick_rules && c.pick_rules.location_mode) === 'scan' ? 'Scan bin' : "Tap I'M HERE"} · ${c.pick_rules && c.pick_rules.require_item_scan === false ? 'count' : 'item scans'} · units ${c.unit_control || 'none'}${c.pick_rules && c.pick_rules.allow_carton_confirm ? ' · carton confirm' : ''}`) },
    { k: 'Labels', v: esc(c.label_mode === 'label_at_pack' ? 'At pack (packer creates in ShipStation)' : 'Label first (printed in ShipStation before picking)') },
    { k: 'Invoice detail', v: esc(c.invoice_detail_mode === 'SUMMARY'
        ? 'Summary (grouped)' : 'Detailed (per LP)') },
    { k: 'Onboarded', v: c.onboarded_at
        ? uiId(new Date(c.onboarded_at).toLocaleDateString()) : '<span class="ui-muted">—</span>' },
    { k: 'Status', v: cliStatusChip(c) + (c.status_note ? ` <span class="ui-muted">${esc(c.status_note)}</span>` : '') + (cliStatusOf(c) === 'offboarded' ? ' <span class="ui-hint">Offboarded clients are read-only until reactivated.</span>' : '') },
    { k: 'System of record', v: cliSorCell(c) },
  ]);
  const goLive = document.getElementById('cliProfileBody').querySelector('.js-cli-golive');
  if(goLive) goLive.addEventListener('click', uiBusyHandler(() => cliGoLive(c)));
  if(typeof loadClientCatchupCard === 'function') loadClientCatchupCard();   // Excalibur catch-up card (live + mapped clients only)
  const backM = document.getElementById('cliProfileBody').querySelector('.js-cli-backmirror');
  if(backM) backM.addEventListener('click', uiBusyHandler(() => cliBackToMirror(c)));

  // Hazmat panel — only the emergency contact + notes live at client level;
  // per-item hazmat (UN #, class, packing group) is on the SKU.
  const hazPanel = document.getElementById('cliHazmatPanel');
  if(c.hazmat_enabled){
    hazPanel.style.display = 'block';
    const hc = c.hazmat_config || {};
    document.getElementById('cliHazmatBody').innerHTML =
      uiMeta([
        { k: 'Emergency contact', v: esc(hc.emergency_contact || '—') },
        { k: 'Notes', v: esc(hc.notes || '—') },
      ]) +
      `<div class="ui-hint" style="margin-top:12px;">Per-item hazmat fields (UN #, hazard class, packing group, ground-only) are set on each item. Items under this client require them.</div>`;
  } else {
    hazPanel.style.display = 'none';
  }

  const editBtn = document.getElementById('cliEditBtn');
  if(editBtn) editBtn.disabled = cliStatusOf(c) === 'offboarded';
  if(editBtn && !editBtn._wired){
    editBtn._wired = true;
    editBtn.addEventListener('click', () => openClientFormModal(_currentClient));
    if(!can('clients.manage')) editBtn.classList.add('perm-denied');
  }
}

// System of record (Excalibur replay mirror, migration 091): a mirror client follows Excalibur's
// posted transactions until "Go live"; the switch runs a final reconcile and refuses on drift.
function cliSorCell(c){
  const mirror = (c.system_of_record || 'wms') === 'excalibur';
  const chip = mirror ? uiChip('DRAFT', 'EXCALIBUR — MIRROR') : uiChip('ACTIVE', 'WMS — LIVE');
  const when = !mirror && c.went_live_at ? ` <span class="ui-muted">live since ${esc(fmtTimeShort(c.went_live_at))}</span>` : '';
  const btn = !can('integrations.excalibur') ? '' : mirror
    ? '<button type="button" class="ui-btn ui-btn-primary cli-sor-btn js-cli-golive">Go live</button> <span class="ui-hint">Excalibur is the system of record; its posted receipts, shipments and adjustments are replayed here. Go live runs a final reconcile and refuses while anything differs.</span>'
    : (c.went_live_at ? '<button type="button" class="ui-btn cli-sor-btn js-cli-backmirror">Back to mirror</button>' : '');
  return `${chip}${when} ${btn}`;
}
async function cliGoLive(c){
  const go = await uiConfirm({ title: `Go live: ${c.code}?`, body: esc('Runs a final reconcile against Excalibur. If Excalibur and the WMS differ on any line the switch is refused and the lines are shown. On success the WMS becomes the system of record and the replay stops for this client.'), confirmLabel: 'Go live' });
  if(!go) return;
  const r = await fetch(`${API}/clients/${c.id}/go-live`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(r.status === 409 && d.drift){ uiToast(d.error || 'Go live refused', 'error'); mmDriftModal(c.code, d.drift, d.error); return; }
  if(!r.ok) return uiToast(d.error || 'Go live failed', 'error');
  uiToast(`${c.code} is live — the WMS is the system of record`, 'success');
  await openClientDetail(c.id);
}
async function cliBackToMirror(c){
  const reason = await uiPrompt({ title: `Back to mirror: ${c.code}?`, body: esc('Excalibur becomes the system of record again and the next cycle replays whatever it posted meanwhile. Use this only if the cutover is being rolled back.'), label: 'Reason', placeholder: 'why', confirmLabel: 'Back to mirror', danger: true });
  if(reason === null || reason === false) return;
  const r = await fetch(`${API}/clients/${c.id}/back-to-mirror`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ reason }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not switch back', 'error');
  uiToast(`${c.code} is mirroring the legacy system again`, 'success');
  await openClientDetail(c.id);
}

// Reactivate — one click for ops. Rendered next to the detail title when the client is not active.
function cliRenderReactivate(d){
  const host = document.getElementById('cliReactivateHost');
  if(!host) return;
  const st = cliStatusOf(d);
  host.innerHTML = st === 'active' ? '' : `<button type="button" class="ui-btn ui-btn-primary js-cli-reactivate">Reactivate</button>`;
  const b = host.querySelector('.js-cli-reactivate');
  if(b) b.addEventListener('click', uiBusyHandler(async () => {
    const r = await fetch(`${API}/clients/${d.id}/reactivate`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
    const x = await r.json().catch(() => ({}));
    if(!r.ok){ uiToast(x.error || 'Could not reactivate', 'error'); return false; }
    uiToast(`${x.code} is active again`, 'success');
    clientsCache = []; await loadCC();
    await openClientDetail(d.id);
  }));
}

// =============================================================================
// NEW / EDIT CLIENT MODAL
// =============================================================================
// Same modal handles both Create (when client is null) and Edit.

let _editingClientId = null;   // null for new, string id for edit
let CLIENT_M = null;           // open client-form uiModal

const CLIENT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive — hidden from lists, no new work' },
  { value: 'offboarded', label: 'Offboarded — inventory must be 0, read-only' },
];
const CLIENT_TYPES = [
  { value: 'B2B',  label: 'B2B — distribution' },
  { value: 'B2C',  label: 'B2C — DTC / eCommerce' },
  { value: 'BOTH', label: 'Both' },
];

function openClientFormModal(client){
  _editingClientId = client?.id || null;
  const hc = client?.hazmat_config || {};
  const pr = (client && client.pick_rules) || {};

  CLIENT_M = uiModal({
    title: client ? `Edit ${client.name || client.code}` : 'New client',
    width: 680,
    body: `
      <div class="ui-field-row">
        ${uiField({ id: 'cfCode', label: 'Client code *', value: client?.code || '',
                    placeholder: 'ACME', hint: 'Short, unique. Shows on LPs and invoices.' })}
        ${uiField({ id: 'cfName', label: 'Client name *', value: client?.name || '' })}
      </div>
      ${uiFieldSelect({ id: 'cfType', label: 'Client type', options: CLIENT_TYPES,
                        value: client?.client_type || 'B2B' })}
      ${client ? `<div class="no-row-3">
        ${uiFieldSelect({ id: 'cfStatus', label: 'Status', options: CLIENT_STATUSES, value: cliStatusOf(client) })}
        ${uiField({ id: 'cfStatusAsOf', label: 'As of', type: 'date', value: client.status_as_of ? String(client.status_as_of).slice(0, 10) : '' })}
        ${uiField({ id: 'cfStatusNote', label: 'Status note', value: client.status_note || '', placeholder: 'why' })}
      </div>
      <div class="ui-hint">Inactive and offboarded clients leave every working list and picker and take no new orders, receipts or allocations. Offboarded also needs on-hand inventory at 0 and makes the client read-only.</div>` : ''}
      <div class="no-row-3">
        ${uiField({ id: 'cfContactName', label: 'Contact name', value: client?.contact_name || '' })}
        ${uiField({ id: 'cfContactEmail', label: 'Contact email', type: 'email', value: client?.contact_email || '' })}
        ${uiField({ id: 'cfContactPhone', label: 'Phone', value: client?.contact_phone || '' })}
      </div>
      ${uiFieldSelect({ id: 'cfInvoiceMode', label: 'Invoice detail',
          options: [
            { value: 'DETAILED', label: 'Detailed — one line per license plate' },
            { value: 'SUMMARY',  label: 'Summary — grouped by charge code' },
          ], value: client?.invoice_detail_mode || 'DETAILED' })}

      <div class="eo-section">
        <div class="ui-label">Client rules</div>
        <div class="item-checks">
          <label class="ui-check ui-check-warn">
            <input type="checkbox" id="cfHazmat" ${client?.hazmat_enabled ? 'checked' : ''}> ⚠ Hazmat client
          </label>
          <label class="ui-check">
            <input type="checkbox" id="cfLotTracking" ${client?.lot_tracking_enabled ? 'checked' : ''}> Lot tracking mandatory
          </label>
        </div>
        <div class="ui-label cf-rules-label">Picking rules</div>
        ${uiFieldSelect({ id: 'cfLocationMode', label: 'Location step', options: [
            { value: 'tap',  label: 'Tap — GO TO the bin, picker taps I\'M HERE' },
            { value: 'scan', label: 'Scan — the bin label must be scanned first' },
          ], value: pr.location_mode || 'tap',
          hint: 'In tap mode every unit or carton scan is still checked against the location it is recorded in. Plain item or UPC barcode labels carry no location, so they are not location-checked in tap mode.' })}
        ${uiFieldSelect({ id: 'cfUnitControl', label: 'Unit control', options: [
            { value: 'none',     label: 'None — count by item scans' },
            { value: 'optional', label: 'Optional — units may be received' },
            { value: 'required', label: 'Required — every pick and ship scans units' },
          ], value: client?.unit_control || 'none' })}
        ${uiFieldSelect({ id: 'cfLabelMode', label: 'Shipping labels', options: [
            { value: 'label_first',   label: 'Label first — the office prints in the shipping system before picking (default)' },
            { value: 'label_at_pack', label: 'Label at pack — the packer creates the label from the closed package' },
          ], value: client?.label_mode || 'label_first' })}
        ${uiFieldSelect({ id: 'cfShipReadyPack', label: 'Ship-ready packaging', options: [
            { value: 'per_unit',  label: 'One package per unit (default)' },
            { value: 'per_order', label: 'One package per order' },
          ], value: (client?.ship_rules && client.ship_rules.ship_ready_packaging) || 'per_unit', hint: 'For items that ship as-is: the unit scan at Pack & Ship packs and closes the box itself.' })}
        ${uiFieldSelect({ id: 'cfDefaultBox', label: 'Default box (label at pack)', options: [{ value: '', label: 'None — the packer scans the box' }], value: (client?.ship_rules && client.ship_rules.default_box_id) || '', hint: 'Offered as "Use <box>" at Pack & Ship. Boxes live under Settings → Packaging.' })}
        <div class="item-checks">
          <label class="ui-check"><input type="checkbox" id="cfAllowCustomDims" ${(client?.ship_rules && client.ship_rules.allow_custom_dims === false) ? '' : 'checked'}> Allow typed dims at Pack & Ship (instead of scanning a box)</label>
          <label class="ui-check"><input type="checkbox" id="cfShipsAsIs" ${client?.ships_as_is_default ? 'checked' : ''}> Items ship as-is by default (each item can override)</label>
          <label class="ui-check"><input type="checkbox" id="cfRequireLabelScan" ${(client?.ship_rules && client.ship_rules.require_label_scan === false) ? '' : 'checked'}> Require the label scan at ship (every box's label is scanned at the bench before Ship)</label>
          <label class="ui-check"><input type="checkbox" id="cfItemScan" ${pr.require_item_scan === false ? '' : 'checked'}> Require item scans (off = tap-to-count)</label>
          <label class="ui-check"><input type="checkbox" id="cfCartonConfirm" ${pr.allow_carton_confirm ? 'checked' : ''}> Allow carton confirm (scan a license plate to count its units)</label>
        </div>
        <div id="cfHazmatBlock" class="item-hazmat" style="display:${client?.hazmat_enabled ? '' : 'none'};">
          ${uiField({ id: 'cfHazEmergency', label: 'Emergency contact',
                      value: hc.emergency_contact || '',
                      hint: '24/7 number for a spill or incident. Prints on hazmat paperwork.' })}
          ${uiField({ id: 'cfHazNotes', label: 'Hazmat notes', value: hc.notes || '' })}
        </div>
      </div>`,
    actions: [
      { label: 'Cancel' },
      { label: client ? 'Save changes' : 'Create client', primary: true, onClick: submitClientForm },
    ],
    onClose: () => { CLIENT_M = null; },
  });

  const haz = document.getElementById('cfHazmat');
  haz.addEventListener('change', () => {
    document.getElementById('cfHazmatBlock').style.display = haz.checked ? '' : 'none';
  });
  document.getElementById('cfCode').focus?.();
  // the box catalog fills the default-box select once it loads (the modal opens at once)
  const want = (client?.ship_rules && client.ship_rules.default_box_id) || '';
  apiGet('/packaging/boxes?all=1').then(d => {
    const sel = document.getElementById('cfDefaultBox');
    if(!sel) return;
    const rows = (d?.rows || []).filter(b => b.active || b.id === want);
    sel.innerHTML = '<option value="">None — the packer scans the box</option>' + rows.map(b => `<option value="${esc(b.id)}" ${b.id === want ? 'selected' : ''}>${esc(b.name)} — ${esc(b.lengthIn)} × ${esc(b.widthIn)} × ${esc(b.heightIn)} in${b.active ? '' : ' (inactive)'}</option>`).join('');
  }).catch(() => {});
}

// uiModal action — returning false keeps the modal open.
async function submitClientForm(m){
  const v = (id) => document.getElementById(id).value.trim();
  const code = v('cfCode').toUpperCase();
  const name = v('cfName');

  uiFieldError(m.el, 'cfCode', code ? '' : 'Client code is required');
  uiFieldError(m.el, 'cfName', name ? '' : 'Client name is required');
  if(!code || !name) return false;

  const lotTracking = document.getElementById('cfLotTracking').checked;

  // Turning lot tracking ON rewrites every SKU under the client — say so, and
  // say how many. The old confirm() just asserted "existing items will be
  // backfilled" without telling ops what that meant in practice.
  if(_currentClient && lotTracking && !_currentClient.lot_tracking_enabled){
    const skus = await apiGet(`/clients/${_currentClient.id}/skus?limit=1`);
    const n = Number(skus?.total ?? (Array.isArray(skus) ? skus.length : 0));
    const ok = await uiConfirm({
      title: 'Make lot tracking mandatory?',
      body: `Every item under <strong>${esc(_currentClient.name || code)}</strong>` +
            (n ? ` — <strong>${esc(n)}</strong> item(s)` : '') +
            ` will be backfilled to lot-tracked, and new items can't opt out.<br><br>` +
            `Receiving will then require a lot number on every inbound line for this client.`,
      confirmLabel: 'Make it mandatory',
    });
    if(!ok) return false;
  }

  const body = {
    code, name,
    client_type:    document.getElementById('cfType').value,
    contact_name:   v('cfContactName') || null,
    contact_email:  v('cfContactEmail') || null,
    contact_phone:  v('cfContactPhone') || null,
    hazmat_enabled: document.getElementById('cfHazmat').checked,
    lot_tracking_enabled: lotTracking,
    invoice_detail_mode: document.getElementById('cfInvoiceMode').value,
    unit_control: document.getElementById('cfUnitControl').value,
    label_mode: document.getElementById('cfLabelMode').value,
    ships_as_is_default: document.getElementById('cfShipsAsIs').checked,
    ship_rules: { ...((_currentClient && _currentClient.id === _editingClientId && _currentClient.ship_rules) || {}), ship_ready_packaging: document.getElementById('cfShipReadyPack').value, require_label_scan: document.getElementById('cfRequireLabelScan').checked,
                  default_box_id: document.getElementById('cfDefaultBox').value || null, allow_custom_dims: document.getElementById('cfAllowCustomDims').checked },
    pick_rules: {
      location_mode: document.getElementById('cfLocationMode').value,
      require_item_scan: document.getElementById('cfItemScan').checked,
      allow_carton_confirm: document.getElementById('cfCartonConfirm').checked,
    },
    // Per-item hazmat (UN #, class, packing group) lives on the SKU — only the
    // emergency contact + notes belong on the client record.
    hazmat_config: document.getElementById('cfHazmat').checked ? {
      emergency_contact: v('cfHazEmergency') || null,
      notes:             v('cfHazNotes') || null,
    } : null,
  };

  // Status goes through its own route (PUT /clients/:id/status); an offboarded client is read-only,
  // so a status change is applied FIRST, and the field edits are skipped while it stays offboarded.
  if(_editingClientId){
    const st = document.getElementById('cfStatus').value, was = cliStatusOf(_currentClient || {});
    const asOf = v('cfStatusAsOf') || null, note = v('cfStatusNote') || null;
    const statusChanged = st !== was || (st !== 'active' && (asOf !== ((_currentClient && _currentClient.status_as_of) ? String(_currentClient.status_as_of).slice(0, 10) : null) || note !== ((_currentClient && _currentClient.status_note) || null)));
    if(statusChanged){
      if(st === 'offboarded' && was !== 'offboarded'){
        const go = await uiConfirm({ title: `Offboard ${esc(code)}?`, body: '<p>The client must have no inventory on hand. It becomes read-only and disappears from every list and picker. History, invoices and reports stay readable. Reactivate is one click.</p>', confirmLabel: 'Offboard', danger: true });
        if(!go) return false;
      }
      const rs = await fetch(`${API}/clients/${_editingClientId}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ status: st, asOf, note }) });
      const ds = await rs.json().catch(() => ({}));
      if(!rs.ok){ uiFieldError(CLIENT_M.el, 'cfStatus', ds.error || 'Status change refused'); uiToast(ds.error || 'Status change refused', 'error'); return false; }
      if(st === 'offboarded'){
        uiToast(`${code} offboarded — read-only`, 'success');
        clientsCache = []; await loadCC(); await loadClients();
        return true;
      }
    }
  }

  try {
    const r = await fetch(
      _editingClientId ? `${API}/clients/${_editingClientId}` : `${API}/clients`, {
        method: _editingClientId ? 'PATCH' : 'POST',
        headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
        body: JSON.stringify(body),
      });
    const d = await r.json();
    if(!r.ok){ uiToast(d.error || 'Save failed', 'error'); return false; }

    uiToast(_editingClientId ? 'Client saved' : `${code} created`);
    // Land on the client's detail page so ops can dial in SLA targets now.
    clientsCache = []; await loadCC();
    await loadClients();
    openClientDetail(d.id);
  } catch(e){
    uiToast('Network error — the client was not saved', 'error');
    return false;
  }
}

// ----- KPI / SLA SETTINGS TAB -----

const KPI_UNIT  = (u) => u === 'pct' ? '%' : u === 'hours' ? 'hrs' : u === 'minutes' ? 'min' : '';
const KPI_DIR   = (d) => d === 'higher_is_better' ? 'Higher is better'
                       : d === 'lower_is_better'  ? 'Lower is better'
                       : 'Informational';

async function loadClientKpiTab(){
  if(!_currentClient) return;
  const body = document.getElementById('cliKpiBody');
  body.innerHTML = uiSpinner('Loading KPI targets…');

  // Catalog is client-independent — cache after the first call.
  if(!_kpiCatalog) _kpiCatalog = await apiGet('/kpi-catalog');
  const config = await apiGet(`/clients/${_currentClient.id}/kpi-config`);
  if(!config){ body.innerHTML = uiError('Could not load the KPI config'); return; }
  _kpiConfigRows = config;
  renderClientKpiTab();
}

const KPI_COLS = [
  { key: '_on', label: 'On', render: r => {
      const i = _kpiConfigRows.indexOf(r);
      return `<input type="checkbox" class="alloc-chk js-kpi-enabled" data-idx="${esc(i)}" ${r.enabled ? 'checked' : ''}>`;
    } },
  { key: '_metric', label: 'Metric', render: r =>
      `<div>${esc(r.custom_label || r.label)}</div>` +
      (r.description ? `<div class="ui-hint">${esc(r.description)}</div>` : '') },
  { key: '_dir', label: 'Direction', render: r =>
      `<span class="ui-muted">${esc(KPI_DIR(r.direction))}</span>` },
  { key: '_target', label: 'Target', render: r => {
      if(r.direction === 'info') return '<span class="ui-muted">—</span>';
      const i = _kpiConfigRows.indexOf(r);
      return `<input type="number" step="0.1" class="ui-input kpi-num js-kpi-target" data-idx="${esc(i)}"
                value="${r.target_value == null ? '' : esc(r.target_value)}">
              <span class="ui-hint">${esc(KPI_UNIT(r.unit))}</span>`;
    } },
  { key: '_warn', label: 'Warning', render: r => {
      if(r.direction === 'info') return '<span class="ui-muted">—</span>';
      const i = _kpiConfigRows.indexOf(r);
      return `<input type="number" step="0.1" class="ui-input kpi-num js-kpi-warning" data-idx="${esc(i)}"
                value="${r.warning_threshold == null ? '' : esc(r.warning_threshold)}">
              <span class="ui-hint">${esc(KPI_UNIT(r.unit))}</span>`;
    } },
];

function renderClientKpiTab(){
  const body = document.getElementById('cliKpiBody');
  uiTable(body, {
    columns: KPI_COLS, rows: _kpiConfigRows, rowKey: 'metric_key',
    empty: 'No metrics in the catalog.',
  });

  // Keep _kpiConfigRows in step as the user edits.
  body.querySelectorAll('.js-kpi-enabled').forEach(cb =>
    cb.addEventListener('change', e => {
      _kpiConfigRows[parseInt(e.target.dataset.idx)].enabled = e.target.checked;
    }));
  const num = (e) => { const v = e.target.value.trim(); return v === '' ? null : Number(v); };
  body.querySelectorAll('.js-kpi-target').forEach(inp =>
    inp.addEventListener('input', e => {
      _kpiConfigRows[parseInt(e.target.dataset.idx)].target_value = num(e);
    }));
  body.querySelectorAll('.js-kpi-warning').forEach(inp =>
    inp.addEventListener('input', e => {
      _kpiConfigRows[parseInt(e.target.dataset.idx)].warning_threshold = num(e);
    }));
}

async function saveClientKpiConfig(){
  if(!_currentClient) return;

  // A warning threshold on the wrong side of the target never fires — the KPI
  // would go straight from good to breached with no amber. Catch it here; the
  // server doesn't check it.
  const backwards = _kpiConfigRows.filter(r => {
    if(r.direction === 'info' || r.target_value == null || r.warning_threshold == null) return false;
    return r.direction === 'higher_is_better'
      ? Number(r.warning_threshold) < Number(r.target_value)   // warn must be ABOVE target
      : Number(r.warning_threshold) > Number(r.target_value);  // warn must be BELOW target
  });
  if(backwards.length){
    const ok = await uiConfirm({
      title: 'Warning thresholds look backwards',
      body: backwards.map(r =>
        `<strong>${esc(r.custom_label || r.label)}</strong>: target ${esc(r.target_value)}, warning ${esc(r.warning_threshold)} — ` +
        (r.direction === 'higher_is_better'
          ? 'for "higher is better", the warning should sit ABOVE the target.'
          : 'for "lower is better", the warning should sit BELOW the target.')).join('<br><br>') +
        '<br><br>As set, these metrics will never show amber — they jump straight from good to breached.',
      confirmLabel: 'Save anyway',
    });
    if(!ok) return;
  }

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
    if(!r.ok) return uiToast(d.error || 'Save failed', 'error');
    _kpiConfigRows = d;
    uiToast('KPI targets saved — the client\'s portal picks them up on next load');
  } catch(e){
    uiToast('Network error — targets not saved', 'error');
  }
}

async function resetClientKpiConfig(){
  if(!_currentClient) return;
  const ok = await uiConfirm({
    title: 'Reset KPI / SLA settings to defaults?',
    body: `Every metric on <strong>${esc(_currentClient.name || '')}</strong> goes back to the catalog defaults. Custom targets and warning thresholds on this client are lost.`,
    confirmLabel: 'Reset to defaults', danger: true,
  });
  if(!ok) return;

  try {
    const r = await fetch(`${API}/clients/${_currentClient.id}/kpi-config/seed`, {
      method:  'POST',
      headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body:    JSON.stringify({}),
    });
    const d = await r.json();
    if(!r.ok) return uiToast(d.error || 'Reset failed', 'error');
    await loadClientKpiTab();
    uiToast('Reset to catalog defaults');
  } catch(e){
    uiToast('Network error — nothing was reset', 'error');
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
      Charges are billed when an order falls outside the SLA. They become billing charges automatically (next phase) — for now they're recorded so the SLA doc shows the rate.
    </div>
    <table class="data-table" style="margin:0;">
      <thead>
        <tr>
          <th style="width:22%;">Rule</th>
          <th style="width:14%;">Value</th>
          <th style="width:10%;">Unit</th>
          <th style="width:18%;">Exception charge</th>
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

  body.querySelectorAll('.js-sla-save').forEach(btn => btn.addEventListener('click', uiBusyHandler(() =>
    saveSlaRule(parseInt(btn.dataset.idx)))));
  body.querySelectorAll('.js-sla-rm').forEach(btn => btn.addEventListener('click', uiBusyHandler(() =>
    deleteSlaRule(parseInt(btn.dataset.idx)))));
}

async function saveSlaRule(idx){
  const r = _slaRules[idx];
  if(!r) return;
  if(!r.rule_label || !r.rule_label.trim()) return uiToast('The rule needs a name', 'error');

  // An exception fee with no label bills the customer for something their
  // invoice can't explain. Catch it before it reaches an invoice line.
  if(r.exception_charge_amount != null && !(r.exception_charge_label || '').trim()){
    return uiToast('Name the exception charge — an unlabelled fee shows up on the invoice with no explanation', 'error');
  }

  // Custom rules: keep rule_key derived from the label so it stays stable.
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
    if(!res.ok) return uiToast(d.error || 'Save failed', 'error');
    uiToast(`“${r.rule_label}” saved — it's now visible on the client's portal`);
    await loadClientRulesTab();
  } catch(e){
    uiToast('Network error — the rule was not saved', 'error');
  }
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
    if(!can('items.edit')) addBtn.classList.add('perm-denied');
    addBtn.addEventListener('click', uiBusyHandler(async () => {
      // Open the existing New Item modal, then preselect this client.
      // openItemFormModal lives in inventory.js — relies on globals.
      await openItemFormModal();
      const cid = String(_currentClient.id);
      cbSet('itemClientWrap', cid,
        `${_currentClient.code || ''} — ${_currentClient.name || ''}`);
      // Trigger the hazmat hint logic
      if(typeof onItemClientChange === 'function') onItemClientChange();
    }));
  }
  // Item Import (js/itemImport.js) — items.import
  const impBtn = document.getElementById('cliItemsImportBtn');
  if(impBtn && !impBtn._wired){ impBtn._wired = true; impBtn.addEventListener('click', uiBusyHandler(() => openItemImportWizard())); }
  const tplBtn = document.getElementById('cliItemsTemplateBtn');
  if(tplBtn && !tplBtn._wired){ tplBtn._wired = true; tplBtn.addEventListener('click', uiBusyHandler(() => downloadItemImportTemplate())); }
  if(typeof applyPermGates === 'function') applyPermGates(document.querySelector('.cli-panel[data-tab="items"]'));
  if(typeof loadItemImportHistory === 'function') loadItemImportHistory();
  fetchClientItems(search?.value.trim() || '');
}

const CLI_ITEM_LIMIT = 500;   // what the endpoint will return in one call

const CLI_ITEM_COLS = [
  { key: 'sku_code', label: 'Item', mono: true },
  { key: '_name', label: 'Description', sortValue: r => r.name, render: r =>
      `<div>${esc(r.name || '')}</div>` +
      (r.special_handling_instructions
        ? `<div class="eo-line-lock"><strong>Special handling:</strong> ${esc(r.special_handling_instructions)}</div>` : '') },
  { key: 'sku_type', label: 'Type', render: r =>
      `<span class="ui-chip ui-chip-neutral">${esc(r.sku_type || '')}</span>` },
  { key: 'uom', label: 'UOM' },
  { key: 'qty_available', label: 'On hand', num: true },
  { key: '_flags', label: 'Flags', sortable: false, render: r => {
      const f = [];
      if(r.is_lot_tracked)    f.push('<span class="ui-chip ui-chip-info">LOT</span>');
      if(r.is_expiry_tracked) f.push('<span class="ui-chip ui-chip-info">EXP</span>');
      if(r.is_hazmat) f.push(`<span class="ui-chip ui-chip-danger">⚠ HAZMAT${r.un_number ? ' ' + esc(r.un_number) : ''}${r.hazard_class ? ' · Cl ' + esc(r.hazard_class) : ''}</span>`);
      if(r.attachment_count > 0) f.push(`<span class="ui-chip ui-chip-neutral">${esc(r.attachment_count)} DOC${Number(r.attachment_count) === 1 ? '' : 'S'}</span>`);
      return f.join(' ') || '<span class="ui-muted">—</span>';
    } },
];

/* Public hook for other modules: "an item was saved — refresh the client's Item
 * Master tab if it's on screen." inventory.js used to reach in and test for a
 * specific element id, which meant renaming that element silently disabled the
 * refresh (stale rows, no error). Modules ask clients.js; clients.js decides. */
function refreshClientItemsIfOpen(){
  if(!_currentClient) return;
  if(!document.getElementById('cliItemsWrap')) return;   // items tab not rendered
  const search = document.getElementById('cliItemsSearch');
  fetchClientItems(search?.value.trim() || '');
}

async function fetchClientItems(searchTerm){
  const host  = document.getElementById('cliItemsWrap');
  const count = document.getElementById('cliItemsCount');
  if(!host) return;
  uiTableLoading(host, CLI_ITEM_COLS);

  let url = `/clients/${_currentClient.id}/skus?limit=${CLI_ITEM_LIMIT}`;
  if(searchTerm) url += `&search=${encodeURIComponent(searchTerm)}`;
  const rows = await apiGet(url);
  if(!rows) return uiTableError(host, CLI_ITEM_COLS, 'Could not load items',
    () => fetchClientItems(searchTerm));

  // This endpoint returns a flat array with no total. If we got exactly the
  // limit back, there are almost certainly more — say so rather than letting
  // ops believe they're seeing the whole catalog.
  const capped = rows.length >= CLI_ITEM_LIMIT;
  if(count){
    count.innerHTML = rows.length
      ? `${esc(rows.length)} item${rows.length === 1 ? '' : 's'}` +
        (capped ? ' <span class="ui-chip ui-chip-warn">first 500 — search to narrow</span>' : '')
      : '';
  }

  uiTable(host, {
    columns: CLI_ITEM_COLS, rows, rowKey: 'id',
    sortable: true,
    onRowClick: r => openItemFormModal(r.id),
    empty: searchTerm
      ? `No items match “${searchTerm}”.`
      : 'No items yet — use Add item to create one.',
  });
}

async function deleteSlaRule(idx){
  const r = _slaRules[idx];
  if(!r) return;
  // Unsaved draft — nothing to delete server-side.
  if(!r.id){
    _slaRules.splice(idx, 1);
    renderSlaRulePresets();
    renderSlaRulesBody();
    return;
  }
  const ok = await uiConfirm({
    title: `Remove “${r.rule_label}”?`,
    body: 'The rule disappears from the client\'s portal, and its exception charge stops applying to new orders. Charges already billed stay billed.',
    confirmLabel: 'Remove rule', danger: true,
  });
  if(!ok) return;
  try {
    const res = await fetch(`${API}/clients/${_currentClient.id}/sla-rules/${r.id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${T}`},
    });
    if(!res.ok){
      const d = await res.json().catch(() => ({}));
      return uiToast(d.error || 'Delete failed', 'error');
    }
    uiToast('Rule removed');
    await loadClientRulesTab();
  } catch(e){
    uiToast('Network error — the rule was not removed', 'error');
  }
}
