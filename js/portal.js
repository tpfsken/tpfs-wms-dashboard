// =============================================================================
// PORTAL — 3PL client portal mode (Phase 3).
// =============================================================================
// Activated by bootPortal() in app.js when the JWT carries userType='client'.
// The portal reuses the existing inventory / orders / reports pages — the API
// already locks those reads to req.user.clientId via scopeClient — and adds
// two portal-only pages:
//   - page-portalHome       : a 4-card landing hub
//   - page-portalNewOrder   : simplified manual order entry
//
// Sidebar layout in portal mode is driven by the body.portal-mode class
// (CSS in app.css): .nav-ops-only is hidden, .nav-portal-only is shown,
// and .ops-only buttons inside pages (Case Break, ops "+ New Order") are
// hidden too.
// =============================================================================

let _portalNewOrderLines = [];   // pending lines in the portal new-order form
let _portalShipToCache   = null; // prior ship-to addresses for the dropdown

function isPortalMode(){
  return typeof U !== 'undefined' && U && U.userType === 'client';
}

// Called from app.js's DOMContentLoaded path when U.userType === 'client'.
// Hides ops nav, primes the page-level filter combos that other modules
// reference, and lands on the portal home.
function bootPortal(){
  document.body.classList.add('portal-mode');

  // Client name from JWT (login query LEFT JOINs clients). Falls back to
  // clientCode then a generic "Customer" so the UI never shows "client".
  const clientLabel = (U && (U.clientName || U.clientCode)) || 'Customer';

  if(U){
    document.getElementById('userAvatar').textContent =
      (U.fullName || U.email || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('userName').textContent = U.fullName || U.email;
    const role = document.querySelector('.topbar-user-info .role');
    if(role) role.textContent = clientLabel;
  }

  // Replace the generic "Customer Portal" page-title with the client name so
  // the user sees their company branding when they land on the home.
  const portalTitle = document.querySelector('#page-portalHome .page-title');
  if(portalTitle) portalTitle.textContent = clientLabel;

  // Top-of-page banner — visible on every portal page so the client always
  // sees their company name front and center.
  const bannerName = document.getElementById('portalBannerName');
  const bannerSub  = document.getElementById('portalBannerSub');
  if(bannerName) bannerName.textContent = clientLabel;
  if(bannerSub && U && U.fullName) bannerSub.textContent = `Customer Portal · ${U.fullName}`;

  // Stub the page-level filter combos that inventory.js / orders.js read on
  // every load. The combos themselves are hidden in portal mode (.ops-only on
  // their wrappers in index.html), but the JS still references _cbState[id].
  initCombo('invStatusFilterWrap', [
    {value:'',label:'All statuses'},
    {value:'available',label:'Available'},
    {value:'allocated',label:'Allocated'},
    {value:'damaged',label:'Damaged'},
  ], {placeholder:'All statuses', onChange:() => loadInventory()});

  initCombo('ordStatusFilterWrap', [
    {value:'',label:'All statuses'},
    {value:'NEW',label:'New'},{value:'ALLOCATED',label:'Allocated'},
    {value:'PICKING',label:'Picking'},{value:'PICKED',label:'Picked'},
    {value:'PACKING',label:'Packing'},{value:'PACKED',label:'Packed'},
    {value:'SHIPPED',label:'Shipped'},{value:'CANCELLED',label:'Cancelled'},
  ], {placeholder:'All statuses', onChange:() => loadOrders()});

  // Pre-init the Billing client-filter combo so loadBilling() skips its
  // first-time init branch — that branch calls loadCC() -> GET /clients,
  // which is requireOps and would 403 a portal user. The wrap itself is
  // .ops-only in index.html, so the stub combo is never shown.
  initCombo('billClientFilterWrap', [{value:'', label:'My Account'}],
    {placeholder:'My Account'});

  // Clock + sign-out wiring already attached in app.js DOMContentLoaded —
  // those run regardless of mode. Just navigate to the portal home so the
  // active nav-item / active page line up with what the user sees.
  navigateTo('portalHome');
}

// =============================================================================
// PORTAL HOME — card grid hub
// =============================================================================

function loadPortalHome(){
  const cards = [
    {id:'portalNewOrder', icon:'➕', title:'Place an Order',
     desc:'Manual outbound order — choose SKUs, quantities, and a ship-to.',
     accent:'var(--blue)'},
    {id:'inventory',      icon:'📦', title:'My Inventory',
     desc:'On-hand SKUs, lots, and license plates at the warehouse.',
     accent:'var(--green)'},
    {id:'orders',         icon:'📋', title:'My Orders',
     desc:'Status of every order you placed — open, picking, shipped.',
     accent:'var(--amber)'},
    {id:'billing',        icon:'💵', title:'My Billing',
     desc:'Per-period charges and the rates set up for your account.',
     accent:'var(--green)'},
    {id:'reports',        icon:'🔎', title:'Reports',
     desc:'Item history and full LP traceability for compliance / recall.',
     accent:'var(--purple)'},
  ];

  const grid = document.getElementById('portalHomeGrid');
  grid.innerHTML = cards.map(c => `
    <div class="card js-portal-card" data-target="${esc(c.id)}"
         style="padding:24px;cursor:pointer;transition:border-color .15s, transform .15s;">
      <div style="font-size:34px;line-height:1;margin-bottom:12px;">${esc(c.icon)}</div>
      <div style="font-size:17px;font-weight:700;color:${esc(c.accent)};margin-bottom:6px;">${esc(c.title)}</div>
      <div style="font-size:13px;color:var(--text2);line-height:1.5;">${esc(c.desc)}</div>
    </div>`).join('');

  grid.querySelectorAll('.js-portal-card').forEach(card => {
    card.addEventListener('mouseover', () => {
      card.style.borderColor = 'var(--blue)';
      card.style.transform   = 'translateY(-1px)';
    });
    card.addEventListener('mouseout', () => {
      card.style.borderColor = '';
      card.style.transform   = '';
    });
    card.addEventListener('click', () => navigateTo(card.dataset.target));
  });

  // Personalise the greeting
  const hi = document.getElementById('portalHomeGreeting');
  if(hi && U) hi.textContent = `Welcome, ${U.fullName || U.email || ''}`;
}

// =============================================================================
// PORTAL NEW ORDER — simplified manual order entry
// =============================================================================
// Body sent to POST /orders. clientId / channel / orderNumber are auto-filled
// by the API for client users (see src/routes.js POST /orders handler).

async function loadPortalNewOrder(){
  // Reset form
  _portalNewOrderLines = [];
  ['pnoCustName','pnoCustEmail','pnoAddr1','pnoAddr2','pnoCity','pnoState',
   'pnoPostal','pnoShipDate','pnoSkuSearch'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.value = '';
  });
  document.getElementById('pnoCountry').value = 'US';
  document.getElementById('pnoSkuResults').style.display = 'none';
  document.getElementById('pnoError').textContent = '';
  document.getElementById('pnoSuccess').textContent = '';
  renderPortalNewOrderLines();

  // Prior ship-to addresses (if any) — populated as a dropdown for quick reuse.
  const addrs = await apiGet('/ship-to-addresses');
  _portalShipToCache = Array.isArray(addrs) ? addrs : [];
  initCombo('pnoPriorAddrWrap',
    [{value:'', label:'— Use saved ship-to —'}].concat(
      _portalShipToCache.map((a, i) => ({
        value: String(i),
        label: `${a.ship_to_name || a.customer_name || ''} — ${[a.ship_to_city, a.ship_to_state].filter(Boolean).join(', ')}`,
      }))
    ),
    {
      placeholder: '— Use saved ship-to —',
      onChange: (v) => {
        if(v === '' || v == null) return;
        const a = _portalShipToCache[parseInt(v)];
        if(!a) return;
        document.getElementById('pnoCustName').value  = a.ship_to_name || a.customer_name || '';
        document.getElementById('pnoCustEmail').value = a.customer_email || '';
        document.getElementById('pnoAddr1').value     = a.ship_to_line1 || '';
        document.getElementById('pnoAddr2').value     = a.ship_to_line2 || '';
        document.getElementById('pnoCity').value      = a.ship_to_city || '';
        document.getElementById('pnoState').value     = a.ship_to_state || '';
        document.getElementById('pnoPostal').value    = a.ship_to_postal || '';
        document.getElementById('pnoCountry').value   = a.ship_to_country || 'US';
      },
    }
  );

  document.getElementById('pnoCustName').focus?.();
}

