'use strict';
// =============================================================================
// INBOUND / RECEIVING + NEW PO MODAL — TERMINAL LEDGER (batch D4e).
// Server-sorted, server-paged: the list used to ask for 50 with no offset and
// no total, so PO 51 onward was invisible.
// =============================================================================

let CPI = null;        // current PO id
let CPD = null;        // current PO data
let AL  = [];          // locations cache
let poLines = [];      // new-PO modal: pending lines

// `key` on a sortable column is the API's sortBy value — it must exist in the
// RECEIPT_SORTS whitelist in the API's queries/inbound.js.
const INB_COLS = [
  { key: 'po_number', label: 'Receipt #', mono: true },
  // The customer's own number — the one they'll quote at you on the phone.
  { key: 'external_po', label: 'Client PO', sortable: false, render: r => r.external_po
      ? uiId(r.external_po) : '<span class="ui-muted">—</span>' },
  { key: 'client_name', label: 'Client' },
  { key: 'supplier_name', label: 'Supplier' },
  { key: 'line_count', label: 'Lines', num: true },
  { key: 'total_expected', label: 'Expected', num: true },
  // What's still owed is the number receiving actually cares about.
  { key: 'total_received', label: 'Received', num: true, render: r => {
      const exp = Number(r.total_expected || 0), got = Number(r.total_received || 0);
      if(got === 0) return uiNum(0);
      return got < exp
        ? `<span class="ui-chip ui-chip-warn">${esc(got)} of ${esc(exp)}</span>`
        : uiNum(got);
    } },
  { key: 'expected_arrival', label: 'Expected arrival', render: r => r.expected_arrival
      ? uiId(new Date(r.expected_arrival).toLocaleDateString()) : '<span class="ui-muted">—</span>' },
  { key: 'status', label: 'Status', render: r => uiChip(r.status) },
];

let INB_LIMIT  = 50;
let INB_OFFSET = 0;
let INB_SORT   = '';     // blank = the API's work-first default ordering
let INB_DIR    = 'asc';
let INB_FILTER_SIG = '';  // client|search|status — a change resets to page 1

// Page header — the shared filter bar (js/ui.js). Built at DOM-ready by app.js.
const INB_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' }, { value: 'confirmed', label: 'Confirmed' },
  { value: 'in_transit', label: 'In transit' }, { value: 'receiving', label: 'Receiving' },
  { value: 'partially_received', label: 'Partially received' }, { value: 'received', label: 'Received' },
  { value: 'closed', label: 'Closed' }, { value: 'cancelled', label: 'Cancelled' },
];
function initInboundFilterBar(){
  uiFilterBar('inbFilterBar', {
    key: 'inb', page: 'inbound',
    title: 'Receiving', subtitle: 'Purchase orders and inbound',
    search: { placeholder: 'Search receipt #, client PO or supplier…' },
    statuses: INB_STATUS_OPTIONS,
    actions: `<button class="ui-btn ui-btn-primary" data-perm="receiving.receive" onclick="uiRun(this, () => showNewPoModal())">New receipt</button>`,
    onChange: () => loadInbound(),
  });
}

function inbSetSort(key, dir){
  INB_SORT = key; INB_DIR = dir; INB_OFFSET = 0;
  loadInbound();
}
function inbSetPage(limit, offset){
  INB_LIMIT = limit; INB_OFFSET = offset;
  loadInbound();
  document.getElementById('inbListWrap')?.scrollIntoView({ block: 'start' });
}

