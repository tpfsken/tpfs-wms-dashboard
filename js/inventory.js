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
let _itemPendingSds = null;    // File staged from "Read SDS"; uploaded as
                               // an attachment after the SKU is saved so
                               // the SDS sticks with the item.
let _itemPendingDocs = [];     // Files staged in create mode via the
                               // Documents section. Uploaded as
                               // sku_attachments after the SKU is saved.

// Baseline UOMs always shown in the dropdown. Anything ops has added
// to existing SKUs gets merged in on top of this via /uoms (so the
// list grows over time). The combo has allowCustom:true, so ops can
// type a brand-new value (e.g. "TON", "ROLL", "BX") and it'll save on
// the SKU and show up in the dropdown next time.
const ITEM_UOM_BASELINE = [
  {value:'EA',  label:'EA — Each'},
  {value:'CS',  label:'CS — Case'},
  {value:'PL',  label:'PL — Pallet'},
  {value:'LB',  label:'LB — Pound'},
  {value:'KG',  label:'KG — Kilogram'},
  {value:'OZ',  label:'OZ — Ounce'},
  {value:'GAL', label:'GAL — Gallon'},
];

// Build the merged UOM option list — baseline + anything else used on
// existing SKUs. Returns the combo-options shape.
async function buildItemUomOptions(){
  const used = (await apiGet('/uoms')) || [];
  const seen = new Set(ITEM_UOM_BASELINE.map(o => o.value));
  const extras = used
    .filter(u => u && !seen.has(u))
    .map(u => ({value: u, label: u}));
  return ITEM_UOM_BASELINE.concat(extras);
}

