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
let _itemHandlingUnits = [];   // Working set of handling-unit levels for
                               // the modal. Each entry: { sku_type,
                               // sku_code, pack_qty, length_in, width_in,
                               // height_in, weight_lbs, nmfc_code,
                               // freight_class }. On save, sent as the
                               // handlingUnits array to POST /items.
const SKU_TYPE_SUFFIX = { EACH:'EA', INNER_PACK:'IP', CASE:'CS', PALLET:'PL' };

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

// SKU type baseline — the conventional handling-unit hierarchy. The DB
// CHECK constraint was dropped (migration 013) so this list is just a
// suggestion; the combo merges in any custom types that have been added
// on the fly via /sku-types and accepts free-typed values too.
const ITEM_TYPE_BASELINE = [
  {value:'EACH',       label:'Each — single sellable unit'},
  {value:'INNER_PACK', label:'Inner Pack — retail multi-unit'},
  {value:'CASE',       label:'Case — shipping carton'},
  {value:'PALLET',     label:'Pallet'},
];

async function buildItemTypeOptions(){
  const used = (await apiGet('/sku-types')) || [];
  const seen = new Set(ITEM_TYPE_BASELINE.map(o => o.value));
  const extras = used.filter(t => t && !seen.has(t)).map(t => ({value:t, label:t}));
  return ITEM_TYPE_BASELINE.concat(extras);
}

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
  initCombo('itemPackingGroupWrap',  PACKING_GROUPS,   {placeholder:'— None —'});

  // Wire hazmat checkbox to reveal block (idempotent)
  const haz = document.getElementById('itemHazmat');
  if(!haz._wired){
    haz._wired = true;
    haz.addEventListener('change', () => {
      document.getElementById('itemHazmatBlock').style.display = haz.checked ? 'block' : 'none';
    });
  }

  // Wire + Add Level — only meaningful in create mode (edit mode shows
  // a single locked SKU; multi-level changes go through Item Master).
  const huAddBtn = document.getElementById('itemHuAddBtn');
  if(huAddBtn && !huAddBtn._wired){
    huAddBtn._wired = true;
    huAddBtn.addEventListener('click', () => {
      if(_editingItemId) return; // disabled in edit mode anyway
      // Pick the next conventional level the user hasn't added yet
      const used = new Set(_itemHandlingUnits.map(h => h.sku_type));
      const next = ['EACH','INNER_PACK','CASE','PALLET'].find(t => !used.has(t)) || 'EACH';
      addHandlingUnit(next);
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

  // Reset working set every open
  _itemHandlingUnits = [];
  // Hide the "Re-read attached SDS" button until loadItemAttachmentsList
  // sees one for this SKU.
  const reuseBtn = document.getElementById('itemSdsReuseBtn');
  if(reuseBtn) reuseBtn.style.display = 'none';

  if(skuId){
    // Edit mode — fetch and populate
    const sku = await apiGet(`/skus/${skuId}`);
    if(!sku){ document.getElementById('itemFormError').textContent = 'Could not load item'; return; }
    cbSet('itemClientWrap', String(sku.client_id),
      (clientsCache.find(c => c.id === sku.client_id)?.code || '') + ' — ' +
      (clientsCache.find(c => c.id === sku.client_id)?.name || ''));
    document.getElementById('itemUpc').value          = sku.upc || '';
    document.getElementById('itemName').value         = sku.name || '';
    document.getElementById('itemDescription').value  = sku.description || '';
    cbSet('itemUomWrap',  sku.uom || 'EA');
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

    // Edit mode shows just THIS SKU as one row; multi-level edit goes
    // through Item Master + create a sibling SKU.
    _itemHandlingUnits.push({
      sku_type:      sku.sku_type || 'EACH',
      sku_code:      sku.sku_code || '',
      pack_qty:      sku.units_per_case ?? null,
      length_in:     sku.length_in ?? null,
      width_in:      sku.width_in ?? null,
      height_in:     sku.height_in ?? null,
      weight_lbs:    sku.weight_lbs ?? null,
      nmfc_code:     sku.nmfc_code || '',
      freight_class: sku.freight_class || '',
    });
    huAddBtn.style.display = 'none';
    document.getElementById('itemHuEditNote').style.display = 'block';
    loadItemAttachmentsList(skuId);
  } else {
    // Create mode — reset everything
    [
      'itemUpc','itemName','itemDescription','itemUnitCost','itemUnitPrice',
      'itemUnNumber','itemHazardClass','itemProperShippingName','itemHazmatNotes',
      'itemSpecialHandling',
    ].forEach(id => { document.getElementById(id).value = ''; });
    ['itemLotTracked','itemExpiryTracked','itemHazmat','itemGroundOnly','itemLimitedQty']
      .forEach(id => { document.getElementById(id).checked = false; });
    document.getElementById('itemHazmatBlock').style.display = 'none';
    document.getElementById('itemSdsExtractStatus').textContent = '';
    cbReset('itemClientWrap'); cbSet('itemUomWrap','EA');
    cbReset('itemPackingGroupWrap');

    // Create mode starts with one default level (EACH); ops can add more
    _itemHandlingUnits.push({
      sku_type:'EACH', sku_code:'', pack_qty:1,
      length_in:null, width_in:null, height_in:null, weight_lbs:null,
      nmfc_code:'', freight_class:'',
    });
    huAddBtn.style.display = '';
    document.getElementById('itemHuEditNote').style.display = 'none';
  }
  await renderHandlingUnits();
  _wireBaseCodeAutofill();

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

  const clientId = cbVal('itemClientWrap');
  const baseCode = document.getElementById('itemCode').value.trim().toUpperCase();
  const name     = document.getElementById('itemName').value.trim();

  if(!clientId)  { err.textContent = 'Client is required'; return; }
  if(!baseCode)  { err.textContent = 'Base SKU code is required'; return; }
  if(!name)      { err.textContent = 'Name is required'; return; }
  if(!_itemHandlingUnits.length){ err.textContent = 'Add at least one handling unit'; return; }

  // Validate each handling unit — sku_code required, sku_type required.
  for(const hu of _itemHandlingUnits){
    if(!hu.sku_code || !hu.sku_code.trim()){
      err.textContent = `Each handling unit needs a SKU code (level: ${hu.sku_type})`;
      return;
    }
    if(!hu.sku_type){
      err.textContent = 'Each handling unit needs a level type';
      return;
    }
  }

  // Common attributes shared across all levels of this item
  const common = {
    clientId,
    name,
    description:     document.getElementById('itemDescription').value.trim() || null,
    upc:             document.getElementById('itemUpc').value.trim() || null,
    uom:             cbVal('itemUomWrap') || 'EA',
    unitCost:        numOrNull('itemUnitCost'),
    unitPrice:       numOrNull('itemUnitPrice'),
    isLotTracked:    document.getElementById('itemLotTracked').checked,
    isExpiryTracked: document.getElementById('itemExpiryTracked').checked,
    isHazmat:        document.getElementById('itemHazmat').checked,
    specialHandlingInstructions: document.getElementById('itemSpecialHandling').value.trim() || null,
  };

  if(common.isHazmat){
    common.unNumber           = document.getElementById('itemUnNumber').value.trim();
    common.hazardClass        = document.getElementById('itemHazardClass').value.trim();
    common.properShippingName = document.getElementById('itemProperShippingName').value.trim() || null;
    common.packingGroup       = cbVal('itemPackingGroupWrap') || null;
    common.isGroundOnly       = document.getElementById('itemGroundOnly').checked;
    common.isLimitedQty       = document.getElementById('itemLimitedQty').checked;
    common.hazmatNotes        = document.getElementById('itemHazmatNotes').value.trim() || null;
    if(!common.unNumber)   { err.textContent = 'UN Number is required for hazmat items'; return; }
    if(!common.hazardClass){ err.textContent = 'Hazard Class is required for hazmat items'; return; }
  }

  const submitBtn = document.getElementById('itemFormSubmitBtn');
  submitBtn.disabled = true;
  try {
    let r, d;
    if(_editingItemId){
      // EDIT MODE — single SKU update via PATCH /skus/:id. The handling
      // unit array always has one row in this mode (by design).
      const hu = _itemHandlingUnits[0];
      const patchBody = Object.assign({}, common, {
        skuCode:       hu.sku_code.trim().toUpperCase(),
        skuType:       hu.sku_type,
        unitsPerCase:  hu.pack_qty,
        lengthIn:      hu.length_in,
        widthIn:       hu.width_in,
        heightIn:      hu.height_in,
        weightLbs:     hu.weight_lbs,
        nmfcCode:      hu.nmfc_code || null,
        freightClass:  hu.freight_class || null,
      });
      r = await fetch(`${API}/skus/${_editingItemId}`, {
        method:'PATCH', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
        body: JSON.stringify(patchBody),
      });
      d = await r.json();
    } else {
      // CREATE MODE — POST /items handles both single-level and multi-
      // level. Server creates parent + linked children in order.
      const createBody = Object.assign({}, common, {
        handlingUnits: _itemHandlingUnits.map(hu => ({
          sku_type:      hu.sku_type,
          sku_code:      hu.sku_code.trim().toUpperCase(),
          pack_qty:      hu.pack_qty,
          length_in:     hu.length_in,
          width_in:      hu.width_in,
          height_in:     hu.height_in,
          weight_lbs:    hu.weight_lbs,
          nmfc_code:     hu.nmfc_code || null,
          freight_class: hu.freight_class || null,
        })),
      });
      r = await fetch(`${API}/items`, {
        method:'POST', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
        body: JSON.stringify(createBody),
      });
      d = await r.json();
    }
    if(!r.ok){ err.textContent = d.error || 'Save failed'; return; }
    // For multi-level create, .items[0] is the biggest level (PALLET if
    // present). Use the LAST one (smallest) as the "primary" id for
    // attachment uploads — that's typically the EACH SKU.
    const primaryId = _editingItemId
      || (Array.isArray(d.items) ? d.items[d.items.length - 1].id : (d.id || null));

    // If the user used "Read SDS to auto-fill" before saving, that PDF
    // is staged in _itemPendingSds — upload it now as a sku attachment
    // tagged SDS. We attach it to the "primary" (smallest / EACH) SKU
    // since that's the canonical sellable unit; documents bind there.
    if(_itemPendingSds && primaryId){
      try {
        const fd = new FormData();
        fd.append('file', _itemPendingSds);
        fd.append('attachment_type', 'SDS');
        await fetch(`${API}/skus/${primaryId}/attachments`, {
          method:'POST',
          headers:{'Authorization':`Bearer ${T}`},
          body: fd,
        });
      } catch(_) { /* swallow — SKU still saved successfully */ }
      _itemPendingSds = null;
    }

    // Any other documents the user staged via 📎 Attach File before
    // Save — upload them now too.
    if(_itemPendingDocs.length && primaryId){
      for(const f of _itemPendingDocs){
        try {
          const fd = new FormData();
          fd.append('file', f);
          if(/sds|safety.*data/i.test(f.name)) fd.append('attachment_type', 'SDS');
          await fetch(`${API}/skus/${primaryId}/attachments`, {
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
// HANDLING UNITS — multi-level handling for the New Item modal.
// =============================================================================
// Each item can be stocked at one or more handling-unit levels (Each,
// Inner Pack, Case, Pallet, or any custom type). Each level has its own
// dimensions, weight, NMFC, freight class. On save the rows are inserted
// as separate skus rows linked via parent_sku_id.

// NMTA density brackets (lbs/ft³) -> freight class. Densest items get
// the lowest class (= cheapest to ship). Manual override always wins.
const FREIGHT_DENSITY_BRACKETS = [
  [50, 50  ], [35, 55  ], [30, 60  ], [22.5, 65 ], [15, 70  ],
  [13.5, 77.5], [12, 85 ], [10.5, 92.5], [9, 100 ], [8, 110  ],
  [7, 125 ], [6, 150 ], [5, 175 ], [4, 200 ], [3, 250 ],
  [2, 300 ], [1, 400 ], [0, 500 ],
];

function densityToFreightClass(d){
  if(d == null) return null;
  for(const [floor, cls] of FREIGHT_DENSITY_BRACKETS){
    if(d >= floor) return cls;
  }
  return 500;
}

function computeDensity(L, W, H, wt){
  L = Number(L); W = Number(W); H = Number(H); wt = Number(wt);
  if(!(L > 0 && W > 0 && H > 0 && wt > 0)) return null;
  const cuFt = (L * W * H) / 1728;
  if(cuFt <= 0) return null;
  return wt / cuFt;
}

function addHandlingUnit(skuType){
  const baseCode = document.getElementById('itemCode').value.trim();
  const suffix = SKU_TYPE_SUFFIX[skuType] || (skuType ? skuType.slice(0, 3).toUpperCase() : 'X');
  _itemHandlingUnits.push({
    sku_type:      skuType,
    sku_code:      baseCode ? `${baseCode}-${suffix}` : '',
    pack_qty:      skuType === 'EACH' ? 1 : null,
    length_in:     null, width_in: null, height_in: null, weight_lbs: null,
    nmfc_code:     '',
    freight_class: '',
  });
  renderHandlingUnits();
}

async function renderHandlingUnits(){
  const wrap = document.getElementById('itemHuList');
  if(!wrap) return;
  if(!_itemHandlingUnits.length){
    wrap.innerHTML = '<div class="empty-state" style="padding:14px;font-size:13px;">No handling units yet — click + Add Level to add one</div>';
    return;
  }
  const typeOptions = await buildItemTypeOptions();
  const editing = !!_editingItemId;

  wrap.innerHTML = _itemHandlingUnits.map((hu, i) => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="min-width:150px;">
          <label class="form-label">Level</label>
          <div class="cb-wrap" id="huType_${esc(i)}"></div>
        </div>
        <div style="flex:1;min-width:200px;">
          <label class="form-label">SKU Code *</label>
          <input class="form-input js-hu-code" data-idx="${esc(i)}" value="${esc(hu.sku_code || '')}" placeholder="auto-filled from base code">
        </div>
        <div style="width:110px;">
          <label class="form-label">Pack Qty</label>
          <input class="form-input js-hu-pack" data-idx="${esc(i)}" type="number" min="0" step="1" value="${hu.pack_qty == null ? '' : esc(hu.pack_qty)}" placeholder="e.g. 24">
        </div>
        ${editing ? '' : `<button type="button" class="btn btn-ghost js-hu-rm" data-idx="${esc(i)}" style="color:var(--red);padding:6px 10px;font-size:14px;" title="Remove this level">✕</button>`}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">L (in)</label><input class="form-input js-hu-len" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.length_in == null ? '' : esc(hu.length_in)}"></div>
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">W (in)</label><input class="form-input js-hu-wid" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.width_in == null ? '' : esc(hu.width_in)}"></div>
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">H (in)</label><input class="form-input js-hu-hgt" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.height_in == null ? '' : esc(hu.height_in)}"></div>
        <div style="width:110px;"><label class="form-label" style="font-size:11px;">Weight (lbs)</label><input class="form-input js-hu-wt" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.weight_lbs == null ? '' : esc(hu.weight_lbs)}"></div>
        <div style="width:140px;"><label class="form-label" style="font-size:11px;">NMFC</label><input class="form-input js-hu-nmfc" data-idx="${esc(i)}" value="${esc(hu.nmfc_code || '')}" placeholder="156600"></div>
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">Class</label><input class="form-input js-hu-fc" data-idx="${esc(i)}" value="${esc(hu.freight_class || '')}" placeholder="60"></div>
        <div style="display:flex;flex-direction:column;justify-content:flex-end;gap:2px;">
          <button type="button" class="btn btn-ghost js-hu-calc" data-idx="${esc(i)}" style="padding:6px 10px;font-size:11px;color:var(--blue);" title="Calc class from density">⚡ Calc</button>
          <span class="js-hu-density" data-idx="${esc(i)}" style="font-size:10px;color:var(--text2);text-align:center;"></span>
        </div>
      </div>
    </div>
  `).join('');

  // Init level combo for each row
  for(let i = 0; i < _itemHandlingUnits.length; i++){
    initCombo(`huType_${i}`, typeOptions, {
      placeholder:'Each',
      value: _itemHandlingUnits[i].sku_type,
      allowCustom: true,
      onChange: (v) => { _itemHandlingUnits[i].sku_type = v; },
    });
  }

  // Wire input changes
  wrap.querySelectorAll('.js-hu-code').forEach(inp => inp.addEventListener('input', e =>
    _itemHandlingUnits[+e.target.dataset.idx].sku_code = e.target.value));
  wrap.querySelectorAll('.js-hu-pack').forEach(inp => inp.addEventListener('input', e => {
    const v = e.target.value.trim();
    _itemHandlingUnits[+e.target.dataset.idx].pack_qty = v === '' ? null : Number(v);
  }));
  const dimWire = (cls, field) => wrap.querySelectorAll(cls).forEach(inp => inp.addEventListener('input', e => {
    const v = e.target.value.trim();
    const i = +e.target.dataset.idx;
    _itemHandlingUnits[i][field] = v === '' ? null : Number(v);
    updateHuDensity(i);
  }));
  dimWire('.js-hu-len', 'length_in');
  dimWire('.js-hu-wid', 'width_in');
  dimWire('.js-hu-hgt', 'height_in');
  dimWire('.js-hu-wt',  'weight_lbs');
  wrap.querySelectorAll('.js-hu-nmfc').forEach(inp => inp.addEventListener('input', e =>
    _itemHandlingUnits[+e.target.dataset.idx].nmfc_code = e.target.value));
  wrap.querySelectorAll('.js-hu-fc').forEach(inp => inp.addEventListener('input', e =>
    _itemHandlingUnits[+e.target.dataset.idx].freight_class = e.target.value));

  // Per-row class-from-density button
  wrap.querySelectorAll('.js-hu-calc').forEach(btn => btn.addEventListener('click', () => {
    const i  = +btn.dataset.idx;
    const hu = _itemHandlingUnits[i];
    const d  = computeDensity(hu.length_in, hu.width_in, hu.height_in, hu.weight_lbs);
    if(d == null){ alert('Need L, W, H, and weight all > 0 on this row to compute density.'); return; }
    hu.freight_class = String(densityToFreightClass(d));
    renderHandlingUnits();
  }));

  // Remove button (create mode only — editing locks to one row)
  wrap.querySelectorAll('.js-hu-rm').forEach(btn => btn.addEventListener('click', () => {
    if(_itemHandlingUnits.length <= 1){ alert('Need at least one handling unit.'); return; }
    _itemHandlingUnits.splice(+btn.dataset.idx, 1);
    renderHandlingUnits();
  }));

  // Initial density readouts
  for(let i = 0; i < _itemHandlingUnits.length; i++) updateHuDensity(i);
}

function updateHuDensity(i){
  const hu = _itemHandlingUnits[i];
  const d  = computeDensity(hu.length_in, hu.width_in, hu.height_in, hu.weight_lbs);
  const span = document.querySelector(`.js-hu-density[data-idx="${i}"]`);
  if(!span) return;
  if(d == null){ span.textContent = ''; return; }
  span.textContent = `${d.toFixed(1)} lb/ft³`;
}

// Optional convenience: when ops types in the Base SKU Code field, fill
// in any per-level sku_codes that are still blank or still match the
// previous derived pattern.
function _wireBaseCodeAutofill(){
  const baseInp = document.getElementById('itemCode');
  if(!baseInp || baseInp._huWired) return;
  baseInp._huWired = true;
  baseInp.addEventListener('input', () => {
    const base = baseInp.value.trim();
    let mutated = false;
    for(const hu of _itemHandlingUnits){
      const suffix = SKU_TYPE_SUFFIX[hu.sku_type] || (hu.sku_type ? hu.sku_type.slice(0,3).toUpperCase() : 'X');
      const expected = base ? `${base}-${suffix}` : '';
      if(!hu.sku_code) { hu.sku_code = expected; mutated = true; }
    }
    if(mutated) renderHandlingUnits();
  });
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
    updateSdsReuseButton(skuId, null);
    return;
  }

  // Surface the most recent SDS (if any) on the hazmat block's re-read
  // button so ops can extract from it without re-uploading.
  const latestSds = rows.find(a =>
    a.attachment_type === 'SDS' || /sds|safety.*data/i.test(a.filename || '')
  );
  updateSdsReuseButton(skuId, latestSds);

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

// Show / hide the "🔄 Re-read attached SDS" button based on whether the
// SKU has an SDS attached. When clicked, re-runs Claude on the attached
// PDF (server-side fetch from S3 + extract) and fills the hazmat fields.
function updateSdsReuseButton(skuId, sdsAttachment){
  const btn = document.getElementById('itemSdsReuseBtn');
  if(!btn) return;
  if(!skuId || !sdsAttachment){
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  btn.title = `Re-extract hazmat info from ${sdsAttachment.filename}`;
  // Replace any prior listener
  btn.onclick = () => extractFromAttachedSds(skuId, sdsAttachment.id, sdsAttachment.filename);
}

async function extractFromAttachedSds(skuId, attId, filename){
  const status = document.getElementById('itemSdsExtractStatus');
  status.style.color = 'var(--text2)';
  status.textContent = `Re-reading ${filename}…`;
  try {
    const r = await fetch(`${API}/skus/${skuId}/attachments/${attId}/extract`, {
      method:'POST', headers:{'Authorization':`Bearer ${T}`},
    });
    const d = await r.json();
    if(!r.ok){
      status.style.color = 'var(--red)';
      status.textContent = d.error || 'SDS read failed';
      return;
    }
    const e = d.extracted || {};

    // Fill the hazmat fields. Same overwrite-only-empty rule as the
    // upload path — don't clobber what ops typed.
    if(e.is_hazardous){
      document.getElementById('itemHazmat').checked = true;
      document.getElementById('itemHazmatBlock').style.display = 'block';
    }
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

    const conf = e.confidence == null ? '' : ` (confidence ${Math.round(Number(e.confidence) * 100)}%)`;
    status.style.color = e.is_hazardous ? 'var(--amber)' : 'var(--green)';
    status.textContent = e.is_hazardous
      ? `✓ Hazardous — fields pre-filled${conf}. Review and click Save Changes.`
      : `✓ Read SDS${conf}. No hazmat detected. Review and click Save Changes.`;
  } catch(_) {
    status.style.color = 'var(--red)';
    status.textContent = 'Network error reading SDS';
  }
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
