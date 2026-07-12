'use strict';
/* =============================================================================
 * INVOICES — list, detail, generate, lifecycle, void.
 * TERMINAL LEDGER (batch D2). Zero native dialogs; money via uiMoney; tables
 * via uiTable; statuses via uiChip (frozen taxonomy); every mutation toasts.
 *
 * Backed by billing_invoices / billing_invoice_lines (API queries/invoices.js).
 * QuickBooks export is intentionally not wired yet (API returns 501).
 * ========================================================================== */

let INVS    = [];          // current invoice list
let CURINV  = null;        // currently open invoice (with lines)
let INV_VIEW_MODE = 'DETAILED';   // per-invoice override of the client default

// Which status button to offer next, per the API's transition rules.
const INV_NEXT = { DRAFT: 'APPROVED', APPROVED: 'SENT', SENT: 'PAID' };

const INV_COLS = [
  { key: 'invoice_number', label: 'Invoice #', mono: true },
  { key: 'client_name', label: 'Client' },
  { key: '_period', label: 'Period', render: r => uiId(
      `${String(r.period_start || '').slice(0, 10)} → ${String(r.period_end || '').slice(0, 10)}`) },
  { key: 'line_count', label: 'Lines', num: true },
  { key: 'total_amount', label: 'Total', money: true },
  { key: 'status', label: 'Status', render: r => uiChip(r.status) },
  { key: '_issued', label: 'Issued', render: r => uiId(r.issued_at ? String(r.issued_at).slice(0, 10) : '—') },
];

/* ---------------------------------------------------------------------------
 * LIST
 * ------------------------------------------------------------------------- */
async function loadInvoices() {
  document.getElementById('invDetailView').style.display = 'none';
  document.getElementById('invListView').style.display   = 'flex';

  // Filter combos — these were never initialized before D2, so the two
  // filter wraps on the page rendered empty and did nothing.
  if (!_cbState['invcStatusFilterWrap']) {
    initCombo('invcStatusFilterWrap',
      [{ value: '', label: 'All statuses' }].concat(
        ['DRAFT', 'APPROVED', 'SENT', 'PAID', 'VOID'].map(s => ({ value: s, label: s }))),
      { placeholder: 'All statuses', onChange: () => loadInvoices() });
  }
  if (!_cbState['invcClientFilterWrap']) {
    await loadCC();
    initCombo('invcClientFilterWrap',
      [{ value: '', label: 'All clients' }].concat(
        (clientsCache || []).map(c => ({ value: String(c.id), label: `${c.code} — ${c.name}` }))),
      { placeholder: 'All clients', onChange: () => loadInvoices() });
  }

  const qs = new URLSearchParams();
  const clientId = cbVal('invcClientFilterWrap');
  const status   = cbVal('invcStatusFilterWrap');
  if (clientId) qs.set('clientId', clientId);
  if (status)   qs.set('status', status);

  uiTableLoading('invListWrap', INV_COLS);
  const d = await apiGet(`/invoices?${qs.toString()}`);
  if (d === null) return uiTableError('invListWrap', INV_COLS, 'Could not load invoices', loadInvoices);
  INVS = d?.rows || d?.data || d || [];

  uiTable('invListWrap', {
    columns: INV_COLS, rows: INVS, rowKey: 'id',
    onRowClick: r => openInvoice(r.id),
    empty: 'No invoices yet — post an accrual run, then Generate invoice.',
  });
}

/* ---------------------------------------------------------------------------
 * DETAIL
 * ------------------------------------------------------------------------- */