async function loadInbound(){
  document.getElementById('inbDetailView').style.display = 'none';
  document.getElementById('inbListView').style.display = 'block';

  const s  = (document.getElementById('inbSearch')?.value || '').trim();
  const st = cbVal('inbStatusFilterWrap');
  const cl = cbVal('inbClientFilterWrap');     // session-wide client (shared filter bar)
  const sig = `${cl}|${s}|${st}`;
  if(sig !== INB_FILTER_SIG){ INB_FILTER_SIG = sig; INB_OFFSET = 0; }

  // Server-paged list: every filter goes to /inbound/receipts as a query param.
  const qs = new URLSearchParams({ limit: INB_LIMIT, offset: INB_OFFSET });
  if(INB_SORT){ qs.set('sortBy', INB_SORT); qs.set('sortDir', INB_DIR); }
  if(cl) qs.set('clientId', cl);
  if(s)  qs.set('search', s);
  if(st) qs.set('status', st);

  uiTableLoading('inbListWrap', INB_COLS);
  const d = await apiGet(`/inbound/receipts?${qs.toString()}`);
  if(d === null) return uiTableError('inbListWrap', INB_COLS, 'Could not load receipts', loadInbound);

  const rows  = d.rows || d || [];
  const total = Number(d.total ?? rows.length);

  if(!rows.length && INB_OFFSET > 0 && total > 0){   // stranded past the last page
    INB_OFFSET = 0;
    return loadInbound();
  }

  uiTable('inbListWrap', {
    columns: INB_COLS, rows, rowKey: 'id',
    sortable: true, sortKey: INB_SORT, sortDir: INB_DIR,
    onSort: inbSetSort,          // server-side — sorting one page would lie
    onRowClick: r => openPoDetail(r.id),
    empty: (s || st || cl) ? 'No purchase orders match that filter.' : 'No purchase orders yet.',
  });

  uiPager('inbPager', {
    total, limit: INB_LIMIT, offset: INB_OFFSET,
    noun: 'purchase orders', onChange: inbSetPage,
  });
}

const PO_LINE_COLS = [
  { key: 'line_number', label: 'Line', num: true },
  { key: 'sku_code', label: 'Item', mono: true },
  { key: 'sku_name', label: 'Description' },
  { key: 'uom', label: 'UOM' },
  { key: '_lot', label: 'Lot', render: ln => ln.lot_number
      ? uiId(ln.lot_number) : '<span class="ui-muted">—</span>' },
  { key: 'expected_qty', label: 'Expected', num: true },
  { key: 'received_qty', label: 'Received', num: true },
  { key: '_rem', label: 'Outstanding', num: true, render: ln => {
      const rem = (ln.expected_qty || 0) - (ln.received_qty || 0);
      // Short is the normal state mid-receipt; OVER is the one that means
      // something is wrong on the dock.
      if(rem > 0) return `<span class="ui-chip ui-chip-warn">${esc(rem)}</span>`;
      if(rem < 0) return `<span class="ui-chip ui-chip-danger">${esc(Math.abs(rem))} over</span>`;
      return uiChip('received', '✓');
    } },
];

const REC_HIST_COLS = [
  { key: 'sku_code', label: 'SKU', mono: true },
  { key: '_lot', label: 'Lot', render: h => h.lot_number ? uiId(h.lot_number) : '<span class="ui-muted">—</span>' },
  { key: '_lp', label: 'LP', render: h => h.lp_number
      ? `<span class="lp-badge ${h.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(h.lp_number)}</span>`
      : '<span class="ui-muted">—</span>' },
  { key: 'location_code', label: 'Location', mono: true },
  { key: 'quantity', label: 'Qty', num: true },
  { key: '_cond', label: 'Condition', render: h => h.condition === 'GOOD'
      ? '<span class="ui-chip ui-chip-ok">GOOD</span>'
      : `<span class="ui-chip ui-chip-danger">${esc(h.condition)}</span>` },
  { key: 'received_by_name', label: 'Received by' },
  { key: '_when', label: 'When', render: h => h.received_at
      ? uiId(fmtTimeShort(h.received_at)) : '<span class="ui-muted">—</span>' },
];

