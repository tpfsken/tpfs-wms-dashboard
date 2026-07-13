// =============================================================================
// DASHBOARD
// =============================================================================

async function loadDashboard(){
  const d = await apiGet('/dashboard/summary');
  if(!d) return;
  if(d.kpis)         renderKPIs(d.kpis);
  if(d.sla)          renderSLA(d.sla);
  if(d.liveOrders)   renderQ(d.liveOrders);
  if(d.alerts)       renderAlerts(d.alerts);
  if(d.waves)        renderWaves(d.waves);
  if(d.dockSchedule) renderDock(d.dockSchedule);
  if(d.inventorySnap)renderDI(d.inventorySnap);
  if(d.carriers)     renderCarriers(d.carriers);
  if(d.throughput)   renderTP(d.throughput);
  if(d.labor){
    document.getElementById('laborUnitsHr').textContent = d.labor.summary?.avg_units_per_hour || '—';
    document.getElementById('laborWorkers').textContent = d.labor.summary?.active_workers || '0';
  }
  // Per-client SLA rollup — separate request so the main dashboard
  // doesn't slow down if this is heavy.
  loadClientsPerformance();
}

// Render the "Performance by Client" panel — one row per active
// client showing their on-time % vs their saved target, past-due, and
// a status chip. Click a row to drill to that client's detail page.
// A client is judged against THEIR contracted target, not a house default —
// falling back to 95/85 only when no SLA is configured.
const CLI_PERF_COLS = [
  { key: '_client', label: 'Client', sortValue: r => r.client_code, render: r =>
      `<div>${uiId(r.client_code || '')}</div><div class="ui-hint">${esc(r.client_name || '')}</div>` },
  { key: 'on_time_pct', label: 'On time', num: true, render: r => {
      if(r.on_time_pct == null) return '<span class="ui-muted">—</span>';
      const t = r.on_time_target ?? 95;
      const w = r.on_time_warning ?? 85;
      const tone = r.on_time_pct >= t ? 'ok' : r.on_time_pct >= w ? 'warn' : 'danger';
      return `<span class="ui-chip ui-chip-${tone}">${esc(r.on_time_pct)}%</span>`;
    } },
  { key: '_target', label: 'Target', sortValue: r => r.on_time_target, render: r =>
      r.on_time_target == null ? '<span class="ui-muted">not set</span>' : uiNum(r.on_time_target + '%') },
  { key: 'past_due', label: 'Past due', num: true, render: r => {
      const n = Number(r.past_due ?? 0);
      return n > 0 ? `<span class="ui-chip ui-chip-danger">${esc(n)}</span>` : uiNum(0);
    } },
  { key: 'open_count', label: 'Open', num: true },
  { key: 'shipped_30d', label: 'Shipped 30d', num: true },
  { key: '_sla', label: 'SLA', sortable: false, render: r => {
      const breaches = [];
      if(r.on_time_target != null && r.on_time_pct != null && r.on_time_pct < r.on_time_target) breaches.push('on-time');
      if(r.past_due_target != null && r.past_due != null && r.past_due > r.past_due_target) breaches.push('past-due');
      if(r.on_time_target == null && r.past_due_target == null){
        return '<span class="ui-chip ui-chip-neutral">no SLA set</span>';
      }
      return breaches.length
        ? `<span class="ui-chip ui-chip-danger">below SLA — ${esc(breaches.join(', '))}</span>`
        : '<span class="ui-chip ui-chip-ok">meeting SLA</span>';
    } },
];

async function loadClientsPerformance(){
  const host = document.getElementById('clientsPerformanceBody');
  if(!host) return;

  uiTableLoading(host, CLI_PERF_COLS);
  const rows = await apiGet('/dashboard/clients-performance');
  if(rows === null) return uiTableError(host, CLI_PERF_COLS, 'Could not load client performance', loadClientsPerformance);

  uiTable(host, {
    columns: CLI_PERF_COLS, rows, rowKey: 'client_id',
    sortable: true,
    onRowClick: (r) => { navigateTo('clients'); openClientDetail(r.client_id); },
    empty: 'No active clients.',
  });
}

