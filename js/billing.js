'use strict';
/* =============================================================================
 * CHARGES — the Billing page's second tab: what each client has accrued in a
 * period, drillable to the individual charges.
 * TERMINAL LEDGER (batch D2). Reads billing_charges via /billing/meter and
 * /billing/charges. Money is NUMERIC dollars throughout.
 *
 * The legacy per-client RATE EDITOR that used to live here is GONE (D2):
 * pricing has one home — Client -> Rate Card (S3b decision). The billing_rates
 * table it wrote to is retired by engine batch S4.
 * ========================================================================== */

let billingMeter       = null;        // {period, rows: [...]}
let billingClient      = null;        // drilled-down client {id, name, code}
let billingCharges     = [];          // charges for drilled client/period
let billingGranularity = 'month';     // 'day' | 'week' | 'month' | 'year'
let billingRefDate     = new Date();  // anchor date for the current view

/* ---------------------------------------------------------------------------
 * PERIOD WINDOW — {from, to} ISO dates for the granularity + anchor date.
 * ------------------------------------------------------------------------- */
function getBillingRange() {
  const d = new Date(billingRefDate);
  const y = d.getFullYear(), m = d.getMonth(), dd = d.getDate();
  const isoDay = (yy, mm, ddd) => {
    const dt = new Date(yy, mm, ddd);
    const off = dt.getTimezoneOffset();
    return new Date(dt.getTime() - off * 60000).toISOString().slice(0, 10);
  };
  if (billingGranularity === 'day') {
    const s = isoDay(y, m, dd);
    return { from: s, to: s };
  }
  if (billingGranularity === 'week') {
    const dow = d.getDay();  // 0 = Sun
    return { from: isoDay(y, m, dd - dow), to: isoDay(y, m, dd - dow + 6) };
  }
  if (billingGranularity === 'year') {
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  const lastDay = new Date(y, m + 1, 0).getDate();
  const mm = String(m + 1).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

function shiftBillingRange(delta) {
  const d = new Date(billingRefDate);
  if (billingGranularity === 'day')   d.setDate(d.getDate() + delta);
  if (billingGranularity === 'week')  d.setDate(d.getDate() + 7 * delta);
  if (billingGranularity === 'month') d.setMonth(d.getMonth() + delta);
  if (billingGranularity === 'year')  d.setFullYear(d.getFullYear() + delta);
  billingRefDate = d;
  billingClient ? openClientBilling(billingClient) : loadBilling();
}

function fmtBillingRangeLabel() {
  const r = getBillingRange();
  const full = { month: 'short', day: 'numeric', year: 'numeric' };
  const at = (s) => new Date(s + 'T00:00:00');
  if (billingGranularity === 'day')  return at(r.from).toLocaleDateString('en-US', full);
  if (billingGranularity === 'week') {
    return `${at(r.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ` +
           `${at(r.to).toLocaleDateString('en-US', full)}`;
  }
  if (billingGranularity === 'year') return String(at(r.from).getFullYear());
  return at(r.from).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/* Legacy stub — some older markup may still call it. */
function shiftBillingPeriod(delta) { shiftBillingRange(delta); }

/* ---------------------------------------------------------------------------
 * METER — one row per client for the selected window.
 * ------------------------------------------------------------------------- */
const BILL_METER_COLS = [
  { key: 'client_code', label: 'Code', mono: true },
  { key: 'client_name', label: 'Client' },
  { key: 'charge_count', label: 'Charges', num: true },
  { key: 'charge_type_count', label: 'Charge codes', num: true },
  { key: 'total_amount', label: 'Total', money: true },
];

async function loadBilling() {
  document.getElementById('billListView').style.display   = 'block';
  document.getElementById('billDetailView').style.display = 'none';
  billingClient = null;

  // Client filter — ops only. In portal mode bootPortal() pre-stubs this combo
  // so we never call loadCC() (GET /clients is requireOps and would 403).
  if (!_cbState['billClientFilterWrap']) {
    await loadCC();
    initCombo('billClientFilterWrap',
      [{ value: '', label: 'All clients' }].concat(
        (clientsCache || []).map(c => ({ value: String(c.id), label: `${c.code} — ${c.name}` }))),
      { placeholder: 'All clients', onChange: () => loadBilling() });
  }
  if (!_cbState['billGranularityWrap']) {
    initCombo('billGranularityWrap',
      [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' },
       { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }],
      { placeholder: 'Period', value: billingGranularity,
        onChange: (v) => { billingGranularity = v || 'month'; loadBilling(); } });
  }

  document.getElementById('billPeriodLabel').textContent = fmtBillingRangeLabel();

  const range = getBillingRange();
  const cl = cbVal('billClientFilterWrap');
  let url = `/billing/meter?from=${range.from}&to=${range.to}`;
  if (cl) url += `&clientId=${encodeURIComponent(cl)}`;

  uiTableLoading('billMeterWrap', BILL_METER_COLS);
  const data = await apiGet(url);
  if (data === null) return uiTableError('billMeterWrap', BILL_METER_COLS, 'Could not load charges', loadBilling);
  billingMeter = data;
  renderMeter();
}

function renderMeter() {
  const rows = billingMeter?.rows || [];
  const total  = rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
  const count  = rows.reduce((s, r) => s + (Number(r.charge_count) || 0), 0);

  const strip = document.getElementById('billStrip');
  strip.className = 'ui-tiles';
  strip.innerHTML =
    uiTile({ label: `Total — ${fmtBillingRangeLabel()}`, value: total, money: true }) +
    uiTile({ label: 'Charges', value: count }) +
    uiTile({ label: 'Clients billed', value: rows.length,
             sub: rows.length ? 'Click a client for the charge detail' : '' });

  uiTable('billMeterWrap', {
    columns: BILL_METER_COLS, rows, rowKey: 'client_id',
    onRowClick: r => openClientBilling({ id: r.client_id, name: r.client_name, code: r.client_code }),
    empty: `No billable activity in ${fmtBillingRangeLabel()}.`,
  });
}

/* ---------------------------------------------------------------------------
 * CLIENT DRILL-DOWN — the charges themselves.
 * ------------------------------------------------------------------------- */
const BILL_CHARGE_COLS = [
  { key: '_date', label: 'Date', render: c => uiId(c.charge_date ? String(c.charge_date).slice(0, 10) : '—') },
  { key: 'charge_type', label: 'Charge code', mono: true },
  { key: '_ref', label: 'Reference', render: c => c.reference_type
      ? `${esc(c.reference_type)} ${uiId(String(c.reference_id || '').slice(0, 8))}`
      : '<span class="ui-muted">—</span>' },
  { key: 'quantity', label: 'Qty', num: true },
  { key: 'unit_rate', label: 'Rate', money: true },
  { key: 'total_amount', label: 'Amount', money: true },
  { key: '_status', label: 'Status', render: c => uiChip(c.is_invoiced ? 'INVOICED' : 'OPEN') },
];

async function openClientBilling(client) {
  billingClient = client;
  document.getElementById('billListView').style.display   = 'none';
  document.getElementById('billDetailView').style.display = 'block';
  document.getElementById('billDetailTitle').innerHTML =
    `${uiId(client.code || '')} ${esc(client.name || '')}`;
  document.getElementById('billDetailPeriod').textContent = fmtBillingRangeLabel();

  uiTableLoading('billChargesWrap', BILL_CHARGE_COLS);
  const range = getBillingRange();
  const rows = await apiGet(
    `/billing/charges?clientId=${encodeURIComponent(client.id)}&from=${range.from}&to=${range.to}&limit=500`);
  if (rows === null) {
    return uiTableError('billChargesWrap', BILL_CHARGE_COLS, 'Could not load charges',
      () => openClientBilling(client));
  }
  billingCharges = rows || [];
  renderClientCharges();
}

function closeClientBilling() {
  billingClient  = null;
  billingCharges = [];
  loadBilling();
}

function renderClientCharges() {
  const charges  = billingCharges;
  const total    = charges.reduce((s, c) => s + (Number(c.total_amount) || 0), 0);
  const open     = charges.filter(c => !c.is_invoiced);
  const openAmt  = open.reduce((s, c) => s + (Number(c.total_amount) || 0), 0);
  const types    = new Set(charges.map(c => c.charge_type)).size;

  const strip = document.getElementById('billClientStrip');
  strip.className = 'ui-tiles';
  strip.innerHTML =
    uiTile({ label: 'Total — period', value: total, money: true }) +
    uiTile({ label: 'Uninvoiced', value: openAmt, money: true,
             tone: openAmt > 0 ? 'warn' : null,
             sub: open.length ? `${open.length} charge(s) not yet on an invoice` : 'All invoiced' }) +
    uiTile({ label: 'Charges', value: charges.length }) +
    uiTile({ label: 'Charge codes', value: types });

  uiTable('billChargesWrap', {
    columns: BILL_CHARGE_COLS, rows: charges, rowKey: 'id',
    empty: `No charges for ${billingClient?.name || 'this client'} in ${fmtBillingRangeLabel()}.`,
  });
}
