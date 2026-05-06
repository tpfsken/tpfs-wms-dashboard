// =============================================================================
// DASHBOARD
// =============================================================================

async function loadDashboard(){
  const d = await apiGet('/dashboard/summary');
  if(!d) return;
  if(d.kpis)         renderKPIs(d.kpis);
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
}

function renderKPIs(k){
  const cards = [
    {l:'Orders Today',  v:k.ordersToday?.value ?? 0, c:'var(--blue)'},
    {l:'Shipped',       v:k.shipped?.value ?? 0,     c:'var(--green)'},
    {l:'In Progress',   v:k.inProgress?.value ?? 0,  c:'var(--amber)'},
    {l:'Total SKUs',    v:k.totalSKUs?.value ?? 0,   c:'var(--text)'},
    {l:'Total Units',   v:(k.totalUnits?.value ?? 0).toLocaleString(), c:'var(--text)'},
    {l:'License Plates',v:k.licensePlates?.active ?? 0, c:'var(--purple)',
     s:`${k.licensePlates?.original ?? 0} orig · ${k.licensePlates?.child ?? 0} child`},
  ];
  document.getElementById('kpiRow').innerHTML = cards.map(x => `
    <div class="kpi">
      <div class="kpi-label">${esc(x.l)}</div>
      <div class="kpi-val" style="color:${x.c}">${esc(x.v)}</div>
      ${x.s ? `<div class="kpi-delta">${esc(x.s)}</div>` : ''}
    </div>
  `).join('');
}

function renderQ(list){
  const c = document.getElementById('orderQueue');
  const b = document.getElementById('orderCountBadge');
  if(!list?.length){
    c.innerHTML = '<div class="empty-state">No open orders</div>';
    b.textContent = '0';
    return;
  }
  b.textContent = list.length + ' open';
  c.innerHTML = list.map(o => {
    const s = SM[o.status] || {c:'chip-new', l:o.status};
    const sd = o.required_ship_date
      ? new Date(o.required_ship_date).toLocaleDateString('en-US', {month:'short', day:'numeric'})
      : '—';
    return `
      <div class="js-queue-row" data-order-id="${esc(o.id)}"
           style="display:grid;grid-template-columns:2fr 1fr 90px 70px 70px 80px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px;">
        <div>
          <div style="font-weight:600;color:var(--blue);">${esc(o.order_number || '')}</div>
          <div style="color:var(--text2);font-size:12px;">${esc(o.client_name || '')}</div>
        </div>
        <div style="color:var(--text2);">${esc(o.channel || '')}</div>
        <div><span class="chip ${s.c}">${esc(s.l)}</span></div>
        <div style="color:var(--text2);">${esc(o.priority || 5)}</div>
        <div style="color:${o.is_past_sla ? 'var(--red)' : 'var(--text2)'};">${esc(sd)}</div>
        <div style="text-align:right;color:var(--text2);">${esc(o.line_count || 0)}L/${esc(o.total_units || 0)}u</div>
      </div>`;
  }).join('');

  // Wire row clicks (delegated)
  c.querySelectorAll('.js-queue-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.orderId;
      navigateTo('orders');
      setTimeout(() => openOrderDetail(id), 100);
    });
  });
}

function renderAlerts(a){
  const c = document.getElementById('alertList');
  const b = document.getElementById('alertBadge');
  if(!a?.length){
    c.innerHTML = '<div class="empty-state">No alerts</div>';
    b.textContent = '0';
    return;
  }
  b.textContent = a.length;
  c.innerHTML = a.slice(0, 6).map(x => {
    const sev = x.severity === 'critical' ? 'var(--red-bg)'
              : x.severity === 'warning'  ? 'var(--amber-bg)'
              : 'var(--blue-bg)';
    const icon = x.severity === 'critical' ? '!' : '⚠';
    return `
      <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:flex-start;">
        <div style="width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;background:${sev};">${icon}</div>
        <div>
          <div style="font-weight:600;font-size:13px;">${esc(x.title || x.alert_type || 'Alert')}</div>
          <div style="font-size:12px;color:var(--text2);">${esc(x.client_name || '')}</div>
        </div>
      </div>`;
  }).join('');
}

