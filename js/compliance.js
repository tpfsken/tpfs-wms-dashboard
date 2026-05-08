// =============================================================================
// COMPLIANCE PAGE — SDS Intelligence reviewer queue + history + reviewer.
// =============================================================================
// Three tabs:
//   Queue    — extractions in review_high / review_low / rejected bands.
//              Click a row → split-pane reviewer (PDF on left, fields on
//              right). Per-field accept/edit/reject/defer.
//   History  — all extractions across time, including auto_applied and
//              completed reviews. Forensic view.
//   Settings — read-only display of the confidence thresholds (95/85/75).
//              Per-warehouse override is a v2 feature.
//
// PDF rendering uses pdf.js (loaded from CDN in index.html). The viewer
// fetches the SDS bytes via GET /sds-documents/:id/download which streams
// from S3 with auth check, so no presigned URLs need to leak from the
// dashboard.
// =============================================================================

let _cmpCurrentTab        = 'queue';
let _cmpCurrentExtraction = null;     // full payload from /sds-extractions/:id
let _cmpPdfDoc            = null;     // pdf.js document
let _cmpPdfPage           = 1;
let _cmpPdfScale          = 1.4;

// =============================================================================
// ENTRY + TABS
// =============================================================================

async function loadCompliance(){
  cmpSwitchTab(_cmpCurrentTab || 'queue');
  // Best-effort: refresh the sidebar badge with pending count
  try {
    const r = await apiGet('/sds-queue');
    const n = (r?.rows || []).length;
    const badge = document.getElementById('navComplianceBadge');
    if(badge){
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.style.display = n > 0 ? '' : 'none';
    }
  } catch(_) {}
}

function cmpSwitchTab(name){
  _cmpCurrentTab = name;
  ['queue','history','settings'].forEach(t => {
    const tab  = document.getElementById('cmpTab' + t.charAt(0).toUpperCase() + t.slice(1));
    const body = document.getElementById('cmp' + t.charAt(0).toUpperCase() + t.slice(1) + 'Tab');
    if(tab)  tab.classList.toggle('cmp-tab-active', t === name);
    if(body) body.style.display = t === name ? '' : 'none';
  });
  if(name === 'queue')   loadComplianceQueue();
  if(name === 'history') loadComplianceHistory();
}

// =============================================================================
// QUEUE
// =============================================================================

async function loadComplianceQueue(){
  const body = document.getElementById('cmpQueueBody');
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  const r = await apiGet('/sds-queue');
  if(!r){ body.innerHTML = '<div class="empty-state" style="color:var(--red);">Could not load queue</div>'; return; }
  const rows = r.rows || [];
  if(!rows.length){
    body.innerHTML = `
      <div class="empty-state" style="text-align:center;padding:40px 20px;">
        <div style="font-size:48px;margin-bottom:12px;">✓</div>
        <div style="font-size:16px;font-weight:600;">Queue is clear</div>
        <div style="font-size:13px;color:var(--text2);margin-top:6px;">No SDS extractions are waiting for human review.</div>
      </div>`;
    return;
  }
  body.innerHTML = rows.map(r => cmpQueueCard(r)).join('');
  body.querySelectorAll('.cmp-queue-card').forEach(el => {
    el.addEventListener('click', () => cmpOpenReviewer(el.dataset.id));
  });
}

