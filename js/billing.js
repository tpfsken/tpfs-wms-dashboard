// =============================================================================
// BILLING (Phase 2) — talks to existing billing_rates / billing_charges /
// billing_periods schema. Money is NUMERIC dollars throughout.
// =============================================================================

let billingPeriod  = null;        // 'YYYY-MM' currently shown
let billingMeter   = null;        // {period, rows: [...]}
let billingClient  = null;        // currently drilled-down client {id, name, code}
let billingCharges = [];          // charges for drilled client/period
let billingRates   = [];          // active rates for drilled client

// These match the billing_rates_rate_type_check constraint in the DB.
const RATE_TYPE_OPTIONS = [
  {value:'PICK_FEE',          label:'Pick Fee — Each',       uom:'pick'},
  {value:'CASE_PICK_FEE',     label:'Pick Fee — Case',       uom:'pick'},
  {value:'PALLET_OUT',        label:'Pallet Out (whole)',    uom:'pallet'},
  {value:'PALLET_IN',         label:'Pallet In (receive)',   uom:'pallet'},
  {value:'HANDLING_INBOUND',  label:'Handling — Inbound',    uom:'unit'},
  {value:'HANDLING_OUTBOUND', label:'Handling — Outbound',   uom:'unit'},
  {value:'STORAGE_PALLET',    label:'Storage — Pallet',      uom:'pallet/day'},
  {value:'STORAGE_BIN',       label:'Storage — Bin',         uom:'bin/day'},
  {value:'STORAGE_SQFT',      label:'Storage — SqFt',        uom:'sqft/day'},
  {value:'LABEL_FEE',         label:'Label Fee',             uom:'label'},
  {value:'KITTING',           label:'Kitting',               uom:'kit'},
  {value:'VALUE_ADDED',       label:'Value-Added Service',   uom:'unit'},
  {value:'SPECIAL_PROJECT',   label:'Special Project',       uom:'hour'},
  {value:'MINIMUM_MONTHLY',   label:'Minimum Monthly',       uom:'month'},
  {value:'OTHER',             label:'Other',                 uom:'unit'},
];

