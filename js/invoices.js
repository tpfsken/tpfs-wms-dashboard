// =============================================================================
// INVOICES — list, detail, generate, lifecycle, void.
// Backed by billing_invoices / billing_invoice_lines (see API queries/invoices.js).
// QuickBooks export is intentionally not wired yet (API returns 501).
// =============================================================================

let INVS = [];        // current invoice list
let CURINV = null;    // currently open invoice (with lines)

const INV_STATUS = {
  DRAFT:    { c: 'chip-warning', l: 'Draft' },
  APPROVED: { c: 'chip-active',  l: 'Approved' },
  SENT:     { c: 'chip-active',  l: 'Sent' },
  PAID:     { c: 'chip-success', l: 'Paid' },
  VOID:     { c: 'chip-danger',  l: 'Void' },
};

// Which status button to offer next, per the API's transition rules.
const INV_NEXT = { DRAFT: 'APPROVED', APPROVED: 'SENT', SENT: 'PAID' };

function invChip(status) {
  const s = INV_STATUS[status] || { c: 'chip-new', l: status || '—' };
  return `<span class="chip ${s.c}">${esc(s.l)}</span>`;
}

async function loadInvoices() {
  const clientId = cbVal('invcClientFilterWrap');
  const status   = cbVal('invcStatusFilterWrap');
  const qs = new URLSearchParams();
  if (clientId) qs.set('clientId', clientId);
  if (status)   qs.set('status', status);

  const d = await apiGet(`/invoices?${qs.toString()}`);
  INVS = d?.rows || d?.data || d || [];

  const body = document.getElementById('invListBody');
  if (!INVS.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state">No invoices yet — use “Generate Invoice”.</div></td></tr>';
    return;
  }
  body.innerHTML = INVS.map(i => `
    <tr class="js-inv-row" data-id="${esc(i.id)}" style="cursor:pointer;">
      <td style="font-weight:600;color:var(--blue);">${esc(i.invoice_number)}</td>
      <td>${esc(i.client_name || '')}</td>
      <td>${esc(i.period_start ? String(i.period_start).slice(0, 10) : '')} → ${esc(i.period_end ? String(i.period_end).slice(0, 10) : '')}</td>
      <td class="right">${esc(i.line_count ?? 0)}</td>
      <td class="right" style="font-weight:700;">${fmtDollars(i.total_amount)}</td>
      <td>${invChip(i.status)}</td>
      <td>${esc(i.issued_at ? String(i.issued_at).slice(0, 10) : '—')}</td>
    </tr>`).join('');

  body.querySelectorAll('.js-inv-row').forEach(r =>
    r.addEventListener('click', () => openInvoice(r.dataset.id))
  );
}

// -----------------------------------------------------------------------------
// DETAIL
// -----------------------------------------------------------------------------
async function openInvoice(id) {
  const d = await apiGet(`/invoices/${id}`);
  if (!d) return;
  CURINV = d;

  document.getElementById('invListView').style.display   = 'none';
  document.getElementById('invDetailView').style.display = 'flex';

  document.getElementById('invDetTitle').textContent = d.invoice_number || 'Invoice';
  document.getElementById('invDetChip').innerHTML    = invChip(d.status);
  document.getElementById('invDetMeta').innerHTML = `
    <div><strong>Client</strong> ${esc(d.client_name || '')}</div>
    <div><strong>Period</strong> ${esc(String(d.period_start).slice(0,10))} → ${esc(String(d.period_end).slice(0,10))}</div>
    <div><strong>Issued</strong> ${esc(d.issued_at ? String(d.issued_at).slice(0,10) : '—')}</div>
    <div><strong>Due</strong> ${esc(d.due_date ? String(d.due_date).slice(0,10) : '—')}</div>
    <div><strong>Paid</strong> ${esc(d.paid_at ? String(d.paid_at).slice(0,10) : '—')}</div>
    <div><strong>QuickBooks</strong> ${d.qb_txn_id ? esc(d.qb_txn_id) : 'not synced'}</div>`;

  // Per-client presentation toggle (S3b): the LEDGER is always per-LP; this
  // only changes how the lines render. Per-invoice override via the buttons.
  INV_VIEW_MODE = (d.invoice_detail_mode === 'SUMMARY') ? 'SUMMARY' : 'DETAILED';
  INV_CURRENT = d;
  renderInvoiceLines();
  const bS = document.getElementById('invViewSummary');
  const bD = document.getElementById('invViewDetailed');
  if (bS && !bS._wired) {
    bS._wired = true;
    bS.addEventListener('click', () => { INV_VIEW_MODE = 'SUMMARY'; renderInvoiceLines(); });
    bD.addEventListener('click', () => { INV_VIEW_MODE = 'DETAILED'; renderInvoiceLines(); });
  }

  document.getElementById('invSubtotal').textContent = fmtDollars(d.subtotal);
  document.getElementById('invTax').textContent      = fmtDollars(d.tax_amount);
  document.getElementById('invTotal').textContent    = fmtDollars(d.total_amount);

  // Actions depend on where the invoice is in its lifecycle.
  const acts = document.getElementById('invDetActions');
  const next = INV_NEXT[d.status];
  let html = '';
  if (next) html += `<button class="btn btn-success js-inv-advance" data-next="${esc(next)}">Mark ${esc(next)}</button>`;
  if (d.status !== 'VOID' && d.status !== 'PAID') html += `<button class="btn btn-ghost js-inv-void" style="color:var(--red);">Void</button>`;
  acts.innerHTML = html;

  acts.querySelectorAll('.js-inv-advance').forEach(b =>
    b.addEventListener('click', () => advanceInvoice(d.id, b.dataset.next)));
  acts.querySelectorAll('.js-inv-void').forEach(b =>
    b.addEventListener('click', () => voidInvoice(d.id)));
}