function cmpQueueCard(r){
  const conf = r.overall_confidence == null ? '—' : Math.round(Number(r.overall_confidence) * 100) + '%';
  const diff = r.diff_summary || {};
  const diffParts = [];
  if(diff.large) diffParts.push(`<span style="color:#ffb380;">${esc(diff.large)} large change${diff.large === 1 ? '' : 's'}</span>`);
  if(diff.minor) diffParts.push(`<span style="color:var(--text2);">${esc(diff.minor)} minor</span>`);
  if(diff.new)   diffParts.push(`<span style="color:var(--blue);">${esc(diff.new)} new</span>`);
  const diffLine = diffParts.length ? '· ' + diffParts.join(' · ') : '';
  const ago = r.started_at ? cmpTimeAgo(r.started_at) : '—';
  return `
    <div class="cmp-queue-card" data-id="${esc(r.id)}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
        <div style="font-weight:700;color:var(--blue);">${esc(r.sku_code || '')}</div>
        <div style="font-size:12px;color:var(--text2);">${esc(r.sku_name || '')}</div>
        <div style="flex:1"></div>
        <span class="cmp-band-chip cmp-band-${esc(r.triage_band)}">${esc((r.triage_band || '').replace('_',' '))}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);">
        ${esc(r.client_name || '')} · v${esc(r.version_number)} · ${esc(r.original_filename || 'sds.pdf')} · weakest required ${esc(conf)} ${diffLine}
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px;">extracted ${esc(ago)}</div>
    </div>`;
}

// =============================================================================
// HISTORY (queue includes only review/rejected — history shows everything)
// =============================================================================

async function loadComplianceHistory(){
  const body = document.getElementById('cmpHistoryBody');
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  // No dedicated history endpoint yet — sds-queue gets review/rejected.
  // For history we'd fetch a broader endpoint; for v1 we surface the queue
  // plus a note. Future: add GET /sds-extractions?limit=...
  const r = await apiGet('/sds-queue');
  if(!r){ body.innerHTML = '<div class="empty-state" style="color:var(--red);">Could not load history</div>'; return; }
  const rows = r.rows || [];
  // Apply client-side search filter
  const q = (document.getElementById('cmpHistorySearch')?.value || '').toLowerCase().trim();
  const filtered = q
    ? rows.filter(x =>
        (x.sku_code || '').toLowerCase().includes(q) ||
        (x.original_filename || '').toLowerCase().includes(q))
    : rows;
  if(!filtered.length){
    body.innerHTML = `
      <div class="empty-state" style="text-align:center;padding:30px 20px;">
        <div style="font-size:13px;color:var(--text2);">${q ? 'No extractions match' : 'No extraction history yet'}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:6px;">v1 history surfaces the same items as Queue. A broader history endpoint is a follow-up.</div>
      </div>`;
    return;
  }
  body.innerHTML = filtered.map(r => cmpQueueCard(r)).join('');
  body.querySelectorAll('.cmp-queue-card').forEach(el => {
    el.addEventListener('click', () => cmpOpenReviewer(el.dataset.id));
  });
}

// Wire history search debounce on first call
document.addEventListener('DOMContentLoaded', () => {
  const s = document.getElementById('cmpHistorySearch');
  if(s) s.addEventListener('input', debounce(loadComplianceHistory, 250));
});

// =============================================================================
// REVIEWER — split-pane: PDF on left, per-field cards on right
// =============================================================================

async function cmpOpenReviewer(extractionId){
  document.getElementById('complianceListView').style.display     = 'none';
  document.getElementById('complianceReviewerView').style.display = '';
  document.getElementById('cmpReviewerTitle').textContent = 'Loading…';
  document.getElementById('cmpReviewerSub').textContent   = '';
  document.getElementById('cmpFieldsBody').innerHTML = '<div class="empty-state">Loading fields…</div>';

  const data = await apiGet(`/sds-extractions/${extractionId}`);
  if(!data){
    document.getElementById('cmpFieldsBody').innerHTML = '<div class="empty-state" style="color:var(--red);">Could not load extraction</div>';
    return;
  }
  _cmpCurrentExtraction = data;

  // Header
  document.getElementById('cmpReviewerTitle').textContent = `${data.sku_code || ''} — ${data.sku_name || ''}`;
  document.getElementById('cmpReviewerSub').textContent =
    `v${data.version_number || '?'} · ${data.original_filename || 'sds.pdf'} · weakest required ${data.overall_confidence == null ? '—' : Math.round(Number(data.overall_confidence) * 100) + '%'}`;
  const bandEl = document.getElementById('cmpReviewerBand');
  bandEl.className = 'cmp-band-chip cmp-band-' + (data.triage_band || 'pending');
  bandEl.textContent = (data.triage_band || '').replace('_', ' ').toUpperCase();

  // Render fields
  cmpRenderFields(data);

  // Show "Accept all green" if any field is auto-eligible AND not yet applied
  const anyGreenPending = (data.fields || []).some(f =>
    f.triage_decision === 'auto' && !f.applied && !f.reviewer_action
  );
  document.getElementById('cmpAcceptAllGreenBtn').style.display = anyGreenPending ? '' : 'none';
  document.getElementById('cmpAcceptAllGreenBtn').onclick = () => cmpAcceptAllGreen(data);

  // Load PDF in parallel
  cmpLoadPdf(data.id);
}