async function openInvoice(id) {
  const d = await apiGet(`/invoices/${id}`);
  if (!d || !d.id) return uiToast('Could not load invoice', 'error');
  CURINV = d;

  document.getElementById('invListView').style.display   = 'none';
  document.getElementById('invDetailView').style.display = 'flex';

  document.getElementById('invDetTitle').innerHTML =
    `${esc(d.invoice_number || 'Invoice')} ${uiChip(d.status)}`;
  document.getElementById('invDetSub').textContent =
    `${d.client_name || ''} · ${String(d.period_start).slice(0, 10)} → ${String(d.period_end).slice(0, 10)}`;

  document.getElementById('invDetMeta').innerHTML = uiMeta([
    { k: 'Client', v: esc(d.client_name || '—') },
    { k: 'Period', v: uiId(`${String(d.period_start).slice(0, 10)} → ${String(d.period_end).slice(0, 10)}`) },
    { k: 'Issued', v: uiId(d.issued_at ? String(d.issued_at).slice(0, 10) : '—') },
    { k: 'Due',    v: uiId(d.due_date ? String(d.due_date).slice(0, 10) : '—') },
    { k: 'Paid',   v: uiId(d.paid_at ? String(d.paid_at).slice(0, 10) : '—') },
    { k: 'QuickBooks', v: d.qb_txn_id ? uiId(d.qb_txn_id) : '<span class="ui-chip ui-chip-neutral">not synced</span>' },
  ]);

  // Ledger hero: the money, before the lines.
  const strip = document.getElementById('invDetStrip');
  strip.className = 'ui-tiles';
  strip.innerHTML =
    uiTile({ label: 'Total', value: d.total_amount, money: true }) +
    uiTile({ label: 'Subtotal', value: d.subtotal, money: true }) +
    uiTile({ label: 'Tax', value: d.tax_amount, money: true }) +
    uiTile({ label: 'Lines', value: (d.lines || []).length });

  // Presentation toggle (S3b): the LEDGER is always per-LP — this only changes
  // how the lines RENDER. Default comes from the client, overridable per view.
  INV_VIEW_MODE = (d.invoice_detail_mode === 'SUMMARY') ? 'SUMMARY' : 'DETAILED';
  uiTabs('invViewTabs', [
    { id: 'DETAILED', label: 'Detailed' },
    { id: 'SUMMARY',  label: 'Summary' },
  ], { active: INV_VIEW_MODE, onChange: m => { INV_VIEW_MODE = m; renderInvoiceLines(); } });
  document.getElementById('invViewHint').textContent =
    `Client default: ${d.invoice_detail_mode === 'SUMMARY' ? 'Summary' : 'Detailed'}`;
  renderInvoiceLines();

  // Actions depend on where the invoice sits in its lifecycle.
  const acts = document.getElementById('invDetActions');
  const next = INV_NEXT[d.status];
  acts.innerHTML =
    (next ? `<button class="ui-btn ui-btn-primary" id="invAdvBtn">Mark ${esc(next)}</button>` : '') +
    (d.status !== 'VOID' && d.status !== 'PAID'
      ? '<button class="ui-btn ui-btn-danger" id="invVoidBtn">Void</button>' : '');
  document.getElementById('invAdvBtn')?.addEventListener('click', () => advanceInvoice(d.id, next));
  document.getElementById('invVoidBtn')?.addEventListener('click', () => voidInvoice(d.id));
}

function closeInvoiceDetail() {
  CURINV = null;
  loadInvoices();
}

async function advanceInvoice(id, next) {
  const r = await fetch(`${API}/invoices/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ status: next }),
  });
  const d = await r.json();
  if (!r.ok) return uiToast(d.error || 'Status change failed', 'error');
  uiToast(`Invoice marked ${next}`);
  openInvoice(id);
}

async function voidInvoice(id) {
  const reason = await uiPrompt({
    title: 'Void this invoice?',
    body: 'Its charges are <strong>released back to uninvoiced</strong> and can be re-invoiced. The invoice itself stays on the books as VOID — it is never deleted.',
    label: 'Reason (optional)',
    placeholder: 'e.g. wrong period',
    confirmLabel: 'Void invoice',
    danger: true,
  });
  if (reason === null) return;   // cancelled
  const r = await fetch(`${API}/invoices/${id}/void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ reason }),
  });
  const d = await r.json();
  if (!r.ok) return uiToast(d.error || 'Void failed', 'error');
  uiToast(`Voided — ${d.chargesReleased} charge(s) released back to uninvoiced`);
  openInvoice(id);
}

/* ---------------------------------------------------------------------------
 * LINES — detailed (one row per charge) vs summary (grouped by code + rate,
 * expandable to the per-LP detail). The prior <table> + inline-style rows are
 * gone; both modes are uiTable now.
 * ------------------------------------------------------------------------- */
const INV_LINE_COLS = [
  { key: 'line_number', label: '#', num: true },
  { key: 'description', label: 'Description' },
  { key: 'charge_type', label: 'Charge code', mono: true },
  { key: '_date', label: 'Date', render: l => uiId(l.charge_date ? String(l.charge_date).slice(0, 10) : '—') },
  { key: 'quantity', label: 'Qty', num: true },
  { key: 'unit_rate', label: 'Rate', money: true },
  { key: 'line_total', label: 'Amount', money: true },
];

