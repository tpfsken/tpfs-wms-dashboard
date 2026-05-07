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

// =============================================================================
// NEW / EDIT ITEM (SKU) MODAL — same modal handles both create and edit.
// =============================================================================

let _editingItemId = null;   // null = create, string = edit
let _itemClientHazmatMap = {}; // {clientId -> hazmat_enabled} for prompting

const ITEM_UOMS = [
  {value:'EA',  label:'EA — Each'},
  {value:'CS',  label:'CS — Case'},
  {value:'PL',  label:'PL — Pallet'},
  {value:'LB',  label:'LB — Pound'},
  {value:'KG',  label:'KG — Kilogram'},
  {value:'OZ',  label:'OZ — Ounce'},
  {value:'GAL', label:'GAL — Gallon'},
];

const ITEM_TYPES = [
  {value:'STANDARD', label:'Standard'},
  {value:'EACH',     label:'Each (case-break child)'},
  {value:'CASE',     label:'Case'},
  {value:'KIT',      label:'Kit'},
  {value:'BUNDLE',   label:'Bundle'},
];

const PACKING_GROUPS = [
  {value:'',    label:'— None —'},
  {value:'I',   label:'I (high danger)'},
  {value:'II',  label:'II (medium danger)'},
  {value:'III', label:'III (low danger)'},
];