function cmpCloseReviewer(){
  document.getElementById('complianceReviewerView').style.display = 'none';
  document.getElementById('complianceListView').style.display     = '';
  _cmpCurrentExtraction = null;
  _cmpPdfDoc = null;
  // Re-load queue so any reviewed items disappear
  loadComplianceQueue();
}

// Section grouping order for the reviewer panel — keeps related fields
// together per SDS section so the reviewer can scan top-to-bottom.
const _cmpSectionOrder = ['1','1.1','1.2','1.3','1.4','2.1','2.2','4.1','7.1','7.2','14.1','14.2','14.3','14.4','14.5','14.x'];

function cmpRenderFields(data){
  const body = document.getElementById('cmpFieldsBody');
  const fields = (data.fields || []).slice().sort((a, b) => {
    const ai = _cmpSectionOrder.indexOf(a.section || '');
    const bi = _cmpSectionOrder.indexOf(b.section || '');
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  body.innerHTML = fields.map(f => cmpFieldCard(f)).join('');

  body.querySelectorAll('.js-cmp-accept').forEach(b =>
    b.addEventListener('click', () => cmpReviewField(b.dataset.id, 'accepted')));
  body.querySelectorAll('.js-cmp-edit').forEach(b =>
    b.addEventListener('click', () => cmpEditField(b.dataset.id)));
  body.querySelectorAll('.js-cmp-reject').forEach(b =>
    b.addEventListener('click', () => cmpReviewField(b.dataset.id, 'rejected')));
  body.querySelectorAll('.js-cmp-defer').forEach(b =>
    b.addEventListener('click', () => cmpReviewField(b.dataset.id, 'deferred')));
  body.querySelectorAll('.cmp-source-quote').forEach(el =>
    el.addEventListener('click', () => {
      const p = parseInt(el.dataset.page);
      if(p) cmpPdfGoTo(p);
    }));
}

function cmpFieldCard(f){
  const conf = f.confidence == null ? 0 : Number(f.confidence);
  const confPct = Math.round(conf * 100);
  const confColor = conf >= 0.95 ? '#28a745'
                  : conf >= 0.85 ? '#d6a700'
                  : conf >= 0.75 ? '#cc6600'
                  :                '#cc1f1f';
  const cardCls = f.applied ? 'applied'
                : f.reviewer_action === 'rejected' ? 'rejected'
                : f.triage_decision === 'review'   ? 'review'
                : '';

  const reviewedBadge = f.reviewer_action
    ? `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${
        f.reviewer_action === 'accepted' ? '#1f4d2e' :
        f.reviewer_action === 'edited'   ? '#1f3a5e' :
        f.reviewer_action === 'rejected' ? '#3a0a0a' : '#3a3a3a'
      };color:${
        f.reviewer_action === 'accepted' ? '#a3ffb3' :
        f.reviewer_action === 'edited'   ? '#cfe3ff' :
        f.reviewer_action === 'rejected' ? '#ff8888' : '#ddd'
      };margin-left:6px;">${esc(f.reviewer_action)}</span>`
    : '';

  const requiredFlag = f.is_required ? '<span style="color:var(--amber);font-weight:700;" title="Required field — missing or low-conf forces review">*</span>' : '';

  const diffLine = f.previous_value != null && f.previous_value !== f.value
    ? `<div style="font-size:11px;margin-top:4px;color:var(--text2);">
         <span style="color:var(--muted);">was:</span> ${esc(f.previous_value)}
         <span style="color:#ffb380;font-weight:600;margin-left:6px;">→ ${esc(f.value || '(missing)')}</span>
         ${f.change_magnitude === 'large' ? '<span style="color:#ffb380;margin-left:6px;">[LARGE CHANGE]</span>' : ''}
       </div>`
    : '';

  const sourceQuote = f.source_snippet
    ? `<div class="cmp-source-quote" data-page="${esc(f.source_page || '')}" title="Click to jump to page ${esc(f.source_page || '?')} in the PDF">
         <strong>p.${esc(f.source_page || '?')}</strong> ${esc(f.source_section ? '§' + f.source_section + ' · ' : '')}"${esc(f.source_snippet)}"
       </div>`
    : f.found
      ? `<div style="font-size:11px;color:var(--muted);font-style:italic;">No source citation</div>`
      : `<div style="font-size:11px;color:var(--muted);font-style:italic;">Not found in document</div>`;

  // Action row (only when not yet reviewed AND found)
  const actions = !f.reviewer_action && f.found
    ? `<div style="display:flex;gap:6px;margin-top:8px;">
         <button class="btn btn-success js-cmp-accept" data-id="${esc(f.id)}" style="padding:5px 10px;font-size:11px;">✓ Accept</button>
         <button class="btn btn-ghost js-cmp-edit"   data-id="${esc(f.id)}" style="padding:5px 10px;font-size:11px;">✏ Edit</button>
         <button class="btn btn-danger js-cmp-reject" data-id="${esc(f.id)}" style="padding:5px 10px;font-size:11px;">✕ Reject</button>
         <button class="btn btn-ghost js-cmp-defer"   data-id="${esc(f.id)}" style="padding:5px 10px;font-size:11px;color:var(--text2);">⏸ Defer</button>
       </div>`
    : !f.reviewer_action && !f.found
      ? `<div style="margin-top:8px;font-size:11px;color:var(--text2);"><em>No value extracted — nothing to review.</em></div>`
      : '';

  return `
    <div class="cmp-field-card ${cardCls}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">§${esc(f.section || '?')}</div>
        <div style="font-size:13px;font-weight:600;color:var(--text);">${esc(f.field_key)}${requiredFlag}</div>
        <div style="flex:1"></div>
        ${reviewedBadge}
        <div style="font-size:11px;color:${confColor};font-weight:700;">${esc(confPct)}%</div>
      </div>
      <div class="cmp-confbar"><div class="cmp-confbar-fill" style="width:${esc(confPct)}%;background:${confColor};"></div></div>
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:13px;color:${f.found ? 'var(--text)' : 'var(--muted)'};word-break:break-word;">
        ${esc(f.value || '—')}
      </div>
      ${diffLine}
      ${sourceQuote}
      ${actions}
    </div>`;
}

async function cmpReviewField(fieldId, action){
  const r = await fetch(`${API}/sds-extraction-fields/${fieldId}/review`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${T}` },
    body: JSON.stringify({ action }),
  });
  if(!r.ok){
    const d = await r.json().catch(() => ({}));
    alert(d.error || 'Review action failed');
    return;
  }
  // Refresh the extraction view in place
  if(_cmpCurrentExtraction?.id) cmpOpenReviewer(_cmpCurrentExtraction.id);
}

async function cmpEditField(fieldId){
  const f = (_cmpCurrentExtraction?.fields || []).find(x => x.id === fieldId);
  const cur = f?.value ?? '';
  const next = prompt(`Edit value for "${f?.field_key || 'field'}":`, cur);
  if(next == null) return;       // cancelled
  if(String(next).trim() === String(cur).trim()){
    if(!confirm('Value is unchanged. Submit as edit anyway?')) return;
  }
  const r = await fetch(`${API}/sds-extraction-fields/${fieldId}/review`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${T}` },
    body: JSON.stringify({ action: 'edited', value: next }),
  });
  if(!r.ok){
    const d = await r.json().catch(() => ({}));
    alert(d.error || 'Edit rejected');
    return;
  }
  if(_cmpCurrentExtraction?.id) cmpOpenReviewer(_cmpCurrentExtraction.id);
}