// SKU search — debounced. /skus is auto-scoped to req.user.clientId via
// scopeClient on the API for portal users, so we don't pass clientId here.
const searchPortalSkus = debounce(async function(){
  const s = document.getElementById('pnoSkuSearch').value.trim();
  const div = document.getElementById('pnoSkuResults');
  let url = '/skus';
  if(s) url += `?search=${encodeURIComponent(s)}`;
  const list = await apiGet(url);
  if(!list){ div.style.display = 'none'; return; }
  const rows = Array.isArray(list) ? list : (list.rows || list.data || []);
  if(!rows.length){
    div.innerHTML = `<div class="empty-state" style="padding:12px;">No SKUs found${s ? ` matching "${esc(s)}"` : ''}</div>`;
    div.style.display = 'block';
    return;
  }
  div.innerHTML = rows.map(r => `
    <div style="border-bottom:1px solid var(--border);">
      <div class="js-pno-sku-row"
           data-payload='${esc(JSON.stringify({
             skuId: r.id, sku_code: r.sku_code, sku_name: r.name || '',
             uom: r.uom || 'EA', sku_type: r.sku_type || '',
             qty_available: Number(r.qty_available || 0),
           }))}'
           style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:12px;font-size:13px;">
        <span style="font-weight:600;color:var(--blue);min-width:120px;">${esc(r.sku_code)}</span>
        <span style="color:var(--text2);flex:1;">${esc(r.name || '')}</span>
        <span style="color:var(--text2);font-size:11px;">${esc(r.uom || '')}</span>
        <span style="font-weight:600;color:var(--green);min-width:90px;text-align:right;">
          ${esc(Number(r.qty_available || 0).toLocaleString())} avail
        </span>
        <span class="js-pno-sku-arrow" style="color:var(--muted);font-size:11px;">▶</span>
      </div>
      <div class="sku-lots js-pno-sku-lots" id="pnoLots_${esc(r.id)}" style="display:none;"></div>
    </div>`).join('');
  div.style.display = 'block';

  div.querySelectorAll('.js-pno-sku-row').forEach(row => {
    row.addEventListener('mouseover', () => row.style.background = 'var(--hover)');
    row.addEventListener('mouseout',  () => row.style.background = '');
    row.addEventListener('click', () => {
      try { expandPortalSkuLots(row, JSON.parse(row.dataset.payload)); }
      catch(e){ console.error('pno sku parse', e); }
    });
  });
}, 250);