async function openPoDetail(id){
  CPI = id;
  document.getElementById('inbListView').style.display = 'none';
  document.getElementById('inbDetailView').style.display = 'block';

  const d = await apiGet(`/inbound/receipts/${id}`);
  if(!d){ uiToast('Could not load that receipt', 'error'); closePoDetail(); return; }
  CPD = d;

  document.getElementById('poDetailTitle').innerHTML =
    `${esc(d.po_number || '')} ${uiChip(d.status)}`;
  document.getElementById('poDetailSub').textContent =
    `${d.client_name || ''} · ${d.supplier_name || ''}`;

  document.getElementById('poInfoGrid').innerHTML = uiMeta([
    { k: 'Receipt # (ours)', v: uiId(d.po_number) },
    { k: 'Customer PO (theirs)', v: d.external_po
        ? uiId(d.external_po) : '<span class="ui-muted">—</span>' },
    { k: 'Supplier', v: esc(d.supplier_name || '—') },
    { k: 'Client', v: esc(d.client_name || '—') },
    { k: 'Expected arrival', v: d.expected_arrival
        ? uiId(new Date(d.expected_arrival).toLocaleDateString()) : '<span class="ui-muted">—</span>' },
    { k: 'Created', v: d.created_at ? uiId(fmtTimeShort(d.created_at)) : '<span class="ui-muted">—</span>' },
  ]);

  uiTable('poLinesWrap', {
    columns: PO_LINE_COLS, rows: d.lines || [], rowKey: 'id', empty: 'No lines on this receipt.',
  });

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
          <div class="rec-line">
            <div class="rec-line-head">
              ${uiId(ln.sku_code)}
              <span class="ui-muted">${esc(ln.sku_name || '')}</span>
              <span style="flex:1"></span>
              <span class="ui-chip ui-chip-warn">${esc(rem)} outstanding</span>
            </div>
            <div class="rec-line-fields">
              <div class="ui-field">
                <label class="ui-label" for="rq${i}">Quantity</label>
                <!-- Capped at what's outstanding, as before. The API does NOT
                     validate over-receipt, so lifting this cap would let a
                     mis-key silently inflate on-hand stock. -->
                <input type="number" class="ui-input" id="rq${i}" value="${esc(rem)}" min="1" max="${esc(rem)}">
              </div>
              <div class="ui-field">
                <label class="ui-label" for="rl${i}">Lot</label>
                <input type="text" class="ui-input" id="rl${i}" value="${esc(ln.lot_number || '')}">
              </div>
              <div class="ui-field">
                <label class="ui-label">Location</label>
                <div class="cb-wrap" id="rcw${i}"></div>
              </div>
              <div class="ui-field">
                <label class="ui-label">Condition</label>
                <div class="cb-wrap" id="rdw${i}"></div>
              </div>
            </div>
            <input type="hidden" id="rp${i}" value="${esc(ln.id)}">
          </div>`;
      }).join('');
      loadLocs(ur.length);
    } else {
      rl.innerHTML = uiEmpty('Every line is fully received — complete the receipt.');
      document.getElementById('completePoBtn').style.display = 'inline-flex';
    }
  }

  const hist = d.receivingHistory || [];
  document.getElementById('recHistBadge').textContent = hist.length;
  uiTable('recHistWrap', {
    columns: REC_HIST_COLS, rows: hist, rowKey: 'id',
    empty: 'Nothing received against this receipt yet.',
  });
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
  const ur = (CPD.lines || []).filter(ln => (ln.expected_qty || 0) > (ln.received_qty || 0));
  const lines = [];
  const missingLoc = [];

  for(let i = 0; i < ur.length; i++){
    const q = parseInt(document.getElementById(`rq${i}`)?.value) || 0;
    if(q <= 0) continue;
    const locationId = cbVal(`rcw${i}`);
    // Receiving stock to nowhere is how inventory goes missing — the location
    // is not optional, and it used to be possible to submit without one.
    if(!locationId){ missingLoc.push(ur[i].sku_code); continue; }
    lines.push({
      poLineId:   document.getElementById(`rp${i}`)?.value,
      quantity:   q,
      lotNumber:  document.getElementById(`rl${i}`)?.value || null,
      locationId,
      condition:  cbVal(`rdw${i}`) || 'GOOD',
    });
  }

  if(missingLoc.length){
    return uiToast(`Pick a location for ${missingLoc.join(', ')}`, 'error');
  }
  if(!lines.length) return uiToast('Enter a quantity on at least one line', 'error');

  const btn = document.getElementById('submitReceiveBtn');
  btn.disabled = true;
  try {
    const r = await fetch(`${API}/inbound/receipts/${CPI}/lines`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({lines}),
    });
    const d = await r.json();
    if(!r.ok) return uiToast(d.error || 'Receive failed', 'error');
    const lps = (d.received || []).map(x => x.lpNumber).filter(Boolean);
    uiToast(`Received ${d.linesProcessed} line(s)${lps.length ? ` — ${lps.join(', ')}` : ''}`);

    // The lots exist now, and the COA paperwork is in the receiver's hand at
    // exactly this moment. Offer to attach it before they walk away — chasing a
    // COA later, by email, is how lots end up shipping without one.
    const withLots = (d.received || []).filter(x => x.lotId);
    if(withLots.length) await offerCoaUpload(withLots);

    openPoDetail(CPI);
  } catch(e){
    uiToast('Network error — nothing was received', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* =============================================================================
 * COA CAPTURE — offered immediately after a receive, one row per new lot.
 * A COA certifies a production lot, so it attaches to the LOT (not the SKU, and
 * not the PO). Skipping is fine — the lot is simply flagged as having no COA.
 * ========================================================================== */
function offerCoaUpload(received){
  return new Promise((resolve) => {
    const rows = received.map((x, i) => `
      <div class="ui-file">
        <span class="ui-file-ext">COA</span>
        <span class="ui-file-meta">
          <span class="ui-file-name">${uiId(x.skuCode || x.skuId || '')} · lot ${esc(x.lotNumber || '—')}</span>
          <span class="ui-hint" id="coaName${i}">No file chosen — PDF or a photo of the certificate</span>
        </span>
        <input type="file" id="coaFile${i}" accept="application/pdf,image/*" style="display:none;"
               data-lot="${esc(x.lotId)}" data-idx="${esc(i)}">
        <button class="ui-btn js-coa-pick" data-idx="${esc(i)}">Choose file</button>
      </div>`).join('');

    const m = uiModal({
      title: 'Attach Certificate of Analysis',
      width: 640,
      body: `
        <div class="ui-dialog-body" style="margin-bottom:12px;">
          These lots were just created. If the COA came with the shipment, attach it now — it rides
          with the lot from here on, and can be printed into the outbound docs pack.
        </div>
        ${rows}
        <div class="ui-hint" style="margin-top:10px;">Skipping is fine. Lots with no COA are flagged, not blocked.</div>`,
      actions: [
        { label: 'Skip', onClick: () => { resolve(); } },
        { label: 'Upload', primary: true, onClick: async (mm) => {
            let done = 0;
            for(const inp of mm.el.querySelectorAll('input[type=file]')){
              const file = (inp.files || [])[0];
              if(!file) continue;
              const fd = new FormData();
              fd.append('file', file);
              fd.append('doc_type', 'COA');
              const r = await fetch(`${API}/lots/${inp.dataset.lot}/documents`, {
                method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd,
              });
              if(r.ok) done++;
              else {
                const e = await r.json().catch(() => ({}));
                uiToast(`${file.name}: ${e.error || 'upload failed'}`, 'error');
              }
            }
            if(done) uiToast(`${done} COA${done === 1 ? '' : 's'} attached`);
            resolve();
          } },
      ],
      onClose: () => resolve(),
    });

    m.el.querySelectorAll('.js-coa-pick').forEach(btn =>
      btn.addEventListener('click', () => document.getElementById('coaFile' + btn.dataset.idx).click()));
    m.el.querySelectorAll('input[type=file]').forEach(inp =>
      inp.addEventListener('change', () => {
        const f = (inp.files || [])[0];
        const label = document.getElementById('coaName' + inp.dataset.idx);
        if(f && label) label.textContent = f.name;
      }));
  });
}

async function completePo(){
  if(!CPI) return;
  const short = (CPD?.lines || []).filter(ln => (ln.expected_qty || 0) > (ln.received_qty || 0));
  if(short.length){
    const ok = await uiConfirm({
      title: 'Complete a short receipt?',
      body: `<strong>${esc(short.length)} line(s)</strong> are still outstanding:<br>` +
            short.map(l => `${esc(l.sku_code)} — ${esc((l.expected_qty || 0) - (l.received_qty || 0))} short`).join('<br>') +
            '<br><br>Completing closes the PO. The shortfall stays on the record as never received.',
      confirmLabel: 'Complete anyway',
    });
    if(!ok) return;
  }
  try {
    const r = await fetch(`${API}/inbound/receipts/${CPI}/complete`, {
      method:'POST', headers:{ Authorization: `Bearer ${T}` },
    });
    const d = await r.json();
    if(!r.ok) return uiToast(d.error || 'Could not complete the PO', 'error');
    uiToast(`Receipt ${d.status} — ${d.total_received} of ${d.total_expected} received`);
    openPoDetail(CPI);
  } catch(e){
    uiToast('Network error — the receipt was not completed', 'error');
  }
}

function closePoDetail(){
  CPI = null; CPD = null;
  loadInbound();
}

// =============================================================================
// NEW PO MODAL
// =============================================================================

let PO_M = null;   // open new-PO uiModal

async function showNewPoModal(){
  await loadCC();
  poLines = [];

  PO_M = uiModal({
    title: 'New receipt',
    width: 800,
    body: `
      <!-- Our receipt number is NOT a field. It is assigned by the sequence on
           save (migration 063) and doesn't exist yet at this point, so there is
           nothing to show and nothing to type. The only number ops enters here
           is the CUSTOMER's — the one on their paperwork. -->
      <div class="ui-field-row">
        <div class="ui-field" data-field="npClientWrap">
          <label class="ui-label">Client *</label>
          <div class="cb-wrap" id="npClientWrap"></div>
          <div class="ui-field-err" style="display:none;"></div>
        </div>
        ${uiField({ id: 'npExtPo', label: 'Customer PO #',
                    placeholder: 'e.g. 15487',
                    hint: 'The number on the customer’s paperwork. Ours is assigned automatically on save.' })}
      </div>
      <div class="no-row-3">
        <div class="ui-field">
          <label class="ui-label">Supplier</label>
          <div class="cb-wrap" id="npSupplierWrap"></div>
        </div>
        ${uiField({ id: 'npArrival', label: 'Expected arrival', type: 'date' })}
        ${uiField({ id: 'npNotes', label: 'Notes' })}
      </div>

      <div class="eo-section">
        <div class="no-section-head">
          <div class="ui-label">Receipt lines</div>
          <span class="ui-hint" id="npLinesCount"></span>
          <div style="flex:1"></div>
          <input type="text" class="ui-input no-search" id="npSkuSearch" placeholder="Search items…">
        </div>
        <div id="npSkuResults" class="no-results"></div>
        <div id="npLinesWrap"></div>
      </div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Create receipt', primary: true, onClick: submitNewPo },
    ],
    onClose: () => { PO_M = null; },
  });

  initCombo('npClientWrap',
    clientsCache.map(c => ({ value: String(c.id), label: `${c.code} — ${c.name}` })),
    { placeholder: 'Select client…', onChange: (v) => { if(v) onPoClientChange(v); } });
  initCombo('npSupplierWrap', [],
    { placeholder: 'Select or type a supplier…', allowCustom: true });

  const search = document.getElementById('npSkuSearch');
  search.addEventListener('input', searchPoSkus);
  search.addEventListener('focus', searchPoSkus);

  renderPL();
}

