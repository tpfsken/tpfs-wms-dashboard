// =============================================================================
// INTAKE PIPELINE — AI document extraction review
// =============================================================================

let _intakeCurrent     = null;   // currently-open intake doc (full record)
let _intakeEdited      = null;   // working copy of "data" (edited_json)
let _intakeMissingSkus = [];     // sku codes not found at approve-time

const INTAKE_STATUSES = [
  {value:'',label:'All statuses'},
  {value:'UPLOADED',label:'Uploaded'},
  {value:'EXTRACTING',label:'Extracting'},
  {value:'EXTRACTED',label:'Extracted'},
  {value:'EXTRACTION_FAILED',label:'Failed'},
  {value:'APPROVED',label:'Approved'},
  {value:'REJECTED',label:'Rejected'},
];

/* Extraction confidence. The tiers drive whether ops can trust a field without
 * checking it against the PDF, so they map onto the frozen status tones —
 * NOT a separate colour scheme. */
function confTier(c){
  if(c == null || c === '') return null;
  const n = Number(c);
  if(isNaN(n)) return null;
  if(n >= 0.85) return 'high';
  if(n >= 0.6)  return 'med';
  return 'low';
}

function confColor(t){
  return t === 'high' ? 'var(--st-ok)'
       : t === 'med'  ? 'var(--st-warn)'
       : t === 'low'  ? 'var(--st-danger)'
       : 'var(--muted)';
}

const INTAKE_COLS = [
  { key: '_when', label: 'Uploaded', sortValue: r => r.uploaded_at,
    render: r => uiId(fmtTimeShort(r.uploaded_at)) },
  { key: 'pdf_filename', label: 'File', render: r => uiId((r.pdf_filename || '').slice(0, 40)) },
  { key: 'doc_type', label: 'Type', render: r =>
      `<span class="ui-chip ui-chip-neutral">${esc(r.doc_type || '—')}</span>` },
  { key: '_client', label: 'Client', sortValue: r => r.client_name,
    render: r => r.client_name
      ? esc(r.client_name)
      // Unassigned blocks approval — it's not a neutral "—".
      : '<span class="ui-chip ui-chip-warn">unassigned</span>' },
  { key: 'pdf_size_bytes', label: 'Size', num: true, render: r => uiNum(fmtBytes(r.pdf_size_bytes)) },
  { key: 'extraction_cost_usd', label: 'AI cost', num: true,
    render: r => uiNum(fmtCost(r.extraction_cost_usd)) },
  { key: 'status', label: 'Status', render: r => uiChip(r.status) },
  { key: '_linked', label: 'Result', sortable: false, render: r =>
      r.created_order_number ? `<span class="ui-chip ui-chip-ok">SO ${esc(r.created_order_number)}</span>`
    : r.created_po_number    ? `<span class="ui-chip ui-chip-ok">PO ${esc(r.created_po_number)}</span>`
    : '<span class="ui-muted">—</span>' },
];

async function loadIntake(){
  const status = (_cbState['intakeStatusFilterWrap']?.selected?.value) || '';
  let u = '/intake?limit=100';
  if(status) u += `&status=${encodeURIComponent(status)}`;

  uiTableLoading('intakeListWrap', INTAKE_COLS);
  const d = await apiGet(u);
  if(d === null) return uiTableError('intakeListWrap', INTAKE_COLS, 'Could not load intake documents', loadIntake);

  uiTable('intakeListWrap', {
    columns: INTAKE_COLS, rows: d, rowKey: 'id',
    sortable: true,
    onRowClick: r => openIntakeReview(r.id),
    empty: status ? 'No documents with that status.' : 'No documents yet — drop a PDF above.',
  });

  // This endpoint returns a flat array with no total. If we got exactly the
  // limit, there are more — don't let the screen imply otherwise.
  const note = document.getElementById('intakeCount');
  if(note){
    note.innerHTML = d.length >= 100
      ? '<span class="ui-chip ui-chip-warn">showing the newest 100 — filter by status to narrow</span>'
      : (d.length ? `${esc(d.length)} document${d.length === 1 ? '' : 's'}` : '');
  }
}

// ----- UPLOAD -----

