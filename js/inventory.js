// =============================================================================
// INVENTORY + CASE BREAK
// =============================================================================

async function loadInventory(){
  const s  = document.getElementById('invSearch')?.value || '';
  const st = (_cbState['invStatusFilterWrap']?.selected?.value) || '';
  const cl = (_cbState['invClientFilterWrap']?.selected?.value) || '';
  let u = '/inventory?limit=200';
  if(st) u += `&status=${encodeURIComponent(st)}`;
  if(s)  u += `&skuCode=${encodeURIComponent('%' + s + '%')}`;
  if(cl) u += `&clientId=${encodeURIComponent(cl)}`;
  const d = await apiGet(u);
  if(!d) return;

  const b = document.getElementById('invBody');
  const rows = d.rows || d;
  if(!rows?.length){
    b.innerHTML = '<tr><td colspan="10" class="empty-state">No inventory</td></tr>';
    return;
  }

  b.innerHTML = rows.map(r => {
    const isCaseAvail = (r.sku_type === 'CASE' || r.uom === 'CASE')
                     && r.status === 'available'
                     && Number(r.quantity) > 0
                     && r.lp_id;
    const statusChip = r.status === 'available' ? 'chip-success'
                     : r.status === 'allocated' ? 'chip-active'
                     : r.status === 'damaged'   ? 'chip-danger'
                     : 'chip-warning';
    const lpBadge = r.lp_number
      ? `<span class="lp-badge ${r.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(r.lp_number)}</span>`
      : '—';
    // Case-break is an ops action — clients in portal mode never see this button.
    const breakBtn = (isCaseAvail && !(typeof isPortalMode === 'function' && isPortalMode()))
      ? `<button class="btn btn-ghost js-break-btn" style="padding:4px 10px;font-size:12px;"
                 data-payload='${esc(JSON.stringify({
                   lp_id: r.lp_id, id: r.id, lp_number: r.lp_number,
                   sku_code: r.sku_code, sku_name: r.sku_name || '',
                   sku_type: r.sku_type || r.uom, quantity: Number(r.quantity),
                   lot_number: r.lot_number || null, location_code: r.location_code || ''
                 }))}'>Break</button>`
      : '';
    return `
      <tr>
        <td style="font-weight:600;color:var(--blue);">${esc(r.sku_code || '')}</td>
        <td>${esc(r.sku_name || '')}</td>
        <td style="color:var(--text2);">${esc(r.client_name || '')}</td>
        <td><span class="chip chip-new">${esc(r.sku_type || r.uom || '')}</span></td>
        <td style="color:var(--blue);">${esc(r.lot_number || '—')}</td>
        <td>${esc(r.location_code || '—')}</td>
        <td>${lpBadge}</td>
        <td class="right" style="font-weight:600;">${esc(Number(r.quantity || 0).toLocaleString())}</td>
        <td><span class="chip ${statusChip}">${esc((r.status || '').toUpperCase())}</span></td>
        <td>${breakBtn}</td>
      </tr>`;
  }).join('');

  // Wire break buttons
  b.querySelectorAll('.js-break-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      try { openCaseBreakFor(JSON.parse(btn.dataset.payload)); }
      catch(e){ console.error('break payload parse error', e); }
    });
  });
}

// =============================================================================
// CASE BREAK
// =============================================================================
let cbSelectedLp = null;
let cbLocsList = [];

function openCaseBreakFor(r){
  showCaseBreakModal().then(() => {
    selectCBLp(r);
    document.getElementById('cbLpSearch').value = r.lp_number;
  });
}

