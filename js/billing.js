// =============================================================================
// BILLING (Phase 2)
// =============================================================================

let billingPeriod = null;        // 'YYYY-MM' currently shown
let billingMeter  = null;        // {period, rows: [{client_id, total_cents, ...}]}
let billingClient = null;        // currently drilled-down client {id, name, code}
let billingEvents = [];          // events for drilled client
let billingRateCard = null;      // rate card for drilled client

const CHARGE_TYPE_OPTIONS = [
  {value:'PICK_EACH',         label:'Pick — Each',           unit:'pick'},
  {value:'PICK_CASE',         label:'Pick — Case',           unit:'pick'},
  {value:'PICK_PALLET',       label:'Pick — Pallet',         unit:'pick'},
  {value:'PALLET_SHIPPED',    label:'Pallet Shipped',        unit:'pallet'},
  {value:'STORAGE_PALLET_DAY',label:'Storage — Pallet/Day',  unit:'day'},
  {value:'STORAGE_BIN_DAY',   label:'Storage — Bin/Day',     unit:'day'},
  {value:'INBOUND_PALLET',    label:'Inbound — Pallet',      unit:'pallet'},
  {value:'INBOUND_CASE',      label:'Inbound — Case',        unit:'case'},
  {value:'INBOUND_CONTAINER', label:'Inbound — Container',   unit:'container'},
  {value:'HAZMAT',            label:'Hazmat Surcharge',      unit:'unit'},
  {value:'FRAGILE',           label:'Fragile Handling',      unit:'unit'},
  {value:'OVERSIZE',          label:'Oversize Surcharge',    unit:'unit'},
  {value:'EXPEDITE',          label:'Expedited Handling',    unit:'unit'},
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
    document.getElementById('billGrandTotal').textContent = fmtCents(0);
    document.getElementById('billGrandEvents').textContent = '0';
    return;
  }

  let grandCents = 0, grandEvents = 0;
  tbody.innerHTML = rows.map(r => {
    grandCents  += Number(r.total_cents) || 0;
    grandEvents += Number(r.event_count) || 0;
    return `
      <tr class="js-bill-client" data-id="${esc(r.client_id)}" data-name="${esc(r.client_name)}" data-code="${esc(r.client_code)}" style="cursor:pointer;">
        <td style="font-weight:600;color:var(--blue);">${esc(r.client_code || '')}</td>
        <td style="font-weight:600;">${esc(r.client_name || '')}</td>
        <td class="right">${esc(r.event_count || 0)}</td>
        <td class="right" style="color:var(--text2);">${esc(r.charge_type_count || 0)}</td>
        <td class="right" style="font-weight:700;color:var(--green);">${fmtCents(r.total_cents)}</td>
      </tr>`;
  }).join('');
  document.getElementById('billGrandTotal').textContent = fmtCents(grandCents);
  document.getElementById('billGrandEvents').textContent = String(grandEvents);

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

  // Fire both fetches in parallel
  const [evRes, cardRes] = await Promise.all([
    apiGet(`/billing/events?clientId=${encodeURIComponent(client.id)}&period=${encodeURIComponent(billingPeriod)}&limit=500`),
    apiGet(`/clients/${encodeURIComponent(client.id)}/rate-card`),
  ]);

  billingEvents   = evRes || [];
  billingRateCard = cardRes;

  renderClientEvents();
  renderClientHeaderTotals();
}

function closeClientBilling(){
  billingClient = null;
  billingEvents = [];
  billingRateCard = null;
  document.getElementById('billDetailView').style.display = 'none';
  document.getElementById('billListView').style.display = 'block';
  loadBilling();
}

function renderClientHeaderTotals(){
  const events = billingEvents;
  const total = events.reduce((sum, e) => sum + (Number(e.amount_cents) || 0), 0);
  const types = new Set(events.map(e => e.charge_type)).size;
  document.getElementById('billClientTotal').textContent  = fmtCents(total);
  document.getElementById('billClientEvents').textContent = String(events.length);
  document.getElementById('billClientTypes').textContent  = String(types);
}