function setupIntakeDropzone(){
  const z = document.getElementById('intakeDropZone');
  if(!z || z._wired) return;
  z._wired = true;
  ['dragenter','dragover'].forEach(e => z.addEventListener(e, ev => {
    ev.preventDefault(); ev.stopPropagation();
    z.classList.add('ui-drop-hot');
  }));
  ['dragleave','drop'].forEach(e => z.addEventListener(e, ev => {
    ev.preventDefault(); ev.stopPropagation();
    z.classList.remove('ui-drop-hot');
  }));
  z.addEventListener('drop', ev => {
    const pdfs = Array.from(ev.dataTransfer.files || []).filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if(pdfs.length) uploadIntakeFiles(pdfs);
    else uiToast('PDFs only — that file type can\'t be extracted', 'error');
  });
}

function onIntakeFilesPicked(ev){
  const files = Array.from(ev.target.files || []);
  if(files.length) uploadIntakeFiles(files);
  ev.target.value = '';
}

const INTAKE_MAX = 25 * 1024 * 1024;

async function uploadIntakeFiles(files){
  const status = document.getElementById('intakeUploadStatus');
  let done = 0, lastId = null;

  for(const file of files){
    if(file.size > INTAKE_MAX){
      uiToast(`${file.name} is ${(file.size / 1048576).toFixed(1)}MB — 25MB max`, 'error');
      continue;
    }
    status.innerHTML = uiSpinner(`Uploading ${file.name} (${done + 1} of ${files.length})…`);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch(`${API}/intake/upload`, {
        method:'POST', headers:{'Authorization':`Bearer ${T}`}, body: fd,
      });
      const d = await r.json();
      if(!r.ok) throw new Error(d.error || 'Upload failed');
      lastId = d.id; done++;
      // Kick extraction off in the background.
      fetch(`${API}/intake/${d.id}/extract`, {
        method:'POST', headers:{'Authorization':`Bearer ${T}`},
      }).catch(() => {});
    } catch(e){
      uiToast(`${file.name}: ${e.message}`, 'error');
    }
  }

  status.innerHTML = '';
  if(done) uiToast(`${done} document${done === 1 ? '' : 's'} uploaded — Claude is reading ${done === 1 ? 'it' : 'them'}`);
  loadIntake();
  setTimeout(loadIntake, 3500);   // extraction usually lands by now

  // Single upload: drop the user straight into the review.
  if(lastId && files.length === 1) setTimeout(() => openIntakeReview(lastId), 2500);
}

// ----- REVIEW -----

async function openIntakeReview(id){
  const doc = await apiGet(`/intake/${id}`);
  if(!doc) return;
  _intakeCurrent = doc;
  _intakeEdited  = JSON.parse(JSON.stringify(doc.edited_json || doc.extracted_json?.data || {}));
  document.getElementById('intakeListView').style.display = 'none';
  document.getElementById('intakeReviewView').style.display = 'flex';
  document.getElementById('intakeRevTitle').textContent = doc.pdf_filename || doc.id;

  const subBits = [];
  if(doc.client_name) subBits.push(doc.client_name);
  subBits.push(`Uploaded ${fmtTimeShort(doc.uploaded_at)}`);
  if(doc.uploaded_by) subBits.push(`by ${doc.uploaded_by}`);
  if(doc.extraction_cost_usd != null) subBits.push(`Cost ${fmtCost(doc.extraction_cost_usd)}`);
  document.getElementById('intakeRevSub').textContent = subBits.join(' · ');

  document.getElementById('intakeRevStatus').innerHTML = uiChip(doc.status);
  document.getElementById('intakeRevDocType').textContent = doc.doc_type || '—';

  const pdfData = await apiGet(`/intake/${id}/pdf-url`);
  if(pdfData?.url){
    document.getElementById('intakePdfFrame').src = pdfData.url;
    document.getElementById('intakePdfDownload').href = pdfData.url;
  }

  renderIntakeForm();

  if(doc.status === 'UPLOADED'){
    setTimeout(() => runIntakeExtract(false), 300);
  }
}

function closeIntakeReview(){
  _intakeCurrent = null; _intakeEdited = null; _intakeMissingSkus = [];
  document.getElementById('intakePdfFrame').src = 'about:blank';
  document.getElementById('intakeListView').style.display = 'block';
  document.getElementById('intakeReviewView').style.display = 'none';
  loadIntake();
}

