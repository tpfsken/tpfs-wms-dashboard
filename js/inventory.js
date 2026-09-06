'use strict';
// =============================================================================
// INVENTORY + CASE BREAK — TERMINAL LEDGER (batch D4a).
// The list is server-sorted and server-paged: it used to ask for limit=200 with
// no offset and no total, so a warehouse with 10,000 LPs showed 200 rows and
// said nothing about the other 9,800.
// =============================================================================

// NOTE ON NAMING: there is no module system here — every top-level const is a
// GLOBAL shared across every js/ file. invoices.js already owns INV_*, so the
// on-hand list uses ONHAND_*. A duplicate top-level `const` is a SyntaxError
// that kills the whole script, and (because app.js's `loaders` map references
// the dead file's function) takes login down with it. Don't reuse a prefix.
//
// `key` on a sortable column is the API's sortBy value — it must exist in the
// INVENTORY_SORTS whitelist in the API's queries/inventory.js.
const ONHAND_COLS = [
  { key: 'sku_code', label: 'Item', render: r => {
      const sev = severityChip(r, { size: 'sm' });
      return `${uiId(r.sku_code || '')}${sev ? ' ' + sev : ''}`;
    } },
  { key: 'sku_name', label: 'Description' },
  { key: 'client_name', label: 'Client' },
  { key: '_type', label: 'Type', sortable: false, render: r =>
      `<span class="ui-chip ui-chip-neutral">${esc(r.sku_type || r.uom || '')}</span>` },
  { key: 'lot_number', label: 'Lot', render: r => r.lot_number
      ? uiId(r.lot_number) : '<span class="ui-muted">—</span>' },
  // Expiry is why FEFO exists — show it, and shout when it's close.
  { key: 'expiry_date', label: 'Expiry', render: r => {
      if(!r.expiry_date) return '<span class="ui-muted">—</span>';
      const days = Number(r.days_until_expiry);
      const txt = new Date(r.expiry_date).toLocaleDateString();
      if(Number.isFinite(days) && days < 0)  return `<span class="ui-chip ui-chip-danger">expired</span>`;
      if(Number.isFinite(days) && days <= 30) return `<span class="ui-chip ui-chip-warn">${esc(txt)}</span>`;
      return uiId(txt);
    } },
  // A COA certifies one production LOT. No lot -> the question doesn't apply.
  // A lot with no COA is a gap you want to see from the list, not discover at
  // pick time when the truck is waiting.
  { key: '_coa', label: 'COA', sortable: false, render: r => {
      if(!r.lot_number) return '<span class="ui-muted">—</span>';
      return r.has_coa
        ? '<span class="ui-chip ui-chip-ok">ON FILE</span>'
        : '<span class="ui-chip ui-chip-warn">MISSING</span>';
    } },
  { key: 'location_code', label: 'Location', mono: true },
  { key: 'lp_number', label: 'LP', render: r => r.lp_number
      ? `<span class="lp-badge ${r.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(r.lp_number)}</span>`
      : '<span class="ui-muted">—</span>' },
  { key: 'quantity', label: 'Qty', num: true },
  { key: 'status', label: 'Status', render: r => uiChip(r.status) },
  { key: '_act', label: '', sortable: false, render: r => {
      // Case-break is an ops action — portal users never see it.
      if(!canCaseBreak(r) || (typeof isPortalMode === 'function' && isPortalMode())) return '';
      return `<button class="ui-btn js-break-btn" data-payload='${esc(JSON.stringify(cbPayload(r)))}'>Break</button>`;
    } },
];

/* Can this inventory line be case-broken?
 * The API is the real authority (it rejects anything whose SKU isn't type CASE,
 * or that has no EACH child SKU) — this just decides whether to OFFER the
 * action. It accepts CS as well as CASE because the UOM list ships "CS — Case":
 * a case SKU carrying uom=CS used to show no Break button at all. */
function canCaseBreak(r){
  const type = String(r.sku_type || '').toUpperCase();
  // The list calls it `uom`; the detail endpoint calls it `sku_uom`.
  const uom  = String(r.uom || r.sku_uom || '').toUpperCase();
  const isCase = type === 'CASE' || uom === 'CASE' || uom === 'CS';
  return isCase && r.status === 'available' && Number(r.quantity) > 0 && !!r.lp_id;
}

function cbPayload(r){
  return {
    lp_id: r.lp_id, id: r.id, lp_number: r.lp_number,
    sku_code: r.sku_code, sku_name: r.sku_name || '',
    sku_type: r.sku_type || r.uom || r.sku_uom, quantity: Number(r.quantity),
    lot_number: r.lot_number || null, location_code: r.location_code || '',
  };
}

let ONHAND_LIMIT  = 50;
let ONHAND_OFFSET = 0;
let ONHAND_SORT   = 'expiry_date';   // FEFO: soonest-expiring first
let ONHAND_DIR    = 'asc';
let ONHAND_FILTER_SIG = '';

function invSetSort(key, dir){
  ONHAND_SORT = key; ONHAND_DIR = dir; ONHAND_OFFSET = 0;
  loadInventory();
}
function invSetPage(limit, offset){
  ONHAND_LIMIT = limit; ONHAND_OFFSET = offset;
  loadInventory();
  document.getElementById('invListWrap')?.scrollIntoView({ block: 'start' });
}

// Page header — the shared filter bar (js/ui.js). Built at DOM-ready by app.js.
const INV_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'available', label: 'Available' },
  { value: 'allocated', label: 'Allocated' },
  { value: 'damaged', label: 'Damaged' },
];
function initInventoryFilterBar(){
  uiFilterBar('invFilterBar', {
    key: 'inv', page: 'inventory',
    title: 'Inventory',
    subtitle: 'On-hand by SKU, lot, and location · add new items from the client\'s Item Master tab',
    leading: `<button class="ui-btn portal-only" onclick="navigateTo('portalHome')">← Home</button>`,
    controls: `<label class="ui-check ops-only inv-show-inactive"><input type="checkbox" id="invShowInactive" onchange="uiRun(this, () => invToggleInactiveClients(this))"> Show inactive</label>`,
    search: { placeholder: 'Search item, lot, license plate or location…' },
    statuses: INV_STATUS_OPTIONS,
    // Jump-to-unit is an ACTION (Enter opens the unit's LP), not a list filter.
    // It carries every "leave me alone" hint a browser or password manager
    // honours; the real fix for the saved-email autofill is on the login form.
    tools: `<input type="search" class="ui-input inv-find-unit ops-only" id="invFindUnit" name="unit-lookup"
              placeholder="Jump to unit code…" aria-label="Jump to a unit by its code (press Enter)"
              title="Type or scan a unit code and press Enter to open its license plate"
              autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore data-form-type="other"
              onkeydown="if(event.key==='Enter'){event.preventDefault();uiRun(this, () => invFindUnit(this.value));}">`,
    actions: `<button class="ui-btn ui-btn-primary ops-only" data-perm="inventory.case_break" onclick="uiRun(this, () => showCaseBreakModal())">Case break</button>`,
    onChange: () => loadInventory(),
  });
}

// Client filter: active clients by default; "Show inactive" rebuilds the combo from /clients?all=1
async function invToggleInactiveClients(cb){
  const list = cb.checked ? (await apiGet('/clients?all=1')) || [] : clientsCache;
  uiFilterBarClientOptions('inv', list);   // keeps the session's selected client
}

async function loadInventory(){
  const s  = document.getElementById('invSearch')?.value || '';
  const st = (_cbState['invStatusFilterWrap']?.selected?.value) || '';
  const cl = (_cbState['invClientFilterWrap']?.selected?.value) || '';

  // A filter change puts you back on page 1 — otherwise you land on page 7 of
  // a 2-page result and see an empty table.
  const sig = `${s}|${st}|${cl}`;
  if(sig !== ONHAND_FILTER_SIG){ ONHAND_FILTER_SIG = sig; ONHAND_OFFSET = 0; }

  const qs = new URLSearchParams({
    limit: ONHAND_LIMIT, offset: ONHAND_OFFSET, sortBy: ONHAND_SORT, sortDir: ONHAND_DIR,
  });
  if(st) qs.set('status', st);
  if(s)  qs.set('skuCode', '%' + s + '%');
  if(cl) qs.set('clientId', cl);

  uiTableLoading('invListWrap', ONHAND_COLS);
  const d = await apiGet(`/inventory?${qs.toString()}`);
  if(d === null) return uiTableError('invListWrap', ONHAND_COLS, 'Could not load inventory', loadInventory);

  const rows  = d.rows || d || [];
  const total = Number(d.total ?? rows.length);

  if(!rows.length && ONHAND_OFFSET > 0 && total > 0){   // stranded past the last page
    ONHAND_OFFSET = 0;
    return loadInventory();
  }

  uiTable('invListWrap', {
    columns: ONHAND_COLS, rows, rowKey: 'id',
    sortable: true, sortKey: ONHAND_SORT, sortDir: ONHAND_DIR,
    onSort: invSetSort,          // server-side — sorting one page would lie
    onRowClick: r => openInventoryDetail(r.id),
    empty: (s || st || cl) ? 'No inventory matches that filter.' : 'No inventory on hand.',
  });

  uiPager('invPager', {
    total, limit: ONHAND_LIMIT, offset: ONHAND_OFFSET,
    noun: 'inventory rows', onChange: invSetPage,
  });

  // Break buttons sit inside clickable rows — don't let them open the detail.
  document.getElementById('invListWrap').querySelectorAll('.js-break-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      try { openCaseBreakFor(JSON.parse(btn.dataset.payload)); }
      catch(err){ uiToast('Could not read that row', 'error'); }
    }));
}

// =============================================================================
// CASE BREAK
// =============================================================================
let cbSelectedLp = null;
let cbLocsList   = [];
let CB_M         = null;   // open case-break uiModal
let CB_SUBMIT    = null;   // its "Break cases" action button

function openCaseBreakFor(r){
  showCaseBreakModal().then(() => selectCBLp(r));
}