function renderSLA(s){
  const wrap = document.getElementById('slaRow');
  if(!wrap) return;
  wrap.className = 'ui-tiles';

  const pct = s.onTimePct;
  // Past-due leads. On-time % is a score you review; a past-due order is work
  // that is already late and needs somebody to move.
  wrap.innerHTML =
    uiTile({ label: 'Past due', value: s.pastDue ?? 0,
             tone: (s.pastDue > 0 ? 'danger' : 'ok'),
             sub: 'open orders past their required ship date' }) +
    uiTile({ label: 'On-time ship', value: pct == null ? '—' : pct + '%',
             tone: pct == null ? null : pct >= 95 ? 'ok' : pct >= 85 ? 'warn' : 'danger',
             sub: `${s.onTimeShipped || 0} of ${s.totalWithSla || 0} shipped on time` }) +
    uiTile({ label: 'Avg turnaround',
             value: s.avgTurnaroundHours == null ? '—' : s.avgTurnaroundHours + 'h',
             sub: 'received to shipped, last 30 days' }) +
    // An average built from one or two orders is noise dressed up as a metric —
    // and this tile is shown to clients. Below 5 samples, say so instead of
    // printing a number someone might quote back at you.
    uiTile({ label: 'Avg pick time',
             value: (s.avgPickMinutes == null || Number(s.picksCount) < 5)
                      ? '—'
                      : s.avgPickMinutes + 'm',
             sub: Number(s.picksCount) < 5
                    ? `not enough data (${s.picksCount || 0} orders, last 30 days)`
                    : `${s.picksCount} orders picked, last 30 days` });
}

function renderKPIs(k){
  const row = document.getElementById('kpiRow');
  row.className = 'ui-tiles';
  row.innerHTML =
    uiTile({ label: 'Orders today', value: k.ordersToday?.value ?? 0 }) +
    uiTile({ label: 'Shipped', value: k.shipped?.value ?? 0 }) +
    uiTile({ label: 'In progress', value: k.inProgress?.value ?? 0 }) +
    uiTile({ label: 'Total SKUs', value: k.totalSKUs?.value ?? 0 }) +
    uiTile({ label: 'Total units', value: (k.totalUnits?.value ?? 0).toLocaleString() }) +
    uiTile({ label: 'Licence plates', value: k.licensePlates?.active ?? 0,
             sub: `${k.licensePlates?.original ?? 0} original · ${k.licensePlates?.child ?? 0} child` });
}