// Click a SKU result -> fetch its available lots and let the customer pick one.
async function expandPortalSkuLots(skuRow, sku){
  const lotsDiv = document.getElementById('pnoLots_' + sku.skuId);
  if(!lotsDiv) return;

  const arrow = skuRow.querySelector('.js-pno-sku-arrow');

  // Toggle close
  if(lotsDiv.style.display === 'block'){
    lotsDiv.style.display = 'none';
    if(arrow) arrow.textContent = '▶';
    return;
  }

  if(arrow) arrow.textContent = '▼';
  lotsDiv.style.display = 'block';
  lotsDiv.innerHTML = '<div style="padding:8px 16px 8px 32px;color:var(--muted);font-size:12px;">Loading lots…</div>';

  // /inventory is auto-scoped to the user's client_id by scopeClient on the API.
  const d = await apiGet(`/inventory?limit=200&status=available&skuCode=${encodeURIComponent('%' + sku.sku_code + '%')}`);
  // Filter by sku_code (more reliable than sku_id which can vary by representation)
  // and require positive qty.
  const allRows = (d?.rows || d || []).filter(r =>
    r.sku_code === sku.sku_code && Number(r.quantity) > 0
  );

  if(!allRows.length){
    lotsDiv.innerHTML = '<div style="padding:8px 16px 8px 32px;color:var(--muted);font-size:12px;">No available inventory.</div>';
    return;
  }

  const header = `
    <div style="padding:6px 16px 6px 32px;display:grid;grid-template-columns:140px 110px 130px 60px 80px;gap:8px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid var(--border);background:rgba(0,0,0,.15);">
      <span>Lot</span><span>Expiry</span><span>Location</span><span>Qty</span><span></span>
    </div>`;

  const body = allRows.map(r => {
    const expiringSoon = r.expiry_date && new Date(r.expiry_date) < new Date(Date.now() + 30 * 864e5);
    return `
      <div class="js-pno-lot-row"
           data-payload='${esc(JSON.stringify({
             skuId:    sku.skuId,
             sku_code: sku.sku_code,
             sku_name: sku.sku_name,
             uom:      sku.uom,
             sku_type: sku.sku_type,
             lot_id:   r.lot_id || null,
             lot_number: r.lot_number || null,
             expiry_date: r.expiry_date || null,
             location_code: r.location_code || null,
             qty_available: Number(r.quantity || 0),
           }))}'
           style="padding:8px 16px 8px 32px;border-top:1px solid var(--border);display:grid;grid-template-columns:140px 110px 130px 60px 80px;align-items:center;gap:8px;font-size:12px;cursor:pointer;transition:background .1s;">
        <span style="color:var(--blue);font-weight:600;">${esc(r.lot_number || 'No lot')}</span>
        <span style="color:${expiringSoon ? 'var(--red)' : 'var(--text2)'};">${esc(r.expiry_date ? new Date(r.expiry_date).toLocaleDateString() : '—')}</span>
        <span style="color:var(--muted);">${esc(r.location_code || '—')}</span>
        <span style="font-weight:600;color:var(--green);">${esc(r.quantity)}</span>
        <span style="color:var(--blue);font-size:11px;font-weight:600;">+ Add</span>
      </div>`;
  }).join('');

  lotsDiv.innerHTML = header + body;

  lotsDiv.querySelectorAll('.js-pno-lot-row').forEach(row => {
    row.addEventListener('mouseover', () => row.style.background = 'var(--hover)');
    row.addEventListener('mouseout',  () => row.style.background = '');
    row.addEventListener('click', e => {
      e.stopPropagation();
      try { addPortalNewOrderLine(JSON.parse(row.dataset.payload)); }
      catch(err){ console.error('pno lot parse', err); }
    });
  });
}