function renderInvoiceLines() {
  const d = CURINV;
  if (!d) return;
  const host = document.getElementById('invLinesWrap');
  const lines = d.lines || [];

  if (INV_VIEW_MODE !== 'SUMMARY') {
    uiTable(host, { columns: INV_LINE_COLS, rows: lines, rowKey: 'id', empty: 'No lines on this invoice.' });
    return;
  }

  // SUMMARY: group by (charge code, unit rate) — "STORAGE_PALLET · 200 × $14.50".
  const groups = {};
  for (const l of lines) {
    const key = `${l.charge_type || ''}|${l.unit_rate}`;
    const g = (groups[key] = groups[key] || { type: l.charge_type, rate: l.unit_rate, qty: 0, total: 0, lines: [] });
    g.qty   += Number(l.quantity);
    g.total += Number(l.line_total);
    g.lines.push(l);
  }
  const keys = Object.keys(groups);
  if (!keys.length) { host.innerHTML = uiEmpty('No lines on this invoice.'); return; }

  host.innerHTML = keys.map((k, i) => {
    const g = groups[k];
    return `<details class="ui-group">
      <summary>
        ${uiId(g.type || '—')}
        <span class="ui-muted">· ${esc(g.lines.length)} item(s) · ${esc(Math.round(g.qty * 10000) / 10000)} × </span>
        ${uiMoney(g.rate)}
        <span style="flex:1"></span>
        ${uiMoney(g.total)}
      </summary>
      <div class="ui-group-body" id="invGrp_${i}"></div>
    </details>`;
  }).join('');

  keys.forEach((k, i) => uiTable(`invGrp_${i}`, {
    columns: INV_LINE_COLS, rows: groups[k].lines, rowKey: 'id',
  }));
}

/* ---------------------------------------------------------------------------
 * GENERATE — the old fixed modal + inline error/success divs are retired for
 * a uiModal form with per-field validation.
 * ------------------------------------------------------------------------- */
async function showGenerateInvoiceModal() {
  await loadCC();
  const now   = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));

  uiModal({
    title: 'Generate invoice',
    width: 560,
    body: `<div class="ui-dialog-body" style="margin-bottom:14px;">
        Gathers every <strong>uninvoiced</strong> charge for this client in the date
        range, rolls them into a DRAFT invoice (one line per charge), and marks those
        charges invoiced. Voiding the invoice later releases them again.
      </div>` +
      uiFieldSelect({ id: 'giClient', label: 'Client',
        options: [{ value: '', label: 'Select client…' }].concat(
          (clientsCache || []).map(c => ({ value: String(c.id), label: `${c.code} — ${c.name}` }))) }) +
      uiField({ id: 'giFrom', label: 'From', type: 'date', value: first.toISOString().slice(0, 10) }) +
      uiField({ id: 'giTo',   label: 'To',   type: 'date', value: last.toISOString().slice(0, 10) }) +
      uiField({ id: 'giDue',  label: 'Due date', type: 'date',
                hint: 'Optional — leave blank to use the client’s payment terms.' }) +
      uiField({ id: 'giNotes', label: 'Notes', placeholder: 'Optional — printed on the invoice' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Generate', primary: true, onClick: async (m) => {
          const clientId = m.el.querySelector('#giClient').value;
          const dateFrom = m.el.querySelector('#giFrom').value;
          const dateTo   = m.el.querySelector('#giTo').value;
          uiFieldError(m.el, 'giClient', clientId ? '' : 'Select a client');
          uiFieldError(m.el, 'giFrom', dateFrom ? '' : 'Required');
          uiFieldError(m.el, 'giTo', dateTo ? '' : 'Required');
          if (!clientId || !dateFrom || !dateTo) return false;
          if (dateTo < dateFrom) { uiFieldError(m.el, 'giTo', 'End date is before the start date'); return false; }

          const r = await fetch(`${API}/invoices/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
            body: JSON.stringify({
              clientId, dateFrom, dateTo,
              dueDate: m.el.querySelector('#giDue').value || null,
              notes:   m.el.querySelector('#giNotes').value.trim() || null,
            }),
          });
          const d = await r.json();
          if (!r.ok) { uiFieldError(m.el, 'giClient', d.error || 'Generate failed'); return false; }
          uiToast(`${d.invoice_number} created — ${d.lineCount} line(s)`);
          openInvoice(d.id);
        } },
    ],
  });
}
/* end invoices.js (D2) */