async function openItemFormModal(skuId){
  _editingItemId = skuId || null;
  document.getElementById('itemFormTitle').textContent     = skuId ? 'Edit Item' : 'New Item';
  document.getElementById('itemFormSubmitBtn').textContent = skuId ? 'Save Changes' : 'Create Item';
  document.getElementById('itemFormError').textContent     = '';

  // Make sure clientsCache is populated for the dropdown
  await loadCC();

  // Build clientId -> hazmat_enabled map so onChange we can prompt
  _itemClientHazmatMap = {};
  for(const c of clientsCache){
    _itemClientHazmatMap[c.id] = !!c.hazmat_enabled;
  }

  // Init combos
  initCombo('itemClientWrap',
    [{value:'', label:'— Pick a client —'}].concat(
      clientsCache.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`}))
    ),
    {placeholder:'— Pick a client —', onChange: () => onItemClientChange()}
  );
  initCombo('itemUomWrap',           ITEM_UOMS,        {placeholder:'EA', value:'EA'});
  initCombo('itemTypeWrap',          ITEM_TYPES,       {placeholder:'Standard', value:'STANDARD'});
  initCombo('itemPackingGroupWrap',  PACKING_GROUPS,   {placeholder:'— None —'});

  // Wire hazmat checkbox to reveal block (idempotent)
  const haz = document.getElementById('itemHazmat');
  if(!haz._wired){
    haz._wired = true;
    haz.addEventListener('change', () => {
      document.getElementById('itemHazmatBlock').style.display = haz.checked ? 'block' : 'none';
    });
  }

  if(skuId){
    // Edit mode — fetch and populate
    const sku = await apiGet(`/skus/${skuId}`);
    if(!sku){ document.getElementById('itemFormError').textContent = 'Could not load item'; return; }
    cbSet('itemClientWrap', String(sku.client_id),
      (clientsCache.find(c => c.id === sku.client_id)?.code || '') + ' — ' +
      (clientsCache.find(c => c.id === sku.client_id)?.name || ''));
    document.getElementById('itemCode').value         = sku.sku_code || '';
    document.getElementById('itemUpc').value          = sku.upc || '';
    document.getElementById('itemName').value         = sku.name || '';
    document.getElementById('itemDescription').value  = sku.description || '';
    cbSet('itemUomWrap',  sku.uom || 'EA');
    cbSet('itemTypeWrap', sku.sku_type || 'STANDARD');
    document.getElementById('itemUnitsPerCase').value = sku.units_per_case ?? '';
    document.getElementById('itemLength').value       = sku.length_in ?? '';
    document.getElementById('itemWidth').value        = sku.width_in ?? '';
    document.getElementById('itemHeight').value       = sku.height_in ?? '';
    document.getElementById('itemWeight').value       = sku.weight_lbs ?? '';
    document.getElementById('itemUnitCost').value     = sku.unit_cost ?? '';
    document.getElementById('itemUnitPrice').value    = sku.unit_price ?? '';
    document.getElementById('itemLotTracked').checked    = !!sku.is_lot_tracked;
    document.getElementById('itemExpiryTracked').checked = !!sku.is_expiry_tracked;
    document.getElementById('itemHazmat').checked        = !!sku.is_hazmat;
    document.getElementById('itemUnNumber').value             = sku.un_number || '';
    document.getElementById('itemHazardClass').value          = sku.hazard_class || '';
    document.getElementById('itemProperShippingName').value   = sku.proper_shipping_name || '';
    cbSet('itemPackingGroupWrap', sku.packing_group || '');
    document.getElementById('itemGroundOnly').checked = !!sku.is_ground_only;
    document.getElementById('itemLimitedQty').checked = !!sku.is_limited_qty;
    document.getElementById('itemHazmatNotes').value  = sku.hazmat_notes || '';
    document.getElementById('itemHazmatBlock').style.display = sku.is_hazmat ? 'block' : 'none';
  } else {
    // Create mode — reset form
    [
      'itemCode','itemUpc','itemName','itemDescription','itemUnitsPerCase',
      'itemLength','itemWidth','itemHeight','itemWeight','itemUnitCost','itemUnitPrice',
      'itemUnNumber','itemHazardClass','itemProperShippingName','itemHazmatNotes',
    ].forEach(id => { document.getElementById(id).value = ''; });
    ['itemLotTracked','itemExpiryTracked','itemHazmat','itemGroundOnly','itemLimitedQty']
      .forEach(id => { document.getElementById(id).checked = false; });
    document.getElementById('itemHazmatBlock').style.display = 'none';
    cbReset('itemClientWrap'); cbSet('itemUomWrap','EA'); cbSet('itemTypeWrap','STANDARD');
    cbReset('itemPackingGroupWrap');
  }

  document.getElementById('itemHazmatHint').style.display = 'none';
  document.getElementById('itemFormModal').style.display  = 'flex';
}

// When a client is picked, surface a hint if that client has hazmat
// enabled at the company level — nudges ops to flip the per-item
// hazmat checkbox if relevant.
function onItemClientChange(){
  const cid  = cbVal('itemClientWrap');
  const hint = document.getElementById('itemHazmatHint');
  hint.style.display = (cid && _itemClientHazmatMap[cid]) ? 'block' : 'none';
}

async function submitItemForm(){
  const err = document.getElementById('itemFormError');
  err.textContent = '';

  const numOrNull = (id) => {
    const v = document.getElementById(id).value.trim();
    return v === '' ? null : Number(v);
  };

  const body = {
    clientId:           cbVal('itemClientWrap'),
    skuCode:            document.getElementById('itemCode').value.trim().toUpperCase(),
    upc:                document.getElementById('itemUpc').value.trim() || null,
    name:               document.getElementById('itemName').value.trim(),
    description:        document.getElementById('itemDescription').value.trim() || null,
    uom:                cbVal('itemUomWrap') || 'EA',
    skuType:            cbVal('itemTypeWrap') || 'STANDARD',
    unitsPerCase:       numOrNull('itemUnitsPerCase'),
    lengthIn:           numOrNull('itemLength'),
    widthIn:            numOrNull('itemWidth'),
    heightIn:           numOrNull('itemHeight'),
    weightLbs:          numOrNull('itemWeight'),
    unitCost:           numOrNull('itemUnitCost'),
    unitPrice:          numOrNull('itemUnitPrice'),
    isLotTracked:       document.getElementById('itemLotTracked').checked,
    isExpiryTracked:    document.getElementById('itemExpiryTracked').checked,
    isHazmat:           document.getElementById('itemHazmat').checked,
  };

  if(!body.clientId){ err.textContent = 'Client is required'; return; }
  if(!body.skuCode) { err.textContent = 'SKU code is required'; return; }
  if(!body.name)    { err.textContent = 'Name is required'; return; }

  if(body.isHazmat){
    body.unNumber           = document.getElementById('itemUnNumber').value.trim();
    body.hazardClass        = document.getElementById('itemHazardClass').value.trim();
    body.properShippingName = document.getElementById('itemProperShippingName').value.trim() || null;
    body.packingGroup       = cbVal('itemPackingGroupWrap') || null;
    body.isGroundOnly       = document.getElementById('itemGroundOnly').checked;
    body.isLimitedQty       = document.getElementById('itemLimitedQty').checked;
    body.hazmatNotes        = document.getElementById('itemHazmatNotes').value.trim() || null;
    if(!body.unNumber)   { err.textContent = 'UN Number is required for hazmat items'; return; }
    if(!body.hazardClass){ err.textContent = 'Hazard Class is required for hazmat items'; return; }
  }

  const submitBtn = document.getElementById('itemFormSubmitBtn');
  submitBtn.disabled = true;
  try {
    const url    = _editingItemId ? `${API}/skus/${_editingItemId}` : `${API}/skus`;
    const method = _editingItemId ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method, headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Save failed'; return; }
    closeModal('itemFormModal');
    loadInventory();
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    submitBtn.disabled = false;
  }
}
