// =============================================================================
// REPORTS (Phase 9) — drill-down: Item History → LP Trace
// =============================================================================
// Level 1: search by SKU or Lot → item-level summary table
// Level 2: click a row → full LP trace for that (SKU, lot) — family,
//          receiving, allocations, timeline.
// =============================================================================

let _itemHistory = null;       // last item-history query result
let _traceData   = null;       // last trace query result
let _traceContext = null;      // {sku, lot} we drilled into
let _reportsClient = '';       // selected client id, '' = all clients

// Catalog of available reports — add a new entry per report as it's built.
// status:'live' renders a clickable card; 'soon' renders a disabled placeholder.
const REPORTS_CATALOG = [
  {
    id:    'item-history',
    title: 'Item History → LP Trace',
    desc:  'Search by SKU or lot. Drill into any row to follow the LP family — receiving, picks, shipments, full timeline.',
    phase: '9.16 / 9.17',
    icon:  '🔎',
    open:  () => openItemHistoryReport(),
    status:'live',
  },
  // Future stubs — uncomment / wire up as we build them
  // {id:'inventory-as-of', title:'Inventory On-Hand by Date', phase:'9.7',  icon:'📅', status:'soon'},
  // {id:'item-activity',   title:'Item Activity Detail',     phase:'9.15', icon:'📊', status:'soon'},
  // {id:'b2b-shipment',    title:'B2B Shipment Detail',      phase:'9.18', icon:'📦', status:'soon'},
  // {id:'case-breaks',     title:'Case Break Activity',      phase:'9.19', icon:'⊞',  status:'soon'},
  // {id:'daily-snapshot',  title:'Daily Snapshot',           phase:'9.20', icon:'🌙', status:'soon'},
  // {id:'txn-export',      title:'Transaction Log Export',   phase:'9.21', icon:'⬇',  status:'soon'},
];

// =============================================================================
// LEVEL 1 — ITEM HISTORY
// =============================================================================

/* =============================================================================
 * GENERIC REPORT RUNNER
 *
 * The dashboard knows nothing about any individual report. It asks the API what
 * reports exist, renders their parameters, runs them, and exports them. A new
 * report is a definition in the API's reportRegistry — it appears here with no
 * dashboard change at all.
 *
 * Client scoping is NOT done here. The server forces a portal user's client_id.
 * Doing it in the UI would mean trusting the browser with the one rule that
 * must not be got wrong.
 * ========================================================================== */
let _reportCatalog = [];
let _reportDef     = null;   // definition currently open
let _reportParams  = {};     // its parameter values
let _reportLimit   = 200;
let _reportOffset  = 0;

// Default landing — a card grid of every available report.
async function loadReports(){
  document.getElementById('reportsIndexView').style.display = 'block';
  document.getElementById('reportsContent').style.display = 'none';

  const d = await apiGet('/reports/catalog');
  _reportCatalog = d?.rows || [];
  renderReportsIndex();
}

const REPORT_ICONS = {
  'client-activity': '📒', 'exceptions': '⚠', 'receiving': '📥',
  'shipments': '📤', 'inventory-as-of': '📅', 'item-history': '🔎',
};

function renderReportsIndex(){
  const grid = document.getElementById('reportsIndexGrid');
  grid.className = 'portal-grid';   // same card-hub as the portal home

  // Server-defined reports + the hand-built ones that predate the registry.
  const cards = _reportCatalog.map(r => ({
    id: r.id, title: r.title, desc: r.description,
    open: () => openReport(r.id),
  })).concat(REPORTS_CATALOG.filter(r => r.status === 'live').map(r => ({
    id: r.id, title: r.title, desc: r.desc, open: r.open,
  })));

  if(!cards.length){ grid.innerHTML = uiEmpty('No reports available.'); return; }

  grid.innerHTML = cards.map(r => `
    <button class="portal-card js-report-card" data-id="${esc(r.id)}">
      <span class="portal-card-icon">${esc(REPORT_ICONS[r.id] || '📄')}</span>
      <span class="portal-card-title">${esc(r.title)}</span>
      <span class="portal-card-desc">${esc(r.desc || '')}</span>
    </button>`).join('');

  grid.querySelectorAll('.js-report-card').forEach(card => {
    const r = cards.find(x => x.id === card.dataset.id);
    if(r) card.addEventListener('click', () => r.open());
  });
}

