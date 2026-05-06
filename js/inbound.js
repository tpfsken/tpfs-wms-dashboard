// =============================================================================
// INBOUND / RECEIVING + NEW PO MODAL
// =============================================================================

let CPI = null;        // current PO id
let CPD = null;        // current PO data
let AL  = [];          // locations cache
let poLines = [];      // new-PO modal: pending lines

async function loadInbound(){
  const d = await apiGet('/inbound/receipts?limit=50');
  if(!d) return;
  const b = document.getElementById('inbBody');
  const rows = d.rows || d;
  if(!rows?.length){
    b.innerHTML = '<tr><td colspan="8" class="empty-state">No POs</td></tr>';
    return;
  }
  b.innerHTML = rows.map(r => {
    const stChip = r.status === 'received'  ? 'chip-success'
                 : r.status === 'receiving' ? 'chip-warning'
                 : 'chip-active';
    return `
      <tr class="js-po-row" data-po-id="${esc(r.id)}" style="cursor:pointer;">
        <td style="font-weight:600;color:var(--blue);">${esc(r.po_number || '')}</td>
        <td>${esc(r.client_name || '')}</td>
        <td>${esc(r.supplier_name || '')}</td>
        <td class="right">${esc(r.line_count || 0)}</td>
        <td class="right">${esc(r.total_expected || 0)}</td>
        <td class="right" style="color:var(--green);">${esc(r.total_received || 0)}</td>
        <td>${esc(r.expected_arrival ? new Date(r.expected_arrival).toLocaleDateString() : '—')}</td>
        <td><span class="chip ${stChip}">${esc((r.status || '').toUpperCase())}</span></td>
      </tr>`;
  }).join('');

  b.querySelectorAll('.js-po-row').forEach(row =>
    row.addEventListener('click', () => openPoDetail(row.dataset.poId))
  );
}

