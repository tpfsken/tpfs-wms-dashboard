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
let _reportsCustomer = '';     // selected customer name, '' = all customers

// =============================================================================
// LEVEL 1 — ITEM HISTORY
// =============================================================================

async function loadReports(){
  document.getElementById('itemHistoryView').style.display = 'block';
  document.getElementById('traceView').style.display = 'none';
  document.getElementById('itemHistoryError').textContent = '';

  // Init the client picker (once) — uses the shared clientsCache from clients.js
  await loadCC();
  initCombo('reportsClientWrap',
    [{value:'', label:'All clients'}].concat(
      clientsCache.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`}))
    ),
    {
      placeholder: 'All clients',
      value: _reportsClient || '',
      onChange: (v) => {
        _reportsClient = v || '';
        // Customer list is client-scoped — refresh when client changes
        loadReportsCustomers();
        if(document.getElementById('traceView').style.display !== 'none'){
          backToItemHistory();
        }
        runItemHistory();
      },
    }
  );

  // Customer picker — populated from /reports/customers, scoped to client.
  await loadReportsCustomers();

  // Auto-load recent activity on first open
  if(!_itemHistory) runItemHistory();
  document.getElementById('reportSkuInput').focus?.();
}

async function loadReportsCustomers(){
  let url = '/reports/customers';
  if(_reportsClient) url += `?clientId=${encodeURIComponent(_reportsClient)}`;
  const customers = await apiGet(url);
  const opts = [{value:'', label:'All customers'}];
  (customers || []).forEach(c => {
    if(!c.customer_name) return;
    const loc = [c.ship_to_city, c.ship_to_state].filter(Boolean).join(', ');
    opts.push({
      value: c.customer_name,
      label: c.customer_name,
      sub:   loc || `${c.order_count || 0} orders`,
    });
  });
  initCombo('reportsCustomerWrap', opts, {
    placeholder: 'All customers',
    value: _reportsCustomer || '',
    onChange: (v) => {
      _reportsCustomer = v || '';
      if(document.getElementById('traceView').style.display !== 'none'){
        backToItemHistory();
      }
      runItemHistory();
    },
  });
}

async function runItemHistory(){
  const sku = document.getElementById('reportSkuInput').value.trim();
  const lot = document.getElementById('reportLotInput').value.trim();
  const err = document.getElementById('itemHistoryError');
  err.textContent = '';

  let url = '/reports/item-history?';
  const qs = [];
  if(sku) qs.push(`skuCode=${encodeURIComponent(sku)}`);
  if(lot) qs.push(`lotNumber=${encodeURIComponent(lot)}`);
  if(_reportsClient) qs.push(`clientId=${encodeURIComponent(_reportsClient)}`);
  if(_reportsCustomer) qs.push(`customerName=${encodeURIComponent(_reportsCustomer)}`);
  url += qs.join('&');

  document.getElementById('itemHistoryEmpty').style.display = 'block';
  document.getElementById('itemHistoryEmpty').textContent = 'Loading…';
  document.getElementById('itemHistoryCard').style.display = 'none';

  const data = await apiGet(url);
  if(!data){ err.textContent = 'Search failed (network or auth error)'; return; }
  _itemHistory = data;
  renderItemHistory();
}

function renderItemHistory(){
  const rows = _itemHistory?.rows || [];
  const card  = document.getElementById('itemHistoryCard');
  const empty = document.getElementById('itemHistoryEmpty');
  const tbody = document.getElementById('itemHistoryBody');

  if(!rows.length){
    card.style.display = 'none';
    empty.style.display = 'block';
    empty.textContent = 'No activity matches your search.';
    return;
  }
  card.style.display = 'block';
  empty.style.display = 'none';

  // Top-level totals
  const total = {
    received: 0, picked: 0, shipped: 0, onHand: 0, lps: 0, items: rows.length,
  };
  rows.forEach(r => {
    total.received += Number(r.total_received || 0);
    total.picked   += Number(r.total_picked   || 0);
    total.shipped  += Number(r.total_shipped  || 0);
    total.onHand   += Number(r.on_hand        || 0);
    total.lps      += Number(r.lp_count       || 0);
  });
  document.getElementById('ihSumItems').textContent    = String(total.items);
  document.getElementById('ihSumReceived').textContent = String(total.received);
  document.getElementById('ihSumPicked').textContent   = String(total.picked);
  document.getElementById('ihSumShipped').textContent  = String(total.shipped);
  document.getElementById('ihSumOnHand').textContent   = String(total.onHand);
  document.getElementById('ihSumLps').textContent      = String(total.lps);

  tbody.innerHTML = rows.map(r => {
    const lastAct = r.last_activity_at
      ? new Date(r.last_activity_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})
      : '—';
    const expiringSoon = r.expiry_date && new Date(r.expiry_date) < new Date(Date.now() + 30 * 864e5);
    const lotCell = r.lot_number
      ? `<span style="color:${expiringSoon ? 'var(--red)' : 'var(--blue)'};font-weight:600;">${esc(r.lot_number)}</span>`
      : '<span style="color:var(--muted);">—</span>';
    const expiry = r.expiry_date
      ? new Date(r.expiry_date).toLocaleDateString('en-US', {month:'short', year:'2-digit'})
      : '—';
    const lpBreakdown = `<span title="${esc(r.lp_original_count)} original / ${esc(r.lp_child_count)} child · ${esc(r.lp_active_count)} active / ${esc(r.lp_empty_count)} empty / ${esc(r.lp_shipped_count)} shipped">${esc(r.lp_count)}</span>`;

    return `
      <tr class="js-item-row"
          data-sku-id="${esc(r.sku_id)}"
          data-sku-code="${esc(r.sku_code)}"
          data-sku-name="${esc(r.sku_name || '')}"
          data-lot-id="${esc(r.lot_id || '')}"
          data-lot-number="${esc(r.lot_number || '')}"
          data-client-name="${esc(r.client_name || '')}"
          style="cursor:pointer;">
        <td><div style="font-weight:600;color:var(--blue);">${esc(r.sku_code)}</div><div style="font-size:11px;color:var(--text2);">${esc(r.sku_name || '')}</div></td>
        <td>${esc(r.client_code || '—')}</td>
        <td>${lotCell}</td>
        <td style="font-size:12px;color:var(--text2);">${esc(expiry)}</td>
        <td class="right" style="color:var(--text2);">${esc(r.total_received)}</td>
        <td class="right" style="color:var(--amber);">${esc(r.total_picked)}</td>
        <td class="right" style="color:var(--green);">${esc(r.total_shipped)}</td>
        <td class="right" style="font-weight:600;">${esc(r.on_hand)}</td>
        <td class="right" style="color:var(--text2);">${esc(r.allocated_qty)}</td>
        <td class="right">${lpBreakdown}</td>
        <td style="font-size:12px;color:var(--text2);">${esc(lastAct)}</td>
        <td><span style="color:var(--blue);font-size:11px;font-weight:600;">Trace ▸</span></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.js-item-row').forEach(row => {
    row.addEventListener('click', () => openTraceFromItem({
      skuId: row.dataset.skuId,
      skuCode: row.dataset.skuCode,
      skuName: row.dataset.skuName,
      lotId: row.dataset.lotId || null,
      lotNumber: row.dataset.lotNumber || null,
      clientName: row.dataset.clientName,
    }));
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
  if(_reportsClient)   url += `&clientId=${encodeURIComponent(_reportsClient)}`;
  if(_reportsCustomer) url += `&customerName=${encodeURIComponent(_reportsCustomer)}`;

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
  if(_reportsClient)   url += `&clientId=${encodeURIComponent(_reportsClient)}`;
  if(_reportsCustomer) url += `&customerName=${encodeURIComponent(_reportsCustomer)}`;
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