function closeInvoiceDetail() {
  document.getElementById('invDetailView').style.display = 'none';
  document.getElementById('invListView').style.display   = 'flex';
  CURINV = null;
  loadInvoices();
}

async function advanceInvoice(id, next) {
  const r = await fetch(`${API}/invoices/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${T}` },
    body: JSON.stringify({ status: next }),
  });
  const d = await r.json();
  if (!r.ok) { alert(d.error || 'Status change failed'); return; }
  openInvoice(id);
}

async function voidInvoice(id) {
  const reason = prompt('Void reason (optional):');
  if (reason === null) return;   // cancelled
  const r = await fetch(`${API}/invoices/${id}/void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${T}` },
    body: JSON.stringify({ reason }),
  });
  const d = await r.json();
  if (!r.ok) { alert(d.error || 'Void failed'); return; }
  alert(`Voided — ${d.chargesReleased} charge(s) released back to uninvoiced.`);
  openInvoice(id);
}

// -----------------------------------------------------------------------------
// GENERATE
// -----------------------------------------------------------------------------
function showGenerateInvoiceModal() {
  const m = document.getElementById('genInvoiceModal');
  m.style.display = 'flex'; m.style.zIndex = '10000';

  document.getElementById('genInvError').textContent   = '';
  document.getElementById('genInvSuccess').textContent = '';
  document.getElementById('genInvSubmitBtn').disabled  = false;

  // Default to last calendar month — the normal billing cadence.
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  document.getElementById('genInvFrom').value = first.toISOString().slice(0, 10);
  document.getElementById('genInvTo').value   = last.toISOString().slice(0, 10);
  document.getElementById('genInvDue').value  = '';
  document.getElementById('genInvNotes').value = '';

  initCombo('genInvClientWrap', (clientsCache || []).map(c => ({ value: c.id, label: c.name })),
    { placeholder: 'Select client...' });
}