function addPortalNewOrderLine(p){
  // De-dupe by (skuId, lot_id) so the same SKU at different lots can be
  // ordered as separate lines.
  const key = p.skuId + '_' + (p.lot_id || 'nolot');
  const exists = _portalNewOrderLines.find(l => l._key === key);
  if(exists){
    exists.qty = (Number(exists.qty) || 0) + 1;
  } else {
    _portalNewOrderLines.push({
      _key: key,
      skuId:         p.skuId,
      sku_code:      p.sku_code,
      sku_name:      p.sku_name,
      uom:           p.uom,
      sku_type:      p.sku_type || '',
      lot_id:        p.lot_id || null,
      lot_number:    p.lot_number || null,
      expiry_date:   p.expiry_date || null,
      location_code: p.location_code || null,
      qty_available: p.qty_available,
      qty:           1,
    });
  }
  document.getElementById('pnoSkuSearch').value = '';
  document.getElementById('pnoSkuResults').style.display = 'none';
  renderPortalNewOrderLines();
}

function renderPortalNewOrderLines(){
  const body  = document.getElementById('pnoLinesBody');
  const empty = document.getElementById('pnoLinesEmpty');
  const count = document.getElementById('pnoLinesCount');

  // Header line counter
  if(count){
    const n = _portalNewOrderLines.length;
    const totalQty = _portalNewOrderLines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    count.textContent = n ? `· ${n} ${n === 1 ? 'line' : 'lines'} · ${totalQty} units` : '';
  }

  if(!_portalNewOrderLines.length){
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  body.innerHTML = _portalNewOrderLines.map((l, i) => {
    const expiringSoon = l.expiry_date && new Date(l.expiry_date) < new Date(Date.now() + 30 * 864e5);
    return `
    <tr>
      <td style="font-weight:600;color:var(--blue);">${esc(l.sku_code)}</td>
      <td>${esc(l.sku_name)}</td>
      <td style="color:var(--blue);font-size:12px;">${esc(l.lot_number || '—')}</td>
      <td style="font-size:12px;color:${expiringSoon ? 'var(--red)' : 'var(--text2)'};">${esc(l.expiry_date ? new Date(l.expiry_date).toLocaleDateString() : '—')}</td>
      <td>${esc(l.uom)}</td>
      <td class="right" style="color:var(--text2);font-size:12px;">
        ${esc(Number(l.qty_available || 0).toLocaleString())}
      </td>
      <td>
        <input type="number" min="1" step="1" class="form-input js-pno-qty"
               data-idx="${esc(i)}" value="${esc(l.qty)}"
               style="width:90px;padding:6px 8px;font-size:13px;">
      </td>
      <td>
        <button class="btn btn-ghost js-pno-rm" data-idx="${esc(i)}"
                style="padding:4px 10px;font-size:12px;color:var(--red);">✕</button>
      </td>
    </tr>`;
  }).join('');
  body.querySelectorAll('.js-pno-qty').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx);
      _portalNewOrderLines[idx].qty = parseInt(e.target.value) || 0;
    });
  });
  body.querySelectorAll('.js-pno-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      _portalNewOrderLines.splice(parseInt(btn.dataset.idx), 1);
      renderPortalNewOrderLines();
    });
  });
}