async function onPoClientChange(cid){
  if(!cid) cid = cbVal('npClientWrap');
  if(!cid) return;
  const sups = await apiGet(`/suppliers?clientId=${encodeURIComponent(cid)}`);
  initCombo('npSupplierWrap',
    (sups || []).map(s => ({ value: s, label: s })),
    { placeholder: 'Select or type a supplier…', allowCustom: true });
  poLines = [];
  renderPL();
}

async function searchPoSkus(){
  const cid = cbVal('npClientWrap');
  const s   = document.getElementById('npSkuSearch')?.value || '';
  const div = document.getElementById('npSkuResults');
  if(!div) return;
  if(!cid){
    // Used to fail silently — the box just did nothing with no client picked.
    div.innerHTML = uiEmpty('Pick a client first — items are scoped to the client.');
    div.style.display = 'block';
    return;
  }
  const d = await apiGet(`/skus?clientId=${encodeURIComponent(cid)}&search=${encodeURIComponent(s)}`);
  const list = Array.isArray(d) ? d : (d?.rows || []);
  div.style.display = 'block';
  if(!list.length){ div.innerHTML = uiEmpty(s ? `No SKUs matching “${s}”` : 'No SKUs on this client'); return; }

  div.innerHTML = list.map(x => `
    <div class="no-sku-row js-pl-add" data-id="${esc(x.id)}" data-code="${esc(x.sku_code)}"
         data-name="${esc(x.name || '')}" data-uom="${esc(x.uom)}">
      ${uiId(x.sku_code)}
      <span class="no-sku-name">${esc(x.name || '')}</span>
      <span class="ui-muted">${esc(x.uom || '')}</span>
    </div>`).join('');

  div.querySelectorAll('.js-pl-add').forEach(row =>
    row.addEventListener('click', () =>
      addPL(row.dataset.id, row.dataset.code, row.dataset.name, row.dataset.uom)));
}