function defaultPeriod(){
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftPeriod(period, delta){
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// =============================================================================
// METER (list view)
// =============================================================================

async function loadBilling(){
  if(!billingPeriod) billingPeriod = defaultPeriod();
  document.getElementById('billListView').style.display = 'block';
  document.getElementById('billDetailView').style.display = 'none';

  document.getElementById('billPeriodLabel').textContent = billingPeriod;

  const data = await apiGet(`/billing/meter?period=${encodeURIComponent(billingPeriod)}`);
  if(!data){ return; }
  billingMeter = data;
  renderMeter();
}

function renderMeter(){
  const rows = billingMeter?.rows || [];
  const tbody = document.getElementById('billMeterBody');
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No billable activity in ${esc(billingPeriod)}</td></tr>`;
    document.getElementById('billGrandTotal').textContent = fmtDollars(0);
    document.getElementById('billGrandEvents').textContent = '0';
    return;
  }

  let grandTotal = 0, grandCount = 0;
  tbody.innerHTML = rows.map(r => {
    grandTotal += Number(r.total_amount) || 0;
    grandCount += Number(r.charge_count) || 0;
    return `
      <tr class="js-bill-client" data-id="${esc(r.client_id)}" data-name="${esc(r.client_name || '')}" data-code="${esc(r.client_code || '')}" style="cursor:pointer;">
        <td style="font-weight:600;color:var(--blue);">${esc(r.client_code || '')}</td>
        <td style="font-weight:600;">${esc(r.client_name || '')}</td>
        <td class="right">${esc(r.charge_count || 0)}</td>
        <td class="right" style="color:var(--text2);">${esc(r.charge_type_count || 0)}</td>
        <td class="right" style="font-weight:700;color:var(--green);">${fmtDollars(r.total_amount)}</td>
      </tr>`;
  }).join('');
  document.getElementById('billGrandTotal').textContent  = fmtDollars(grandTotal);
  document.getElementById('billGrandEvents').textContent = String(grandCount);

  tbody.querySelectorAll('.js-bill-client').forEach(row =>
    row.addEventListener('click', () => openClientBilling({
      id:   row.dataset.id,
      name: row.dataset.name,
      code: row.dataset.code,
    }))
  );
}

function shiftBillingPeriod(delta){
  billingPeriod = shiftPeriod(billingPeriod, delta);
  loadBilling();
}

// =============================================================================
// CLIENT DRILL-DOWN
// =============================================================================

async function openClientBilling(client){
  billingClient = client;
  document.getElementById('billListView').style.display = 'none';
  document.getElementById('billDetailView').style.display = 'block';
  document.getElementById('billDetailTitle').textContent = `${client.code} — ${client.name}`;
  document.getElementById('billDetailPeriod').textContent = billingPeriod;

  const [chRes, rRes] = await Promise.all([
    apiGet(`/billing/charges?clientId=${encodeURIComponent(client.id)}&period=${encodeURIComponent(billingPeriod)}&limit=500`),
    apiGet(`/clients/${encodeURIComponent(client.id)}/rates`),
  ]);

  billingCharges = chRes || [];
  billingRates   = rRes  || [];

  renderClientCharges();
  renderClientHeaderTotals();
}

function closeClientBilling(){
  billingClient  = null;
  billingCharges = [];
  billingRates   = [];
  document.getElementById('billDetailView').style.display = 'none';
  document.getElementById('billListView').style.display = 'block';
  loadBilling();
}

function renderClientHeaderTotals(){
  const charges = billingCharges;
  const total = charges.reduce((sum, e) => sum + (Number(e.total_amount) || 0), 0);
  const types = new Set(charges.map(e => e.charge_type)).size;
  document.getElementById('billClientTotal').textContent  = fmtDollars(total);
  document.getElementById('billClientEvents').textContent = String(charges.length);
  document.getElementById('billClientTypes').textContent  = String(types);
}

function renderClientCharges(){
  const tbody = document.getElementById('billEventsBody');
  if(!billingCharges.length){
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No charges for ${esc(billingClient.name)} in ${esc(billingPeriod)}</td></tr>`;
    return;
  }
  tbody.innerHTML = billingCharges.map(c => {
    const stChip = c.is_invoiced ? 'chip-active' : 'chip-success';
    const stLabel = c.is_invoiced ? 'INVOICED' : 'OPEN';
    // charge_date can come back as 'YYYY-MM-DD' or a full ISO timestamp
    // depending on driver. Just hand it to Date() directly.
    const ts = c.charge_date
      ? new Date(c.charge_date).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})
      : '—';
    const refShort = c.reference_id ? String(c.reference_id).slice(0, 8) : '';
    const ref = c.reference_type
      ? `${esc(c.reference_type)} <span style="color:var(--muted);font-size:11px;">${esc(refShort)}</span>`
      : '—';
    return `
      <tr>
        <td style="color:var(--text2);font-size:12px;">${esc(ts)}</td>
        <td><span class="chip chip-new" style="font-size:11px;">${esc(c.charge_type)}</span></td>
        <td style="color:var(--text2);">${ref}</td>
        <td class="right">${esc(Number(c.quantity).toString())}</td>
        <td class="right" style="color:var(--text2);">${fmtDollars(c.unit_rate)}</td>
        <td class="right" style="font-weight:700;color:var(--green);">${fmtDollars(c.total_amount)}</td>
        <td><span class="chip ${stChip}" style="font-size:11px;">${esc(stLabel)}</span></td>
      </tr>`;
  }).join('');
}

// =============================================================================
// RATES MODAL — bulk edit a client's active rates
// =============================================================================

function showRateCardModal(){
  if(!billingClient) return;
  const modal = document.getElementById('rateCardModal');
  modal.style.display = 'flex';
  modal.style.zIndex = '10000';

  document.getElementById('rcModalTitle').textContent = `Rates — ${billingClient.code} ${billingClient.name}`;
  document.getElementById('rcModalError').textContent = '';

  const rates = (billingRates || []).slice();
  if(!rates.find(r => r.rate_type === 'PICK_FEE')){
    rates.push({rate_name:'Standard Pick Fee', rate_type:'PICK_FEE', rate_amount:0.50, uom:'pick'});
  }
  renderRateRows(rates);
}