// SKU types — must match the skus_sku_type_check CHECK constraint.
// (PALLET, CASE, INNER_PACK, EACH). Adjust here AND on the DB if you
// want to add new types.
const ITEM_TYPES = [
  {value:'EACH',       label:'Each — single sellable unit'},
  {value:'INNER_PACK', label:'Inner Pack — retail multi-unit'},
  {value:'CASE',       label:'Case — shipping carton'},
  {value:'PALLET',     label:'Pallet'},
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

  // Init combos. UOM options merge the baseline catalog with whatever's
  // already in use on existing SKUs (loaded fresh each open). allowCustom
  // lets ops type a brand-new UOM inline — it persists to the SKU on
  // save and appears in the dropdown on next open.
  initCombo('itemClientWrap',
    [{value:'', label:'— Pick a client —'}].concat(
      clientsCache.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`}))
    ),
    {placeholder:'— Pick a client —', onChange: () => onItemClientChange()}
  );
  const uomOptions = await buildItemUomOptions();
  initCombo('itemUomWrap',           uomOptions,       {placeholder:'EA', value:'EA', allowCustom:true});
  initCombo('itemTypeWrap',          ITEM_TYPES,       {placeholder:'Each', value:'EACH'});
  initCombo('itemPackingGroupWrap',  PACKING_GROUPS,   {placeholder:'— None —'});

  // Wire hazmat checkbox to reveal block (idempotent)
  const haz = document.getElementById('itemHazmat');
  if(!haz._wired){
    haz._wired = true;
    haz.addEventListener('change', () => {
      document.getElementById('itemHazmatBlock').style.display = haz.checked ? 'block' : 'none';
    });
  }

  // Wire "Read SDS to auto-fill" — runs Claude on the PDF and pre-fills
  // the hazmat fields. The file is also staged for upload as an
  // attachment after the SKU is saved.
  const sdsInput = document.getElementById('itemSdsExtractInput');
  if(sdsInput && !sdsInput._wired){
    sdsInput._wired = true;
    sdsInput.addEventListener('change', e => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if(file) extractSdsAndFill(file);
    });
  }

  // Wire Documents section's add button (idempotent). In create mode we
  // stage files client-side and upload them after Save; in edit mode we
  // upload directly.
  const docBtn = document.getElementById('itemDocAddBtn');
  const docInput = document.getElementById('itemDocAddInput');
  if(docBtn && !docBtn._wired){
    docBtn._wired = true;
    docBtn.addEventListener('click', () => docInput.click());
  }
  if(docInput && !docInput._wired){
    docInput._wired = true;
    docInput.addEventListener('change', e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if(!files.length) return;
      if(_editingItemId){
        uploadItemAttachments(_editingItemId, files);
      } else {
        const MAX = 25 * 1024 * 1024;
        for(const f of files){
          if(f.size > MAX){
            alert(`${f.name} is over 25MB — skipped`);
            continue;
          }
          _itemPendingDocs.push(f);
        }
        renderItemPendingDocs();
      }
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
    cbSet('itemTypeWrap', sku.sku_type || 'EACH');
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
    document.getElementById('itemSpecialHandling').value = sku.special_handling_instructions || '';
    document.getElementById('itemHazmatBlock').style.display = sku.is_hazmat ? 'block' : 'none';
    document.getElementById('itemSdsExtractStatus').textContent = '';
    // Edit mode — load attachments list so ops can manage docs
    loadItemAttachmentsList(skuId);
  } else {
    // Create mode — reset form
    [
      'itemCode','itemUpc','itemName','itemDescription','itemUnitsPerCase',
      'itemLength','itemWidth','itemHeight','itemWeight','itemUnitCost','itemUnitPrice',
      'itemUnNumber','itemHazardClass','itemProperShippingName','itemHazmatNotes',
      'itemSpecialHandling',
    ].forEach(id => { document.getElementById(id).value = ''; });
    ['itemLotTracked','itemExpiryTracked','itemHazmat','itemGroundOnly','itemLimitedQty']
      .forEach(id => { document.getElementById(id).checked = false; });
    document.getElementById('itemHazmatBlock').style.display = 'none';
    document.getElementById('itemSdsExtractStatus').textContent = '';
    cbReset('itemClientWrap'); cbSet('itemUomWrap','EA'); cbSet('itemTypeWrap','EACH');
    cbReset('itemPackingGroupWrap');
  }

  // Reset staging before rendering so a previous modal open doesn't leak
  // files into a fresh New Item form.
  _itemPendingSds = null;
  _itemPendingDocs = [];
  if(!skuId) renderItemPendingDocs();
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
    specialHandlingInstructions: document.getElementById('itemSpecialHandling').value.trim() || null,
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

    // If the user used "Read SDS to auto-fill" before saving, that PDF
    // is staged in _itemPendingSds — upload it now as a sku attachment
    // tagged SDS so it stays with the item.
    if(_itemPendingSds){
      try {
        const fd = new FormData();
        fd.append('file', _itemPendingSds);
        fd.append('attachment_type', 'SDS');
        await fetch(`${API}/skus/${d.id}/attachments`, {
          method:'POST',
          headers:{'Authorization':`Bearer ${T}`},
          body: fd,
        });
      } catch(_) { /* swallow — SKU still saved successfully */ }
      _itemPendingSds = null;
    }

    // Any other documents the user staged via 📎 Attach File before
    // Save — upload them now too.
    if(_itemPendingDocs.length){
      for(const f of _itemPendingDocs){
        try {
          const fd = new FormData();
          fd.append('file', f);
          if(/sds|safety.*data/i.test(f.name)) fd.append('attachment_type', 'SDS');
          await fetch(`${API}/skus/${d.id}/attachments`, {
            method:'POST',
            headers:{'Authorization':`Bearer ${T}`},
            body: fd,
          });
        } catch(_) { /* keep going on individual failures */ }
      }
      _itemPendingDocs = [];
    }

    closeModal('itemFormModal');
    loadInventory();
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    submitBtn.disabled = false;
  }
}

// =============================================================================
// SDS AI EXTRACT — drop a PDF, run Claude on it, fill the modal
// =============================================================================

async function extractSdsAndFill(file){
  const status = document.getElementById('itemSdsExtractStatus');
  status.style.color = 'var(--text2)';
  status.textContent = `Reading ${file.name}…`;

  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${API}/skus/extract-sds`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${T}` },
      body: fd,
    });
    const d = await r.json();
    if(!r.ok){
      status.style.color = 'var(--red)';
      status.textContent = d.error || 'SDS read failed';
      return;
    }
    const e = d.extracted || {};

    // Auto-toggle hazmat checkbox when the SDS says so. Reveal block.
    if(e.is_hazardous){
      document.getElementById('itemHazmat').checked = true;
      document.getElementById('itemHazmatBlock').style.display = 'block';
    }

    // Pre-fill — only overwrite empties so we don't clobber what ops typed
    const setIfEmpty = (id, v) => {
      if(v == null || v === '') return;
      const el = document.getElementById(id);
      if(!el.value.trim()) el.value = v;
    };
    setIfEmpty('itemUnNumber',           e.un_number);
    setIfEmpty('itemHazardClass',        e.hazard_class);
    setIfEmpty('itemProperShippingName', e.proper_shipping_name);
    setIfEmpty('itemSpecialHandling',    e.special_handling);
    if(e.packing_group){ cbSet('itemPackingGroupWrap', e.packing_group); }
    if(e.is_ground_only) document.getElementById('itemGroundOnly').checked = true;
    if(e.is_limited_qty) document.getElementById('itemLimitedQty').checked = true;

    // Stash the file so submitItemForm can save it as an SDS attachment
    // post-create.
    _itemPendingSds = file;

    const conf = e.confidence == null ? '' : ` (confidence ${Math.round(Number(e.confidence) * 100)}%)`;
    status.style.color = e.is_hazardous ? 'var(--amber)' : 'var(--green)';
    status.textContent = e.is_hazardous
      ? `✓ Hazardous — fields pre-filled from SDS${conf}. Review before saving.`
      : `✓ Read SDS${conf}. No hazmat detected — fields left untouched. Review before saving.`;
  } catch(err){
    status.style.color = 'var(--red)';
    status.textContent = 'Network error reading SDS';
  }
}

// =============================================================================
// SKU ATTACHMENTS (SDS / photos / spec sheets) — only available in edit
// mode (we need a sku id). The list lives inside the New Item modal
// when an existing item is open.
// =============================================================================

// Renders the create-mode staging list — files the user has dropped in
// via 📎 Attach File before the SKU exists. They sit client-side until
// Save creates the SKU, then they're uploaded as attachments.
function renderItemPendingDocs(){
  const body = document.getElementById('itemDocsBody');
  if(!body) return;
  if(!_itemPendingDocs.length){
    body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">No documents staged. Click 📎 Attach File to add an SDS, photo, or spec sheet — they\'ll upload after Save. (Or use Read SDS above to also auto-fill hazmat from a PDF.)</div>';
    return;
  }
  body.innerHTML = _itemPendingDocs.map((f, i) => {
    const ext = (f.name.split('.').pop() || 'FILE').toUpperCase();
    const sizeKb = (f.size / 1024).toFixed(0);
    const sizeMb = (f.size / 1024 / 1024).toFixed(2);
    const sizeLabel = f.size > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
    const tagged = /sds|safety.*data/i.test(f.name);
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <div style="width:38px;height:38px;border-radius:6px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--blue);">${esc(ext.slice(0,4))}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)} ${tagged ? '<span class="chip chip-warning" style="font-size:10px;">SDS</span>' : ''} <span style="color:var(--muted);font-weight:400;">· uploads on Save</span></div>
          <div style="font-size:11px;color:var(--text2);">${esc(sizeLabel)} · ${esc(f.type || 'unknown')}</div>
        </div>
        <button class="btn btn-ghost js-item-pend-rm" data-idx="${esc(i)}" style="padding:3px 10px;font-size:12px;color:var(--red);">✕</button>
      </div>`;
  }).join('');
  body.querySelectorAll('.js-item-pend-rm').forEach(btn => btn.addEventListener('click', () => {
    _itemPendingDocs.splice(parseInt(btn.dataset.idx), 1);
    renderItemPendingDocs();
  }));
}