function renderQ(list){
  const b = document.getElementById('orderCountBadge');
  b.textContent = (list?.length || 0) + ' open';

  uiTable('orderQueue', {
    columns: [
      { key: '_ord', label: 'Order', render: o =>
          `<div>${uiId(o.order_number || '')}</div><div class="ui-hint">${esc(o.client_name || '')}</div>` },
      { key: 'channel', label: 'Channel' },
      { key: 'status', label: 'Status', render: o => uiChip(o.status) },
      { key: 'priority', label: 'Priority', num: true },
      { key: '_due', label: 'Ship by', render: o => {
          if(!o.required_ship_date) return '<span class="ui-muted">—</span>';
          const d = new Date(o.required_ship_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return o.is_past_sla
            ? `<span class="ui-chip ui-chip-danger">${esc(d)}</span>`
            : uiId(d);
        } },
      { key: 'line_count', label: 'Lines', num: true },
      { key: 'total_units', label: 'Units', num: true },
    ],
    rows: list || [], rowKey: 'id',
    onRowClick: (o) => { navigateTo('orders'); openOrderDetail(o.id); },
    empty: 'No open orders.',
  });
}

function renderAlerts(a){
  const c = document.getElementById('alertList');
  const b = document.getElementById('alertBadge');
  b.textContent = a?.length || 0;
  if(!a?.length){ c.innerHTML = uiEmpty('No alerts.'); return; }

  c.innerHTML = a.slice(0, 6).map(x => {
    const tone = x.severity === 'critical' ? 'danger'
               : x.severity === 'warning'  ? 'warn'
               : 'info';
    return `
      <div class="dash-alert">
        <span class="ui-chip ui-chip-${tone}">${esc((x.severity || 'info').toUpperCase())}</span>
        <span class="dash-alert-body">
          <span class="dash-alert-title">${esc(x.title || x.alert_type || 'Alert')}</span>
          <span class="ui-hint">${esc(x.client_name || '')}</span>
        </span>
      </div>`;
  }).join('');
}

function renderWaves(w){
  const c = document.getElementById('waveList');
  const b = document.getElementById('waveBadge');
  b.textContent = w?.length || 0;
  if(!w?.length){ c.innerHTML = uiEmpty('No active waves.'); return; }

  c.innerHTML = w.map(v => `
    <div class="dash-row">
      ${uiId(v.wave_number || '')}
      <span class="ui-hint">${esc(v.status)} · ${esc(v.order_count || 0)} order(s)</span>
    </div>`).join('');
}

function renderDock(s){
  const b = document.getElementById('dockBadge');
  b.textContent = s?.length || 0;

  uiTable('dockList', {
    columns: [
      { key: 'door_code', label: 'Door', mono: true },
      { key: '_appt', label: 'Type', render: d =>
          `<span class="ui-chip ui-chip-neutral">${esc((d.appt_type || '').toUpperCase())}</span>` },
      { key: '_who', label: 'Client', render: d =>
          `<div>${esc(d.client_name || '')}</div><div class="ui-hint">${esc(d.carrier_name || '')}</div>` },
      { key: '_time', label: 'Scheduled', render: d => d.scheduled_start
          ? uiId(new Date(d.scheduled_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
          : '<span class="ui-muted">—</span>' },
      { key: 'status', label: 'Status', render: d => uiChip(d.status) },
    ],
    rows: s || [], rowKey: 'id',
    empty: 'No appointments today.',
  });
}

function renderDI(items){
  uiTable('inventoryList', {
    columns: [
      { key: '_sku', label: 'SKU', render: r =>
          `<div>${uiId(r.sku_code || '')}</div><div class="ui-hint">${esc(r.client_name || '')}</div>` },
      { key: 'qty_total', label: 'On hand', num: true },
      { key: 'qty_allocated', label: 'Allocated', num: true },
      { key: '_st', label: 'Status', render: r => {
          const s = (r.status || 'ok').toLowerCase();
          const tone = s === 'expiring' ? 'danger' : s === 'low' ? 'warn' : 'ok';
          return `<span class="ui-chip ui-chip-${tone}">${esc(s.toUpperCase())}</span>`;
        } },
    ],
    rows: items || [], rowKey: 'sku_code',
    onRowClick: () => navigateTo('inventory'),
    empty: 'No inventory.',
  });
}

function renderCarriers(cs){
  const c = document.getElementById('carrierList');
  if(!cs?.length){ c.innerHTML = uiEmpty('No shipments.'); return; }

  // Bars are relative to the busiest carrier, not to a fixed 100 — the old
  // version capped the width at the raw shipment count, so any carrier with
  // 100+ shipments pegged the bar and they all looked identical.
  const max = Math.max(...cs.map(x => Number(x.total_shipments) || 0), 1);
  c.innerHTML = cs.map(x => {
    const n = Number(x.total_shipments) || 0;
    return `
      <div class="dash-bar-row">
        <span class="dash-bar-label">${esc(x.carrier || '—')}</span>
        <span class="dash-bar-track"><span class="dash-bar-fill" style="width:${Math.round((n / max) * 100)}%;"></span></span>
        <span class="dash-bar-val">${uiNum(n)}</span>
      </div>`;
  }).join('');
}

function renderTP(data){
  const ch = document.getElementById('throughputChart');
  const t  = document.getElementById('throughputTotal');
  if(!data?.length){
    ch.innerHTML = '<div class="empty-state" style="width:100%">No data</div>';
    t.textContent = '';
    return;
  }
  const v = data.map(d => parseInt(d.orders_shipped) || 0);
  const tot = v.reduce((a, b) => a + b, 0);
  t.textContent = 'Total: ' + tot;
  const mx = Math.max(...v, 1);
  const dn = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  ch.innerHTML = data.map((d, i) => {
    const h = Math.round((v[i] / mx) * 60);
    const color = i === data.length - 1 ? 'var(--blue)' : 'var(--border)';
    const day = d.ship_date ? dn[new Date(d.ship_date).getDay()] : '';
    return `
      <div class="bar-col">
        <div class="bar" style="height:${h}px;background:${color};" title="${esc(v[i])}"></div>
        <div class="bar-day">${esc(day)}</div>
      </div>`;
  }).join('');
}