function renderRateRows(rates){
  const tbody = document.getElementById('rcRatesBody');
  tbody.innerHTML = rates.map((r, i) => {
    return `
      <tr data-i="${i}">
        <td>
          <input type="text" class="form-input js-rc-name" data-i="${i}"
                 value="${esc(r.rate_name || '')}"
                 placeholder="e.g. Standard Each Pick"
                 style="padding:6px 8px;font-size:12px;">
        </td>
        <td>
          <select class="form-input js-rc-type" data-i="${i}" style="padding:6px 8px;font-size:12px;">
            ${RATE_TYPE_OPTIONS.map(o => `<option value="${esc(o.value)}" ${o.value === r.rate_type ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="number" step="0.01" min="0" class="form-input js-rc-amount" data-i="${i}"
                 value="${esc(Number(r.rate_amount || 0).toFixed(2))}"
                 style="width:100px;padding:6px 8px;font-size:12px;">
        </td>
        <td>
          <input type="text" class="form-input js-rc-uom" data-i="${i}"
                 value="${esc(r.uom || '')}"
                 placeholder="unit" style="width:90px;padding:6px 8px;font-size:12px;">
        </td>
        <td>
          <input type="text" class="form-input js-rc-notes" data-i="${i}"
                 value="${esc(r.notes || '')}"
                 placeholder="notes (optional)" style="padding:6px 8px;font-size:12px;">
        </td>
        <td><button class="btn btn-ghost js-rc-remove" data-i="${i}" style="padding:4px 8px;color:var(--red);font-size:12px;">✕</button></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.js-rc-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const cur = collectRateRows();
      cur.splice(parseInt(btn.dataset.i), 1);
      renderRateRows(cur);
    });
  });
}

function collectRateRows(){
  const rows = document.querySelectorAll('#rcRatesBody tr');
  const out = [];
  rows.forEach(tr => {
    const rate_name   = tr.querySelector('.js-rc-name')?.value?.trim();
    const rate_type   = tr.querySelector('.js-rc-type')?.value;
    const rate_amount = parseFloat(tr.querySelector('.js-rc-amount')?.value);
    const uom         = tr.querySelector('.js-rc-uom')?.value?.trim() || null;
    const notes       = tr.querySelector('.js-rc-notes')?.value?.trim() || null;
    if(!rate_type || !rate_name) return;
    out.push({
      rate_name,
      rate_type,
      rate_amount: Number.isFinite(rate_amount) ? rate_amount : 0,
      uom,
      notes,
    });
  });
  return out;
}

function addRateRow(){
  const cur = collectRateRows();
  cur.push({rate_name:'', rate_type:'PICK_FEE', rate_amount:0, uom:'pick'});
  renderRateRows(cur);
}

async function saveRateCard(){
  if(!billingClient) return;
  const err = document.getElementById('rcModalError');
  err.textContent = '';

  const rateRows = collectRateRows();

  // Reject duplicate (rate_type + rate_name) pairs
  const seen = new Set();
  for(const r of rateRows){
    const key = `${r.rate_type}|${r.rate_name}`;
    if(seen.has(key)){
      err.textContent = `Duplicate rate: ${r.rate_type} / ${r.rate_name}`;
      return;
    }
    seen.add(key);
  }

  try {
    const r = await fetch(`${API}/clients/${encodeURIComponent(billingClient.id)}/rates`, {
      method:'PUT',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        rates: rateRows.map(r => ({
          rateName:   r.rate_name,
          rateType:   r.rate_type,
          rateAmount: r.rate_amount,
          uom:        r.uom,
          notes:      r.notes,
        })),
      }),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Save failed'; return; }
    billingRates = d;
    closeModal('rateCardModal');
    renderClientHeaderTotals();
  } catch(e){
    err.textContent = 'Network error';
  }
}