function renderIntakeForm(){
  const doc  = _intakeCurrent;
  const data = _intakeEdited || {};
  const conf = doc?.confidence_json || {};
  const root = document.getElementById('intakeRevForm');

  if(doc?.status === 'UPLOADED'){
    root.innerHTML = '<div class="empty-state" style="padding:40px;">Extraction in progress...</div>';
    return;
  }
  if(doc?.status === 'EXTRACTING'){
    root.innerHTML = '<div class="empty-state" style="padding:40px;">Claude is reading the document...</div>';
    return;
  }
  if(doc?.status === 'EXTRACTION_FAILED'){
    root.innerHTML = `
      <div style="padding:16px;background:var(--red-bg);border:1px solid rgba(239,68,68,.2);border-radius:8px;">
        <div style="font-weight:600;color:var(--red);margin-bottom:6px;">Extraction failed</div>
        <div style="font-size:13px;color:var(--text2);font-family:monospace;white-space:pre-wrap;">${esc(doc.extraction_error || 'Unknown error')}</div>
        <div style="font-size:13px;color:var(--text2);margin-top:8px;">Click "Re-extract" above to try again.</div>
      </div>`;
    return;
  }
  if(!Object.keys(data).length){
    root.innerHTML = '<div class="empty-state" style="padding:40px;">No extracted data yet</div>';
    return;
  }

  const docType = (doc.doc_type || '').toUpperCase();
  const isOrder  = docType === 'OUTBOUND_ORDER';
  const isPoLike = docType === 'INBOUND_PO';

  let html = '';

  if(!doc.client_id){
    html += `
      <div style="background:var(--amber-bg);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:12px;margin-bottom:16px;">
        <div style="font-weight:600;color:var(--amber);margin-bottom:6px;">⚠ Client not assigned</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:8px;">Select the client this document belongs to before approving.</div>
        <div class="cb-wrap" id="intakeClientPickerWrap" style="max-width:280px;"></div>
      </div>`;
  }

  if(isOrder){
    html += intakeFieldGroup('Order', [
      ['order_number','Order Number',data,conf],
      ['external_order_number','External Order #',data,conf],
      ['channel','Channel',data,conf],
      ['required_ship_date','Required Ship Date',data,conf,'date'],
    ]);
    html += intakeFieldGroup('Customer', [
      ['customer_name','Customer Name',data,conf],
      ['customer_email','Email',data,conf],
    ]);
    html += intakeFieldGroup('Ship To', [
      ['ship_to_name','Name',data,conf],
      ['ship_to_line1','Address Line 1',data,conf],
      ['ship_to_line2','Address Line 2',data,conf],
      ['ship_to_city','City',data,conf],
      ['ship_to_state','State',data,conf],
      ['ship_to_postal','Postal',data,conf],
      ['ship_to_country','Country',data,conf],
    ]);
    html += intakeFieldGroup('Carrier', [
      ['ship_method','Ship Method',data,conf],
      ['carrier_code','Carrier Code',data,conf],
    ]);
  } else if(isPoLike){
    html += intakeFieldGroup('Purchase Order', [
      ['po_number','PO Number',data,conf],
      ['external_po','External PO',data,conf],
      ['supplier_name','Supplier',data,conf],
      ['supplier_ref','Supplier Ref',data,conf],
      ['expected_arrival','Expected Arrival',data,conf,'date'],
    ]);
  } else {
    html += `<div class="empty-state" style="padding:24px;">Document classified as <strong>${esc(docType || 'unknown')}</strong> — edit the doc type to INBOUND_PO or OUTBOUND_ORDER, or reject.</div>`;
  }

  if(data.notes !== undefined){
    html += intakeFieldGroup('Notes', [['notes','Notes',data,conf,'textarea']]);
  }

  if(Array.isArray(data.lines)){
    const lineConf = conf.lines || [];
    html += `<div style="margin-top:12px;"><div style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Lines (${esc(data.lines.length)})</div>`;
    html += '<div style="overflow-x:auto;"><table class="data-table" style="min-width:900px;table-layout:fixed;"><thead><tr>';
    html += '<th style="width:40px;">#</th>';
    html += '<th style="width:140px;">SKU Code</th>';
    html += '<th style="width:180px;">Description</th>';
    html += '<th style="width:70px;">Qty</th>';
    html += '<th style="width:60px;">UOM</th>';
    if(isPoLike){
      html += '<th style="width:120px;">Lot</th>';
      html += '<th style="width:130px;">Expiry</th>';
      html += '<th style="width:90px;">Unit Cost</th>';
    }
    if(isOrder) html += '<th style="width:90px;">Unit Price</th>';
    html += '<th style="width:36px;"></th>';
    html += '</tr></thead><tbody>';

    data.lines.forEach((line, idx) => {
      const lc = lineConf[idx] || {};
      html += `
        <tr>
          <td><input class="form-input js-il-field" data-idx="${idx}" data-key="line_number" style="padding:6px 8px;font-size:12px;width:100%;" value="${esc(line.line_number ?? idx + 1)}"></td>
          <td>${intakeInputCell(line, lc, 'sku_code',    idx, 'monospace')}</td>
          <td>${intakeInputCell(line, lc, 'description', idx)}</td>
          <td>${intakeInputCell(line, lc, 'quantity',    idx, null, 'number')}</td>
          <td>${intakeInputCell(line, lc, 'uom',         idx)}</td>`;
      if(isPoLike){
        html += `<td>${intakeInputCell(line, lc, 'lot_number',  idx)}</td>`;
        html += `<td>${intakeInputCell(line, lc, 'expiry_date', idx, null, 'date')}</td>`;
        html += `<td>${intakeInputCell(line, lc, 'unit_cost',   idx, null, 'number')}</td>`;
      }
      if(isOrder){
        html += `<td>${intakeInputCell(line, lc, 'unit_price', idx, null, 'number')}</td>`;
      }
      html += `<td><button class="btn btn-ghost js-il-remove" data-idx="${idx}" style="padding:4px 6px;font-size:11px;">✕</button></td></tr>`;
    });

    html += '</tbody></table></div>';
    html += `<button class="btn btn-ghost js-il-add" style="margin-top:8px;font-size:12px;padding:6px 12px;">+ Add line</button></div>`;
  }

  root.innerHTML = html;

  // Wire field/line inputs (delegated)
  root.querySelectorAll('.js-if-field').forEach(inp => {
    inp.addEventListener('input', () => onIntakeFieldChange(inp.dataset.key, inp.value));
  });
  root.querySelectorAll('.js-il-field').forEach(inp => {
    inp.addEventListener('input', () => onIntakeLineChange(parseInt(inp.dataset.idx), inp.dataset.key, inp.value));
  });
  root.querySelectorAll('.js-il-remove').forEach(btn => {
    btn.addEventListener('click', () => removeIntakeLine(parseInt(btn.dataset.idx)));
  });
  root.querySelectorAll('.js-il-add').forEach(btn => {
    btn.addEventListener('click', addIntakeLine);
  });

  if(!doc.client_id){
    apiGet('/clients').then(clients => {
      if(!clients) return;
      const opts = [{value:'', label:'Select client...'}].concat(
        clients.map(c => ({value: c.id, label: `${c.code} — ${c.name}`}))
      );
      initCombo('intakeClientPickerWrap', opts, {
        placeholder:'Select client...',
        onChange:(v) => { if(v) assignIntakeClient(v); },
      });
    });
  }
}