async function showCaseBreakModal(){
  cbSelectedLp = null;

  CB_M = uiModal({
    title: 'Case break',
    width: 680,
    body: `
      <div class="ui-dialog-body" style="margin-bottom:14px;">
        Break cases into eaches. Find the case license plate, say how many cases to break, and pick the
        target pick-face location. The case pack quantity comes from the SKU configuration.
      </div>
      <div class="ui-field" data-field="cbLpSearch">
        <label class="ui-label" for="cbLpSearch">License plate</label>
        <input type="text" class="ui-input" id="cbLpSearch" placeholder="Type a license plate number…" autocomplete="off">
        <div class="ui-field-err" style="display:none;"></div>
      </div>
      <div id="cbLpResults" class="cb-results"></div>
      <div id="cbLpDetail" class="cb-lp" style="display:none;"></div>
      <div id="cbForm" style="display:none;">
        <div class="ui-field-row">
          <div class="ui-field" data-field="cbQty">
            <label class="ui-label" for="cbQty">Cases to break</label>
            <input type="number" class="ui-input" id="cbQty" min="1" value="1">
            <div class="ui-hint" id="cbPreview"></div>
            <div class="ui-field-err" style="display:none;"></div>
          </div>
          <div class="ui-field" data-field="cbLocationWrap">
            <label class="ui-label">Target location (pick face)</label>
            <div class="cb-wrap" id="cbLocationWrap"></div>
            <div class="ui-field-err" style="display:none;"></div>
          </div>
        </div>
      </div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Break cases', primary: true, onClick: submitCaseBreak },
    ],
    onClose: () => { CB_M = null; CB_SUBMIT = null; cbSelectedLp = null; },
  });

  CB_SUBMIT = [...CB_M.el.querySelectorAll('.ui-dialog-actions button')]
    .find(b => b.textContent.includes('Break cases'));
  if(CB_SUBMIT) CB_SUBMIT.disabled = true;   // nothing to break until an LP is chosen

  document.getElementById('cbLpSearch').addEventListener('input', searchCBLps);
  document.getElementById('cbQty').addEventListener('input', updateCBPreview);

  if(!cbLocsList.length){
    const l = await apiGet('/locations');
    if(l?.length) cbLocsList = l.map(x => ({ id: x.id, code: x.code, zone: x.zone_name }));
  }
  initCombo('cbLocationWrap',
    cbLocsList.map(l => ({ value: String(l.id), label: l.code, sub: l.zone || '' })),
    { placeholder: 'Select location…' });
}

/* The LP search used to pull `/inventory?limit=200` and filter in the browser —
 * so it only ever searched the first 200 rows of the whole warehouse, sorted by
 * expiry. An LP outside that window simply "did not exist". The API's skuCode
 * filter already matches lp_number (and sku, name, lot, location), so search
 * server-side and let the DB find it. */
const searchCBLps = debounce(async function(){
  const s   = document.getElementById('cbLpSearch')?.value.trim();
  const div = document.getElementById('cbLpResults');
  if(!div) return;
  if(!s || s.length < 2){ div.style.display = 'none'; return; }

  div.style.display = 'block';
  div.innerHTML = uiSpinner('Searching…');

  const qs = new URLSearchParams({
    skuCode: '%' + s + '%', status: 'available', limit: 50,
  });
  const d = await apiGet(`/inventory?${qs.toString()}`);
  const rows = (d?.rows || d || []);

  // Case LPs only — an each/pallet LP can't be case-broken.
  const seen = new Set();
  const matches = rows.filter(r => {
    if(!r.lp_number || !r.lp_number.toLowerCase().includes(s.toLowerCase())) return false;
    if((r.sku_type !== 'CASE' && r.uom !== 'CASE') || Number(r.quantity) <= 0) return false;
    if(seen.has(r.lp_number)) return false;
    seen.add(r.lp_number);
    return true;
  });

  if(!matches.length){
    div.innerHTML = uiEmpty(`No available case license plates matching “${s}”`);
    return;
  }

  div.innerHTML = matches.map(r => `
    <div class="cb-row js-cb-lp-row" data-payload='${esc(JSON.stringify({
      lp_id: r.lp_id || null, id: r.id, lp_number: r.lp_number,
      sku_code: r.sku_code, sku_name: r.sku_name || '',
      sku_type: r.sku_type || r.uom, quantity: Number(r.quantity),
      lot_number: r.lot_number || null, location_code: r.location_code || '',
    }))}'>
      <span class="lp-badge lp-original">${esc(r.lp_number)}</span>
      ${uiId(r.sku_code)}
      <span class="cb-row-name">${esc(r.sku_name || '')}</span>
      <span>${uiNum(r.quantity)} cases</span>
      <span class="ui-muted">${esc(r.location_code || '')}</span>
    </div>`).join('');

  div.querySelectorAll('.js-cb-lp-row').forEach(row =>
    row.addEventListener('click', () => {
      try { selectCBLp(JSON.parse(row.dataset.payload)); }
      catch(e){ uiToast('Could not read that license plate row', 'error'); }
    }));
}, 300);

function selectCBLp(r){
  cbSelectedLp = r;
  document.getElementById('cbLpResults').style.display = 'none';
  document.getElementById('cbLpSearch').value = r.lp_number;
  document.getElementById('cbForm').style.display = '';
  if(CB_SUBMIT) CB_SUBMIT.disabled = false;

  const detail = document.getElementById('cbLpDetail');
  detail.style.display = '';
  detail.innerHTML = `
    <div class="cb-lp-head">
      <span class="lp-badge lp-original">${esc(r.lp_number)}</span>
      ${uiId(r.sku_code)}
      <span class="ui-muted">${esc(r.sku_name || '')}</span>
      <span style="flex:1"></span>
      <span class="ui-chip ui-chip-info">${esc(r.quantity)} cases on hand</span>
    </div>
    ${uiMeta([
      { k: 'Lot', v: r.lot_number ? uiId(r.lot_number) : '<span class="ui-muted">—</span>' },
      { k: 'Location', v: r.location_code ? uiId(r.location_code) : '<span class="ui-muted">—</span>' },
      { k: 'SKU type', v: esc(r.sku_type || r.uom || 'CASE') },
      { k: 'Each SKU', v: '<span class="ui-muted">resolved from the item settings</span>' },
    ])}`;

  const qty = document.getElementById('cbQty');
  qty.max = r.quantity;
  qty.value = 1;
  updateCBPreview();
}

function updateCBPreview(){
  if(!cbSelectedLp) return;
  const qty = parseInt(document.getElementById('cbQty').value) || 0;
  const max = Number(cbSelectedLp.quantity);
  const preview = document.getElementById('cbPreview');
  if(qty > max){
    preview.innerHTML = `<span class="ui-err-text">Only ${esc(max)} case${max === 1 ? '' : 's'} on this license plate</span>`;
    return;
  }
  if(qty <= 0){ preview.textContent = 'Enter at least 1 case'; return; }
  const left = max - qty;
  preview.innerHTML = `Breaks <strong>${esc(qty)}</strong> case${qty > 1 ? 's' : ''} into eaches at the target location · <strong>${esc(left)}</strong> case${left !== 1 ? 's' : ''} left on this LP`;
}

// uiModal action — returning false keeps the modal open.
async function submitCaseBreak(m){
  if(!cbSelectedLp){ uiToast('Find and select a case license plate first', 'error'); return false; }
  const qty   = parseInt(document.getElementById('cbQty').value) || 0;
  const locId = cbVal('cbLocationWrap');

  uiFieldError(m.el, 'cbQty', qty > 0 ? '' : 'Enter at least 1 case');
  uiFieldError(m.el, 'cbLocationWrap', locId ? '' : 'Pick a target location');
  if(qty > Number(cbSelectedLp.quantity)){
    uiFieldError(m.el, 'cbQty', `Only ${cbSelectedLp.quantity} cases on this license plate`);
    return false;
  }
  if(qty <= 0 || !locId) return false;

  const lpId = cbSelectedLp.lp_id || cbSelectedLp.id;
  if(!lpId){ uiToast('That row has no license plate ID, so it can\'t be case-broken', 'error'); return false; }

  const r = await fetch(`${API}/inventory/case-break`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ caseLpId: lpId, caseQuantity: qty, toLocationId: locId }),
  });
  const d = await r.json();
  if(!r.ok){ uiToast(d.error || 'Case break failed', 'error'); return false; }

  const remaining = Number(cbSelectedLp.quantity) - qty;
  const childLp = d.childLpNumber || d.toLpNumber;
  uiToast(
    `Broke ${d.casesRemoved || qty} case${qty > 1 ? 's' : ''} of ${d.caseSku || cbSelectedLp.sku_code}` +
    (d.eachesCreated ? ` → ${d.eachesCreated} EA` : '') +
    (childLp ? ` on ${childLp}` : '') +
    ` · ${remaining} case${remaining !== 1 ? 's' : ''} left`);
  loadInventory();
}

// =============================================================================
// NEW / EDIT ITEM (SKU) MODAL — same modal handles both create and edit.
// =============================================================================

let _editingItemId = null;   // null = create, string = edit
let _itemClientHazmatMap = {}; // {clientId -> hazmat_enabled} for prompting
let _itemClientLotMap    = {}; // {clientId -> lot_tracking_enabled} for SKU lock
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

/* The item form's markup lives here now (D4d-2), not in index.html. That is
 * not cosmetic: the old fixed modal had to be SCRUBBED on every open, and the
 * scrub kept missing things — a sticky SDS-Intel panel made every item look
 * like it had a pending review, a staged SDS file could ride along to a
 * different item, and a stale Base SKU Code bled from an edit into the next
 * New Item. A modal built fresh each open cannot leak state between items, so
 * all of that reset code is simply gone. */
function itemFormBody(){
  return `
    <div class="ui-label">Basics</div>
    <div class="ui-field" data-field="itemClientWrap">
      <label class="ui-label">Client *</label>
      <div class="cb-wrap" id="itemClientWrap"></div>
      <div class="ui-field-err" style="display:none;"></div>
    </div>
    ${uiField({ id: 'itemCode', label: 'Base SKU code *',
                placeholder: 'ACM-1234', hint: 'Auto-fills the level codes below. Barcodes live under Identifiers & pack levels.' })}
    ${uiField({ id: 'itemName', label: 'Name *', placeholder: 'e.g. Vitamin C 500mg, 60-count bottle' })}
    ${uiField({ id: 'itemDescription', label: 'Description', placeholder: 'Long-form description (optional)' })}
    <div class="ui-field">
      <label class="ui-label">UOM</label>
      <div class="cb-wrap" id="itemUomWrap"></div>
    </div>

    <div class="eo-section">
      <div class="item-sec-head">
        <div class="ui-label">Handling units</div>
        <span class="ui-hint">One row per level you stock. Each level has its OWN barcode — a case code never doubles as the each UPC — plus dimensions, weight, NMFC and freight class.</span>
        <span style="flex:1"></span>
        <button type="button" class="ui-btn" id="itemHuAddBtn">+ Add level</button>
      </div>
      <div id="itemHuList"></div>
      <div id="itemHuEditNote" class="ui-hint" style="display:none;margin-top:6px;"></div>
    </div>

    <div class="eo-section" id="itemIdnSection">
      <div class="item-sec-head">
        <div class="ui-label">Identifiers &amp; pack levels</div>
        <span class="ui-hint">Barcodes on the sellable unit (each). The first UPC, GTIN or ASIN is the primary — labels and scans resolve to it.</span>
        <span style="flex:1"></span>
        <button type="button" class="ui-btn" id="itemIdnAddBtn">+ Add barcode</button>
      </div>
      <div id="itemIdnList" class="idn-list"></div>
      <div class="idn-case">
        <div class="item-sec-head">
          <div class="ui-label">Case pack</div>
          <span class="ui-hint">The case level above the each. Leave blank if the item is never handled by the case.</span>
        </div>
        <div class="idn-case-row">
          ${uiField({ id: 'itemCaseSku', label: 'Case SKU code', placeholder: 'ACM-1234-CS' })}
          ${uiField({ id: 'itemCaseUnits', label: 'Units per case', type: 'number', placeholder: '12' })}
          ${uiField({ id: 'itemCaseBarcode', label: 'Case barcode', placeholder: '10012345678902', hint: '14 digits is kept as a GTIN-14; anything else as a carton code.' })}
        </div>
      </div>
    </div>

    <div class="eo-section">
      <div class="ui-label">Pricing</div>
      <div class="ui-field-row">
        ${uiField({ id: 'itemUnitCost', label: 'Unit cost ($)', type: 'number' })}
        ${uiField({ id: 'itemUnitPrice', label: 'Unit price ($)', type: 'number' })}
      </div>
    </div>

    <div class="eo-section">
      <div class="ui-label">Tracking</div>
      <div class="item-checks">
        <label class="ui-check"><input type="checkbox" id="itemLotTracked"> Lot tracked</label>
        <label class="ui-check inv-ships-as-is"><span class="ui-muted">Ships as-is</span>
          <select class="ui-input" id="itemShipsAsIs" aria-label="Ships as-is">
            <option value="">Client default</option>
            <option value="true">Yes — the unit is its own package</option>
            <option value="false">No — packed into a box</option>
          </select></label>
        <label class="ui-check"><input type="checkbox" id="itemExpiryTracked"> Expiry tracked</label>
        <label class="ui-check ui-check-warn"><input type="checkbox" id="itemHazmat"> ⚠ Hazmat</label>
      </div>
      <div id="itemHazmatHint" class="ui-banner ui-banner-warn" style="display:none;margin-top:8px;">
        This client has hazmat enabled — turn this on if the item is hazardous.
      </div>
    </div>

    <div class="eo-section">
      <div class="ui-label">Special handling instructions</div>
      <input class="ui-input" id="itemSpecialHandling"
             placeholder="Printed on the pick slip and shown on the handheld — e.g. 'Wear gloves', 'Keep upright'">
    </div>

    <div class="eo-section">
      <div class="item-sec-head">
        <div class="ui-label">Safety data sheet</div>
        <span style="flex:1"></span>
        <button type="button" class="ui-btn" id="itemSdsReuseBtn" style="display:none;">Re-read attached SDS</button>
        <button type="button" class="ui-btn" onclick="document.getElementById('itemSdsExtractInput').click()">Upload SDS to auto-fill</button>
        <button type="button" class="ui-btn" id="itemSdsIntelBtn" style="display:none;"
                title="Per-field SDS extraction: versions the SDS, per-field confidence, audit log, queues review items">Full SDS intelligence</button>
        <input type="file" id="itemSdsExtractInput" accept="application/pdf,.pdf" style="display:none;">
        <input type="file" id="itemSdsIntelInput" accept="application/pdf,.pdf" style="display:none;">
      </div>
      <div class="ui-hint">Any product's SDS (PDF). Auto-fill pre-fills the hazmat block if it's hazardous; otherwise it's simply kept on file.</div>
      <div id="itemSdsExtractStatus" class="item-sds-status"></div>
      <div id="itemSdsIntelResult" class="item-sds-intel" style="display:none;"></div>
      <div id="itemSdsCurrentCard" class="item-sds-card" style="display:none;"></div>
    </div>

    <div id="itemHazmatBlock" class="item-hazmat" style="display:none;">
      <div class="ui-label" style="color:var(--st-warn);">⚠ Hazmat details</div>
      <div class="ui-field-row">
        ${uiField({ id: 'itemUnNumber', label: 'UN number *', placeholder: 'e.g. UN1090' })}
        ${uiField({ id: 'itemHazardClass', label: 'Hazard class *', placeholder: 'e.g. 3, 9, 1.4G' })}
      </div>
      ${uiField({ id: 'itemProperShippingName', label: 'Proper shipping name', placeholder: 'e.g. Acetone' })}
      <div class="ui-field-row">
        <div class="ui-field">
          <label class="ui-label">Packing group</label>
          <div class="cb-wrap" id="itemPackingGroupWrap"></div>
        </div>
        <div class="ui-field">
          <label class="ui-label">Restrictions</label>
          <div class="item-checks">
            <label class="ui-check"><input type="checkbox" id="itemGroundOnly"> Ground-only</label>
            <label class="ui-check"><input type="checkbox" id="itemLimitedQty"> Limited quantity</label>
          </div>
        </div>
      </div>
      ${uiField({ id: 'itemHazmatNotes', label: 'Hazmat notes' })}
    </div>

    <div id="itemDocsSection" class="eo-section">
      <div class="item-sec-head">
        <div class="ui-label">Documents</div>
        <span class="ui-hint">SDS, product photos, spec sheets</span>
        <span style="flex:1"></span>
        <button type="button" class="ui-btn" id="itemDocAddBtn">Attach file</button>
        <input type="file" id="itemDocAddInput" multiple style="display:none;"
               accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,application/pdf,image/*">
      </div>
      <div id="itemDocsBody"></div>
    </div>

    <div id="itemAuditBlock" class="eo-section" style="display:none;">
      <div class="item-sec-head" style="cursor:pointer;" onclick="toggleSkuAuditPanel()">
        <div class="ui-label">Compliance audit</div>
        <span class="ui-hint" id="itemAuditCount"></span>
        <span style="flex:1"></span>
        <span class="ui-hint" id="itemAuditToggle">▾ Show</span>
      </div>
      <div id="itemAuditBody" class="item-audit" style="display:none;"></div>
    </div>`;
}

let ITEM_M = null;   // open item-form uiModal

async function openItemFormModal(skuId){
  _editingItemId = skuId || null;

  // Fresh DOM each open — no scrubbing, so no state can leak between items.
  ITEM_M = uiModal({
    title: skuId ? 'Edit item' : 'New item',
    width: 820,
    body: itemFormBody(),
    actions: [
      { label: 'Cancel' },
      { label: skuId ? 'Save changes' : 'Create item', primary: true, onClick: submitItemForm },
    ],
    onClose: () => {
      ITEM_M = null;
      // Staged files die with the modal — they belonged to this item only.
      _itemPendingSds = null;
      _itemPendingDocs = [];
    },
  });

  _itemPendingSds  = null;
  _itemPendingDocs = [];

  // Compliance audit + current SDS — edit mode only (both need a sku_id).
  if(skuId){
    if(typeof loadSkuComplianceAudit === 'function') loadSkuComplianceAudit(skuId);
    if(typeof loadSkuCurrentSds === 'function') loadSkuCurrentSds(skuId);
  }

  // Make sure clientsCache is populated for the dropdown
  await loadCC();

  // Build clientId -> hazmat_enabled map so onChange we can prompt
  _itemClientHazmatMap = {};
  _itemClientLotMap    = {};
  for(const c of clientsCache){
    _itemClientHazmatMap[c.id] = !!c.hazmat_enabled;
    _itemClientLotMap[c.id]    = !!c.lot_tracking_enabled;
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

  // Wire hazmat checkbox to reveal block (idempotent). Toggling hazmat
  // on also auto-checks Lot tracked + Expiry tracked since hazmat items
  // basically always require traceability — ops can untick if needed.
  const haz = document.getElementById('itemHazmat');
  if(!haz._wired){
    haz._wired = true;
    haz.addEventListener('change', () => {
      document.getElementById('itemHazmatBlock').style.display = haz.checked ? 'block' : 'none';
      if(haz.checked){
        const lot = document.getElementById('itemLotTracked');
        const exp = document.getElementById('itemExpiryTracked');
        if(lot && !lot.checked) lot.checked = true;
        if(exp && !exp.checked) exp.checked = true;
      }
    });
  }

  // Wire + Add Level — works in both create AND edit mode now. In edit
  // mode the new unit is tagged _isNew=true and gets POSTed to
  // /skus/:anchor/handling-units on save with proper parent linkage
  // (see addHandlingUnit + submitItemForm).
  const huAddBtn = document.getElementById('itemHuAddBtn');
  if(huAddBtn && !huAddBtn._wired){
    huAddBtn._wired = true;
    huAddBtn.addEventListener('click', () => {
      // Pick a sensible default level for the next row. Most warehouses
      // skip INNER_PACK (it's a niche level used mostly in retail/CPG)
      // and go directly EACH <-> CASE. We try in order: CASE if EACH
      // exists, EACH if CASE exists, then PALLET, then INNER_PACK as
      // a last resort. User can always change the dropdown manually.
      const used = new Set(_itemHandlingUnits.map(h => h.sku_type));
      const order = used.has('EACH')       ? ['CASE','PALLET','INNER_PACK','EACH']
                  : used.has('CASE')       ? ['EACH','PALLET','INNER_PACK','CASE']
                  : used.has('PALLET')     ? ['CASE','EACH','INNER_PACK','PALLET']
                  : used.has('INNER_PACK') ? ['EACH','CASE','PALLET','INNER_PACK']
                  :                          ['EACH','CASE','PALLET','INNER_PACK'];
      const next = order.find(t => !used.has(t)) || 'EACH';
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

  // Wire "Full SDS Intelligence" — only enabled in edit mode (we need a
  // real sku id for the versioned upload). New per-field pipeline:
  // versions the SDS doc, runs Claude with per-field confidence + source
  // attribution, auto-applies high-confidence fields directly to the SKU
  // master, queues review_high/review_low items for the compliance page.
  const intelBtn = document.getElementById('itemSdsIntelBtn');
  const intelInput = document.getElementById('itemSdsIntelInput');
  if(intelBtn && !intelBtn._wired){
    intelBtn._wired = true;
    intelBtn.addEventListener('click', () => intelInput.click());
  }
  if(intelInput && !intelInput._wired){
    intelInput._wired = true;
    intelInput.addEventListener('change', e => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if(file && _editingItemId) runSdsIntelExtract(_editingItemId, file);
    });
  }
  // Reveal the Intel button only in edit mode
  if(intelBtn){
    intelBtn.style.display = _editingItemId ? '' : 'none';
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
            uiToast(`${f.name} is ${(f.size / 1048576).toFixed(1)}MB — 25MB max`, 'error');
            continue;
          }
          _itemPendingDocs.push(f);
        }
        renderItemPendingDocs();
      }
    });
  }

  _itemHandlingUnits = [];
  _itemIdentifiers = [];
  _itemCaseBarcode = '';
  _itemCaseTouched = false;
  _itemIdnLoaded = !skuId;     // create mode has nothing to load; edit mode flips this after GET

  if(skuId){
    // Edit mode — fetch and populate
    const sku = await apiGet(`/skus/${skuId}`);
    if(!sku){
      uiToast('Could not load that item', 'error');
      ITEM_M?.close();
      return;
    }
    cbSet('itemClientWrap', String(sku.client_id),
      (clientsCache.find(c => c.id === sku.client_id)?.code || '') + ' — ' +
      (clientsCache.find(c => c.id === sku.client_id)?.name || ''));
    document.getElementById('itemName').value         = sku.name || '';
    document.getElementById('itemDescription').value  = sku.description || '';
    cbSet('itemUomWrap',  sku.uom || 'EA');
    document.getElementById('itemUnitCost').value     = sku.unit_cost ?? '';
    document.getElementById('itemUnitPrice').value    = sku.unit_price ?? '';
    document.getElementById('itemLotTracked').checked    = !!sku.is_lot_tracked;
    document.getElementById('itemShipsAsIs').value       = sku.ships_as_is == null ? '' : String(!!sku.ships_as_is);
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

    // Pre-fill the Base SKU Code field with the existing sku_code. In
    // edit mode there's only one handling unit, so the base code IS the
    // SKU code — keeping the two in sync (via _autoSync=true on the loaded
    // unit) means typing in either field updates the saved value. Without
    // this, the user types into Base SKU Code, the handling unit row
    // doesn't auto-update, and Save sends the unchanged old code.
    document.getElementById('itemCode').value = sku.sku_code || '';

    // Edit mode now loads the entire SKU family (parent chain +
    // descendants) so ops can see all handling-unit levels of the item
    // and add new ones if needed (e.g. SKU was created as EACH but
    // arrives in cases of 12, so they need to add a CASE level above).
    // 078: /levels returns every level with its own barcode + identifiers.
    const lv = await apiGet(`/skus/${skuId}/levels`);
    const family = lv?.rows && lv.rows.length ? null : await apiGet(`/skus/${skuId}/family`);
    const members = lv?.rows && lv.rows.length
      ? lv.rows.map(l => ({ id: l.id, sku_type: l.skuType, sku_code: l.skuCode, units_per_case: l.packQty, upc: l.upc, _identifiers: l.identifiers,
                            length_in: l.length_in, width_in: l.width_in, height_in: l.height_in, weight_lbs: l.weight_lbs, nmfc_code: l.nmfc_code, freight_class: l.freight_class }))
      : (family?.members && family.members.length ? family.members : [sku]);
    // dims / freight live on the full sku rows — merge them in from the family call when /levels was used
    if(lv?.rows && lv.rows.length){
      const fam2 = await apiGet(`/skus/${skuId}/family`);
      for(const m of members){ const full = (fam2?.members || []).find(x => x.id === m.id) || (m.id === sku.id ? sku : null); if(full){ m.length_in = full.length_in; m.width_in = full.width_in; m.height_in = full.height_in; m.weight_lbs = full.weight_lbs; m.nmfc_code = full.nmfc_code; m.freight_class = full.freight_class; } }
    }
    for (const m of members) {
      _itemHandlingUnits.push({
        _id:           m.id,                // existing SKU id
        _isNew:        false,
        _autoSync:     m.id === sku.id,     // only the anchor's code follows the base field
        _identifiers:  m._identifiers || [],
        upc:           m.upc || '',
        sku_type:      m.sku_type || 'EACH',
        sku_code:      m.sku_code || '',
        pack_qty:      m.units_per_case ?? null,
        length_in:     m.length_in ?? null,
        width_in:      m.width_in ?? null,
        height_in:     m.height_in ?? null,
        weight_lbs:    m.weight_lbs ?? null,
        nmfc_code:     m.nmfc_code || '',
        freight_class: m.freight_class || '',
      });
    }
    // Identifiers & pack levels — the EACH's barcodes + the CASE's one barcode.
    // If this GET fails we must NOT save an empty list later (that would wipe
    // every barcode), so _itemIdnLoaded gates the PUT in submitItemForm.
    const idn = await apiGet(`/skus/${skuId}/identifiers`);
    if(idn && Array.isArray(idn.levels)){
      const eachLvl = idn.levels.find(l => l.id === idn.each_id) || idn.levels.find(l => l.sku_type === 'EACH') || idn.levels.find(l => l.id === skuId);
      _itemIdentifiers = (eachLvl?.identifiers || []).map(x => ({ id: x.id, type: x.type, value: x.value, source: x.source, read_only: !!x.read_only }));
      const caseLvl = idn.levels.find(l => l.id === idn.case_id);
      if(caseLvl){
        // One "case barcode": the GTIN column first, then a carton code, then a legacy upc.
        const pick = (t, s) => (caseLvl.identifiers || []).find(x => x.type === t && (!s || s.includes(x.source)));
        const cb = pick('gtin', ['sync', 'backfill']) || pick('carton_barcode') || pick('upc', ['sync', 'backfill']) || pick('gtin');
        _itemCaseBarcode = cb ? cb.value : '';
      }
      _itemIdnLoaded = true;
    } else {
      uiToast('Could not load this item\'s barcodes — they will not be changed by Save', 'error');
    }
    // Multi-handling-unit edit: + Add Level button stays visible in
    // edit mode now. Uses POST /skus/:id/handling-units to attach a
    // new level with proper parent linkage.
    huAddBtn.style.display = '';
    document.getElementById('itemHuEditNote').style.display = 'none';
    loadItemAttachmentsList(skuId);
  } else {
    // Create mode. The form is already empty — it was built a moment ago —
    // so there is nothing to reset. Just seed the default level.
    // _autoSync=true keeps the unit's sku_code in step with the Base SKU Code
    // field as the user types (until they edit the unit's code by hand).
    _itemHandlingUnits.push({
      sku_type:'EACH', sku_code:'', pack_qty:1,
      _autoSync: true,
      length_in:null, width_in:null, height_in:null, weight_lbs:null,
      nmfc_code:'', freight_class:'',
    });
    huAddBtn.style.display = '';
  }
  await renderHandlingUnits();
  _wireBaseCodeAutofill();
  renderItemIdentifiers();
  renderCasePack();
  _wireIdentifiersSection();
  if(!skuId) renderItemPendingDocs();
}

// When a client is picked, surface a hint if that client has hazmat
// enabled at the company level — nudges ops to flip the per-item
// hazmat checkbox if relevant.
function onItemClientChange(){
  const cid  = cbVal('itemClientWrap');
  const hint = document.getElementById('itemHazmatHint');
  hint.style.display = (cid && _itemClientHazmatMap[cid]) ? 'block' : 'none';

  // Lot tracking mandate: if the selected client has lot_tracking_enabled,
  // force-check the per-SKU Lot tracked checkbox + disable it so the user
  // can't uncheck. The backend enforces this independently — UI just
  // mirrors so the user understands what's happening.
  const lotInp = document.getElementById('itemLotTracked');
  if(lotInp){
    const mandated = !!(cid && _itemClientLotMap[cid]);
    if(mandated){
      lotInp.checked  = true;
      lotInp.disabled = true;
      // Tooltip on the parent label so hover explains why
      lotInp.title = 'This client mandates lot tracking on all SKUs (set on the client record).';
      // Mark the label itself with the mandate so the visual state reads
      const lab = lotInp.closest('label');
      if(lab) lab.style.opacity = '0.85';
    } else {
      lotInp.disabled = false;
      lotInp.title = '';
      const lab = lotInp.closest('label');
      if(lab) lab.style.opacity = '';
    }
  }
}

// uiModal action — returning false keeps the modal open.
async function submitItemForm(m){
  const numOrNull = (id) => {
    const v = document.getElementById(id).value.trim();
    return v === '' ? null : Number(v);
  };

  const clientId = cbVal('itemClientWrap');
  const baseCode = document.getElementById('itemCode').value.trim().toUpperCase();
  const name     = document.getElementById('itemName').value.trim();

  // Errors land on the field that caused them, not in one red line at the
  // bottom of an 820px form the user has to hunt through.
  uiFieldError(m.el, 'itemClientWrap', clientId ? '' : 'Pick a client');
  uiFieldError(m.el, 'itemCode', baseCode ? '' : 'Base SKU code is required');
  uiFieldError(m.el, 'itemName', name ? '' : 'Name is required');
  if(!clientId || !baseCode || !name) return false;

  if(!_itemHandlingUnits.length){
    uiToast('Add at least one handling unit', 'error');
    return false;
  }
  for(const hu of _itemHandlingUnits){
    if(!hu.sku_code || !hu.sku_code.trim()){
      uiToast(`The ${hu.sku_type} level needs a SKU code`, 'error');
      return false;
    }
    if(!hu.sku_type){
      uiToast('Every handling unit needs a level type', 'error');
      return false;
    }
  }

  // Common attributes shared across all levels of this item
  const common = {
    clientId,
    name,
    description:     document.getElementById('itemDescription').value.trim() || null,
    uom:             cbVal('itemUomWrap') || 'EA',
    unitCost:        numOrNull('itemUnitCost'),
    unitPrice:       numOrNull('itemUnitPrice'),
    isLotTracked:    document.getElementById('itemLotTracked').checked,
    shipsAsIs:       document.getElementById('itemShipsAsIs').value === '' ? null : document.getElementById('itemShipsAsIs').value === 'true',
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
    // A hazmat item without a UN number or hazard class is a shipping
    // violation waiting to happen — these are not optional.
    uiFieldError(m.el, 'itemUnNumber', common.unNumber ? '' : 'Required for a hazmat item');
    uiFieldError(m.el, 'itemHazardClass', common.hazardClass ? '' : 'Required for a hazmat item');
    if(!common.unNumber || !common.hazardClass) return false;
  }

  // Identifiers & pack levels payload — validated here for the obvious
  // (half-filled case pack), by the API for the rest (check digits,
  // duplicates). Errors from either land beside the offending input.
  _clearIdentifierErrors(m.el);
  const idnPayload = _identifiersPayload();
  if(idnPayload._error){
    uiFieldError(m.el, idnPayload._error.field, idnPayload._error.msg);
    return false;
  }
  // The EACH's and CASE's barcodes are owned by the identifiers payload, so
  // the level rows must not also PATCH/POST `upc` for them — that would clear
  // the code a moment before the PUT writes it back.
  const levelUpc = (hu) => (hu.sku_type === 'EACH' || hu.sku_type === 'CASE') ? undefined : ((hu.upc || '').trim() || null);

  try {
    let r, d;
    if(_editingItemId){
      // EDIT MODE — split the units into existing (PATCH) vs new (POST
      // via /skus/:anchor/handling-units). The anchor is the originally-
      // edited SKU id; new units get attached to the family with
      // automatic parent-linkage based on hierarchy.
      const existingUnits = _itemHandlingUnits.filter(hu => hu._id);
      const newUnits      = _itemHandlingUnits.filter(hu => hu._isNew);

      // 1) PATCH each existing unit with its own row's level-specific
      //    fields. Common fields (name, hazmat, notes, etc.) only need
      //    to be patched on the anchor — no point sending the same
      //    name to every sibling.
      let lastResp = null;
      for (const hu of existingUnits) {
        const isAnchor = hu._id === _editingItemId;
        const patchBody = Object.assign(
          {},
          isAnchor ? common : {},     // only anchor receives common fields
          {
            skuCode:      hu.sku_code.trim().toUpperCase(),
            skuType:      hu.sku_type,
            ...(levelUpc(hu) === undefined ? {} : { upc: levelUpc(hu) }),
            unitsPerCase: hu.pack_qty,
            lengthIn:     hu.length_in,
            widthIn:      hu.width_in,
            heightIn:     hu.height_in,
            weightLbs:    hu.weight_lbs,
            nmfcCode:     hu.nmfc_code || null,
            freightClass: hu.freight_class || null,
          }
        );
        const rr = await fetch(`${API}/skus/${hu._id}`, {
          method:'PATCH', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
          body: JSON.stringify(patchBody),
        });
        const dd = await rr.json();
        if(!rr.ok){
          uiToast(dd.error || `Could not update ${hu.sku_code}`, 'error');
          return false;
        }
        lastResp = dd;
      }

      // 2) POST each new unit. Server figures out parent linkage based
      //    on the standard PALLET > CASE > INNER_PACK > EACH hierarchy
      //    and rewires neighbors as needed.
      for (const hu of newUnits) {
        const newBody = {
          sku_type:      hu.sku_type,
          sku_code:      hu.sku_code.trim().toUpperCase(),
          upc:           levelUpc(hu) ?? null,
          pack_qty:      hu.pack_qty,
          length_in:     hu.length_in,
          width_in:      hu.width_in,
          height_in:     hu.height_in,
          weight_lbs:    hu.weight_lbs,
          nmfc_code:     hu.nmfc_code || null,
          freight_class: hu.freight_class || null,
        };
        const rr = await fetch(`${API}/skus/${_editingItemId}/handling-units`, {
          method:'POST', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
          body: JSON.stringify(newBody),
        });
        const dd = await rr.json();
        if(!rr.ok){
          uiToast(dd.error || `Could not add the ${hu.sku_type} level (${hu.sku_code})`, 'error');
          return false;
        }
        lastResp = dd;
        if(hu.sku_type === 'CASE' && dd.inserted) hu._id = dd.inserted.id;   // the case pack PUT below finds it by family, but keep state honest
      }

      // 3) Barcodes + case pack in ONE call on the EACH (any level id works —
      //    the API walks the family). Skipped when the GET failed on open, so
      //    a blank list can never overwrite real barcodes.
      if(_itemIdnLoaded){
        const eachHu = _itemHandlingUnits.find(hu => hu.sku_type === 'EACH' && hu._id);
        const rr = await fetch(`${API}/skus/${eachHu ? eachHu._id : _editingItemId}/identifiers`, {
          method:'PUT', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
          body: JSON.stringify({ identifiers: idnPayload.identifiers, case_pack: idnPayload.case_pack }),
        });
        const dd = await rr.json().catch(() => ({}));
        if(!rr.ok){
          _showIdentifierError(m.el, dd, idnPayload);
          uiToast(`Item saved, but the barcodes were not: ${dd.error || 'save failed'}`, 'error');
          if(typeof loadInventory === 'function') loadInventory();
          if(typeof refreshClientItemsIfOpen === 'function') refreshClientItemsIfOpen();
          return false;
        }
      }

      r = { ok: true };  // shape so the success branch below doesn't choke
      d = lastResp || {};
    } else {
      // CREATE MODE — POST /items handles both single-level and multi-
      // level. Server creates parent + linked children in order, then the
      // identifiers + case pack in the same transaction — one save, and a
      // barcode 409 leaves no half-made item behind.
      const createBody = Object.assign({}, common, {
        identifiers: idnPayload.identifiers,
        case_pack:   idnPayload.case_pack,
        handlingUnits: _itemHandlingUnits.map(hu => ({
          sku_type:      hu.sku_type,
          sku_code:      hu.sku_code.trim().toUpperCase(),
          upc:           levelUpc(hu) ?? null,
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
      if(!r.ok) _showIdentifierError(m.el, d, idnPayload);
    }
    if(!r.ok){ uiToast(d.error || 'Save failed', 'error'); return false; }
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

    // Any other documents the user staged via Attach File before
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

    uiToast(_editingItemId ? 'Item saved' : `Item ${baseCode} created`);

    // Refresh whichever list is actually on screen — the user could be on
    // Inventory OR on a client's Item Master tab. Refresh only one and the
    // other shows stale rows.
    // NOTE: ask clients.js, don't test for one of its element ids here. The old
    // code guarded on #cliItemsBody, so renaming that element (D5b) silently
    // disabled this refresh — no crash, just the stale rows it exists to prevent.
    if(typeof loadInventory === 'function') loadInventory();
    if(typeof refreshClientItemsIfOpen === 'function') refreshClientItemsIfOpen();
  } catch(e){
    uiToast('Network error — the item was not saved', 'error');
    return false;
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
  // For a single-level item the unit code defaults to the base code with
  // no suffix — that's the user's actual SKU. For multi-level items each
  // level gets a suffix (CS, EA, etc.) so codes are unique across the
  // family. _autoSync tracks whether typing in the base code field
  // should keep updating this unit's code (cleared when user edits the
  // unit code directly).
  // _isNew=true marks units added in EDIT mode — they get POSTed via
  // /skus/:anchor/handling-units instead of PATCHed.
  const isFirstAndOnly = _itemHandlingUnits.length === 0;
  _itemHandlingUnits.push({
    sku_type:      skuType,
    sku_code:      baseCode
      ? (isFirstAndOnly ? baseCode : `${baseCode}-${suffix}`)
      : '',
    _isNew:        !!_editingItemId,        // edit mode + new unit → POST on save
    _autoSync:     true,
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
          <label class="form-label">SKU code *</label>
          <input class="form-input js-hu-code" data-idx="${esc(i)}" value="${esc(hu.sku_code || '')}" placeholder="auto-filled from base code">
        </div>
        <div style="width:110px;">
          <label class="form-label" title="Number of EACH inside this level. e.g. a Case of 12 means pack qty 12 on the Case level (and 1 on the Each level).">Qty per parent <span style="color:var(--muted);font-weight:400;font-size:10px;">(qty inside)</span></label>
          <input class="form-input js-hu-pack" data-idx="${esc(i)}" type="number" min="0" step="1" value="${hu.pack_qty == null ? '' : esc(hu.pack_qty)}" placeholder="${hu.sku_type === 'EACH' ? '1' : 'e.g. 12'}">
        </div>
        ${hu.sku_type === 'EACH' || hu.sku_type === 'CASE'
          ? `<div style="min-width:170px;">
              <label class="form-label">Barcode</label>
              <div class="ui-hint idn-hu-note">${hu.sku_type === 'EACH' ? 'Identifiers & pack levels ↓' : 'Case pack ↓'}</div>
            </div>`
          : `<div style="min-width:170px;">
              <label class="form-label">Barcode <span style="color:var(--muted);font-weight:400;font-size:10px;">(UPC / EAN / GTIN)</span></label>
              <input class="form-input ui-mono js-hu-upc" data-idx="${esc(i)}" value="${esc(hu.upc || '')}" placeholder="012345678905">
            </div>`}
        ${(!editing || hu._isNew) ? `<button type="button" class="btn btn-ghost js-hu-rm" data-idx="${esc(i)}" style="color:var(--red);padding:6px 10px;font-size:14px;" title="${editing ? 'Remove this new level — existing levels cannot be removed here' : 'Remove this level'}">✕</button>` : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">L (in)</label><input class="form-input js-hu-len" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.length_in == null ? '' : esc(hu.length_in)}"></div>
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">W (in)</label><input class="form-input js-hu-wid" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.width_in == null ? '' : esc(hu.width_in)}"></div>
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">H (in)</label><input class="form-input js-hu-hgt" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.height_in == null ? '' : esc(hu.height_in)}"></div>
        <div style="width:110px;"><label class="form-label" style="font-size:11px;">Weight (lbs)</label><input class="form-input js-hu-wt" data-idx="${esc(i)}" type="number" min="0" step="0.01" value="${hu.weight_lbs == null ? '' : esc(hu.weight_lbs)}"></div>
        <div style="width:140px;"><label class="form-label" style="font-size:11px;">NMFC</label><input class="form-input js-hu-nmfc" data-idx="${esc(i)}" value="${esc(hu.nmfc_code || '')}" placeholder="156600"></div>
        <div style="width:90px;"><label class="form-label" style="font-size:11px;">Class</label><input class="form-input js-hu-fc" data-idx="${esc(i)}" value="${esc(hu.freight_class || '')}" placeholder="60"></div>
        <div style="display:flex;flex-direction:column;justify-content:flex-end;gap:2px;">
          <button type="button" class="btn btn-ghost js-hu-calc" data-idx="${esc(i)}" style="padding:6px 10px;font-size:11px;color:var(--blue);" title="Calculate freight class from density">Calc class</button>
          <span class="js-hu-density" data-idx="${esc(i)}" style="font-size:10px;color:var(--text2);text-align:center;"></span>
        </div>
      </div>
      ${hu.sku_type === 'EACH' ? '' : `<div class="hu-codes">
        <span class="ui-label">Other codes</span>
        ${(hu._identifiers || []).filter(x => x.source === 'manual').map(x => `<span class="ui-chip ui-chip-neutral hu-code">${esc(x.type)} · <span class="ui-mono">${esc(x.value)}</span> <button type="button" class="hu-code-rm js-hu-code-rm" data-idx="${esc(i)}" data-ident="${esc(x.id)}" aria-label="Remove">✕</button></span>`).join('')}
        ${hu._id ? `<span class="hu-code-add">
            <select class="form-input js-hu-code-type" data-idx="${esc(i)}">
              <option value="carton_barcode">case code</option><option value="alias">alt</option><option value="customer_barcode">customer barcode</option><option value="customer_sku">customer SKU</option><option value="gtin">GTIN</option>
            </select>
            <input class="form-input ui-mono js-hu-code-val" data-idx="${esc(i)}" placeholder="code">
            <button type="button" class="btn btn-ghost js-hu-code-add" data-idx="${esc(i)}">+ Add</button>
          </span>` : '<span class="ui-hint">Save the item to add other codes to this level</span>'}
      </div>`}
    </div>
  `).join('');

  // Init level combo for each row. When the level changes on a row
  // that's still auto-sync'd to the base code (i.e. user hasn't manually
  // edited the sku_code), refresh the suffix so the code matches the
  // new level. Without this, picking "Case" after the row defaulted
  // to "Inner Pack" leaves the code stuck at "...-IP".
  for(let i = 0; i < _itemHandlingUnits.length; i++){
    initCombo(`huType_${i}`, typeOptions, {
      placeholder:'Each',
      value: _itemHandlingUnits[i].sku_type,
      allowCustom: true,
      onChange: (v) => {
        _itemHandlingUnits[i].sku_type = v;
        // Re-derive sku_code suffix if the row is still in auto-sync
        // mode (user hasn't typed in the code field directly).
        const hu = _itemHandlingUnits[i];
        if(hu._autoSync){
          const base = document.getElementById('itemCode').value.trim();
          const suffix = SKU_TYPE_SUFFIX[v] || (v ? v.slice(0,3).toUpperCase() : 'X');
          const oneLevel = _itemHandlingUnits.length === 1;
          hu.sku_code = base ? (oneLevel ? base : `${base}-${suffix}`) : '';
          renderHandlingUnits();
        }
      },
    });
  }

  // Wire input changes. Editing a unit's sku_code directly breaks the
  // auto-sync link with the base code — we won't clobber it on future
  // base code edits.
  wrap.querySelectorAll('.js-hu-code').forEach(inp => inp.addEventListener('input', e => {
    const i = +e.target.dataset.idx;
    _itemHandlingUnits[i].sku_code = e.target.value;
    _itemHandlingUnits[i]._autoSync = false;
    if(_itemHandlingUnits[i].sku_type === 'CASE') renderCasePack();   // the Case pack block mirrors the CASE row
  }));
  wrap.querySelectorAll('.js-hu-upc').forEach(inp => inp.addEventListener('input', e => {
    _itemHandlingUnits[+e.target.dataset.idx].upc = e.target.value.trim();
  }));
  // Other codes: written straight to sku_identifiers for that level (edit mode).
  wrap.querySelectorAll('.js-hu-code-add').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const i = +b.dataset.idx, hu = _itemHandlingUnits[i];
    const type = wrap.querySelector(`.js-hu-code-type[data-idx="${i}"]`).value;
    const value = wrap.querySelector(`.js-hu-code-val[data-idx="${i}"]`).value.trim();
    if(!value) return uiToast('Enter a code', 'error');
    const r = await fetch(`${API}/skus/${hu._id}/identifiers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ type, value }) });
    const d = await r.json().catch(() => ({}));
    if(!r.ok) return uiToast(d.error || 'Could not add that code', 'error');
    hu._identifiers = (hu._identifiers || []).concat([{ id: d.id, type: d.identifier_type, value: d.value, source: d.source }]);
    uiToast(`${value} added to ${hu.sku_code} (${hu.sku_type})`, 'success');
    renderHandlingUnits();
  })));
  wrap.querySelectorAll('.js-hu-code-rm').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const i = +b.dataset.idx, hu = _itemHandlingUnits[i];
    const r = await fetch(`${API}/skus/${hu._id}/identifiers/${b.dataset.ident}`, { method: 'DELETE', headers: { Authorization: `Bearer ${T}` } });
    const d = await r.json().catch(() => ({}));
    if(!r.ok) return uiToast(d.error || 'Could not remove that code', 'error');
    hu._identifiers = (hu._identifiers || []).filter(x => x.id !== b.dataset.ident);
    uiToast('Code removed', 'success');
    renderHandlingUnits();
  })));
  wrap.querySelectorAll('.js-hu-pack').forEach(inp => inp.addEventListener('input', e => {
    const v = e.target.value.trim();
    const hu = _itemHandlingUnits[+e.target.dataset.idx];
    hu.pack_qty = v === '' ? null : Number(v);
    if(hu.sku_type === 'CASE') renderCasePack();
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
  wrap.querySelectorAll('.js-hu-calc').forEach(btn => btn.addEventListener('click', uiBusyHandler(() => {
    const i  = +btn.dataset.idx;
    const hu = _itemHandlingUnits[i];
    const d  = computeDensity(hu.length_in, hu.width_in, hu.height_in, hu.weight_lbs);
    if(d == null){
      return uiToast('Needs length, width, height and weight — all greater than 0 — to compute density', 'error');
    }
    hu.freight_class = String(densityToFreightClass(d));
    renderHandlingUnits();
    uiToast(`Density ${d.toFixed(2)} lb/ft³ → freight class ${hu.freight_class}`);
  })));

  // Remove button (create mode only — editing locks to one row)
  wrap.querySelectorAll('.js-hu-rm').forEach(btn => btn.addEventListener('click', uiBusyHandler(() => {
    if(_itemHandlingUnits.length <= 1){
      return uiToast('An item needs at least one handling unit', 'error');
    }
    const [removed] = _itemHandlingUnits.splice(+btn.dataset.idx, 1);
    if(removed && removed.sku_type === 'CASE'){ _itemCaseBarcode = ''; _itemCaseTouched = true; }
    renderHandlingUnits();
    renderCasePack();
  })));

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

// When ops types in the Base SKU Code field, keep each handling unit's
// sku_code in sync — but only for units the user hasn't manually edited.
// Tracking is via hu._autoSync (true on creation, false once the user
// types into the unit's sku_code input).
//
// For a single-level item the unit code = base code (no suffix), since
// that single level IS the SKU the user means. For multi-level items
// each gets ${base}-${suffix}.
function _wireBaseCodeAutofill(){
  const baseInp = document.getElementById('itemCode');
  if(!baseInp || baseInp._huWired) return;
  baseInp._huWired = true;
  baseInp.addEventListener('input', () => {
    const base = baseInp.value.trim();
    const oneLevel = _itemHandlingUnits.length === 1;
    let mutated = false;
    for(const hu of _itemHandlingUnits){
      // Sync only units that started auto-filled and haven't been
      // manually edited. Edit-mode rows + user-customized create-mode
      // rows are left alone (their _autoSync is unset or false).
      if(hu._autoSync !== true) continue;
      const suffix = SKU_TYPE_SUFFIX[hu.sku_type] || (hu.sku_type ? hu.sku_type.slice(0,3).toUpperCase() : 'X');
      const next = base
        ? (oneLevel ? base : `${base}-${suffix}`)
        : '';
      if(hu.sku_code !== next){
        hu.sku_code = next;
        mutated = true;
      }
    }
    if(mutated) renderHandlingUnits();
  });
}

// =============================================================================
// IDENTIFIERS & PACK LEVELS — the EACH's barcodes and the CASE pack, saved
// through PUT /skus/:id/identifiers (edit) or inside POST /items (create).
// =============================================================================
// Rows in _itemIdentifiers: { id?, type, value, source, read_only }. Synced
// rows the API marks read_only (the SKU code itself) are shown with a tag and
// cannot be edited or removed here; a synced UPC / GTIN / ASIN IS editable —
// it is the item's primary code and the API keeps the column in step.
let _itemIdentifiers = [];
let _itemCaseBarcode = '';      // the CASE level's one barcode (GTIN-14 or carton code)
let _itemCaseTouched = false;   // the user typed in the Case pack block this open
let _itemIdnLoaded   = false;   // GET succeeded (edit) or create mode — gates the PUT

const IDN_TYPE_OPTIONS = [
  { value: 'upc',              label: 'UPC' },
  { value: 'gtin',             label: 'GTIN / EAN' },
  { value: 'asin',             label: 'ASIN' },
  { value: 'customer_sku',     label: 'Customer SKU' },
  { value: 'carton_barcode',   label: 'Carton barcode' },
  { value: 'alias',            label: 'Alias' },
  { value: 'customer_barcode', label: 'Customer barcode' },
  { value: 'internal_sku',     label: 'SKU code' },
];
const IDN_PRIMARY_TYPES = ['upc', 'gtin', 'asin'];
const idnTypeLabel = (t) => (IDN_TYPE_OPTIONS.find(o => o.value === t) || { label: t }).label;

function _caseHu(){ return _itemHandlingUnits.find(h => h.sku_type === 'CASE'); }

function renderItemIdentifiers(){
  const list = document.getElementById('itemIdnList');
  if(!list) return;
  const seenPrimary = new Set();
  const rows = _itemIdentifiers.map((x, i) => {
    const primary = IDN_PRIMARY_TYPES.includes(x.type) && !seenPrimary.has(x.type) && (x.value || '').trim();
    if(primary) seenPrimary.add(x.type);
    const ro = !!x.read_only;
    return `<div class="idn-row${ro ? ' idn-ro' : ''}" data-field="idn_${esc(i)}">
      <select class="ui-input js-idn-type" data-idx="${esc(i)}"${ro ? ' disabled' : ''}>
        ${IDN_TYPE_OPTIONS.filter(o => o.value !== 'internal_sku' || x.type === 'internal_sku')
          .map(o => `<option value="${esc(o.value)}"${o.value === x.type ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
      <input class="ui-input ui-mono js-idn-val" data-idx="${esc(i)}" value="${esc(x.value || '')}" placeholder="scan or type the code"${ro ? ' disabled' : ''}>
      <span class="idn-tags">${ro || (x.source && x.source !== 'manual' && !IDN_PRIMARY_TYPES.includes(x.type)) ? '<span class="idn-tag">synced</span>' : ''}${primary ? '<span class="idn-tag idn-tag-primary">primary</span>' : ''}</span>
      ${ro ? '<span></span>' : `<button type="button" class="idn-rm js-idn-rm" data-idx="${esc(i)}" aria-label="Remove barcode" title="Remove">✕</button>`}
      <div class="ui-field-err" style="display:none;"></div>
    </div>`;
  });
  list.innerHTML = rows.join('') || '<div class="idn-empty">No barcodes yet — add the UPC / EAN the label carries.</div>';

  list.querySelectorAll('.js-idn-type').forEach(sel => sel.addEventListener('change', e => {
    _itemIdentifiers[+e.target.dataset.idx].type = e.target.value;
    renderItemIdentifiers();                      // the primary tag may move
  }));
  // Never rebuild the list from inside input/blur: replacing the focused
  // node mid-event throws in Chrome and steals focus from the next field.
  // Only the primary tags can change while typing, so refresh those in place.
  list.querySelectorAll('.js-idn-val').forEach(inp => inp.addEventListener('input', e => {
    _itemIdentifiers[+e.target.dataset.idx].value = e.target.value;
    _refreshIdnTags();
  }));
  list.querySelectorAll('.js-idn-val').forEach(inp => inp.addEventListener('blur', e => {
    e.target.value = e.target.value.trim();
    _itemIdentifiers[+e.target.dataset.idx].value = e.target.value;
    _refreshIdnTags();
  }));
  list.querySelectorAll('.js-idn-rm').forEach(b => b.addEventListener('click', uiBusyHandler(() => {
    _itemIdentifiers.splice(+b.dataset.idx, 1);
    renderItemIdentifiers();
  })));
}

function _refreshIdnTags(){
  const seen = new Set();
  _itemIdentifiers.forEach((x, i) => {
    const primary = IDN_PRIMARY_TYPES.includes(x.type) && !seen.has(x.type) && (x.value || '').trim();
    if(primary) seen.add(x.type);
    const tags = document.querySelector(`#itemIdnList .idn-row[data-field="idn_${i}"] .idn-tags`);
    if(!tags) return;
    const synced = x.read_only || (x.source && x.source !== 'manual' && !IDN_PRIMARY_TYPES.includes(x.type));
    tags.innerHTML = `${synced ? '<span class="idn-tag">synced</span>' : ''}${primary ? '<span class="idn-tag idn-tag-primary">primary</span>' : ''}`;
  });
}

function _wireIdentifiersSection(){
  const add = document.getElementById('itemIdnAddBtn');
  if(add && !add._wired){
    add._wired = true;
    add.addEventListener('click', uiBusyHandler(() => {
      // Default to the first type not yet present: UPC, then GTIN, then customer SKU.
      const used = new Set(_itemIdentifiers.map(x => x.type));
      const type = ['upc', 'gtin', 'customer_sku', 'asin', 'carton_barcode'].find(t => !used.has(t)) || 'alias';
      _itemIdentifiers.push({ type, value: '', source: 'manual', read_only: false });
      renderItemIdentifiers();
      const inputs = document.querySelectorAll('#itemIdnList .js-idn-val:not([disabled])');
      if(inputs.length) inputs[inputs.length - 1].focus();
    }));
  }
  for(const id of ['itemCaseSku', 'itemCaseUnits', 'itemCaseBarcode']){
    const el = document.getElementById(id);
    if(el && !el._wired){ el._wired = true; el.addEventListener('input', onCasePackInput); }
  }
}

// Case pack block <-> the CASE row in the Handling units list are ONE thing:
// typing in either updates the same _itemHandlingUnits entry.
function renderCasePack(){
  const skuEl = document.getElementById('itemCaseSku');
  if(!skuEl) return;
  const hu = _caseHu();
  const set = (id, v) => { const el = document.getElementById(id); if(el && document.activeElement !== el) el.value = v; };
  set('itemCaseSku', hu ? (hu.sku_code || '') : '');
  set('itemCaseUnits', hu && hu.pack_qty != null ? String(hu.pack_qty) : '');
  set('itemCaseBarcode', _itemCaseBarcode || '');
}

function onCasePackInput(){
  _itemCaseTouched = true;
  const code  = document.getElementById('itemCaseSku').value.trim();
  const units = document.getElementById('itemCaseUnits').value.trim();
  _itemCaseBarcode = document.getElementById('itemCaseBarcode').value.trim();
  let hu = _caseHu();
  if(!hu){
    if(!code && !units && !_itemCaseBarcode) return;
    hu = {
      sku_type: 'CASE', sku_code: '', pack_qty: null,
      _isNew: !!_editingItemId, _autoSync: false, _fromCasePack: true,
      length_in: null, width_in: null, height_in: null, weight_lbs: null, nmfc_code: '', freight_class: '',
    };
    _itemHandlingUnits.push(hu);
    hu.sku_code = code; hu.pack_qty = units === '' ? null : Number(units);
    renderHandlingUnits();                          // a new row appears in the Handling units list
    return;
  }
  if(hu._fromCasePack && !hu._id && !code && !units && !_itemCaseBarcode){
    // The block created this row and the user emptied it again — take the row back out.
    _itemHandlingUnits.splice(_itemHandlingUnits.indexOf(hu), 1);
    renderHandlingUnits();
    return;
  }
  hu.sku_code = code; hu._autoSync = false; hu.pack_qty = units === '' ? null : Number(units);
  // Mirror into the CASE row's inputs without re-rendering the whole list mid-keystroke.
  const i = _itemHandlingUnits.indexOf(hu);
  const codeInp = document.querySelector(`#itemHuList .js-hu-code[data-idx="${i}"]`);
  const packInp = document.querySelector(`#itemHuList .js-hu-pack[data-idx="${i}"]`);
  if(codeInp) codeInp.value = code;
  if(packInp) packInp.value = hu.pack_qty == null ? '' : String(hu.pack_qty);
}

/** The PUT / POST payload, or { _error: { field, msg } } for a half-filled case pack. */
function _identifiersPayload(){
  const identifiers = _itemIdentifiers
    .filter(x => !x.read_only)
    .map(x => ({ type: x.type, value: (x.value || '').trim() }))
    .filter(x => x.value);
  const hu = _caseHu();
  const code  = hu ? (hu.sku_code || '').trim().toUpperCase() : '';
  const units = hu && hu.pack_qty != null && hu.pack_qty !== '' ? Number(hu.pack_qty) : null;
  let case_pack = null;
  // A pre-existing CASE the user never touched and that is missing a code or
  // quantity (legacy data) is left alone rather than blocking the whole save.
  if(hu && hu._id && !_itemCaseTouched && (!code || !units)) return { identifiers, case_pack: null };
  if(hu || _itemCaseBarcode){
    if(!code)  return { _error: { field: 'itemCaseSku',   msg: 'Case SKU code is required for the case pack' } };
    if(!units || !Number.isInteger(units) || units < 1) return { _error: { field: 'itemCaseUnits', msg: 'Units per case must be a whole number of 1 or more' } };
    case_pack = { case_sku_code: code, units_per_case: units };
    // Only rewrite the case barcode when the user actually touched the block
    // (or on create): an untouched block must never clear a code we could not
    // show (e.g. a case that carries both a GTIN and a legacy UPC).
    if(_itemCaseTouched || !_editingItemId) case_pack.case_barcode = _itemCaseBarcode || '';
  }
  return { identifiers, case_pack };
}

