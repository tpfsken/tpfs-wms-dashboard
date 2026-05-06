// =============================================================================
// ORDERS — list, detail, allocation, new-order modal
// =============================================================================

let COI = null;          // current order id
let COD = null;          // current order data
let AIC = {};            // allocation inventory cache by order line id
let orderLines = [];     // new-order modal: pending lines

async function loadOrders(){
  const s  = document.getElementById('ordSearch')?.value || '';
  const st = (_cbState['ordStatusFilterWrap']?.selected?.value) || '';
  let u = '/orders?limit=100';
  if(st) u += `&status=${encodeURIComponent(st)}`;
  if(s)  u += `&search=${encodeURIComponent(s)}`;
  const d = await apiGet(u);
  if(!d) return;

  const b = document.getElementById('ordBody');
  const rows = d.data || d.rows || d;
  if(!rows?.length){
    b.innerHTML = '<tr><td colspan="11" class="empty-state">No orders</td></tr>';
    return;
  }

  b.innerHTML = rows.map(o => {
    const s = SM[o.status] || {c:'chip-new', l:o.status};
    const sd = o.required_ship_date
      ? new Date(o.required_ship_date).toLocaleDateString('en-US', {month:'short', day:'numeric'})
      : '—';
    const cityState = [o.ship_to_city, o.ship_to_state].filter(Boolean).join(', ');
    return `
      <tr class="js-order-row" data-order-id="${esc(o.id)}" style="cursor:pointer;">
        <td style="font-weight:600;color:var(--blue);">${esc(o.order_number || '')}</td>
        <td>${esc(o.client_name || '')}</td>
        <td>${esc(o.channel || '')}</td>
        <td><span class="chip chip-new">${esc(o.order_type || '')}</span></td>
        <td>${esc(o.customer_name || '—')}</td>
        <td style="color:var(--text2);font-size:12px;">${esc(cityState)}</td>
        <td>${esc(o.carrier_code || '—')}</td>
        <td class="right">${esc(o.line_count || 0)}</td>
        <td class="right" style="font-weight:600;">${esc(o.total_units || 0)}</td>
        <td style="color:${o.is_past_sla ? 'var(--red)' : 'var(--text2)'};">${esc(sd)}</td>
        <td><span class="chip ${s.c}">${esc(s.l)}</span></td>
      </tr>`;
  }).join('');

  b.querySelectorAll('.js-order-row').forEach(row => {
    row.addEventListener('click', () => openOrderDetail(row.dataset.orderId));
  });
}