function intakeFieldGroup(title, fields){
  let html = `<div style="margin-bottom:16px;"><div style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">${esc(title)}</div>`;
  html += '<div class="form-row form-row-2">';
  for(const [key, label, data, conf, type] of fields){
    const val = data[key] ?? '';
    const c = conf[key];
    const tier = confTier(c);
    const dotColor = confColor(tier);
    const inputType = type === 'date' ? 'date' : type === 'textarea' ? '' : 'text';
    const dot = tier
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};" title="Confidence ${(c * 100).toFixed(0)}%"></span>`
      : '';
    const widget = type === 'textarea'
      ? `<textarea class="form-input js-if-field" data-key="${esc(key)}" style="min-height:60px;">${esc(val ?? '')}</textarea>`
      : `<input class="form-input js-if-field" data-key="${esc(key)}" type="${inputType}" value="${esc(val ?? '')}">`;
    html += `
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label" style="display:flex;align-items:center;gap:6px;">${esc(label)}${dot}</label>
        ${widget}
      </div>`;
  }
  html += '</div></div>';
  return html;
}

// FIX: previously `(v||'').toString()` rendered numeric 0 as blank.
function intakeInputCell(line, lineConf, key, idx, fontFamily, inputType){
  const v = line[key] ?? '';
  const c = lineConf[key];
  const tier = confTier(c);
  const dotColor = confColor(tier);
  const styles = `width:100%;padding:6px 8px;font-size:12px;${fontFamily ? 'font-family:monospace;' : ''}`;
  const t = inputType === 'date' ? 'date' : inputType === 'number' ? 'number' : 'text';
  const dot = tier
    ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0;" title="Confidence ${(c * 100).toFixed(0)}%"></span>`
    : '';
  return `
    <div style="position:relative;display:flex;align-items:center;gap:4px;">
      ${dot}
      <input class="form-input js-il-field" type="${t}" data-idx="${idx}" data-key="${esc(key)}" style="${styles}" value="${esc(v ?? '')}">
    </div>`;
}