async function showCaseBreakModal(){
  document.getElementById('caseBreakModal').style.display = 'flex';
  document.getElementById('caseBreakModal').style.zIndex  = '10000';
  cbSelectedLp = null;
  document.getElementById('cbLpSearch').value = '';
  document.getElementById('cbLpResults').style.display = 'none';
  document.getElementById('cbLpDetail').style.display  = 'none';
  document.getElementById('cbForm').style.display      = 'none';
  document.getElementById('cbSubmitBtn').style.display = 'none';
  document.getElementById('cbError').textContent = '';
  document.getElementById('cbSuccess').style.display = 'none';
  document.getElementById('cbQty').value = '1';
  document.getElementById('cbPreview').textContent = '';

  if(!cbLocsList.length){
    const l = await apiGet('/locations');
    if(l?.length) cbLocsList = l.map(x => ({id:x.id, code:x.code, zone:x.zone_name}));
  }
  initCombo('cbLocationWrap',
    cbLocsList.map(l => ({value:String(l.id), label:l.code, sub:l.zone || ''})),
    {placeholder:'Select location...'}
  );
}

const searchCBLps = debounce(async function(){
  const s = document.getElementById('cbLpSearch').value.trim();
  const div = document.getElementById('cbLpResults');
  if(s.length < 2){ div.style.display = 'none'; return; }

  const d = await apiGet(`/inventory?limit=200`);
  if(!d) return;
  const rows = (d.rows || d) || [];

  const seen = new Set();
  const matches = rows.filter(r => {
    if(!r.lp_number || !r.lp_number.toLowerCase().includes(s.toLowerCase())) return false;
    if((r.sku_type !== 'CASE' && r.uom !== 'CASE') || r.status !== 'available' || Number(r.quantity) <= 0) return false;
    if(seen.has(r.lp_number)) return false;
    seen.add(r.lp_number);
    return true;
  });

  if(!matches.length){
    div.innerHTML = `<div class="empty-state" style="padding:12px;">No case LPs found matching "${esc(s)}"</div>`;
    div.style.display = 'block';
    return;
  }

  div.innerHTML = matches.map(r => `
    <div class="js-cb-lp-row"
         data-payload='${esc(JSON.stringify({
           lp_id: r.lp_id || null, id: r.id, lp_number: r.lp_number,
           sku_code: r.sku_code, sku_name: r.sku_name || '',
           sku_type: r.sku_type || r.uom, quantity: Number(r.quantity),
           lot_number: r.lot_number || null, location_code: r.location_code || ''
         }))}'
         style="padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:12px;font-size:13px;">
      <span class="lp-badge lp-original">${esc(r.lp_number)}</span>
      <span style="font-weight:600;color:var(--blue);">${esc(r.sku_code)}</span>
      <span style="color:var(--text2);">${esc(r.sku_name || '')}</span>
      <span style="margin-left:auto;font-weight:600;">${esc(r.quantity)} cases</span>
      <span style="color:var(--text2);">${esc(r.location_code || '')}</span>
    </div>`).join('');
  div.style.display = 'block';

  div.querySelectorAll('.js-cb-lp-row').forEach(row => {
    row.addEventListener('mouseover', () => row.style.background = 'var(--hover)');
    row.addEventListener('mouseout',  () => row.style.background = '');
    row.addEventListener('click', () => {
      try { selectCBLp(JSON.parse(row.dataset.payload)); }
      catch(e){ console.error('cb lp parse error', e); }
    });
  });
}, 300);

function selectCBLp(r){
  cbSelectedLp = r;
  document.getElementById('cbLpResults').style.display = 'none';
  document.getElementById('cbLpSearch').value = r.lp_number;
  document.getElementById('cbLpDetail').style.display  = 'block';
  document.getElementById('cbForm').style.display      = 'block';
  document.getElementById('cbSubmitBtn').style.display = 'inline-flex';
  document.getElementById('cbSuccess').style.display = 'none';
  document.getElementById('cbError').textContent = '';

  document.getElementById('cbLpNum').textContent  = r.lp_number;
  document.getElementById('cbLpSku').textContent  = `${r.sku_code} — ${r.sku_name || ''}`;
  document.getElementById('cbLpQty').textContent  = `${r.quantity} cases on hand`;
  document.getElementById('cbLpLot').textContent  = r.lot_number || '—';
  document.getElementById('cbLpLoc').textContent  = r.location_code || '—';
  document.getElementById('cbLpType').textContent = r.sku_type || r.uom || 'CASE';
  document.getElementById('cbEachSku').textContent = '(resolved by API)';
  document.getElementById('cbConversion').textContent = 'Case pack qty will be determined by SKU configuration';

  document.getElementById('cbQty').max = r.quantity;
  document.getElementById('cbQty').value = 1;
  updateCBPreview();
}