/* ---- Generic runner: parameters -> results -> export --------------------- */

async function openReport(id){
  _reportDef = _reportCatalog.find(r => r.id === id);
  if(!_reportDef) return uiToast('Unknown report', 'error');
  _reportParams = {};
  _reportOffset = 0;

  document.getElementById('reportsIndexView').style.display = 'none';
  document.getElementById('reportsContent').style.display = 'block';
  document.getElementById('itemHistoryView').style.display = 'none';
  document.getElementById('traceView').style.display = 'none';
  document.getElementById('genericReportView').style.display = 'block';

  document.getElementById('reportsCurrentTitle').textContent = _reportDef.title;
  document.getElementById('reportsCurrentSub').textContent   = _reportDef.description || '';

  // Sensible default window: this month to date. Most report questions are
  // "what happened recently", and an empty date box helps nobody.
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const iso = (d) => d.toISOString().slice(0, 10);

  const clients = (typeof isPortalMode === 'function' && isPortalMode())
    ? [] : (await apiGet('/clients')) || [];

  document.getElementById('genericReportParams').innerHTML =
    _reportDef.params.map(p => {
      if(p.type === 'client'){
        // Portal users don't get a client picker — the server forces their scope.
        if(!clients.length) return '';
        return `<div class="ui-field" style="min-width:220px;margin-bottom:0;">
          <label class="ui-label">${esc(p.label)}</label>
          <select class="ui-input js-rp" data-key="${esc(p.key)}">
            <option value="">All clients</option>
            ${clients.map(c => `<option value="${esc(c.id)}">${esc(c.code)} — ${esc(c.name)}</option>`).join('')}
          </select>
        </div>`;
      }
      if(p.type === 'select'){
        return `<div class="ui-field" style="min-width:180px;margin-bottom:0;">
          <label class="ui-label">${esc(p.label)}</label>
          <select class="ui-input js-rp" data-key="${esc(p.key)}">
            ${(p.options || []).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
          </select>
        </div>`;
      }
      const val = p.type === 'date'
        ? (p.key === 'dateTo' || p.key === 'asOf' ? iso(today) : iso(first))
        : '';
      return `<div class="ui-field" style="min-width:170px;margin-bottom:0;">
        <label class="ui-label">${esc(p.label)}${p.required ? ' *' : ''}</label>
        <input class="ui-input js-rp" data-key="${esc(p.key)}" type="${p.type === 'date' ? 'date' : 'text'}"
               value="${esc(val)}">
      </div>`;
    }).join('') +
    `<button class="ui-btn ui-btn-primary" onclick="runGenericReport()">Run</button>
     <div style="flex:1"></div>
     <button class="ui-btn" onclick="exportGenericReport()">Export CSV</button>`;

  runGenericReport();
}

function collectReportParams(){
  const p = {};
  document.querySelectorAll('#genericReportParams .js-rp').forEach(el => {
    if(el.value) p[el.dataset.key] = el.value;
  });
  return p;
}

function reportQuery(extra = {}){
  const qs = new URLSearchParams({ ..._reportParams, ...extra });
  return qs.toString();
}

async function runGenericReport(){
  if(!_reportDef) return;
  _reportParams = collectReportParams();

  const missing = _reportDef.params.filter(p => p.required && !_reportParams[p.key]);
  if(missing.length) return uiToast(`${missing.map(m => m.label).join(' and ')} required`, 'error');

  const cols = _reportDef.columns.map(c => ({
    key: c.key,
    label: c.label,
    num:   c.type === 'num',
    money: c.type === 'money',
    mono:  c.type === 'mono',
    render: c.type === 'datetime'
      ? (r) => r[c.key] ? uiId(fmtTimeShort(r[c.key])) : '<span class="ui-muted">—</span>'
      : c.type === 'date'
        ? (r) => r[c.key] ? uiId(new Date(r[c.key]).toLocaleDateString()) : '<span class="ui-muted">—</span>'
        : undefined,
  }));

  uiTableLoading('genericReportWrap', cols);
  const d = await apiGet(`/reports/run/${_reportDef.id}?${reportQuery({
    limit: _reportLimit, offset: _reportOffset,
  })}`);
  if(d === null) return uiTableError('genericReportWrap', cols, 'Report failed', runGenericReport);

  uiTable('genericReportWrap', {
    columns: cols, rows: d.rows || [], rowKey: 'id',
    empty: 'Nothing happened in that window — no rows match.',
  });

  uiPager('genericReportPager', {
    total: Number(d.total || 0), limit: _reportLimit, offset: _reportOffset,
    noun: 'rows',
    onChange: (limit, offset) => { _reportLimit = limit; _reportOffset = offset; runGenericReport(); },
  });
}