function onIntakeFieldChange(key, val){
  if(!_intakeEdited) _intakeEdited = {};
  _intakeEdited[key] = val;
}

function onIntakeLineChange(idx, key, val){
  if(!_intakeEdited.lines || !_intakeEdited.lines[idx]) return;
  if(key === 'quantity' || key === 'line_number' || key === 'unit_price' || key === 'unit_cost'){
    _intakeEdited.lines[idx][key] = val === '' ? null : Number(val);
  } else {
    _intakeEdited.lines[idx][key] = val;
  }
}

function removeIntakeLine(idx){
  if(!_intakeEdited.lines) return;
  _intakeEdited.lines.splice(idx, 1);
  renderIntakeForm();
}

function addIntakeLine(){
  if(!_intakeEdited.lines) _intakeEdited.lines = [];
  const isOrder = (_intakeCurrent.doc_type || '').toUpperCase() === 'OUTBOUND_ORDER';
  _intakeEdited.lines.push({
    line_number: _intakeEdited.lines.length + 1,
    sku_code: '', description: '', quantity: 0, uom: 'EA',
    ...(isOrder ? {unit_price:null} : {lot_number:null, expiry_date:null, unit_cost:null}),
  });
  renderIntakeForm();
}

async function runIntakeExtract(force){
  const id = _intakeCurrent?.id; if(!id) return;
  document.getElementById('intakeRevForm').innerHTML = uiSpinner('Claude is reading the document…');
  try {
    const r = await fetch(`${API}/intake/${id}/extract${force ? '?force=true' : ''}`, {
      method:'POST', headers:{'Authorization':`Bearer ${T}`},
    });
    const d = await r.json();
    if(!r.ok) uiToast(d.error || 'Extraction failed', 'error');
    openIntakeReview(id);
  } catch(e){
    uiToast('Network error during extraction', 'error');
    openIntakeReview(id);
  }
}

async function saveIntakeEdits(){
  const id = _intakeCurrent?.id; if(!id) return;
  try {
    const r = await fetch(`${API}/intake/${id}/edits`, {
      method:'PATCH',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${T}`},
      body: JSON.stringify({editedJson: _intakeEdited}),
    });
    const d = await r.json();
    if(!r.ok) return uiToast(d.error || 'Save failed', 'error');
    uiToast(d.diffs
      ? `Saved — ${d.diffs} field${d.diffs === 1 ? '' : 's'} changed from what Claude read`
      : 'Saved — nothing changed');
  } catch(e){
    uiToast('Network error — edits not saved', 'error');
  }
}

async function assignIntakeClient(clientId){
  const id = _intakeCurrent?.id; if(!id) return;
  try {
    const r = await fetch(`${API}/intake/${id}/client`, {
      method:'PATCH',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${T}`},
      body: JSON.stringify({clientId}),
    });
    if(!r.ok){
      const d = await r.json();
      return uiToast(d.error || 'Could not assign the client', 'error');
    }
    uiToast('Client assigned');
    openIntakeReview(id);
  } catch(e){
    uiToast('Network error', 'error');
  }
}