function addPL(id, code, name, uom){
  if(poLines.find(l => l.skuId === id)){
    return uiToast(`${code} is already on this receipt`, 'error');   // was a silent no-op
  }
  poLines.push({ skuId: id, code, name, uom, qty: 1, lot: '', expiry: '' });
  renderPL();
  document.getElementById('npSkuSearch').value = '';
  document.getElementById('npSkuResults').style.display = 'none';
  uiToast(`${code} added`);
}

const PL_COLS = [
  { key: 'code', label: 'SKU', mono: true },
  { key: 'name', label: 'Description' },
  { key: 'uom', label: 'UOM' },
  { key: '_qty', label: 'Expected qty', render: l =>
      `<input type="number" class="ui-input ord-pick-qty js-pl-qty" data-key="${esc(l.skuId)}" value="${esc(l.qty)}" min="1">` },
  { key: '_lot', label: 'Lot', render: l =>
      `<input type="text" class="ui-input pl-lot js-pl-lot" data-key="${esc(l.skuId)}" value="${esc(l.lot)}" placeholder="Lot #">` },
  { key: '_exp', label: 'Expiry', render: l =>
      `<input type="date" class="ui-input pl-exp js-pl-expiry" data-key="${esc(l.skuId)}" value="${esc(l.expiry)}">` },
  { key: '_rm', label: '', render: l =>
      `<button class="ui-btn js-pl-remove" data-key="${esc(l.skuId)}" aria-label="Remove line">✕</button>` },
];