async function openPoDetail(id){
  CPI = id;
  document.getElementById('inbListView').style.display = 'none';
  document.getElementById('inbDetailView').style.display = 'block';
  document.getElementById('receiveError').textContent = '';
  document.getElementById('receiveSuccess').textContent = '';

  const d = await apiGet(`/inbound/receipts/${id}`);
  if(!d){ closePoDetail(); return; }
  CPD = d;

  document.getElementById('poDetailTitle').textContent = d.po_number || '';
  document.getElementById('poDetailSub').textContent   = `${d.client_name || ''} · ${d.supplier_name || ''}`;
  const se = document.getElementById('poDetailStatus');
  se.textContent = (d.status || '').toUpperCase();
  se.className = 'chip ' + (d.status === 'received' ? 'chip-success' : d.status === 'receiving' ? 'chip-warning' : 'chip-active');

  const fields = [
    {l:'PO #',     v:d.po_number},
    {l:'External', v:d.external_po || '—'},
    {l:'Supplier', v:d.supplier_name || '—'},
    {l:'Client',   v:d.client_name || '—'},
    {l:'Expected', v:d.expected_arrival ? new Date(d.expected_arrival).toLocaleDateString() : '—'},
    {l:'Created',  v:d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'},
  ];
  document.getElementById('poInfoGrid').innerHTML = fields.map(f =>
    `<div><div class="detail-label">${esc(f.l)}</div><div class="detail-value">${esc(f.v)}</div></div>`
  ).join('');

  document.getElementById('poLinesBody').innerHTML = d.lines?.map(ln => {
    const rem = (ln.expected_qty || 0) - (ln.received_qty || 0);
    return `
      <tr>
        <td>${esc(ln.line_number)}</td>
        <td style="font-weight:600;color:var(--blue);">${esc(ln.sku_code || '')}</td>
        <td>${esc(ln.sku_name || '')}</td>
        <td>${esc(ln.uom || '')}</td>
        <td style="color:var(--blue);">${esc(ln.lot_number || '—')}</td>
        <td class="right">${esc(ln.expected_qty || 0)}</td>
        <td class="right" style="color:var(--green);">${esc(ln.received_qty || 0)}</td>
        <td class="right" style="color:${rem > 0 ? 'var(--amber)' : 'var(--green)'};font-weight:600;">${esc(rem)}</td>
      </tr>`;
  }).join('') || '';

  const recv = !['received', 'closed', 'cancelled'].includes(d.status);
  document.getElementById('receivingFormSection').style.display = recv ? 'block' : 'none';
  document.getElementById('completePoBtn').style.display = d.status === 'receiving' ? 'inline-flex' : 'none';

  if(recv && d.lines){
    const ur = d.lines.filter(ln => (ln.expected_qty || 0) > (ln.received_qty || 0));
    const rl = document.getElementById('receiveLinesList');
    if(ur.length){
      rl.innerHTML = ur.map((ln, i) => {
        const rem = (ln.expected_qty || 0) - (ln.received_qty || 0);
        return `
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
              <span style="font-weight:700;color:var(--blue);font-size:14px;">${esc(ln.sku_code)}</span>
              <span style="color:var(--text2);">${esc(ln.sku_name || '')}</span>
              <span style="margin-left:auto;font-weight:600;color:var(--amber);">Remaining: ${esc(rem)}</span>
            </div>
            <div class="form-row form-row-4">
              <div class="form-group"><label class="form-label">Quantity</label><input type="number" class="form-input" id="rq${i}" value="${esc(rem)}" min="1" max="${esc(rem)}"></div>
              <div class="form-group"><label class="form-label">Lot</label><input type="text" class="form-input" id="rl${i}" value="${esc(ln.lot_number || '')}"></div>
              <div class="form-group"><label class="form-label">Location</label><div class="cb-wrap" id="rcw${i}"></div></div>
              <div class="form-group"><label class="form-label">Condition</label><div class="cb-wrap" id="rdw${i}"></div></div>
            </div>
            <input type="hidden" id="rp${i}" value="${esc(ln.id)}">
          </div>`;
      }).join('');
      loadLocs(ur.length);
    } else {
      rl.innerHTML = '<div class="empty-state">All received</div>';
      document.getElementById('completePoBtn').style.display = 'inline-flex';
    }
  }

  const hb = document.getElementById('recHistBody');
  const hg = document.getElementById('recHistBadge');
  if(d.receivingHistory?.length){
    hg.textContent = d.receivingHistory.length;
    hb.innerHTML = d.receivingHistory.map(h => {
      const lp = h.lp_number
        ? `<span class="lp-badge ${h.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(h.lp_number)}</span>`
        : '—';
      const condChip = h.condition === 'GOOD' ? 'chip-success' : 'chip-danger';
      return `
        <tr>
          <td style="color:var(--blue);">${esc(h.sku_code || '')}</td>
          <td>${esc(h.lot_number || '—')}</td>
          <td>${lp}</td>
          <td>${esc(h.lp_type || '')}</td>
          <td>${esc(h.location_code || '—')}</td>
          <td class="right" style="font-weight:600;">${esc(h.quantity || 0)}</td>
          <td><span class="chip ${condChip}">${esc(h.condition)}</span></td>
          <td>${esc(h.received_by_name || '—')}</td>
          <td style="font-size:12px;color:var(--muted);">${esc(h.received_at ? new Date(h.received_at).toLocaleString() : '—')}</td>
        </tr>`;
    }).join('');
  } else {
    hg.textContent = '0';
    hb.innerHTML = '<tr><td colspan="9" class="empty-state">None yet</td></tr>';
  }
}

async function loadLocs(n){
  if(!AL.length){
    const l = await apiGet('/locations');
    if(l?.length) AL = l.map(x => ({id:x.id, code:x.code, zone:x.zone_name}));
  }
  for(let i = 0; i < n; i++){
    const sw = document.getElementById(`rcw${i}`);
    if(sw) initCombo(`rcw${i}`,
      AL.map(l => ({value:String(l.id), label:l.code, sub:l.zone || ''})),
      {placeholder:'Select location...'}
    );
    const dw = document.getElementById(`rdw${i}`);
    if(dw) initCombo(`rdw${i}`, [
      {value:'GOOD',       label:'Good'},
      {value:'DAMAGED',    label:'Damaged'},
      {value:'QUARANTINE', label:'Quarantine'},
    ], {placeholder:'Condition...', value:'GOOD'});
  }
}

async function submitReceive(){
  if(!CPI || !CPD) return;
  const err = document.getElementById('receiveError');
  const suc = document.getElementById('receiveSuccess');
  err.textContent = ''; suc.textContent = '';
  const ur = (CPD.lines || []).filter(ln => (ln.expected_qty || 0) > (ln.received_qty || 0));
  const lines = [];
  for(let i = 0; i < ur.length; i++){
    const q = parseInt(document.getElementById(`rq${i}`)?.value) || 0;
    if(q <= 0) continue;
    lines.push({
      poLineId:   document.getElementById(`rp${i}`)?.value,
      quantity:   q,
      lotNumber:  document.getElementById(`rl${i}`)?.value || null,
      locationId: cbVal(`rcw${i}`),
      condition:  cbVal(`rdw${i}`) || 'GOOD',
    });
  }
  if(!lines.length){ err.textContent = 'Nothing to receive'; return; }
  document.getElementById('submitReceiveBtn').disabled = true;

  try {
    const r = await fetch(`${API}/inbound/receipts/${CPI}/lines`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({lines}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    suc.textContent = `Received ${d.linesProcessed} lines. LPs: ${(d.received || []).map(r => r.lpNumber).join(', ')}`;
    setTimeout(() => openPoDetail(CPI), 1000);
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    document.getElementById('submitReceiveBtn').disabled = false;
  }
}

async function completePo(){
  if(!CPI) return;
  const err = document.getElementById('receiveError');
  const suc = document.getElementById('receiveSuccess');
  err.textContent = ''; suc.textContent = '';
  try {
    const r = await fetch(`${API}/inbound/receipts/${CPI}/complete`, {
      method:'POST',
      headers:{'Authorization':`Bearer ${T}`},
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    suc.textContent = `PO ${d.status}. ${d.total_received}/${d.total_expected}`;
    setTimeout(() => openPoDetail(CPI), 1000);
  } catch(e){
    err.textContent = 'Network error';
  }
}

function closePoDetail(){
  document.getElementById('inbDetailView').style.display = 'none';
  document.getElementById('inbListView').style.display = 'block';
  CPI = null; CPD = null;
  loadInbound();
}

// =============================================================================
// NEW PO MODAL
// =============================================================================

async function showNewPoModal(){
  await loadCC();
  const m = document.getElementById('newPoModal');
  m.style.display = 'flex'; m.style.zIndex = '10000';

  initCombo('npClientWrap',
    clientsCache.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`})),
    {placeholder:'Select client...', onChange:(v) => { if(v) onPoClientChange(v); }}
  );
  initCombo('npSupplierWrap', [],
    {placeholder:'Select or type supplier...', allowCustom:true, onChange:(v) => {}}
  );
  poLines = [];
  renderPL();
  document.getElementById('npError').textContent = '';
  document.getElementById('npPoNum').value =
    'PO-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 900) + 100);
}

async function onPoClientChange(cid){
  if(!cid) cid = cbVal('npClientWrap');
  if(!cid) return;
  const sups = await apiGet(`/suppliers?clientId=${encodeURIComponent(cid)}`);
  initCombo('npSupplierWrap',
    (sups || []).map(s => ({value:s, label:s})),
    {placeholder:'Select or type supplier...', allowCustom:true, onChange:(v) => {}}
  );
  poLines = [];
  renderPL();
}

async function searchPoSkus(){
  const cid = cbVal('npClientWrap');
  const s   = document.getElementById('npSkuSearch').value;
  if(!cid){ document.getElementById('npSkuResults').style.display = 'none'; return; }
  const d = await apiGet(`/skus?clientId=${encodeURIComponent(cid)}&search=${encodeURIComponent(s)}`);
  const div = document.getElementById('npSkuResults');
  const list = Array.isArray(d) ? d : (d?.rows || []);
  if(!list.length){
    div.innerHTML = '<div class="empty-state" style="padding:12px;">No SKUs</div>';
    div.style.display = 'block';
    return;
  }
  div.innerHTML = list.map(x => `
    <div class="js-pl-add"
         data-id="${esc(x.id)}"
         data-code="${esc(x.sku_code)}"
         data-name="${esc(x.name || '')}"
         data-uom="${esc(x.uom)}"
         style="padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:12px;font-size:13px;">
      <span style="font-weight:600;color:var(--blue);">${esc(x.sku_code)}</span>
      <span style="color:var(--text2);">${esc(x.name || '')}</span>
    </div>`).join('');
  div.style.display = 'block';

  div.querySelectorAll('.js-pl-add').forEach(row =>
    row.addEventListener('click', () =>
      addPL(row.dataset.id, row.dataset.code, row.dataset.name, row.dataset.uom)
    )
  );
}

function addPL(id, code, name, uom){
  if(poLines.find(l => l.skuId === id)) return;
  poLines.push({skuId:id, code, name, uom, qty:1, lot:'', expiry:''});
  renderPL();
  document.getElementById('npSkuSearch').value = '';
  document.getElementById('npSkuResults').style.display = 'none';
}

function renderPL(){
  const b = document.getElementById('npLinesBody');
  const e = document.getElementById('npLinesEmpty');
  if(!poLines.length){
    b.innerHTML = '';
    e.style.display = 'block';
    return;
  }
  e.style.display = 'none';

  b.innerHTML = poLines.map((l, i) => `
    <tr>
      <td style="font-weight:600;color:var(--blue);">${esc(l.code)}</td>
      <td>${esc(l.name)}</td>
      <td>${esc(l.uom)}</td>
      <td><input type="number" class="form-input js-pl-qty" data-i="${i}" value="${esc(l.qty)}" min="1" style="width:80px;padding:8px;"></td>
      <td><input type="text" class="form-input js-pl-lot" data-i="${i}" value="${esc(l.lot)}" style="width:120px;padding:8px;" placeholder="Lot #"></td>
      <td><input type="date" class="form-input js-pl-expiry" data-i="${i}" value="${esc(l.expiry)}" style="width:130px;padding:8px;"></td>
      <td><button class="btn btn-ghost js-pl-remove" data-i="${i}" style="padding:4px 8px;color:var(--red);">✕</button></td>
    </tr>`).join('');

  b.querySelectorAll('.js-pl-qty').forEach(inp =>
    inp.addEventListener('change', () => poLines[parseInt(inp.dataset.i)].qty = parseInt(inp.value) || 1));
  b.querySelectorAll('.js-pl-lot').forEach(inp =>
    inp.addEventListener('change', () => poLines[parseInt(inp.dataset.i)].lot = inp.value));
  b.querySelectorAll('.js-pl-expiry').forEach(inp =>
    inp.addEventListener('change', () => poLines[parseInt(inp.dataset.i)].expiry = inp.value));
  b.querySelectorAll('.js-pl-remove').forEach(btn =>
    btn.addEventListener('click', () => { poLines.splice(parseInt(btn.dataset.i), 1); renderPL(); }));
}

async function submitNewPo(){
  const err = document.getElementById('npError');
  err.textContent = '';
  const cid = cbVal('npClientWrap');
  const num = document.getElementById('npPoNum').value.trim();
  if(!cid){ err.textContent = 'Select a client'; return; }
  if(!num){ err.textContent = 'Enter PO number'; return; }
  if(!poLines.length){ err.textContent = 'Add at least one line'; return; }
  const sup = cbVal('npSupplierWrap') || '';

  try {
    const r = await fetch(`${API}/inbound/receipts`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        clientId: cid,
        poNumber: num,
        supplierName: sup || null,
        externalPo: document.getElementById('npExtPo').value || null,
        expectedArrival: document.getElementById('npArrival').value || null,
        notes: document.getElementById('npNotes').value || null,
        lines: poLines.map(l => ({
          skuId: l.skuId, qty: l.qty, uom: l.uom,
          lotNumber: l.lot || null, expiryDate: l.expiry || null,
        })),
      }),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    closeModal('newPoModal');
    loadInbound();
  } catch(e){
    err.textContent = 'Network error';
  }
}