function updateCBPreview(){
  if(!cbSelectedLp) return;
  const qty = parseInt(document.getElementById('cbQty').value) || 0;
  const max = Number(cbSelectedLp.quantity);
  const preview = document.getElementById('cbPreview');
  if(qty > max){
    preview.innerHTML = `<span style="color:var(--red);">Cannot break ${esc(qty)} — only ${esc(max)} cases on this LP</span>`;
    return;
  }
  if(qty <= 0){ preview.textContent = 'Enter at least 1 case'; return; }
  preview.innerHTML = `Will break <strong>${esc(qty)}</strong> case${qty > 1 ? 's' : ''} → eaches moved to target location. <strong>${esc(max - qty)}</strong> case${max - qty !== 1 ? 's' : ''} remaining on LP.`;
}

async function submitCaseBreak(){
  const err = document.getElementById('cbError');
  const suc = document.getElementById('cbSuccess');
  err.textContent = '';
  suc.style.display = 'none';

  if(!cbSelectedLp){ err.textContent = 'Select a license plate first'; return; }
  const qty   = parseInt(document.getElementById('cbQty').value) || 0;
  const locId = cbVal('cbLocationWrap');
  if(qty <= 0){ err.textContent = 'Enter at least 1 case'; return; }
  if(qty > Number(cbSelectedLp.quantity)){ err.textContent = `Only ${cbSelectedLp.quantity} cases on this LP`; return; }
  if(!locId){ err.textContent = 'Select a target location'; return; }

  document.getElementById('cbSubmitBtn').disabled = true;
  try {
    const lpId = cbSelectedLp.lp_id || cbSelectedLp.id;
    if(!lpId){ err.textContent = 'LP ID not available. Add i.lp_id to the inventory query SELECT.'; return; }
    const r = await fetch(`${API}/inventory/case-break`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({caseLpId: lpId, caseQuantity: qty, toLocationId: locId}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Case break failed'; return; }

    suc.style.display = 'block';
    const remaining = Number(cbSelectedLp.quantity) - qty;
    const childLp = d.childLpNumber || d.toLpNumber;
    document.getElementById('cbSuccessDetail').innerHTML =
      `Broke <strong>${esc(d.casesRemoved || qty)}</strong> case${qty > 1 ? 's' : ''} of <strong>${esc(d.caseSku || cbSelectedLp.sku_code)}</strong>` +
      (childLp ? ` → New child LP <span class="lp-badge lp-child">${esc(childLp)}</span>` : '') +
      (d.eachesCreated ? ` — <strong>${esc(d.eachesCreated)}</strong> EA of ${esc(d.eachSku || 'eaches')} created` : '') +
      (d.conversionFactor ? ` (${esc(d.conversionFactor)} per case)` : '') +
      ` — <strong>${esc(remaining)}</strong> case${remaining !== 1 ? 's' : ''} remaining on ${esc(d.fromLp || cbSelectedLp.lp_number)}` +
      (d.lotNumber ? ` · Lot: ${esc(d.lotNumber)}` : '');
    document.getElementById('cbForm').style.display = 'none';
    document.getElementById('cbSubmitBtn').style.display = 'none';
    setTimeout(() => loadInventory(), 500);
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    document.getElementById('cbSubmitBtn').disabled = false;
  }
}