// The CSV comes from the SAME definition as the screen — it cannot disagree
// with what the user was just looking at.
async function exportGenericReport(){
  if(!_reportDef) return;
  _reportParams = collectReportParams();
  uiToast('Building the export…');
  const r = await fetch(`${API}/reports/export/${_reportDef.id}.csv?${reportQuery()}`, {
    headers: { Authorization: `Bearer ${T}` },
  });
  if(!r.ok) return uiToast('Export failed', 'error');
  const blob = await r.blob();
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${_reportDef.id}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  uiToast('CSV downloaded');
}

function backToReportsIndex(){
  document.getElementById('reportsContent').style.display = 'none';
  document.getElementById('genericReportView').style.display = 'none';
  document.getElementById('reportsIndexView').style.display = 'block';
  _reportDef = null;
}

// =============================================================================
// REPORT — Item History → LP Trace
// =============================================================================

async function openItemHistoryReport(){
  document.getElementById('reportsIndexView').style.display = 'none';
  document.getElementById('reportsContent').style.display = 'block';
  document.getElementById('genericReportView').style.display = 'none';
  document.getElementById('reportsCurrentTitle').textContent = 'Item History';
  document.getElementById('reportsCurrentSub').textContent   = 'Item history → LP traceability';

  document.getElementById('itemHistoryView').style.display = 'block';
  document.getElementById('traceView').style.display = 'none';

  // Phase 3: in portal mode the client picker is hidden (.ops-only on the
  // form-group in index.html) and /clients is requireOps anyway, so skip
  // both the fetch and the combo init. Reports are auto-scoped server-side
  // by scopeClient.
  if(typeof isPortalMode === 'function' && isPortalMode()){
    _reportsClient = '';
  } else {
    // Always fetch fresh — bypass any cache state that might be empty.
    const clientsList = await apiGet('/clients');
    const clients = Array.isArray(clientsList) ? clientsList : [];

    initCombo('reportsClientWrap',
      [{value:'', label:'All clients'}].concat(
        clients.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`}))
      ),
      {
        placeholder: 'All clients',
        value: _reportsClient || '',
        onChange: (v) => {
          _reportsClient = v || '';
          if(document.getElementById('traceView').style.display !== 'none'){
            backToItemHistory();
          }
          runItemHistory();
        },
      }
    );
  }

  if(!_itemHistory) runItemHistory();
  document.getElementById('reportSkuInput').focus?.();
}

const IH_COLS = [
  { key: '_sku', label: 'SKU', sortValue: r => r.sku_code, render: r =>
      `<div>${uiId(r.sku_code)}</div><div class="ui-hint">${esc(r.sku_name || '')}</div>` },
  { key: 'client_code', label: 'Client', mono: true },
  { key: '_lot', label: 'Lot', sortValue: r => r.lot_number, render: r => {
      if(!r.lot_number) return '<span class="ui-muted">—</span>';
      const soon = r.expiry_date && new Date(r.expiry_date) < new Date(Date.now() + 30 * 864e5);
      return soon
        ? `<span class="ui-chip ui-chip-warn">${esc(r.lot_number)}</span>`
        : uiId(r.lot_number);
    } },
  { key: '_exp', label: 'Expiry', sortValue: r => r.expiry_date, render: r => r.expiry_date
      ? uiId(new Date(r.expiry_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }))
      : '<span class="ui-muted">—</span>' },
  { key: 'total_received', label: 'Received', num: true },
  { key: 'total_picked', label: 'Picked', num: true },
  { key: 'total_shipped', label: 'Shipped', num: true },
  { key: 'on_hand', label: 'On hand', num: true },
  { key: 'allocated_qty', label: 'Allocated', num: true },
  { key: '_lps', label: 'LPs', num: true, sortValue: r => Number(r.lp_count || 0), render: r =>
      `<span title="${esc(r.lp_original_count)} original / ${esc(r.lp_child_count)} child · ${esc(r.lp_active_count)} active / ${esc(r.lp_empty_count)} empty / ${esc(r.lp_shipped_count)} shipped">${uiNum(r.lp_count)}</span>` },
  { key: '_last', label: 'Last activity', sortValue: r => r.last_activity_at, render: r => r.last_activity_at
      ? uiId(new Date(r.last_activity_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
      : '<span class="ui-muted">—</span>' },
];

async function runItemHistory(){
  const sku = document.getElementById('reportSkuInput').value.trim();
  const lot = document.getElementById('reportLotInput').value.trim();

  const qs = [];
  if(sku) qs.push(`skuCode=${encodeURIComponent(sku)}`);
  if(lot) qs.push(`lotNumber=${encodeURIComponent(lot)}`);
  if(_reportsClient) qs.push(`clientId=${encodeURIComponent(_reportsClient)}`);

  uiTableLoading('itemHistoryWrap', IH_COLS);
  const data = await apiGet(`/reports/item-history?${qs.join('&')}`);
  if(data === null) return uiTableError('itemHistoryWrap', IH_COLS, 'Search failed', runItemHistory);
  _itemHistory = data;
  renderItemHistory();
}

function renderItemHistory(){
  const rows = _itemHistory?.rows || [];

  // Recall totals. On a recall these are the numbers someone reads down the
  // phone — "how much went out" is the one that matters, so it leads.
  const t = rows.reduce((a, r) => ({
    received: a.received + Number(r.total_received || 0),
    picked:   a.picked   + Number(r.total_picked   || 0),
    shipped:  a.shipped  + Number(r.total_shipped  || 0),
    onHand:   a.onHand   + Number(r.on_hand        || 0),
    lps:      a.lps      + Number(r.lp_count       || 0),
  }), { received: 0, picked: 0, shipped: 0, onHand: 0, lps: 0 });

  const strip = document.getElementById('ihSummary');
  strip.className = 'ui-tiles';
  strip.innerHTML = rows.length
    ? uiTile({ label: 'Shipped out', value: t.shipped.toLocaleString(),
               tone: t.shipped > 0 ? 'warn' : null,
               sub: t.shipped > 0 ? 'already left the building' : 'nothing shipped' }) +
      uiTile({ label: 'Still on hand', value: t.onHand.toLocaleString(),
               sub: 'can still be quarantined' }) +
      uiTile({ label: 'Received', value: t.received.toLocaleString() }) +
      uiTile({ label: 'Picked', value: t.picked.toLocaleString() }) +
      uiTile({ label: 'Items', value: rows.length }) +
      uiTile({ label: 'License plates', value: t.lps.toLocaleString() })
    : '';

  uiTable('itemHistoryWrap', {
    columns: IH_COLS, rows, rowKey: '_k',
    sortable: true,
    onRowClick: r => openTraceFromItem({
      skuId: r.sku_id, skuCode: r.sku_code, skuName: r.sku_name,
      lotId: r.lot_id || null, lotNumber: r.lot_number || null,
      clientName: r.client_name,
    }),
    empty: 'No activity matches that search.',
  });
}

// =============================================================================
// LEVEL 2 — LP TRACE for a chosen item
// =============================================================================

async function openTraceFromItem(ctx){
  _traceContext = ctx;

  document.getElementById('itemHistoryView').style.display = 'none';
  document.getElementById('traceView').style.display = 'block';
  document.getElementById('traceContextLabel').innerHTML =
    `<span style="color:var(--blue);font-weight:600;">${esc(ctx.skuCode)}</span>` +
    `<span style="color:var(--text2);"> · ${esc(ctx.skuName || '')}</span>` +
    (ctx.lotNumber ? ` <span style="color:var(--text2);"> · Lot </span><span style="color:var(--blue);">${esc(ctx.lotNumber)}</span>` : '');

  document.getElementById('traceResults').style.display = 'none';
  document.getElementById('traceEmptyState').style.display = 'block';
  document.getElementById('traceEmptyState').textContent = 'Loading LP trace…';
  document.getElementById('traceError').textContent = '';

  // If we have a specific lot, use it. Otherwise fall back to LP search by SKU
  // (less precise, but at least returns LPs for that SKU).
  let url;
  if(ctx.lotNumber){
    url = `/reports/trace?lotNumber=${encodeURIComponent(ctx.lotNumber)}`;
  } else {
    // No lot — show all LPs whose number contains the SKU code (heuristic)
    url = `/reports/trace?lpNumber=${encodeURIComponent(ctx.skuCode)}`;
  }
  if(_reportsClient) url += `&clientId=${encodeURIComponent(_reportsClient)}`;

  const data = await apiGet(url);
  if(!data){
    document.getElementById('traceError').textContent = 'Trace failed (network or auth error)';
    document.getElementById('traceEmptyState').textContent = 'No results';
    return;
  }
  _traceData = data;
  renderTrace();
}

function backToItemHistory(){
  document.getElementById('traceView').style.display = 'none';
  document.getElementById('itemHistoryView').style.display = 'block';
}

// Manual LP search inside the trace view (when user wants to look up a specific LP).
async function runManualTrace(){
  const lp = document.getElementById('manualLpInput').value.trim();
  const err = document.getElementById('traceError');
  err.textContent = '';
  if(!lp){ err.textContent = 'Enter an LP number'; return; }

  document.getElementById('traceResults').style.display = 'none';
  document.getElementById('traceEmptyState').style.display = 'block';
  document.getElementById('traceEmptyState').textContent = 'Loading…';

  let url = `/reports/trace?lpNumber=${encodeURIComponent(lp)}`;
  if(_reportsClient) url += `&clientId=${encodeURIComponent(_reportsClient)}`;
  const data = await apiGet(url);
  if(!data){ err.textContent = 'Trace failed'; return; }
  _traceData = data;
  _traceContext = { skuCode: 'Manual LP search', skuName: '', lotNumber: '' };
  document.getElementById('traceContextLabel').textContent = `Manual LP search: ${lp}`;
  renderTrace();
}

function renderTrace(){
  const data = _traceData || {};
  const results = document.getElementById('traceResults');
  const empty   = document.getElementById('traceEmptyState');

  const hasFamily = data.lpFamily?.length > 0;
  const hasAllocs = data.allocations?.length > 0;
  if(!hasFamily && !hasAllocs){
    results.style.display = 'none';
    empty.style.display = 'block';
    empty.textContent = 'No LPs or allocations found.';
    return;
  }

  results.style.display = 'block';
  empty.style.display = 'none';

  // -------- summary tiles
  const s = data.summary || {};
  document.getElementById('traceSumFamily').textContent     = String(s.familySize || 0);
  document.getElementById('traceSumOrigCh').textContent     = `${s.originalLps || 0} orig · ${s.childLps || 0} child`;
  document.getElementById('traceSumOrders').textContent     = String(s.distinctOrders || 0);
  document.getElementById('traceSumCustomers').textContent  = String(s.distinctCustomers || 0);
  document.getElementById('traceSumQty').textContent        = String(Number(s.totalQuantity || 0));
  document.getElementById('traceSumEvents').textContent     = String(s.timelineEvents || 0);
  document.getElementById('traceSumReceiving').textContent  = String(s.receivingEvents || 0);

  renderLpFamily(data.lpFamily || []);
  renderReceiving(data.receiving || []);
  renderTraceAllocations(data.allocations || []);
  renderTimeline(data.timeline || []);
}

// -------- LP family tree (parent → children, indented)
function renderLpFamily(family){
  const card = document.getElementById('lpFamilyCard');
  const tbody = document.getElementById('lpFamilyBody');
  if(!family.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  const byParent = {};
  family.forEach(lp => {
    const k = lp.parent_lp_id || 'ROOT';
    if(!byParent[k]) byParent[k] = [];
    byParent[k].push(lp);
  });

  const rendered = [];
  function emit(lp, depth){
    rendered.push({lp, depth});
    (byParent[lp.id] || []).forEach(child => emit(child, depth + 1));
  }
  (byParent['ROOT'] || []).forEach(root => emit(root, 0));
  family.forEach(lp => {
    if(!rendered.find(r => r.lp.id === lp.id)){
      rendered.push({lp, depth: 0});
    }
  });

  tbody.innerHTML = rendered.map(({lp, depth}) => {
    const indent = '&nbsp;'.repeat(depth * 4) + (depth > 0 ? '↳ ' : '');
    const lpBadge = `<span class="lp-badge ${lp.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(lp.lp_number)}</span>`;
    const stChip = lp.status === 'ACTIVE'   ? 'chip-success'
                 : lp.status === 'EMPTY'    ? 'chip-warning'
                 : lp.status === 'SHIPPED'  ? 'chip-active'
                 : 'chip-new';
    const recv = lp.received_at
      ? new Date(lp.received_at).toLocaleString('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'})
      : '—';
    return `
      <tr>
        <td>${indent}${lpBadge}</td>
        <td>${esc(lp.sku_code || '—')}</td>
        <td style="color:var(--blue);">${esc(lp.lot_number || '—')}</td>
        <td>${esc(lp.location_code || '—')}</td>
        <td class="right">${esc(lp.current_qty ?? 0)}</td>
        <td><span class="chip ${stChip}">${esc(lp.status || '')}</span></td>
        <td style="color:var(--text2);font-size:12px;">${esc(recv)}</td>
      </tr>`;
  }).join('');
}