async function approveIntakeDoc(){
  const id = _intakeCurrent?.id; if(!id) return;
  if(!_intakeCurrent.client_id){
    return uiToast('Assign a client before approving — the order can\'t be created without one', 'error');
  }

  // Approving turns AI-extracted text into a real order or PO. If Claude was
  // unsure about anything, say so BEFORE it becomes a live document — that is
  // the entire point of a review step.
  const conf = _intakeCurrent.confidence_json || {};
  const shaky = Object.entries(conf)
    .filter(([, v]) => confTier(v) === 'low')
    .map(([k]) => k);
  if(shaky.length){
    const ok = await uiConfirm({
      title: 'Approve with low-confidence fields?',
      body: `Claude was <strong>unsure</strong> about ${shaky.length} field(s): ` +
            `<strong>${esc(shaky.slice(0, 8).join(', '))}</strong>` +
            (shaky.length > 8 ? ` and ${shaky.length - 8} more` : '') +
            `.<br><br>Approving creates a real ${_intakeCurrent.doc_type === 'INBOUND_PO' ? 'PO' : 'order'} from this data. Check those fields against the PDF first.`,
      confirmLabel: 'Approve anyway',
    });
    if(!ok) return;
  }

  // Persist edits first — approve reads the saved record, not what's on screen.
  try {
    await fetch(`${API}/intake/${id}/edits`, {
      method:'PATCH',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${T}`},
      body: JSON.stringify({editedJson: _intakeEdited}),
    });
  } catch(e){
    return uiToast('Could not save your edits — not approving', 'error');
  }

  try {
    const r = await fetch(`${API}/intake/${id}/approve`, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${T}`},
      body: JSON.stringify({}),
    });
    const d = await r.json();
    if(!r.ok){
      if(d.error && d.error.includes('Unknown SKU code')){
        const codes = d.error.replace(/.*: /, '').replace(/\..*$/, '').split(',').map(s => s.trim()).filter(Boolean);
        _intakeMissingSkus = codes;
        uiToast(`${codes.length} SKU(s) don't exist yet: ${codes.join(', ')} — create them to continue`, 'error');
        promptCreateNextMissingSku();
        return;
      }
      return uiToast(d.error || 'Approval failed', 'error');
    }
    const created = d.created;
    uiToast(created.type === 'ORDER' ? 'Order created from this document' : 'PO created from this document');
    closeIntakeReview();
  } catch(e){
    uiToast('Network error — nothing was created', 'error');
  }
}

async function rejectIntakeDoc(){
  const id = _intakeCurrent?.id; if(!id) return;
  const reason = await uiPrompt({
    title: 'Reject this document?',
    body: 'It stays on file, marked REJECTED. Nothing is created from it.',
    label: 'Reason (optional)',
    placeholder: 'e.g. duplicate, wrong client, illegible scan',
    confirmLabel: 'Reject',
    danger: true,
  });
  if(reason === null) return;   // cancelled
  try {
    const r = await fetch(`${API}/intake/${id}/reject`, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${T}`},
      body: JSON.stringify({reason}),
    });
    if(!r.ok){
      const d = await r.json();
      return uiToast(d.error || 'Reject failed', 'error');
    }
    uiToast('Document rejected');
    closeIntakeReview();
  } catch(e){
    uiToast('Network error', 'error');
  }
}

function promptCreateNextMissingSku(){
  if(!_intakeMissingSkus.length) return;
  const code = _intakeMissingSkus[0];
  document.getElementById('iskCode').value = code;
  document.getElementById('iskName').value = '';
  document.getElementById('iskUom').value = 'EA';
  document.getElementById('iskUpc').value = '';
  document.getElementById('iskUnitsPerCase').value = '';
  document.getElementById('iskError').textContent = '';
  document.getElementById('intakeSkuModal').style.display = 'flex';
}

async function submitIntakeSku(){
  const err = document.getElementById('iskError'); err.textContent = '';
  const code = document.getElementById('iskCode').value.trim();
  const name = document.getElementById('iskName').value.trim();
  const uom  = document.getElementById('iskUom').value.trim() || 'EA';
  if(!code || !name){ err.textContent = 'Code and description required'; return; }
  if(!_intakeCurrent?.client_id){ err.textContent = 'Client not assigned on intake doc'; return; }
  const upc = document.getElementById('iskUpc').value.trim() || null;
  const unitsPerCase = parseInt(document.getElementById('iskUnitsPerCase').value) || null;

  try {
    const r = await fetch(`${API}/skus`, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        clientId: _intakeCurrent.client_id,
        skuCode: code, name, uom, upc, unitsPerCase,
      }),
    });
    if(!r.ok){
      const d = await r.json();
      err.textContent = d.error || 'Failed to create SKU';
      return;
    }
    _intakeMissingSkus.shift();
    closeModal('intakeSkuModal');
    if(_intakeMissingSkus.length){
      setTimeout(promptCreateNextMissingSku, 200);
    } else {
      setTimeout(approveIntakeDoc, 200);
    }
  } catch(e){
    err.textContent = 'Network error';
  }
}