function renderPL(){
  const host = document.getElementById('npLinesWrap');
  if(!host) return;
  const count = document.getElementById('npLinesCount');
  if(count){
    const n = poLines.length;
    const qty = poLines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    count.textContent = n ? `${n} ${n === 1 ? 'line' : 'lines'} · ${qty} units expected` : '';
  }

  uiTable(host, {
    columns: PL_COLS, rows: poLines, rowKey: 'skuId',
    empty: 'No lines yet — search an item above.',
  });

  const find = (k) => poLines.find(l => String(l.skuId) === String(k));
  host.querySelectorAll('.js-pl-qty').forEach(inp =>
    inp.addEventListener('input', () => { const l = find(inp.dataset.key); if(l){ l.qty = parseInt(inp.value) || 1; } }));
  host.querySelectorAll('.js-pl-lot').forEach(inp =>
    inp.addEventListener('input', () => { const l = find(inp.dataset.key); if(l) l.lot = inp.value; }));
  host.querySelectorAll('.js-pl-expiry').forEach(inp =>
    inp.addEventListener('input', () => { const l = find(inp.dataset.key); if(l) l.expiry = inp.value; }));
  host.querySelectorAll('.js-pl-remove').forEach(btn =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      poLines = poLines.filter(l => String(l.skuId) !== String(btn.dataset.key));
      renderPL();
    }));
}

// uiModal action — returning false keeps the modal open.
async function submitNewPo(m){
  const cid = cbVal('npClientWrap');
  uiFieldError(m.el, 'npClientWrap', cid ? '' : 'Pick a client');
  if(!cid) return false;
  if(!poLines.length){ uiToast('Add at least one line', 'error'); return false; }

  try {
    const r = await fetch(`${API}/inbound/receipts`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        clientId: cid,
        // Always null: OUR receipt number comes from the sequence (migration
        // 063). There is no field for it, so a customer's PO number can never
        // end up in it by accident.
        poNumber: null,
        supplierName: cbVal('npSupplierWrap') || null,
        // THEIR number, off the customer's paperwork.
        externalPo: document.getElementById('npExtPo').value.trim() || null,
        expectedArrival: document.getElementById('npArrival').value || null,
        notes: document.getElementById('npNotes').value || null,
        lines: poLines.map(l => ({
          skuId: l.skuId, qty: l.qty, uom: l.uom,
          lotNumber: l.lot || null, expiryDate: l.expiry || null,
        })),
      }),
    });
    const d = await r.json();
    if(!r.ok){ uiToast(d.error || 'Could not create the PO', 'error'); return false; }
    uiToast(`${d.po_number} created`);
    loadInbound();
  } catch(e){
    uiToast('Network error — the receipt was not created', 'error');
    return false;
  }
}