function renderReceiving(rows){
  const card = document.getElementById('traceReceivingCard');
  const tbody = document.getElementById('traceReceivingBody');
  if(!rows.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  tbody.innerHTML = rows.map(r => {
    const recv = r.received_line_at
      ? new Date(r.received_line_at).toLocaleString('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'})
      : '—';
    return `
      <tr>
        <td style="font-weight:600;color:var(--blue);">${esc(r.po_number || '—')}</td>
        <td>${esc(r.supplier_name || '—')}</td>
        <td class="right">${esc(r.received_qty || 0)}</td>
        <td>${esc(r.condition || '—')}</td>
        <td>${esc(r.received_by_name || '—')}</td>
        <td style="color:var(--text2);font-size:12px;">${esc(recv)}</td>
      </tr>`;
  }).join('');
}

function renderTraceAllocations(rows){
  const card = document.getElementById('traceAllocCard');
  const tbody = document.getElementById('traceAllocBody');
  if(!rows.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  tbody.innerHTML = rows.map(r => {
    const shipped = r.shipment_shipped_at
      ? new Date(r.shipment_shipped_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})
      : (r.allocated_at ? new Date(r.allocated_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '—');
    const orderChip = SM[r.order_status]
      ? `<span class="chip ${SM[r.order_status].c}">${esc(SM[r.order_status].l)}</span>`
      : `<span class="chip chip-new">${esc(r.order_status)}</span>`;
    const cityState = [r.ship_to_city, r.ship_to_state].filter(Boolean).join(', ');
    const lpBadge = r.lp_number
      ? `<span class="lp-badge ${r.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(r.lp_number)}</span>`
      : '—';
    const ship = r.shipment_number
      ? `<div style="font-size:12px;"><span style="color:var(--blue);">${esc(r.shipment_number)}</span>${r.tracking_number ? `<br><span style="color:var(--muted);font-size:11px;">${esc(r.tracking_number)}</span>` : ''}</div>`
      : '<span style="color:var(--muted);">—</span>';

    return `
      <tr class="js-trace-row" data-order-id="${esc(r.order_id)}" style="cursor:pointer;">
        <td>${lpBadge}</td>
        <td style="font-weight:600;color:var(--blue);">${esc(r.order_number || '')}</td>
        <td><div>${esc(r.client_name || '')}</div><div style="font-size:11px;color:var(--muted);">${esc(r.client_code || '')}</div></td>
        <td>
          <div style="font-weight:600;">${esc(r.customer_name || r.ship_to_name || '—')}</div>
          <div style="font-size:11px;color:var(--text2);">${esc(r.customer_email || '')}</div>
        </td>
        <td>
          <div>${esc(r.ship_to_line1 || '')}${r.ship_to_line2 ? ', ' + esc(r.ship_to_line2) : ''}</div>
          <div style="font-size:11px;color:var(--text2);">${esc(cityState)} ${esc(r.ship_to_postal || '')}</div>
        </td>
        <td><span style="font-weight:600;color:var(--blue);">${esc(r.sku_code || '')}</span></td>
        <td style="color:var(--blue);">${esc(r.lot_number || '—')}</td>
        <td class="right" style="font-weight:600;">${esc(Number(r.picked_qty || r.allocated_qty || 0))}</td>
        <td>${esc(shipped)}</td>
        <td>${ship}</td>
        <td>${orderChip}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.js-trace-row').forEach(row => {
    row.addEventListener('click', () => {
      navigateTo('orders');
      setTimeout(() => openOrderDetail(row.dataset.orderId), 100);
    });
  });
}

function renderTimeline(rows){
  const card = document.getElementById('traceTimelineCard');
  const list = document.getElementById('traceTimelineList');
  if(!rows.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  list.innerHTML = rows.map(e => {
    const ts = e.created_at
      ? new Date(e.created_at).toLocaleString('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'})
      : '—';
    const colors = {
      'receipt':    {icon:'📦', bg:'var(--blue-bg)',  fg:'var(--blue)'},
      'case_break': {icon:'⊞',  bg:'var(--purple-bg)',fg:'var(--purple)'},
      'pick':       {icon:'✓',  bg:'var(--amber-bg)', fg:'var(--amber)'},
      'ship':       {icon:'🚚', bg:'var(--green-bg)', fg:'var(--green)'},
      'adjustment': {icon:'±',  bg:'var(--red-bg)',   fg:'var(--red)'},
    };
    const c = colors[e.transaction_type] || {icon:'•', bg:'rgba(255,255,255,.06)', fg:'var(--text2)'};
    const lpBadge = e.lp_number
      ? `<span class="lp-badge ${e.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(e.lp_number)}</span>`
      : '';
    const flow = (e.from_location_code || e.to_location_code)
      ? `<span style="color:var(--muted);font-size:11px;">${esc(e.from_location_code || '?')} → ${esc(e.to_location_code || '?')}</span>`
      : '';
    return `
      <div style="display:flex;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);align-items:flex-start;">
        <div style="width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;background:${c.bg};color:${c.fg};flex-shrink:0;">${c.icon}</div>
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:10px;font-size:13px;flex-wrap:wrap;">
            <span style="font-weight:600;color:${c.fg};">${esc(e.transaction_type)}</span>
            ${lpBadge}
            <span>${esc(e.sku_code || '')}</span>
            ${e.lot_number ? `<span style="color:var(--blue);">Lot ${esc(e.lot_number)}</span>` : ''}
            <span style="font-weight:600;">${esc(Number(e.quantity || 0))}</span>
            ${flow}
            <span style="margin-left:auto;color:var(--text2);font-size:12px;">${esc(ts)}</span>
          </div>
          ${e.notes ? `<div style="font-size:12px;color:var(--text2);margin-top:4px;">${esc(e.notes)}</div>` : ''}
          ${e.user_name ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">by ${esc(e.user_name)}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// CSV export of allocations slice (the "where it went" rows)
function exportRecallCsv(){
  if(!_traceData || !_traceData.allocations?.length) return;
  const cols = [
    ['lp_number',      'LP'],
    ['order_number',   'Order #'],
    ['client_code',    'Client Code'],
    ['client_name',    'Client'],
    ['customer_name',  'Customer'],
    ['customer_email', 'Email'],
    ['ship_to_line1',  'Address 1'],
    ['ship_to_line2',  'Address 2'],
    ['ship_to_city',   'City'],
    ['ship_to_state',  'State'],
    ['ship_to_postal', 'Postal'],
    ['ship_to_country','Country'],
    ['sku_code',       'SKU'],
    ['lot_number',     'Lot'],
    ['picked_qty',     'Qty'],
    ['shipment_shipped_at','Shipped At'],
    ['shipment_number','Shipment #'],
    ['tracking_number','Tracking #'],
    ['order_status',   'Order Status'],
  ];
  const escCsv = v => {
    if(v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.map(c => escCsv(c[1])).join(',');
  const lines = _traceData.allocations.map(r => cols.map(c => escCsv(r[c[0]])).join(','));
  const csv = [header, ...lines].join('\n');

  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  const tag = (_traceContext?.lotNumber || _traceContext?.skuCode || 'trace').replace(/[^A-Za-z0-9_-]/g, '_');
  a.href = url;
  a.download = `trace_${tag}_${stamp}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