function renderWaves(w){
  const c = document.getElementById('waveList');
  const b = document.getElementById('waveBadge');
  if(!w?.length){
    c.innerHTML = '<div class="empty-state">No active waves</div>';
    b.textContent = '0';
    return;
  }
  b.textContent = w.length;
  c.innerHTML = w.map(v => `
    <div style="background:var(--bg);border-radius:8px;padding:12px;margin-bottom:8px;">
      <div style="font-weight:600;color:var(--blue);">${esc(v.wave_number || '')}</div>
      <div style="font-size:12px;color:var(--text2);">${esc(v.status)} · ${esc(v.order_count || 0)} orders</div>
    </div>`).join('');
}

function renderDock(s){
  const c = document.getElementById('dockList');
  const b = document.getElementById('dockBadge');
  if(!s?.length){
    c.innerHTML = '<div class="empty-state">No appointments today</div>';
    b.textContent = '0';
    return;
  }
  b.textContent = s.length;
  c.innerHTML = s.map(d => `
    <div style="padding:12px 20px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:80px 1fr 100px 90px;align-items:center;gap:12px;">
      <div style="text-align:center;">
        <div style="font-weight:700;font-size:16px;color:var(--blue);">${esc(d.door_code || '?')}</div>
        <div style="font-size:10px;color:var(--muted);">${esc((d.appt_type || '').toUpperCase())}</div>
      </div>
      <div>
        <div style="font-weight:600;font-size:13px;">${esc(d.client_name || '')}</div>
        <div style="font-size:12px;color:var(--text2);">${esc(d.carrier_name || '')}</div>
      </div>
      <div style="color:var(--text2);font-size:13px;">${d.scheduled_start ? esc(new Date(d.scheduled_start).toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'})) : '—'}</div>
      <div><span class="chip chip-active">${esc(d.status || '')}</span></div>
    </div>`).join('');
}

function renderDI(items){
  const c = document.getElementById('inventoryList');
  if(!items?.length){
    c.innerHTML = '<div class="empty-state">No inventory</div>';
    return;
  }
  c.innerHTML = items.map(r => {
    const statusColor = r.status === 'expiring' ? 'var(--red)'
                      : r.status === 'low'      ? 'var(--amber)'
                      : 'var(--green)';
    return `
      <div class="js-inv-row" style="display:grid;grid-template-columns:1fr 80px 80px 80px;padding:12px 20px;border-bottom:1px solid var(--border);font-size:13px;cursor:pointer;">
        <div>
          <div style="font-weight:600;">${esc(r.sku_code || '')}</div>
          <div style="font-size:12px;color:var(--text2);">${esc(r.client_name || '')}</div>
        </div>
        <div style="text-align:right;font-weight:600;">${esc(Number(r.qty_total || 0).toLocaleString())}</div>
        <div style="text-align:right;color:var(--blue);">${esc(Number(r.qty_allocated || 0).toLocaleString())}</div>
        <div style="text-align:right;color:${statusColor};font-size:12px;">${esc((r.status || 'OK').toUpperCase())}</div>
      </div>`;
  }).join('');
  c.querySelectorAll('.js-inv-row').forEach(row => row.addEventListener('click', () => navigateTo('inventory')));
}

function renderCarriers(cs){
  const c = document.getElementById('carrierList');
  if(!cs?.length){
    c.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }
  c.innerHTML = cs.map(x => {
    const pct = Math.min(100, parseInt(x.total_shipments) || 0);
    return `
      <div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;font-size:13px;">
        <div style="font-weight:600;width:60px;">${esc(x.carrier || '?')}</div>
        <div style="flex:1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden;">
          <div style="height:100%;border-radius:3px;width:${pct}%;background:var(--blue);"></div>
        </div>
        <div style="color:var(--text2);width:40px;text-align:right;">${esc(x.total_shipments || 0)}</div>
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