function _clearIdentifierErrors(scopeEl){
  for(const id of ['itemCaseSku', 'itemCaseUnits', 'itemCaseBarcode']) uiFieldError(scopeEl, id, '');
  scopeEl.querySelectorAll('#itemIdnList .ui-field-err').forEach(f => { f.textContent = ''; f.style.display = 'none'; });
}

/** Pin an API 400/409 to the row or case-pack field it names. */
function _showIdentifierError(scopeEl, resp, payload){
  const c = resp?.conflict || {};
  const field = c.field || resp?.field || null;
  const index = c.index != null ? c.index : (resp?.index != null ? resp.index : null);
  const msg = resp?.error || 'Not saved';
  const caseField = { case_barcode: 'itemCaseBarcode', case_sku_code: 'itemCaseSku', units_per_case: 'itemCaseUnits' }[field];
  if(caseField){ uiFieldError(scopeEl, caseField, msg); _scrollFieldIntoView(scopeEl, caseField); return; }
  // Payload index -> row: the payload is the editable, non-blank rows in order.
  let rowIdx = null;
  if(index != null){
    const editable = _itemIdentifiers.map((x, i) => ({ x, i })).filter(({ x }) => !x.read_only && (x.value || '').trim());
    if(editable[index]) rowIdx = editable[index].i;
  }
  if(rowIdx == null && c.value){
    const hit = _itemIdentifiers.findIndex(x => (x.value || '').trim() === String(c.value).trim());
    if(hit >= 0) rowIdx = hit;
  }
  if(rowIdx != null){ uiFieldError(scopeEl, `idn_${rowIdx}`, msg); _scrollFieldIntoView(scopeEl, `idn_${rowIdx}`); }
}
function _scrollFieldIntoView(scopeEl, id){
  const el = scopeEl.querySelector(`[data-field="${CSS.escape(id)}"]`);
  if(el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Read-only card on the inventory detail modal: every level of the family,
// biggest first, with its barcodes.
async function renderIdentifiersCard(skuId, hostId){
  const host = document.getElementById(hostId);
  if(!host) return;
  const d = await apiGet(`/skus/${skuId}/identifiers`);
  if(!d || !Array.isArray(d.levels)){ host.innerHTML = uiError('Could not load barcodes for this item'); return; }
  const codes = (l) => {
    const list = (l.identifiers || []).filter(x => x.type !== 'internal_sku');   // the SKU code is already its own column
    if(!list.length) return '<span class="ui-muted">—</span>';
    return `<div class="idn-codes">${list.map(x =>
      `<span class="idn-code"><span class="idn-type">${esc(idnTypeLabel(x.type))}</span><span class="ui-mono">${esc(x.value)}</span>${x.source && x.source !== 'manual' ? '<span class="idn-tag">synced</span>' : ''}</span>`).join('')}</div>`;
  };
  const pack = (l) => {
    const n = l.units_per_case ?? l.conversion_factor;
    if(l.sku_type === 'EACH') return uiNum(1);
    return n != null && Number(n) > 0 ? `<span class="ui-num">× ${esc(n)}</span>` : '<span class="ui-muted">—</span>';
  };
  uiTable(host, {
    columns: [
      { key: 'sku_type', label: 'Level', render: l => `<span class="idn-level">${esc(l.sku_type || '')}</span>${l.id === skuId ? ' <span class="idn-tag">this license plate</span>' : ''}` },
      { key: 'sku_code', label: 'SKU code', mono: true },
      { key: '_pack', label: 'Pack', num: true, render: pack },
      { key: '_codes', label: 'Barcodes', render: codes },
    ],
    rows: d.levels, rowKey: 'id',
    empty: 'No levels found for this item.',
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
// CURRENT SDS CARD — shows the active versioned SDS in the Safety Data
// Sheet section of the SKU edit modal. Lets ops open the PDF, see the
// version, see when it was uploaded.
// =============================================================================
async function loadSkuCurrentSds(skuId){
  const card = document.getElementById('itemSdsCurrentCard');
  if(!card) return;
  const r = await apiGet(`/skus/${skuId}/sds-history`);
  if(!r){ card.style.display = 'none'; return; }
  const rows = r.rows || [];
  // Filter out withdrawn docs; pick the current one
  const active = rows.filter(d => !d.withdrawn_at);
  const current = active.find(d => d.is_current) || active[0];
  if(!current){
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  const histCount = active.length;
  const uploaded = current.uploaded_at ? new Date(current.uploaded_at).toLocaleString() : '—';
  const by = current.uploaded_by_email || 'unknown';
  const sizeKb = current.byte_size ? `${(current.byte_size / 1024).toFixed(0)} KB` : '';
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <div style="width:36px;height:36px;border-radius:6px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#cc1f1f;">PDF</div>
      <div style="flex:1;min-width:200px;">
        <div style="font-weight:600;color:var(--text);">${esc(current.original_filename || 'sds.pdf')} <span style="color:var(--muted);font-weight:400;font-size:11px;">v${esc(current.version_number)} · current</span></div>
        <div style="font-size:11px;color:var(--text2);">Uploaded ${esc(uploaded)} by ${esc(by)} ${sizeKb ? '· ' + esc(sizeKb) : ''}</div>
      </div>
      <button type="button" class="btn btn-ghost" onclick="uiRun(this, () => openSdsDocument('${esc(current.id)}','${esc(current.original_filename || 'sds.pdf')}'))" style="padding:4px 10px;font-size:11px;color:var(--blue);">Open</button>
      ${histCount > 1
        ? `<span style="font-size:11px;color:var(--muted);">${esc(histCount - 1)} prior version${histCount - 1 === 1 ? '' : 's'} on file</span>`
        : ''}
    </div>
  `;
}

// Fetch the SDS PDF bytes through the authenticated download endpoint
// (so we never expose presigned S3 URLs) and pop a new tab with the blob.
async function openSdsDocument(docId, filename){
  try {
    const r = await fetch(`${API}/sds-documents/${docId}/download`, {
      headers: { 'Authorization': `Bearer ${T}` },
    });
    if(!r.ok){
      return uiToast(`Could not open the SDS — ${(await r.text()) || r.status}`, 'error');
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    // Open in a new tab; revoke after a delay so the tab can read it first.
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch(e){
    uiToast('Network error opening the SDS', 'error');
  }
}

// =============================================================================
// SDS INTELLIGENCE — new per-field pipeline. Versions the SDS doc, runs
// Claude with per-field confidence + verbatim source citations, auto-
// applies high-conf fields to the item master, queues review items for
// the compliance page. Edit mode only (needs an existing sku_id).
// =============================================================================
async function runSdsIntelExtract(skuId, file){
  const result = document.getElementById('itemSdsIntelResult');
  result.style.display = 'block';
  result.style.borderColor = 'var(--blue)';
  result.style.background = 'transparent';
  result.style.color = 'var(--text2)';
  result.innerHTML = `Running SDS Intelligence on <strong>${esc(file.name)}</strong>… (typically 10-30 sec for multi-page SDS)`;

  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${API}/skus/${skuId}/sds-extract`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${T}` },
      body: fd,
    });
    const d = await r.json();
    if(!r.ok){
      result.style.borderColor = 'var(--red)';
      result.style.color = 'var(--red)';
      result.innerHTML = `${esc(d.error || 'Extraction failed')}`;
      return;
    }

    if(d.deduped){
      result.style.borderColor = 'var(--amber)';
      result.style.color = 'var(--amber)';
      result.innerHTML = `
        <div style="margin-bottom:10px;">This exact PDF (sha256 match) was already uploaded as <strong>version ${esc(d.document.version_number)}</strong>. No re-upload was needed.</div>
        <button class="btn btn-primary" id="reExtractExistingBtn" style="padding:6px 14px;font-size:12px;" data-doc-id="${esc(d.document.id)}">↻ Re-extract this version</button>
        <span style="font-size:11px;color:var(--text2);margin-left:10px;">Same PDF, fresh Claude run. Useful when the prompt or model changed since last extraction.</span>
      `;
      // Wire the re-extract button to the existing-doc extraction endpoint
      const reBtn = document.getElementById('reExtractExistingBtn');
      if(reBtn){
        reBtn.addEventListener('click', uiBusyHandler(() => reRunExtractionOnExistingDoc(reBtn.dataset.docId)));
      }
      return;
    }

    renderSdsExtractResult(d.extraction || {}, d.document || {});
  } catch(err){
    result.style.borderColor = 'var(--red)';
    result.style.color = 'var(--red)';
    result.innerHTML = `Network error: ${esc(err.message || err)}`;
  }
}

// Re-run extraction on an existing SDS document (no upload, just kicks
// Claude again on the same bytes). Used when dedupe rejected a re-upload
// but the user wants a fresh extraction run — e.g. after a prompt or
// triage-band fix.
async function reRunExtractionOnExistingDoc(docId){
  const result = document.getElementById('itemSdsIntelResult');
  result.style.background = 'transparent';
  result.style.borderColor = 'var(--blue)';
  result.style.color = 'var(--text2)';
  result.innerHTML = `Re-running extraction on existing SDS… (typically 10-30 sec for multi-page SDS)`;
  try {
    const r = await fetch(`${API}/sds-documents/${docId}/extract`, {
      method:'POST', headers:{ 'Authorization': `Bearer ${T}` },
    });
    const d = await r.json();
    if(!r.ok){
      result.style.borderColor = 'var(--red)';
      result.style.color = 'var(--red)';
      result.innerHTML = `${esc(d.error || 'Re-extraction failed')}`;
      return;
    }
    // /sds-documents/:id/extract returns { extractionId, band, weakestRequiredConf }
    // — synthesize the same shape as the upload-and-extract endpoint for
    // the shared renderer.
    renderSdsExtractResult(d, { id: docId, version_number: '?', original_filename: 'sds.pdf' });
  } catch(err){
    result.style.borderColor = 'var(--red)';
    result.style.color = 'var(--red)';
    result.innerHTML = `Network error: ${esc(err.message || err)}`;
  }
}

// Shared renderer for the SDS Intel result panel — used by both the
// upload-and-extract path and the re-extract-existing-doc path.
function renderSdsExtractResult(ext, doc){
  const result = document.getElementById('itemSdsIntelResult');
  const band = ext.band || 'pending';
  const conf = ext.weakestRequiredConf == null ? '' : ` · weakest required field at ${Math.round(Number(ext.weakestRequiredConf) * 100)}%`;

  const bandStyle = {
    auto_applied: { bg:'#1f4d2e', fg:'#a3ffb3', border:'#28a745', icon:'✓', label:'Auto-applied' },
    review_high:  { bg:'#3a2c00', fg:'#ffd591', border:'#d6a700', icon:'⚠', label:'Queued for review (high confidence)' },
    review_low:   { bg:'#3a1c00', fg:'#ffb380', border:'#cc6600', icon:'⚠', label:'Queued for review (low confidence)' },
    rejected:     { bg:'#5a2c2c', fg:'#ffb3b3', border:'#d22',    icon:'✕', label:'Rejected (required fields missing or below threshold)' },
    error:        { bg:'#5a2c2c', fg:'#ffb3b3', border:'#d22',    icon:'', label:'Extraction errored' },
  }[band] || { bg:'#3a3a3a', fg:'#ddd', border:'#888', icon:'…', label:band };

  result.style.background = bandStyle.bg;
  result.style.color = bandStyle.fg;
  result.style.borderColor = bandStyle.border;

  const reviewLink = (band === 'review_high' || band === 'review_low' || band === 'rejected')
    ? `<div style="margin-top:8px;"><button class="ui-btn js-sds-review">Open in the compliance queue →</button></div>`
    : '';
  const docLine = `Version ${esc(doc.version_number)} · ${esc(doc.original_filename || 'sds.pdf')}`;

  // Use the backend-supplied reason when available — it explains things
  // like "5 required fields couldn't be extracted" instead of the
  // confidence-only message which can be misleading (e.g. weakest field
  // at 98% but band still review_low because other required fields were
  // entirely missing from the document).
  const reasonText = ext.reason
    ? esc(ext.reason)
    : (band === 'auto_applied'
        ? 'High-confidence fields written directly to the item master. Review the audit log on the SKU detail page if you want to see what changed.'
        : band === 'rejected'
          ? 'Some required hazmat fields were missing or below 75% confidence. Reviewer must fix before this SKU can be considered compliant.'
          : 'Some fields landed below the 95% auto-apply threshold or contained changes vs. previously approved values.');

  result.innerHTML = `
    <div style="font-weight:700;font-size:13px;margin-bottom:4px;">${bandStyle.icon} ${esc(bandStyle.label)}${conf}</div>
    <div style="font-size:11px;opacity:.85;">${docLine}</div>
    <div style="font-size:11px;margin-top:6px;line-height:1.5;">${reasonText}</div>
    ${reviewLink}
  `;

  result.querySelector('.js-sds-review')?.addEventListener('click', () => {
    ITEM_M?.close();
    navigateTo('compliance');
  });

  // If auto-applied, refresh both the inventory list AND the open edit
  // form so the user immediately sees the values flow into hazmat
  // checkbox, special handling, hazmat notes, etc.
  if(band === 'auto_applied'){
    setTimeout(() => {
      if(typeof loadInventory === 'function') loadInventory();
    }, 800);
    if(_editingItemId && typeof refreshOpenSkuForm === 'function'){
      refreshOpenSkuForm(_editingItemId);
    }
  }
  // Always refresh the Current SDS card + audit panel so the user sees
  // the new version + new audit entries alongside the result panel.
  if(_editingItemId){
    if(typeof loadSkuCurrentSds === 'function')      loadSkuCurrentSds(_editingItemId);
    if(typeof loadSkuComplianceAudit === 'function') loadSkuComplianceAudit(_editingItemId);
  }
}

// Re-fetch a SKU and write its compliance/safety values back into the
// open Edit Item form. Called after auto-apply or reviewer accept so
// fields the user can see (Hazmat checkbox, UN Number, Special Handling
// Instructions, Hazmat Notes, etc.) reflect the latest state without
// the user closing and reopening the modal.
async function refreshOpenSkuForm(skuId){
  if(!skuId) return;
  const sku = await apiGet(`/skus/${skuId}`);
  if(!sku) return;
  // Hazmat checkbox + reveal block. Hazmat-block fields only make sense
  // when checked, so the toggle drives display.
  const haz = !!sku.is_hazmat;
  document.getElementById('itemHazmat').checked = haz;
  document.getElementById('itemHazmatBlock').style.display = haz ? 'block' : 'none';
  // Hazmat-block fields
  document.getElementById('itemUnNumber').value           = sku.un_number || '';
  document.getElementById('itemHazardClass').value        = sku.hazard_class || '';
  document.getElementById('itemProperShippingName').value = sku.proper_shipping_name || '';
  document.getElementById('itemGroundOnly').checked       = !!sku.is_ground_only;
  document.getElementById('itemLimitedQty').checked       = !!sku.is_limited_qty;
  document.getElementById('itemHazmatNotes').value        = sku.hazmat_notes || '';
  // Combo for packing group needs cbSet (writes the inner display value)
  if(typeof cbSet === 'function') cbSet('itemPackingGroupWrap', sku.packing_group || '');
  // Always-visible safety field
  document.getElementById('itemSpecialHandling').value    = sku.special_handling_instructions || '';
}

// =============================================================================
// SKU ATTACHMENTS (SDS / photos / spec sheets) — only available in edit
// mode (we need a sku id). The list lives inside the New Item modal
// when an existing item is open.
// =============================================================================

// Renders the create-mode staging list — files the user has dropped in
// via Attach File before the SKU exists. They sit client-side until
// Save creates the SKU, then they're uploaded as attachments.
function renderItemPendingDocs(){
  const body = document.getElementById('itemDocsBody');
  if(!body) return;
  if(!_itemPendingDocs.length){
    body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">No documents staged. Click Attach file to add an SDS, photo, or spec sheet — they\'ll upload after Save. (Or use Read SDS above to also auto-fill hazmat from a PDF.)</div>';
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
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)} ${tagged ? '<span class="chip chip-warning" style="font-size:10px;">SDS</span>' : ''} <span style="color:var(--muted);font-weight:400;">· Uploads on Save</span></div>
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
    body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">No documents yet — click Attach file to add an SDS, photo, or spec sheet</div>';
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
        <button class="btn btn-ghost js-item-att-dl" data-att-id="${esc(r.id)}" style="padding:3px 10px;font-size:12px;">Open</button>
        <button class="btn btn-ghost js-item-att-rm" data-att-id="${esc(r.id)}" style="padding:3px 8px;font-size:12px;color:var(--red);">✕</button>
      </div>`;
  }).join('');
  body.querySelectorAll('.js-item-att-dl').forEach(b =>
    b.addEventListener('click', uiBusyHandler(async () => {
      const d = await apiGet(`/skus/${skuId}/attachments/${b.dataset.attId}/url`);
      if(!d?.url) return uiToast('Could not get a download link for that document', 'error');
      window.open(d.url, '_blank', 'noopener');
    })));
  body.querySelectorAll('.js-item-att-rm').forEach(b =>
    b.addEventListener('click', uiBusyHandler(async () => {
      const ok = await uiConfirm({
        title: 'Remove this document?',
        body: 'It is deleted from the item master. If it is the SDS, the hazmat fields it filled in stay as they are.',
        confirmLabel: 'Remove', danger: true,
      });
      if(!ok) return;
      const r = await fetch(`${API}/skus/${skuId}/attachments/${b.dataset.attId}`, {
        method:'DELETE', headers:{'Authorization':`Bearer ${T}`},
      });
      if(!r.ok) return uiToast('Could not remove the document', 'error');
      uiToast('Document removed');
      loadItemAttachmentsList(skuId);
    })));
}

// Show / hide the "Re-read attached SDS" button based on whether the
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
  btn.onclick = uiBusyHandler(() => extractFromAttachedSds(skuId, sdsAttachment.id, sdsAttachment.filename));
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

// =============================================================================
// INVENTORY DETAIL MODAL — drill-down from a row click. Renders the full
// origin trail for an inventory entry: item master, lot, license-plate
// family (parent / children if case-broken), inbound origin (PO + supplier
// + receiver), and any current allocations holding the LP.
// =============================================================================

/* =============================================================================
 * LOT COA — list / open / attach / withdraw, from the inventory detail.
 *
 * The client portal reaches this same modal, so uploads and withdrawals are
 * ops-only: a customer sees their lot's certificate, not the internal trail of
 * which document was pulled and why.
 * ========================================================================== */
async function renderLotCoa(lotId, lotNumber){
  const body    = document.getElementById('coaBody');
  const actions = document.getElementById('coaActions');
  if(!body) return;
  const portal = (typeof isPortalMode === 'function' && isPortalMode());

  body.innerHTML = uiSpinner('Loading…');
  const rows = await apiGet(`/lots/${lotId}/documents`);
  if(rows === null){ body.innerHTML = uiError('Could not load the COA'); return; }

  const live = rows.filter(r => !r.withdrawn_at);
  const gone = rows.filter(r => r.withdrawn_at);

  if(!portal && actions){
    actions.innerHTML = `
      <button class="ui-btn" id="coaAddBtn">${live.length ? 'Replace COA' : 'Attach COA'}</button>
      <input type="file" id="coaAddInput" accept="application/pdf,image/*" style="display:none;">`;
    document.getElementById('coaAddBtn').addEventListener('click', () =>
      document.getElementById('coaAddInput').click());
    document.getElementById('coaAddInput').addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if(!file) return;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', 'COA');
      const r = await fetch(`${API}/lots/${lotId}/documents`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd,
      });
      if(!r.ok){
        const d = await r.json().catch(() => ({}));
        return uiToast(d.error || 'Upload failed', 'error');
      }
      uiToast(`COA attached to lot ${lotNumber || ''}`);
      renderLotCoa(lotId, lotNumber);
      loadInventory();     // the list's COA flag just changed
    });
  }

  if(!live.length && !gone.length){
    body.innerHTML = `<div class="ui-banner ui-banner-warn">
      <strong>No COA on file for lot ${esc(lotNumber || '')}.</strong>
      It can't be included in an outbound docs pack until one is attached.
    </div>`;
    return;
  }

  const fileRow = (r, withdrawn) => `
    <div class="ui-file${withdrawn ? ' ui-file-gone' : ''}">
      <span class="ui-file-ext">${esc((r.mime_type || '').includes('image') ? 'IMG' : 'PDF')}</span>
      <span class="ui-file-meta">
        <span class="ui-file-name">${esc(r.original_filename || 'coa.pdf')}</span>
        <span class="ui-hint">
          ${esc(fmtBytes(r.byte_size))} · ${esc(r.uploaded_by_name || '')} · ${esc(fmtTimeShort(r.uploaded_at))}
          ${withdrawn ? ` · <strong>withdrawn</strong>: ${esc(r.withdrawn_reason || '')}` : ''}
        </span>
      </span>
      <button class="ui-btn js-coa-open" data-id="${esc(r.id)}">Open</button>
      ${(!withdrawn && !portal)
        ? `<button class="ui-btn ui-btn-danger js-coa-wd" data-id="${esc(r.id)}">Withdraw</button>` : ''}
    </div>`;

  body.innerHTML =
    (live.length ? live.map(r => fileRow(r, false)).join('')
                 : `<div class="ui-banner ui-banner-warn">No live COA — the one(s) below were withdrawn.</div>`) +
    // The withdraw trail is internal: it explains why a certificate was pulled.
    (!portal && gone.length
      ? `<div class="ui-label" style="margin-top:12px;">Withdrawn</div>` + gone.map(r => fileRow(r, true)).join('')
      : '');

  body.querySelectorAll('.js-coa-open').forEach(b =>
    b.addEventListener('click', uiBusyHandler(() => openLotDocument(b.dataset.id))));
  body.querySelectorAll('.js-coa-wd').forEach(b =>
    b.addEventListener('click', uiBusyHandler(() => withdrawLotDocument(b.dataset.id, lotId, lotNumber))));
}

// Streamed through the API with an auth check — no presigned S3 URL is handed
// to the browser (same discipline as the SDS pipeline).
async function openLotDocument(docId){
  const r = await fetch(`${API}/lot-documents/${docId}/download`, {
    headers: { Authorization: `Bearer ${T}` },
  });
  if(!r.ok) return uiToast('Could not open that document', 'error');
  const blob = await r.blob();
  const url  = URL.createObjectURL(blob);
  if(!window.open(url, '_blank', 'noopener')) uiToast('Pop-up blocked — allow pop-ups to view it', 'error');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function withdrawLotDocument(docId, lotId, lotNumber){
  uiModal({
    title: 'Withdraw this COA?',
    width: 520,
    body:
      `<div class="ui-banner ui-banner-warn">
         For a wrong or superseded certificate. It stays in the audit trail — a COA that already
         shipped with an order has to remain on the record — but it stops appearing on docs packs,
         and the lot goes back to <strong>no COA on file</strong>.
       </div>` +
      uiField({ id: 'coaWdReason', label: 'Reason',
                placeholder: 'e.g. certificate is for lot B-2291, not this one',
                hint: 'Minimum 5 characters.' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Withdraw', danger: true, onClick: async (m) => {
          const reason = m.el.querySelector('#coaWdReason').value.trim();
          uiFieldError(m.el, 'coaWdReason', reason.length >= 5 ? '' : 'At least 5 characters');
          if(reason.length < 5) return false;
          const r = await fetch(`${API}/lot-documents/${docId}/withdraw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
            body: JSON.stringify({ reason }),
          });
          if(!r.ok){
            const d = await r.json().catch(() => ({}));
            uiFieldError(m.el, 'coaWdReason', d.error || 'Withdraw failed');
            return false;
          }
          uiToast('COA withdrawn — this lot now has no certificate on file', 'error');
          renderLotCoa(lotId, lotNumber);
          loadInventory();
        } },
    ],
  });
}

async function openInventoryDetail(invId, opts = {}){
  const m = uiModal({
    title: 'Inventory',
    width: 880,
    body: uiSpinner('Loading…'),
    actions: [{ label: 'Close' }],
  });
  const body = m.el.querySelector('.ui-modal-body');

  const d = await apiGet(`/inventory/${invId}`);
  if(!d){ body.innerHTML = uiError('Could not load this inventory record'); return; }

  const inv = d.inventory;
  m.el.querySelector('.ui-dialog-title').innerHTML =
    `${uiId(inv.sku_code || '')} <span class="ui-muted">${esc(inv.sku_name || '')}</span>`;

  // Ledger hero — the five facts you open this modal to see.
  const expSoon = inv.expiry_date && new Date(inv.expiry_date) < new Date(Date.now() + 30 * 864e5);
  // Quantity is the only number here — it gets Ledger display type. Everything
  // else is an identifier and gets compact Terminal type.
  const header =
    `<div class="ui-tiles">` +
    uiTile({ label: 'Quantity', value: Number(inv.quantity || 0).toLocaleString(), sub: inv.sku_uom || 'EA' }) +
    uiTile({ label: 'Status', value: (inv.status || '').toUpperCase(), compact: true,
             tone: inv.status === 'damaged' ? 'danger' : inv.status === 'available' ? 'ok' : null }) +
    uiTile({ label: 'Location', value: inv.location_code || '—', compact: true, sub: inv.zone_name || '' }) +
    uiTile({ label: 'License plate', value: inv.lp_number || '—', compact: true, sub: inv.lp_type || '' }) +
    uiTile({ label: 'Carton', value: inv.carton_barcode || '—', compact: true, sub: inv.carton_barcode ? 'scan resolves as carton' : '' }) +
    uiTile({ label: 'Lot', value: inv.lot_number || '—', compact: true,
             tone: expSoon ? 'warn' : null,
             sub: inv.expiry_date ? 'Exp ' + new Date(inv.expiry_date).toLocaleDateString() : '' }) +
    `</div>`;

  // ---- Item master ----
  const dims = [inv.length_in, inv.width_in, inv.height_in].some(x => x != null)
    ? `${inv.length_in ?? '—'} × ${inv.width_in ?? '—'} × ${inv.height_in ?? '—'} in` : '—';
  const item = `
    <div class="card inv-sec">
      <div class="card-head">
        <div class="card-title">Item master</div>
        <div style="flex:1"></div>
        ${inv.is_hazmat ? `<span class="ui-chip ui-chip-danger">⚠ HAZMAT${inv.un_number ? ' ' + esc(inv.un_number) : ''}${inv.hazard_class ? ' · Cl ' + esc(inv.hazard_class) : ''}${inv.packing_group ? ' · PG ' + esc(inv.packing_group) : ''}</span>` : ''}
      </div>
      <div class="inv-sec-body">
        ${uiMeta([
          { k: 'SKU code', v: uiId(inv.sku_code || '—') },
          { k: 'Type', v: esc(inv.sku_type || '—') },
          { k: 'Client', v: `${esc(inv.client_name || '')} <span class="ui-muted">${esc(inv.client_code || '')}</span>` },
          { k: 'UPC', v: inv.upc ? uiId(inv.upc) : '<span class="ui-muted">—</span>' },
          { k: 'Dimensions', v: esc(dims) },
          { k: 'Weight', v: inv.weight_lbs != null ? esc(inv.weight_lbs) + ' lbs' : '<span class="ui-muted">—</span>' },
          { k: 'NMFC', v: esc(inv.nmfc_code || '—') },
          { k: 'Freight class', v: esc(inv.freight_class || '—') },
        ])}
        ${inv.description ? `<div class="ui-hint" style="margin-top:12px;">${esc(inv.description)}</div>` : ''}
        ${inv.special_handling_instructions
          ? `<div class="ui-banner ui-banner-warn" style="margin-top:12px;">⚠ <strong>Special handling:</strong> ${esc(inv.special_handling_instructions)}</div>` : ''}
      </div>
    </div>`;

  // ---- Identifiers & pack levels (every level of the family, biggest first) ----
  const idnCard = inv.sku_id ? `
    <div class="card inv-sec">
      <div class="card-head">
        <div class="card-title">Identifiers &amp; pack levels</div>
        <div class="ui-hint" style="margin-left:8px;">Barcodes on each handling level</div>
      </div>
      <div id="invIdnWrap">${uiSpinner('Loading…')}</div>
    </div>` : '';

  // ---- Lot ----
  const lot = inv.lot_id ? `
    <div class="card inv-sec">
      <div class="card-head"><div class="card-title">Lot</div></div>
      <div class="inv-sec-body">
        ${uiMeta([
          { k: 'Lot number', v: uiId(inv.lot_number || '—') },
          { k: 'Expiry', v: inv.expiry_date
              ? (expSoon ? `<span class="ui-chip ui-chip-warn">${esc(new Date(inv.expiry_date).toLocaleDateString())}</span>`
                         : uiId(new Date(inv.expiry_date).toLocaleDateString()))
              : '<span class="ui-muted">—</span>' },
          { k: 'Manufactured', v: inv.manufacture_date
              ? uiId(new Date(inv.manufacture_date).toLocaleDateString()) : '<span class="ui-muted">—</span>' },
        ])}
      </div>
    </div>` : '';

  // ---- License plate family (case-break lineage) ----
  const family = (d.parent_lp || d.child_lps?.length) ? `
    <div class="card inv-sec">
      <div class="card-head"><div class="card-title">LP family</div></div>
      <div class="inv-sec-body">
        ${d.parent_lp ? `<div style="margin-bottom:10px;">
          <span class="ui-hint">Case-break child of</span>
          <span class="lp-badge lp-original" style="margin-left:8px;">${esc(d.parent_lp.lp_number)}</span></div>` : ''}
        ${d.child_lps?.length ? `<div>
          <span class="ui-hint">Broken into</span>
          <div class="inv-lp-list">${d.child_lps.map(c =>
            `<span class="lp-badge ${c.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(c.lp_number)}</span>`).join('')}</div>
        </div>` : ''}
      </div>
    </div>` : '';

  // ---- Receipt origin ----
  const inbound = d.inbound ? `
    <div class="card inv-sec">
      <div class="card-head"><div class="card-title">Inbound origin</div></div>
      <div class="inv-sec-body">
        ${uiMeta([
          { k: 'Received', v: d.inbound.received_at ? uiId(fmtTimeShort(d.inbound.received_at)) : '<span class="ui-muted">—</span>' },
          { k: 'Received by', v: esc(d.inbound.received_by_name || d.inbound.received_by_email || '—') },
          { k: 'PO number', v: d.inbound.po_number ? uiId(d.inbound.po_number) : '<span class="ui-muted">—</span>' },
          { k: 'Customer PO', v: esc(d.inbound.external_po || '—') },
          { k: 'Supplier', v: esc(d.inbound.supplier_name || '—') },
          { k: 'Received qty', v: uiNum(d.inbound.received_qty || 0) },
          { k: 'Condition', v: esc(d.inbound.condition || '—') },
        ])}
        ${d.inbound.notes ? `<div class="ui-hint" style="margin-top:12px;">${esc(d.inbound.notes)}</div>` : ''}
      </div>
    </div>` : `
    <div class="card inv-sec">
      <div class="card-head"><div class="card-title">Inbound origin</div></div>
      <div class="inv-sec-body">${uiEmpty('No receiving record for this license plate — entered directly, or it predates this WMS.')}</div>
    </div>`;

  // ---- COA (lot documents) ----
  // Only meaningful for lot-tracked stock: a COA certifies a production lot.
  const coaSection = inv.lot_id ? `
    <div class="card inv-sec">
      <div class="card-head">
        <div class="card-title">Certificate of Analysis</div>
        <div class="ui-hint" style="margin-left:8px;">for lot ${esc(inv.lot_number || '')}</div>
        <div style="flex:1"></div>
        <span id="coaActions"></span>
      </div>
      <div class="inv-sec-body" id="coaBody"></div>
    </div>` : '';

  // ---- Current allocations ----
  const allocs = d.current_allocations || [];
  const alloc = allocs.length ? `
    <div class="card inv-sec">
      <div class="card-head">
        <div class="card-title">Current allocations</div>
        <div class="ui-hint" style="margin-left:8px;">orders holding this license plate</div>
      </div>
      <div id="invAllocWrap"></div>
    </div>` : '';

  body.innerHTML = header + item + idnCard + lot + coaSection + family + inbound + alloc;
  if(inv.sku_id) renderIdentifiersCard(inv.sku_id, 'invIdnWrap');
  // Units on this LP — every UID with status, lot, order and last event; click a unit for its history.
  if(inv.lp_id && typeof lpUnitsSection === 'function') lpUnitsSection(inv.lp_id, body, { highlight: opts.highlightUid || null });

  if(inv.lot_id) renderLotCoa(inv.lot_id, inv.lot_number);

  if(allocs.length){
    uiTable('invAllocWrap', {
      columns: [
        { key: 'order_number', label: 'Order', mono: true },
        { key: 'ship_to_name', label: 'Ship to' },
        { key: '_req', label: 'Required ship', render: a => a.required_ship_date
            ? uiId(new Date(a.required_ship_date).toLocaleDateString()) : '<span class="ui-muted">—</span>' },
        { key: 'quantity', label: 'Qty', num: true },
        { key: '_st', label: 'Status', render: a =>
            `${uiChip(a.allocation_status)} <span class="ui-muted">${esc(a.order_status || '')}</span>` },
      ],
      rows: allocs, rowKey: 'order_id',
      onRowClick: (a) => {
        m.close();
        navigateTo('orders');
        openOrderDetail(a.order_id);
      },
    });
  }

  // Ops actions on the line you're actually looking at. Without these, drilling
  // into a row was a dead end — you had to close the modal and go re-find the
  // same LP to do anything with it.
  if(!(typeof isPortalMode === 'function' && isPortalMode())){
    const acts = m.el.querySelector('.ui-dialog-actions');

    if(canCaseBreak(inv) && can('inventory.case_break')){
      const brk = document.createElement('button');
      brk.className = 'ui-btn ui-btn-primary';
      brk.textContent = 'Case break';
      brk.addEventListener('click', () => {
        m.close();
        // Carries the LP straight through — no re-searching for it.
        openCaseBreakFor(cbPayload(inv));
      });
      acts.insertBefore(brk, acts.firstChild);
    }

    if(inv.sku_id && can('items.edit')){
      const edit = document.createElement('button');
      edit.className = 'ui-btn';
      edit.textContent = 'Edit item master';
      edit.addEventListener('click', uiBusyHandler(() => { m.close(); openItemFormModal(inv.sku_id); }));
      acts.insertBefore(edit, acts.firstChild);
    }
  }
}
