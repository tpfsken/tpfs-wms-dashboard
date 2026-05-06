// =============================================================================
// REPORTS (Phase 9)
// =============================================================================
// First report: Trace — follow an LP from start to finish.
// Search supports either an LP # or a lot # (auto-detected by the API
// based on which field you fill).
// =============================================================================

let _traceData = null;     // last trace query result

function loadReports(){
  document.getElementById('traceResults').style.display = 'none';
  document.getElementById('traceEmptyState').style.display = 'block';
  document.getElementById('traceError').textContent = '';
  document.getElementById('traceSearch').focus?.();
}

async function runTrace(modeOverride){
  const raw = document.getElementById('traceSearch').value.trim();
  const mode = modeOverride || (document.querySelector('input[name="traceMode"]:checked')?.value) || 'auto';
  const err = document.getElementById('traceError');
  err.textContent = '';

  if(!raw){
    err.textContent = 'Enter a lot number or LP number';
    return;
  }

  document.getElementById('traceResults').style.display = 'none';
  document.getElementById('traceEmptyState').style.display = 'block';
  document.getElementById('traceEmptyState').textContent = 'Searching…';

  // Build query — auto mode tries LP first, falls through to lot if no match.
  let url;
  if(mode === 'lp'){
    url = `/reports/trace?lpNumber=${encodeURIComponent(raw)}`;
  } else if(mode === 'lot'){
    url = `/reports/trace?lotNumber=${encodeURIComponent(raw)}`;
  } else {
    // auto — heuristic: starts with LP or contains LP-, treat as LP
    const looksLikeLp = /^(LP|LPN|PALLET)/i.test(raw) || /^[A-Z0-9]+-\d{4}-/i.test(raw);
    url = looksLikeLp
      ? `/reports/trace?lpNumber=${encodeURIComponent(raw)}`
      : `/reports/trace?lotNumber=${encodeURIComponent(raw)}`;
  }

  let data = await apiGet(url);

  // If auto and the heuristic guessed wrong (no results), try the other mode.
  if(mode === 'auto' && data && (!data.lpFamily?.length && !data.allocations?.length)){
    const other = url.includes('lpNumber')
      ? `/reports/trace?lotNumber=${encodeURIComponent(raw)}`
      : `/reports/trace?lpNumber=${encodeURIComponent(raw)}`;
    const fallback = await apiGet(other);
    if(fallback && (fallback.lpFamily?.length || fallback.allocations?.length)){
      data = fallback;
    }
  }

  if(!data){
    err.textContent = 'Search failed (network or auth error)';
    document.getElementById('traceEmptyState').textContent = 'No results';
    return;
  }

  _traceData = data;
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
    empty.textContent = 'No matching license plates or allocations found.';
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

// -------- LP family list (parent → children, indented)
function renderLpFamily(family){
  const card = document.getElementById('lpFamilyCard');
  const tbody = document.getElementById('lpFamilyBody');
  if(!family.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  // Build a parent → children map for indentation
  const byParent = {};
  family.forEach(lp => {
    const k = lp.parent_lp_id || 'ROOT';
    if(!byParent[k]) byParent[k] = [];
    byParent[k].push(lp);
  });

  // Render in tree order: roots first, then their children, recursively
  const rendered = [];
  function emit(lp, depth){
    rendered.push({lp, depth});
    (byParent[lp.id] || []).forEach(child => emit(child, depth + 1));
  }
  (byParent['ROOT'] || []).forEach(root => emit(root, 0));
  // Catch any orphans (parent in family but somehow not picked up)
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

// -------- Receiving info — where it came from
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

// -------- Allocations — where pieces went (orders + customers + shipments)
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

// -------- Timeline — every inventory_transactions event for the family
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

// -------- CSV export of allocations slice
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
  const search = document.getElementById('traceSearch').value.trim().replace(/[^A-Za-z0-9_-]/g, '_');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `trace_${search || 'lp_or_lot'}_${stamp}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