async function submitPortalNewOrder(){
  const err = document.getElementById('pnoError');
  const suc = document.getElementById('pnoSuccess');
  err.textContent = '';
  suc.textContent = '';

  const custName = document.getElementById('pnoCustName').value.trim();
  const addr1    = document.getElementById('pnoAddr1').value.trim();
  const city     = document.getElementById('pnoCity').value.trim();
  const state    = document.getElementById('pnoState').value.trim();
  const postal   = document.getElementById('pnoPostal').value.trim();
  const country  = document.getElementById('pnoCountry').value.trim() || 'US';

  if(!custName){ err.textContent = 'Customer / Ship-to name is required'; return; }
  if(!addr1)   { err.textContent = 'Address line 1 is required'; return; }
  if(!city || !state || !postal){
    err.textContent = 'City, State, and Postal Code are required';
    return;
  }
  if(!_portalNewOrderLines.length){ err.textContent = 'Add at least one SKU'; return; }
  for(const l of _portalNewOrderLines){
    if(!l.qty || l.qty <= 0){
      err.textContent = `Quantity must be > 0 for ${l.sku_code}`;
      return;
    }
  }

  const body = {
    // clientId / channel='PORTAL' / orderNumber are auto-filled by the API
    // for client users (see POST /orders in src/routes.js). We deliberately
    // do not send them — the JWT is the source of truth.
    customerName:     custName,
    customerEmail:    document.getElementById('pnoCustEmail').value.trim() || null,
    requiredShipDate: document.getElementById('pnoShipDate').value || null,
    shipTo: {
      name:    custName,
      line1:   addr1,
      line2:   document.getElementById('pnoAddr2').value.trim() || null,
      city, state, postal, country,
    },
    lines: _portalNewOrderLines.map(l => ({
      skuId:      l.skuId,
      qty:        Number(l.qty),
      uom:        l.uom || 'EACH',
      // Customer's preferred lot — passed through so ops can honor it during
      // allocation. Backend currently logs these in order notes; in a future
      // pass we'll auto-allocate from the requested lot.
      lotId:      l.lot_id || null,
      lotNumber:  l.lot_number || null,
    })),
  };

  // Build a customer-readable summary of lot preferences so ops sees it on
  // the order even before we add a dedicated requested_lot_id column.
  const lotSummary = _portalNewOrderLines
    .filter(l => l.lot_number)
    .map(l => `${l.sku_code} → ${l.lot_number}${l.expiry_date ? ` (exp ${new Date(l.expiry_date).toLocaleDateString()})` : ''}`)
    .join('; ');
  if(lotSummary) body.notes = `Customer requested lots: ${lotSummary}`;

  const submitBtn = document.getElementById('pnoSubmitBtn');
  submitBtn.disabled = true;
  try {
    const r = await fetch(`${API}/orders`, {
      method:  'POST',
      headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body:    JSON.stringify(body),
    });
    const d = await r.json();
    if(!r.ok){
      err.textContent = d.error || 'Order create failed';
      return;
    }
    suc.textContent = `Order ${d.order_number} created. Our ops team will allocate and ship it.`;
    _portalNewOrderLines = [];
    renderPortalNewOrderLines();
    setTimeout(() => navigateTo('orders'), 1500);
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    submitBtn.disabled = false;
  }
}