async function cmpAcceptAllGreen(data){
  const greens = (data.fields || []).filter(f =>
    f.triage_decision === 'auto' && !f.applied && !f.reviewer_action && f.found
  );
  if(!greens.length){ alert('Nothing eligible to bulk-accept.'); return; }
  if(!confirm(`Accept ${greens.length} field${greens.length === 1 ? '' : 's'} that scored ≥95% confidence?`)) return;

  // Sequential to keep the audit log readable. Could parallelize later.
  for(const f of greens){
    try {
      await fetch(`${API}/sds-extraction-fields/${f.id}/review`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${T}` },
        body: JSON.stringify({ action: 'accepted' }),
      });
    } catch(_) { /* keep going on partial failure */ }
  }
  if(_cmpCurrentExtraction?.id) cmpOpenReviewer(_cmpCurrentExtraction.id);
}

// =============================================================================
// PDF.js — load + render with page nav and zoom
// =============================================================================

async function cmpLoadPdf(extractionId){
  if(typeof pdfjsLib === 'undefined'){
    document.getElementById('cmpPdfPageInfo').textContent = 'pdf.js failed to load';
    return;
  }
  const sdsDocId = _cmpCurrentExtraction?.sds_document_id;
  if(!sdsDocId){
    document.getElementById('cmpPdfPageInfo').textContent = 'no document';
    return;
  }
  // The dashboard fetches the PDF bytes via an authenticated endpoint;
  // pdf.js then renders them client-side. No presigned URLs leak.
  document.getElementById('cmpPdfPageInfo').textContent = 'Loading PDF…';
  try {
    const r = await fetch(`${API}/sds-documents/${sdsDocId}/download`, {
      headers: { 'Authorization': `Bearer ${T}` },
    });
    if(!r.ok){
      document.getElementById('cmpPdfPageInfo').textContent = `PDF load failed (HTTP ${r.status})`;
      return;
    }
    const buf = await r.arrayBuffer();
    const loading = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
    _cmpPdfDoc = await loading.promise;
    _cmpPdfPage = 1;
    cmpPdfRender();
  } catch(err){
    document.getElementById('cmpPdfPageInfo').textContent = 'PDF render error: ' + (err.message || err);
  }
}

async function cmpPdfRender(){
  if(!_cmpPdfDoc) return;
  const page = await _cmpPdfDoc.getPage(_cmpPdfPage);
  const viewport = page.getViewport({ scale: _cmpPdfScale });
  const canvas = document.getElementById('cmpPdfCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  document.getElementById('cmpPdfPageInfo').textContent =
    `Page ${_cmpPdfPage} / ${_cmpPdfDoc.numPages}`;
}

function cmpPdfPrev(){ if(_cmpPdfPage > 1){ _cmpPdfPage--; cmpPdfRender(); } }
function cmpPdfNext(){ if(_cmpPdfDoc && _cmpPdfPage < _cmpPdfDoc.numPages){ _cmpPdfPage++; cmpPdfRender(); } }
function cmpPdfGoTo(p){
  if(!_cmpPdfDoc) return;
  const n = Math.max(1, Math.min(_cmpPdfDoc.numPages, parseInt(p) || 1));
  _cmpPdfPage = n; cmpPdfRender();
}
function cmpPdfZoomIn(){  _cmpPdfScale = Math.min(_cmpPdfScale + 0.2, 3); cmpPdfRender(); }
function cmpPdfZoomOut(){ _cmpPdfScale = Math.max(_cmpPdfScale - 0.2, 0.4); cmpPdfRender(); }

// =============================================================================
// HELPERS
// =============================================================================

function cmpTimeAgo(ts){
  const d = new Date(ts);
  if(!d.getTime()) return '—';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if(sec < 60)        return `${sec}s ago`;
  if(sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if(sec < 86400)     return `${Math.floor(sec / 3600)}h ago`;
  if(sec < 7 * 86400) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}