async function loadItemAttachmentsList(skuId){
  const body = document.getElementById('itemDocsBody');
  body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">Loading…</div>';
  const rows = await apiGet(`/skus/${skuId}/attachments`);
  if(!rows){
    body.innerHTML = '<div style="color:var(--red);font-size:12px;">Could not load attachments</div>';
    return;
  }
  if(!rows.length){
    body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">No documents yet — click 📎 Attach File to add an SDS, photo, or spec sheet</div>';
    return;
  }
  body.innerHTML = rows.map(r => {
    const ext = (r.filename || '').split('.').pop()?.toUpperCase() || 'FILE';
    const sizeKb = Number(r.size_bytes || 0) / 1024;
    const sizeLabel = (r.size_bytes || 0) > 1024 * 1024
      ? `${(sizeKb / 1024).toFixed(2)} MB`
      : `${sizeKb.toFixed(0)} KB`;
    const tag = r.attachment_type
      ? `<span class="chip chip-warning" style="font-size:10px;">${esc(r.attachment_type)}</span>`
      : '';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <div style="width:38px;height:38px;border-radius:6px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--blue);">${esc(ext.slice(0,4))}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.filename || '')} ${tag}</div>
          <div style="font-size:11px;color:var(--text2);">${esc(sizeLabel)} · ${esc(r.uploaded_by || '')}</div>
        </div>
        <button class="btn btn-ghost js-item-att-dl" data-att-id="${esc(r.id)}" style="padding:3px 10px;font-size:12px;">⬇ Open</button>
        <button class="btn btn-ghost js-item-att-rm" data-att-id="${esc(r.id)}" style="padding:3px 8px;font-size:12px;color:var(--red);">✕</button>
      </div>`;
  }).join('');
  body.querySelectorAll('.js-item-att-dl').forEach(b =>
    b.addEventListener('click', async () => {
      const d = await apiGet(`/skus/${skuId}/attachments/${b.dataset.attId}/url`);
      if(d?.url) window.open(d.url, '_blank');
    }));
  body.querySelectorAll('.js-item-att-rm').forEach(b =>
    b.addEventListener('click', async () => {
      if(!confirm('Remove this document?')) return;
      const r = await fetch(`${API}/skus/${skuId}/attachments/${b.dataset.attId}`, {
        method:'DELETE', headers:{'Authorization':`Bearer ${T}`},
      });
      if(r.ok) loadItemAttachmentsList(skuId);
    }));
}

async function uploadItemAttachments(skuId, files){
  const body = document.getElementById('itemDocsBody');
  for(const f of files){
    body.innerHTML = `<div style="color:var(--text2);font-size:12px;">Uploading ${esc(f.name)}…</div>`;
    const fd = new FormData();
    fd.append('file', f);
    // Auto-tag PDFs that look like an SDS by filename hint
    if(/sds|safety.*data/i.test(f.name)) fd.append('attachment_type', 'SDS');
    try {
      await fetch(`${API}/skus/${skuId}/attachments`, {
        method:'POST', headers:{'Authorization':`Bearer ${T}`}, body: fd,
      });
    } catch(_) { /* keep going */ }
  }
  loadItemAttachmentsList(skuId);
}
