// =============================================================================
// REPORTS (Phase 9)
// =============================================================================
// Lives behind the Reports nav item. First report wired up: Lot Recall (9.16).
// More reports will be added as cards / tabs in the same page.
// =============================================================================

let _recallData = null;     // last query result (kept for CSV export later)

function loadReports(){
  // Default landing: empty state with the recall search ready to go.
  document.getElementById('recallResultsCard').style.display = 'none';
  document.getElementById('recallEmptyState').style.display = 'block';
  document.getElementById('recallError').textContent = '';
  document.getElementById('recallSearch').focus?.();
}

async function runRecallReport(){
  const lotNumber = document.getElementById('recallSearch').value.trim();
  const err = document.getElementById('recallError');
  err.textContent = '';

  if(!lotNumber){
    err.textContent = 'Enter a lot number (or partial — wildcard search)';
    return;
  }

  document.getElementById('recallResultsCard').style.display = 'none';
  document.getElementById('recallEmptyState').style.display = 'block';
  document.getElementById('recallEmptyState').textContent = 'Searching…';

  const data = await apiGet(`/reports/recall?lotNumber=${encodeURIComponent(lotNumber)}`);
  if(!data){
    err.textContent = 'Search failed (network or auth error)';
    document.getElementById('recallEmptyState').textContent = 'No results';
    return;
  }

  _recallData = data;
  renderRecallResults();
}

function renderRecallResults(){
  const data = _recallData || { summary: {}, rows: [] };
  const card  = document.getElementById('recallResultsCard');
  const empty = document.getElementById('recallEmptyState');

  if(!data.rows.length){
    card.style.display = 'none';
    empty.style.display = 'block';
    empty.textContent = 'No allocations found for that lot.';
    return;
  }

  card.style.display = 'block';
  empty.style.display = 'none';

  const s = data.summary || {};
  document.getElementById('recallSumOrders').textContent     = String(s.distinctOrders || 0);
  document.getElementById('recallSumClients').textContent    = String(s.distinctClients || 0);
  document.getElementById('recallSumLots').textContent       = String(s.distinctLots || 0);
  document.getElementById('recallSumCustomers').textContent  = String(s.distinctCustomers || 0);
  document.getElementById('recallSumQty').textContent        = String(Number(s.totalQuantity || 0));
  document.getElementById('recallSumAllocations').textContent = String(s.totalAllocations || 0);

  const tbody = document.getElementById('recallBody');
  tbody.innerHTML = data.rows.map(r => {
    const shipped = r.shipment_shipped_at
      ? new Date(r.shipment_shipped_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})
      : '—';
    const orderStatusChip = SM[r.order_status]
      ? `<span class="chip ${SM[r.order_status].c}">${esc(SM[r.order_status].l)}</span>`
      : `<span class="chip chip-new">${esc(r.order_status)}</span>`;
    const cityState = [r.ship_to_city, r.ship_to_state].filter(Boolean).join(', ');
    const ship = r.shipment_number
      ? `<div style="font-size:12px;"><span style="color:var(--blue);">${esc(r.shipment_number)}</span>${r.tracking_number ? `<br><span style="color:var(--muted);font-size:11px;">${esc(r.tracking_number)}</span>` : ''}</div>`
      : '<span style="color:var(--muted);">—</span>';

    return `
      <tr class="js-recall-row" data-order-id="${esc(r.order_id)}" style="cursor:pointer;">
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
        <td>${orderStatusChip}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.js-recall-row').forEach(row => {
    row.addEventListener('click', () => {
      navigateTo('orders');
      setTimeout(() => openOrderDetail(row.dataset.orderId), 100);
    });
  });
}

// CSV export — dump current results to a file the user can hand to a regulator.
function exportRecallCsv(){
  if(!_recallData || !_recallData.rows.length) return;
  const cols = [
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
  const lines = _recallData.rows.map(r => cols.map(c => escCsv(r[c[0]])).join(','));
  const csv = [header, ...lines].join('\n');

  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const lotInput = document.getElementById('recallSearch').value.trim().replace(/[^A-Za-z0-9_-]/g, '_');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `recall_${lotInput || 'lot'}_${stamp}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