function renderClientEvents(){
  const tbody = document.getElementById('billEventsBody');
  if(!billingEvents.length){
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No events for ${esc(billingClient.name)} in ${esc(billingPeriod)}</td></tr>`;
    return;
  }
  tbody.innerHTML = billingEvents.map(e => {
    const stChip = e.status === 'INVOICED' ? 'chip-active'
                 : e.status === 'DISPUTED' ? 'chip-warning'
                 : e.status === 'VOID'     ? 'chip-danger'
                 : 'chip-success';
    const ts = e.occurred_at
      ? new Date(e.occurred_at).toLocaleString('en-US', {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'})
      : '—';
    return `
      <tr>
        <td style="color:var(--text2);font-size:12px;">${esc(ts)}</td>
        <td><span class="chip chip-new" style="font-size:11px;">${esc(e.charge_type)}</span></td>
        <td style="color:var(--text2);">${esc(e.reference_type || '—')} ${e.reference_id ? `<span style="color:var(--muted);font-size:11px;">${esc(String(e.reference_id).slice(0,8))}</span>` : ''}</td>
        <td class="right">${esc(Number(e.quantity).toString())}</td>
        <td class="right" style="color:var(--text2);">${fmtCents(e.unit_cents)}</td>
        <td class="right" style="font-weight:700;color:var(--green);">${fmtCents(e.amount_cents)}</td>
        <td><span class="chip ${stChip}" style="font-size:11px;">${esc(e.status)}</span></td>
      </tr>`;
  }).join('');
}

// =============================================================================
// RATE CARD MODAL
// =============================================================================

function showRateCardModal(){
  if(!billingClient) return;
  const modal = document.getElementById('rateCardModal');
  modal.style.display = 'flex';
  modal.style.zIndex = '10000';

  document.getElementById('rcModalTitle').textContent = `Rate Card — ${billingClient.code} ${billingClient.name}`;
  document.getElementById('rcModalError').textContent = '';

  const card = billingRateCard || {};
  initCombo('rcPickModeWrap', [
    {value:'TOUCH_MOVES_ONLY', label:'Touch Moves Only — only physically-picked units charge'},
    {value:'ALL_PICKS',        label:'All Picks — every unit on a child LP charges'},
  ], {
    placeholder:'Select pick billing mode...',
    value: card.pick_billing_mode || 'TOUCH_MOVES_ONLY',
  });

  document.getElementById('rcMinDollars').value = card.monthly_minimum_cents
    ? (Number(card.monthly_minimum_cents) / 100).toFixed(2)
    : '0.00';
  document.getElementById('rcNotes').value = card.notes || '';

  // Render existing rates
  const rates = (card.rates || []).slice();
  // Make sure PICK_EACH always exists as a row even if not configured yet
  if(!rates.find(r => r.charge_type === 'PICK_EACH')){
    rates.push({charge_type:'PICK_EACH', unit_cents:0, unit_label:'pick'});
  }
  renderRateRows(rates);
}

function renderRateRows(rates){
  const tbody = document.getElementById('rcRatesBody');
  tbody.innerHTML = rates.map((r, i) => {
    const opt = CHARGE_TYPE_OPTIONS.find(o => o.value === r.charge_type);
    return `
      <tr data-i="${i}">
        <td>
          <select class="form-input js-rc-type" data-i="${i}" style="padding:6px 8px;font-size:12px;">
            ${CHARGE_TYPE_OPTIONS.map(o => `<option value="${esc(o.value)}" ${o.value === r.charge_type ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="number" step="0.01" min="0" class="form-input js-rc-dollars" data-i="${i}"
                 value="${esc((Number(r.unit_cents || 0) / 100).toFixed(2))}"
                 style="width:100px;padding:6px 8px;font-size:12px;">
        </td>
        <td>
          <input type="text" class="form-input js-rc-unit" data-i="${i}"
                 value="${esc(r.unit_label || (opt ? opt.unit : ''))}"
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

  // Wire row removals
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
    const i = tr.dataset.i;
    const charge_type = tr.querySelector('.js-rc-type')?.value;
    const dollars = parseFloat(tr.querySelector('.js-rc-dollars')?.value);
    const unit_label = tr.querySelector('.js-rc-unit')?.value || null;
    const notes = tr.querySelector('.js-rc-notes')?.value || null;
    if(!charge_type) return;
    out.push({
      charge_type,
      unit_cents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0,
      unit_label,
      notes,
    });
  });
  return out;
}

function addRateRow(){
  const cur = collectRateRows();
  cur.push({charge_type:'PICK_EACH', unit_cents:0, unit_label:'pick'});
  renderRateRows(cur);
}

async function saveRateCard(){
  if(!billingClient) return;
  const err = document.getElementById('rcModalError');
  err.textContent = '';

  const pickMode = cbVal('rcPickModeWrap') || 'TOUCH_MOVES_ONLY';
  const minDollars = parseFloat(document.getElementById('rcMinDollars').value);
  const monthlyMinimumCents = Number.isFinite(minDollars) ? Math.round(minDollars * 100) : 0;
  const notes = document.getElementById('rcNotes').value || null;
  const rateRows = collectRateRows();

  // Reject duplicate charge types
  const seen = new Set();
  for(const r of rateRows){
    if(seen.has(r.charge_type)){
      err.textContent = `Duplicate charge type: ${r.charge_type}`;
      return;
    }
    seen.add(r.charge_type);
  }

  try {
    const r = await fetch(`${API}/clients/${encodeURIComponent(billingClient.id)}/rate-card`, {
      method:'PUT',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        pickBillingMode: pickMode,
        monthlyMinimumCents,
        notes,
        rates: rateRows.map(r => ({
          chargeType: r.charge_type,
          unitCents:  r.unit_cents,
          unitLabel:  r.unit_label,
          notes:      r.notes,
        })),
      }),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Save failed'; return; }
    billingRateCard = d;
    closeModal('rateCardModal');
    // Refresh detail (header doesn't change but new rates may inform future picks)
    renderClientHeaderTotals();
  } catch(e){
    err.textContent = 'Network error';
  }
}