async function submitGenerateInvoice() {
  const err = document.getElementById('genInvError');
  const suc = document.getElementById('genInvSuccess');
  err.textContent = ''; suc.textContent = '';

  const clientId = cbVal('genInvClientWrap');
  const dateFrom = document.getElementById('genInvFrom').value;
  const dateTo   = document.getElementById('genInvTo').value;
  if (!clientId)          { err.textContent = 'Select a client'; return; }
  if (!dateFrom || !dateTo) { err.textContent = 'Pick a date range'; return; }

  const btn = document.getElementById('genInvSubmitBtn');
  btn.disabled = true;
  try {
    const r = await fetch(`${API}/invoices/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${T}` },
      body: JSON.stringify({
        clientId, dateFrom, dateTo,
        dueDate: document.getElementById('genInvDue').value || null,
        notes:   document.getElementById('genInvNotes').value || null,
      }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Generate failed'; btn.disabled = false; return; }

    suc.textContent = `Created ${d.invoice_number} — ${d.lineCount} line(s), ${fmtDollars(d.total_amount)}`;
    setTimeout(() => { closeModal('genInvoiceModal'); openInvoice(d.id); }, 1000);
  } catch (e) {
    err.textContent = 'Network error';
    btn.disabled = false;
  }
}


// ---------------------------------------------------------------------------
// S3b: detailed vs summary invoice rendering. Summary groups lines by
// (charge_type, unit_rate) — "Storage — 200 x $14.50" — expandable to the
// per-LP detail. The default comes from the client's invoice_detail_mode.
// ---------------------------------------------------------------------------
let INV_VIEW_MODE = 'DETAILED';
let INV_CURRENT = null;

function renderInvoiceLines() {
  const d = INV_CURRENT;
  if (!d) return;
  const body = document.getElementById('invLinesBody');
  const lines = d.lines || [];
  const bS = document.getElementById('invViewSummary');
  const bD = document.getElementById('invViewDetailed');
  if (bS) {
    bS.classList.toggle('btn-primary', INV_VIEW_MODE === 'SUMMARY');
    bS.classList.toggle('btn-ghost', INV_VIEW_MODE !== 'SUMMARY');
    bD.classList.toggle('btn-primary', INV_VIEW_MODE === 'DETAILED');
    bD.classList.toggle('btn-ghost', INV_VIEW_MODE !== 'DETAILED');
    document.getElementById('invViewHint').textContent =
      `client default: ${d.invoice_detail_mode === 'SUMMARY' ? 'Summary' : 'Detailed'}`;
  }

  if (INV_VIEW_MODE !== 'SUMMARY') {
    body.innerHTML = lines.map(l => `
      <tr>
        <td class="right">${esc(l.line_number)}</td>
        <td>${esc(l.description || '')}</td>
        <td>${esc(l.charge_type || '')}</td>
        <td>${esc(l.charge_date ? String(l.charge_date).slice(0,10) : '')}</td>
        <td class="right">${esc(l.quantity)}</td>
        <td class="right">${fmtDollars(l.unit_rate)}</td>
        <td class="right" style="font-weight:600;">${fmtDollars(l.line_total)}</td>
      </tr>`).join('') || '<tr><td colspan="7"><div class="empty-state">No lines</div></td></tr>';
    return;
  }

  // SUMMARY: group by charge type + rate.
  const groups = {};
  for (const l of lines) {
    const key = `${l.charge_type || ''}|${l.unit_rate}`;
    const g = (groups[key] = groups[key] || { type: l.charge_type, rate: l.unit_rate, qty: 0, total: 0, lines: [] });
    g.qty += Number(l.quantity);
    g.total += Number(l.line_total);
    g.lines.push(l);
  }
  let i = 0;
  body.innerHTML = Object.values(groups).map(g => {
    i++;
    const gid = 'invGrp' + i;
    return `
      <tr class="inv-grp-row js-inv-grp" data-target="${gid}" style="cursor:pointer;background:var(--bg);">
        <td class="right">▸</td>
        <td style="font-weight:600;">${esc(g.type || '')} — ${esc(g.lines.length)} item(s)</td>
        <td>${esc(g.type || '')}</td>
        <td></td>
        <td class="right" style="font-weight:600;">${esc(Math.round(g.qty * 10000) / 10000)}</td>
        <td class="right">${fmtDollars(g.rate)}</td>
        <td class="right" style="font-weight:700;">${fmtDollars(g.total)}</td>
      </tr>
      ${g.lines.map(l => `
      <tr class="${gid}" style="display:none;color:var(--text2);font-size:12px;">
        <td class="right">${esc(l.line_number)}</td>
        <td style="padding-left:26px;">${esc(l.description || '')}</td>
        <td>${esc(l.charge_type || '')}</td>
        <td>${esc(l.charge_date ? String(l.charge_date).slice(0,10) : '')}</td>
        <td class="right">${esc(l.quantity)}</td>
        <td class="right">${fmtDollars(l.unit_rate)}</td>
        <td class="right">${fmtDollars(l.line_total)}</td>
      </tr>`).join('')}`;
  }).join('') || '<tr><td colspan="7"><div class="empty-state">No lines</div></td></tr>';

  body.querySelectorAll('.js-inv-grp').forEach(tr =>
    tr.addEventListener('click', () => {
      const open = tr.dataset.open === '1';
      tr.dataset.open = open ? '' : '1';
      tr.querySelector('td').textContent = open ? '▸' : '▾';
      body.querySelectorAll('.' + tr.dataset.target).forEach(r =>
        r.style.display = open ? 'none' : '');
    }));
}