async function openOrderDetail(id){
  COI = id;
  document.getElementById('ordListView').style.display = 'none';
  document.getElementById('ordDetailView').style.display = 'block';
  document.getElementById('ordTransError').textContent = '';
  document.getElementById('ordTransSuccess').textContent = '';

  const d = await apiGet(`/orders/${id}`);
  if(!d){ closeOrderDetail(); return; }
  COD = d;

  document.getElementById('ordDetailTitle').textContent = d.order_number || '';
  document.getElementById('ordDetailSub').textContent   = `${d.client_name || ''} · ${d.channel || ''}`;
  const st = SM[d.status] || {c:'chip-new', l:d.status};
  const stEl = document.getElementById('ordDetailStatus');
  stEl.textContent = st.l;
  stEl.className = 'chip ' + st.c;

  const fields = [
    {l:'Order #',  v:d.order_number},
    {l:'External', v:d.external_order_number || '—'},
    {l:'Channel',  v:d.channel || '—'},
    {l:'Type',     v:d.order_type || '—'},
    {l:'Customer', v:d.customer_name || '—'},
    {l:'Carrier',  v:`${d.carrier_code || '—'} / ${d.ship_method || '—'}`},
    {l:'Ship By',  v:d.required_ship_date ? new Date(d.required_ship_date).toLocaleDateString() : '—'},
    {l:'Created',  v:d.created_at ? new Date(d.created_at).toLocaleString() : '—'},
  ];
  document.getElementById('ordInfoGrid').innerHTML = fields.map(f =>
    `<div><div class="detail-label">${esc(f.l)}</div><div class="detail-value">${esc(f.v)}</div></div>`
  ).join('');

  document.getElementById('ordLinesBody').innerHTML = d.lines?.map(ln => `
    <tr>
      <td>${esc(ln.line_number)}</td>
      <td style="font-weight:600;color:var(--blue);">${esc(ln.sku_code || '')}</td>
      <td>${esc(ln.sku_name || '')}</td>
      <td>${esc(ln.sku_type || ln.uom || '')}</td>
      <td class="right">${esc(ln.ordered_qty || 0)}</td>
      <td class="right" style="color:var(--blue);">${esc(ln.allocated_qty || 0)}</td>
      <td class="right" style="color:var(--amber);">${esc(ln.picked_qty || 0)}</td>
      <td class="right" style="color:var(--green);">${esc(ln.shipped_qty || 0)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty-state">No lines</td></tr>';

  const ci = WF.indexOf(d.status);
  document.getElementById('ordWorkflowSteps').innerHTML = WF.map((s, i) => {
    const cls = i < ci ? 'done' : s === d.status ? 'current' : 'pending';
    const icon = i < ci ? '✓' : s === d.status ? '●' : '○';
    const cur = s === d.status ? '<span class="wf-current-label">CURRENT</span>' : '';
    return `<div class="workflow-step ${cls}"><div class="workflow-icon">${icon}</div>${esc(s)}${cur}</div>`;
  }).join('') + (d.status === 'CANCELLED'
    ? '<div class="workflow-step" style="color:var(--red);"><div class="workflow-icon">✕</div>CANCELLED</div>'
    : '');

  const tr = await apiGet(`/orders/${id}/valid-transitions`);
  const transBtns = document.getElementById('ordTransitionBtns');
  if(tr?.allowed?.length){
    transBtns.innerHTML = tr.allowed.map(t =>
      `<button class="btn ${t === 'CANCELLED' ? 'btn-danger' : 'btn-primary'} js-trans-btn"
               data-target="${esc(t)}" style="margin:0 8px 8px 0;">${t === 'CANCELLED' ? 'Cancel' : '→ ' + esc(t)}</button>`
    ).join('');
    transBtns.querySelectorAll('.js-trans-btn').forEach(btn =>
      btn.addEventListener('click', () => transitionOrder(id, btn.dataset.target))
    );
  } else {
    transBtns.innerHTML = '<div style="color:var(--muted);font-size:13px;">Terminal state</div>';
  }

  const shipTo = `
    <div style="font-weight:600;font-size:15px;margin-bottom:6px;">${esc(d.ship_to_name || d.customer_name || '—')}</div>
    <div style="color:var(--text2);line-height:1.7;">
      ${esc(d.ship_to_line1 || '')}<br>
      ${d.ship_to_line2 ? esc(d.ship_to_line2) + '<br>' : ''}
      ${esc([d.ship_to_city, d.ship_to_state, d.ship_to_postal].filter(Boolean).join(', '))}<br>
      ${esc(d.ship_to_country || 'US')}
    </div>
    ${d.customer_email ? `<div style="color:var(--muted);margin-top:8px;">${esc(d.customer_email)}</div>` : ''}`;
  document.getElementById('ordShipTo').innerHTML = shipTo;

  document.getElementById('ordShipments').innerHTML = d.shipments?.length
    ? d.shipments.map(sh => `
        <div style="padding:14px 20px;border-bottom:1px solid var(--border);">
          <div style="font-weight:600;color:var(--blue);">${esc(sh.shipment_number || '')} <span class="chip chip-success">${esc(sh.status || '')}</span></div>
          <div style="font-size:12px;color:var(--text2);margin-top:4px;">Tracking: ${esc(sh.tracking_number || '—')}</div>
        </div>`).join('')
    : '<div class="empty-state">No shipments</div>';

  document.getElementById('allocPanel').style.display = 'none';
  const ah = document.getElementById('allocHistPanel');
  if(d.allocations?.length){
    ah.style.display = 'block';
    document.getElementById('allocHistBadge').textContent = d.allocations.length;
    document.getElementById('allocHistBody').innerHTML = d.allocations.map(a => {
      const lp = a.lp_number
        ? `<span class="lp-badge ${a.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(a.lp_number)}</span>`
        : '—';
      const stChip = a.status === 'ALLOCATED' ? 'chip-active' : 'chip-success';
      return `
        <tr>
          <td style="color:var(--blue);">${esc(a.sku_code || '')}</td>
          <td style="color:var(--blue);">${esc(a.lot_number || '—')}</td>
          <td>${lp}</td>
          <td>${esc(a.location_code || '')}</td>
          <td class="right" style="font-weight:600;">${esc(a.quantity || 0)}</td>
          <td><span class="chip ${stChip}">${esc(a.status)}</span></td>
        </tr>`;
    }).join('');
  } else {
    ah.style.display = 'none';
  }
}

function closeOrderDetail(){
  document.getElementById('ordDetailView').style.display = 'none';
  document.getElementById('ordListView').style.display = 'block';
  COI = null; COD = null;
  loadOrders();
}

async function transitionOrder(id, ns){
  const err = document.getElementById('ordTransError');
  const suc = document.getElementById('ordTransSuccess');
  err.textContent = ''; suc.textContent = '';
  if(ns === 'ALLOCATED' && COD?.status === 'NEW'){ showAllocPanel(id); return; }
  try {
    const r = await fetch(`${API}/orders/${id}/status`, {
      method:'PATCH',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({status: ns}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    suc.textContent = `→ ${ns}`;
    setTimeout(() => openOrderDetail(id), 500);
  } catch(e){
    err.textContent = 'Network error';
  }
}

async function showAllocPanel(id){
  document.getElementById('allocPanel').style.display = 'block';
  document.getElementById('allocError').textContent = '';
  document.getElementById('allocSuccess').textContent = '';
  const ll = document.getElementById('allocLinesList');
  ll.innerHTML = '<div class="empty-state">Loading...</div>';
  if(!COD?.lines) return;

  let html = '';
  for(let i = 0; i < COD.lines.length; i++){
    const ln = COD.lines[i];
    const rem = (ln.ordered_qty || 0) - (ln.allocated_qty || 0);
    if(rem <= 0) continue;
    const av = await apiGet(`/orders/${id}/available-inventory?skuId=${encodeURIComponent(ln.sku_id)}`);
    if(!av) continue;
    AIC[ln.id] = av.inventory || [];
    const pm = av.pickMode || 'FEFO';
    document.getElementById('allocModeBadge').textContent = pm;

    html += `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <span style="font-weight:700;color:var(--blue);font-size:14px;">Line ${esc(ln.line_number)}: ${esc(ln.sku_code)}</span>
          <span style="color:var(--text2);">${esc(ln.sku_name || '')}</span>
          <span style="margin-left:auto;font-weight:600;color:var(--amber);">Need: ${esc(rem)} ${esc(ln.sku_uom || ln.uom || '')}</span>
        </div>`;

    if(!av.inventory?.length){
      html += '<div class="empty-state">No inventory available</div>';
    } else {
      html += `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:12px;color:var(--muted);">Sorted ${esc(pm)}:</span>
          <input type="text" class="form-input js-alloc-search" id="als_${i}" data-idx="${i}" placeholder="Search lot # or LP #..." style="max-width:260px;padding:8px 12px;font-size:13px;">
        </div>
        <table class="data-table">
          <thead><tr><th style="width:36px">Sel</th><th>Lot</th><th>Expiry</th><th>LP</th><th>Type</th><th>Location</th><th>Zone</th><th class="right">Avail</th><th style="width:90px">Qty</th></tr></thead>
          <tbody id="atb_${i}">`;

      let rf = rem;
      av.inventory.forEach((inv, j) => {
        const sq = Math.min(rf, inv.available_qty);
        const as = sq > 0 && rf > 0;
        if(as) rf -= sq;
        const expiringSoon = inv.expiry_date && new Date(inv.expiry_date) < new Date(Date.now() + 30 * 864e5);
        const lpBadge = inv.lp_number
          ? `<span class="lp-badge ${inv.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(inv.lp_number)}</span>`
          : '—';
        html += `
          <tr id="ar_${i}_${j}" data-lot="${esc((inv.lot_number || '').toLowerCase())}" data-lp="${esc((inv.lp_number || '').toLowerCase())}">
            <td><input type="checkbox" class="js-alloc-chk" id="ac_${i}_${j}" data-i="${i}" data-j="${j}" ${as ? 'checked' : ''} style="width:18px;height:18px;"></td>
            <td style="color:var(--blue);font-weight:500;">${esc(inv.lot_number || '—')}</td>
            <td style="color:${expiringSoon ? 'var(--red)' : 'var(--text2)'};">${esc(inv.expiry_date ? new Date(inv.expiry_date).toLocaleDateString() : '—')}</td>
            <td>${lpBadge}</td>
            <td>${esc(inv.lp_type || '')}</td>
            <td>${esc(inv.location_code || '')}</td>
            <td style="color:var(--muted);font-size:12px;">${esc(inv.zone_name || '')}</td>
            <td class="right" style="font-weight:600;">${esc(inv.available_qty)}</td>
            <td><input type="number" class="form-input" id="aq_${i}_${j}" value="${as ? sq : 0}" min="0" max="${esc(inv.available_qty)}" style="width:80px;padding:8px;" ${!as ? 'disabled' : ''}></td>
          </tr>`;
      });
      html += '</tbody></table>';
    }
    html += `<input type="hidden" id="ali_${i}" value="${esc(ln.id)}"><input type="hidden" id="aln_${i}" value="${esc(rem)}"></div>`;
  }
  ll.innerHTML = html || '<div class="empty-state">All allocated</div>';

  // Wire allocation interactions
  ll.querySelectorAll('.js-alloc-chk').forEach(chk => {
    chk.addEventListener('change', () => tar(parseInt(chk.dataset.i), parseInt(chk.dataset.j)));
  });
  ll.querySelectorAll('.js-alloc-search').forEach(inp => {
    inp.addEventListener('input', () => filterAR(parseInt(inp.dataset.idx)));
  });
}

function tar(i, j){
  const c = document.getElementById(`ac_${i}_${j}`);
  const q = document.getElementById(`aq_${i}_${j}`);
  if(c && q){
    q.disabled = !c.checked;
    if(!c.checked) q.value = 0;
  }
}

function filterAR(i){
  const sv = (document.getElementById(`als_${i}`)?.value || '').toLowerCase();
  document.getElementById(`atb_${i}`)?.querySelectorAll('tr').forEach(r => {
    if(!sv){ r.style.display = ''; return; }
    r.style.display = (r.dataset.lot || '').includes(sv) || (r.dataset.lp || '').includes(sv) ? '' : 'none';
  });
}

async function submitAllocation(){
  if(!COI || !COD) return;
  const err = document.getElementById('allocError');
  const suc = document.getElementById('allocSuccess');
  err.textContent = ''; suc.textContent = '';
  const allocs = [];

  for(let i = 0; ; i++){
    const el = document.getElementById(`ali_${i}`);
    if(!el) break;
    const olid = el.value;
    const need = parseInt(document.getElementById(`aln_${i}`)?.value) || 0;
    const inv = AIC[olid] || [];
    let lt = 0;
    for(let j = 0; j < inv.length; j++){
      const chk = document.getElementById(`ac_${i}_${j}`);
      const qi  = document.getElementById(`aq_${i}_${j}`);
      if(!chk?.checked) continue;
      const q = parseInt(qi?.value) || 0;
      if(q <= 0) continue;
      if(q > inv[j].available_qty){
        err.textContent = `Cannot allocate ${q} — only ${inv[j].available_qty} available`;
        return;
      }
      lt += q;
      allocs.push({
        orderLineId: olid,
        inventoryId: inv[j].inventory_id,
        lotId:       inv[j].lot_id,
        lpId:        inv[j].lp_id,
        locationId:  inv[j].location_id,
        quantity:    q,
      });
    }
    if(lt > need && !confirm(`Allocating ${lt} but only ${need} ordered. Over-allocate?`)) return;
    if(lt < need && !confirm(`Only ${lt} of ${need}. Partial allocation?`)) return;
  }

  if(!allocs.length){ err.textContent = 'No inventory selected'; return; }

  try {
    const r = await fetch(`${API}/orders/${COI}/allocate`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({allocations: allocs}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    suc.textContent = `Allocated ${d.allocationsCreated} line(s)`;
    setTimeout(() => openOrderDetail(COI), 1000);
  } catch(e){
    err.textContent = 'Network error';
  }
}

// =============================================================================
// NEW ORDER MODAL
// =============================================================================

async function showNewOrderModal(){
  await loadCC();
  const m = document.getElementById('newOrderModal');
  m.style.display = 'flex'; m.style.zIndex = '10000';

  initCombo('noClientWrap',
    clientsCache.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`})),
    {placeholder:'Select client...', onChange:(v) => { if(v) onOrderClientChange(v); }}
  );
  initCombo('noChannelWrap', [
    {value:'MANUAL',label:'Manual'},{value:'SHOPIFY',label:'Shopify'},
    {value:'EDI',label:'EDI'},{value:'PHONE',label:'Phone'},{value:'EMAIL',label:'Email'},
  ], {placeholder:'Select...', value:'MANUAL'});
  initCombo('noTypeWrap', [
    {value:'FULFILLMENT',label:'Fulfillment'},{value:'B2B',label:'B2B'},
  ], {placeholder:'Select...', value:'FULFILLMENT'});
  initCombo('noPriorityWrap', [
    {value:'5',label:'Normal (5)'},{value:'7',label:'High (7)'},
    {value:'9',label:'Rush (9)'},{value:'3',label:'Low (3)'},
  ], {placeholder:'Select...', value:'5'});
  initCombo('noCarrierWrap', [
    {value:'UPS',label:'UPS'},{value:'FEDEX',label:'FedEx'},{value:'USPS',label:'USPS'},
    {value:'DHL',label:'DHL'},{value:'OTHER',label:'LTL/Other'},
  ], {placeholder:'Select carrier...'});
  initCombo('noPriorAddrWrap', [],
    {placeholder:'Load from prior order...', onChange:(v) => fillPriorAddress(v)});

  orderLines = [];
  renderOL();
  document.getElementById('noError').textContent = '';
  document.getElementById('noOrderNum').value =
    'ORD-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 9000) + 1000);
}

async function onOrderClientChange(cid){
  if(!cid) cid = cbVal('noClientWrap');
  if(!cid) return;
  const addrs = await apiGet(`/ship-to-addresses?clientId=${encodeURIComponent(cid)}`);
  window._priorAddrs = addrs || [];
  initCombo('noPriorAddrWrap',
    (addrs || []).map((a, i) => ({
      value: String(i),
      label: `${a.ship_to_name} — ${a.ship_to_line1}, ${a.ship_to_city}`,
    })),
    {placeholder:'Load from prior order...', onChange:(v) => fillPriorAddress(v)}
  );
  orderLines = [];
  renderOL();
}

// FIX: previously referenced non-existent #noCarrier (carrier is now a combo).
function fillPriorAddress(idx){
  const i = parseInt(idx);
  const addrs = window._priorAddrs || [];
  if(isNaN(i) || !addrs.length) return;
  const a = addrs[i];
  document.getElementById('noCustName').value  = a.customer_name || a.ship_to_name || '';
  document.getElementById('noCustEmail').value = a.customer_email || '';
  document.getElementById('noAddr1').value     = a.ship_to_line1 || '';
  document.getElementById('noAddr2').value     = a.ship_to_line2 || '';
  document.getElementById('noCity').value      = a.ship_to_city || '';
  document.getElementById('noState').value     = a.ship_to_state || '';
  document.getElementById('noPostal').value    = a.ship_to_postal || '';
  document.getElementById('noCountry').value   = a.ship_to_country || 'US';
  if(a.carrier_code) cbSet('noCarrierWrap', a.carrier_code, a.carrier_code);
  if(a.ship_method)  document.getElementById('noShipMethod').value = a.ship_method;
}

async function searchOrderSkus(){
  const cid = cbVal('noClientWrap');
  const s   = document.getElementById('noSkuSearch').value;
  const div = document.getElementById('noSkuResults');
  if(!cid){ div.style.display = 'none'; return; }

  const [skuRes, invRes] = await Promise.all([
    apiGet(`/skus?clientId=${encodeURIComponent(cid)}&search=${encodeURIComponent(s)}`),
    s ? apiGet(`/inventory?limit=100&status=available&skuCode=${encodeURIComponent('%' + s + '%')}&clientId=${encodeURIComponent(cid)}`) : Promise.resolve([]),
  ]);

  // Merge SKU results with inventory lot-search results — using REAL sku_id only.
  const skuMap = {};
  (skuRes || []).forEach(x => { skuMap[String(x.id)] = x; });

  const invRows = invRes?.rows || invRes || [];
  invRows.forEach(r => {
    if(!r.sku_code || !r.sku_id) return;     // FIX: require real sku_id (no synthetic IDs)
    const key = String(r.sku_id);
    if(skuMap[key]){
      skuMap[key].qty_available = (skuMap[key].qty_available || 0) + Number(r.quantity || 0);
    } else {
      skuMap[key] = {
        id: r.sku_id,
        sku_code: r.sku_code,
        name: r.sku_name || '',
        uom: r.uom || r.sku_type || 'EACH',
        qty_available: Number(r.quantity || 0),
      };
    }
  });

  const d = Object.values(skuMap);
  if(!d?.length){
    div.innerHTML = '<div class="empty-state" style="padding:12px;">No SKUs or lots found</div>';
    div.style.display = 'block';
    return;
  }

  // SKUs that matched via lot search → auto-expand
  const autoExpand = s && invRows.length > 0
    ? new Set(invRows.map(r => r.sku_code))
    : new Set();

  div.innerHTML = d.map(x => {
    const availColor = (x.qty_available || 0) > 0 ? 'var(--green)' : 'var(--red)';
    return `
      <div style="border-bottom:1px solid var(--border);">
        <div class="js-sku-row"
             data-sku-id="${esc(x.id)}"
             data-sku-code="${esc(x.sku_code)}"
             data-sku-name="${esc(x.name || '')}"
             data-uom="${esc(x.uom)}"
             data-avail="${esc(x.qty_available || 0)}"
             style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;font-size:13px;">
          <span style="font-weight:600;color:var(--blue);">${esc(x.sku_code)}</span>
          <span style="color:var(--text2);">${esc(x.name || '')}</span>
          <span style="margin-left:auto;color:${availColor};font-weight:600;">${esc(x.qty_available || 0)} avail</span>
          <span class="js-sku-arrow" style="color:var(--muted);font-size:11px;">▶</span>
        </div>
        <div class="sku-lots" id="lots_${esc(x.id)}" style="display:none;"></div>
      </div>`;
  }).join('');
  div.style.display = 'block';

  div.querySelectorAll('.js-sku-row').forEach(row => {
    row.addEventListener('click', () => {
      const filter = document.getElementById('noSkuSearch').value;
      expandSkuLots(row, row.dataset.skuId, row.dataset.skuCode, row.dataset.skuName, row.dataset.uom, parseInt(row.dataset.avail) || 0, filter);
    });
  });

  if(autoExpand.size > 0){
    div.querySelectorAll('.js-sku-row').forEach(row => {
      if(autoExpand.has(row.dataset.skuCode)){
        expandSkuLots(row, row.dataset.skuId, row.dataset.skuCode, row.dataset.skuName, row.dataset.uom, parseInt(row.dataset.avail) || 0, s);
      }
    });
  }
}

async function expandSkuLots(el, skuId, skuCode, skuName, uom, totalAvail, lotFilter){
  const lotsDiv = document.getElementById('lots_' + skuId);
  if(!lotsDiv) return;
  const arrow = el.querySelector('.js-sku-arrow');
  if(lotsDiv.style.display === 'block'){
    lotsDiv.style.display = 'none';
    if(arrow) arrow.textContent = '▶';
    return;
  }
  if(arrow) arrow.textContent = '▼';
  lotsDiv.style.display = 'block';
  lotsDiv.innerHTML = '<div style="padding:8px 16px 8px 32px;color:var(--muted);font-size:12px;">Loading lots...</div>';

  const cid = cbVal('noClientWrap');
  const d = await apiGet(`/inventory?limit=100&clientId=${encodeURIComponent(cid)}&skuCode=${encodeURIComponent('%' + skuCode + '%')}&status=available`);
  const allRows = (d?.rows || d || []).filter(r => r.quantity > 0);

  const lf = (lotFilter || '').toLowerCase().trim();
  const skuMatches = lf && (skuCode.toLowerCase().includes(lf) || skuName.toLowerCase().includes(lf));
  const rows = (lf && !skuMatches)
    ? allRows.filter(r => (r.lot_number || '').toLowerCase().includes(lf))
    : allRows;

  if(!rows.length){
    lotsDiv.innerHTML = '<div style="padding:8px 16px 8px 32px;color:var(--muted);font-size:12px;">No available inventory</div>';
    return;
  }

  const header = `
    <div style="padding:6px 16px 6px 32px;display:grid;grid-template-columns:140px 100px 130px 120px 60px 80px;gap:8px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid var(--border);background:rgba(0,0,0,.15);">
      <span>Lot</span><span>Expiry</span><span>LP</span><span>Location</span><span>Qty</span><span></span>
    </div>`;

  const body = rows.map(r => {
    const expiringSoon = r.expiry_date && new Date(r.expiry_date) < new Date(Date.now() + 30 * 864e5);
    const lpClass = r.lp_type === 'CHILD' ? 'lp-child' : 'lp-original';
    return `
      <div class="js-lot-row"
           data-sku-id="${esc(skuId)}"
           data-sku-code="${esc(skuCode)}"
           data-sku-name="${esc(skuName)}"
           data-uom="${esc(uom)}"
           data-lot="${esc(r.lot_number || '')}"
           data-expiry="${esc(r.expiry_date || '')}"
           data-lp="${esc(r.lp_number || '')}"
           data-location="${esc(r.location_code || '')}"
           data-qty="${esc(r.quantity || 0)}"
           style="padding:8px 16px 8px 32px;border-top:1px solid var(--border);display:grid;grid-template-columns:140px 100px 130px 120px 60px 80px;align-items:center;gap:8px;font-size:12px;cursor:pointer;transition:background .1s;">
        <span style="color:var(--blue);font-weight:600;">${esc(r.lot_number || 'No lot')}</span>
        <span style="color:${expiringSoon ? 'var(--red)' : 'var(--text2)'};">${esc(r.expiry_date ? new Date(r.expiry_date).toLocaleDateString() : '—')}</span>
        <span class="lp-badge ${lpClass}">${esc(r.lp_number || '—')}</span>
        <span style="color:var(--muted);">${esc(r.location_code || '—')}</span>
        <span style="font-weight:600;color:var(--green);">${esc(r.quantity)}</span>
        <span style="color:var(--blue);font-size:11px;font-weight:600;">+ Add</span>
      </div>`;
  }).join('');

  lotsDiv.innerHTML = header + body;

  lotsDiv.querySelectorAll('.js-lot-row').forEach(row => {
    row.addEventListener('mouseover', () => row.style.background = 'var(--hover)');
    row.addEventListener('mouseout',  () => row.style.background = '');
    row.addEventListener('click', () => {
      addOLWithLot(
        row.dataset.skuId, row.dataset.skuCode, row.dataset.skuName, row.dataset.uom,
        row.dataset.lot, row.dataset.expiry, row.dataset.lp, row.dataset.location,
        Number(row.dataset.qty)
      );
    });
  });
}

function addOLWithLot(skuId, skuCode, skuName, uom, lotNum, expiry, lpNum, location, avail){
  const key = skuId + '_' + (lotNum || 'nolot');
  if(orderLines.find(l => l._key === key)) return;
  orderLines.push({
    _key: key, skuId, code: skuCode, name: skuName, uom,
    lotNum, expiry, lpNum, location, avail, qty: 1,
  });
  renderOL();
  document.getElementById('noSkuSearch').value = '';
  document.getElementById('noSkuResults').style.display = 'none';
}

function addOL(id, code, name, uom, avail){
  addOLWithLot(id, code, name, uom, '', '', '', '', avail);
}

function renderOL(){
  const b = document.getElementById('noLinesBody');
  const e = document.getElementById('noLinesEmpty');
  if(!orderLines.length){
    b.innerHTML = '';
    e.style.display = 'block';
    return;
  }
  e.style.display = 'none';

  b.innerHTML = orderLines.map((l, i) => `
    <tr>
      <td style="font-weight:600;color:var(--blue);">${esc(l.code)}</td>
      <td style="color:var(--text2);font-size:12px;">${esc(l.name)}</td>
      <td style="color:var(--blue);font-size:12px;">${esc(l.lotNum || '—')}</td>
      <td style="font-size:12px;color:var(--text2);">${esc(l.expiry ? new Date(l.expiry).toLocaleDateString() : '—')}</td>
      <td style="font-size:12px;">${l.lpNum ? `<span class="lp-badge lp-original">${esc(l.lpNum)}</span>` : '—'}</td>
      <td style="font-size:12px;color:var(--muted);">${esc(l.location || '—')}</td>
      <td class="right" style="color:var(--green);font-size:12px;">${esc(l.avail)}</td>
      <td><input type="number" class="form-input js-ol-qty" data-i="${i}" value="${esc(l.qty)}" min="1" max="${esc(l.avail)}" style="width:72px;padding:6px 8px;"></td>
      <td><button class="btn btn-ghost js-ol-remove" data-i="${i}" style="padding:4px 8px;color:var(--red);">✕</button></td>
    </tr>`).join('');

  b.querySelectorAll('.js-ol-qty').forEach(inp => {
    inp.addEventListener('change', () => {
      orderLines[parseInt(inp.dataset.i)].qty = parseInt(inp.value) || 1;
    });
  });
  b.querySelectorAll('.js-ol-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      orderLines.splice(parseInt(btn.dataset.i), 1);
      renderOL();
    });
  });
}

async function submitNewOrder(){
  const err = document.getElementById('noError');
  err.textContent = '';
  const cid = cbVal('noClientWrap');
  const num = document.getElementById('noOrderNum').value.trim();
  const cn  = document.getElementById('noCustName').value.trim();
  if(!cid){ err.textContent = 'Select a client'; return; }
  if(!num){ err.textContent = 'Enter order number'; return; }
  if(!orderLines.length){ err.textContent = 'Add at least one line'; return; }
  if(!cn){ err.textContent = 'Enter customer name'; return; }

  try {
    const r = await fetch(`${API}/orders`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        clientId: cid,
        orderNumber: num,
        channel: cbVal('noChannelWrap') || 'MANUAL',
        orderType: cbVal('noTypeWrap') || 'FULFILLMENT',
        priority: parseInt(cbVal('noPriorityWrap')) || 5,
        carrierCode: cbVal('noCarrierWrap') || null,
        shipMethod: document.getElementById('noShipMethod').value || null,
        requiredShipDate: document.getElementById('noShipDate').value || null,
        customerName: cn,
        customerEmail: document.getElementById('noCustEmail').value || null,
        shipTo: {
          name: cn,
          line1:   document.getElementById('noAddr1').value,
          line2:   document.getElementById('noAddr2').value,
          city:    document.getElementById('noCity').value,
          state:   document.getElementById('noState').value,
          postal:  document.getElementById('noPostal').value,
          country: document.getElementById('noCountry').value || 'US',
        },
        lines: orderLines.map(l => ({skuId: l.skuId, qty: l.qty, uom: l.uom})),
      }),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    closeModal('newOrderModal');
    loadOrders();
  } catch(e){
    err.textContent = 'Network error';
  }
}
