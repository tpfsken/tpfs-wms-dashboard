'use strict';
/* BILLING ENGINE UI — first screen family on the TERMINAL LEDGER design
 * system (batch D1). Zero native dialogs; money via uiMoney; tables via
 * uiTable (mono identifiers, tabular numerics); statuses via uiChip;
 * mutations toast.
 *
 * Screen homes (durable user decision):
 *   Billing page          — workflow only: Accrual Runs (default) + Charges.
 *   Client -> Rate Card   — account pricing (this module renders the tab).
 *   Settings              — Billable Service Catalog.
 */

let BE_TAB = 'runs';
let BE_CODES = [];
let BE_CARD_CLIENT = '';
let BE_EDITING_CARD = null;

/* ---------------------------------------------------------------------------
 * Billing page: tabs
 * ------------------------------------------------------------------------- */
function loadBillingSection() {
  const isPortal = (U && U.userType === 'client');
  const host = document.getElementById('billTabs');
  if (host) host.style.display = isPortal ? 'none' : '';
  if (isPortal) { beShowTab('charges'); return; }
  uiTabs('billTabs', [
    { id: 'runs', label: 'Accrual runs' },
    { id: 'charges', label: 'Charges' },
  ], { active: BE_TAB || 'runs', onChange: beShowTab });
  beShowTab(BE_TAB || 'runs');
}

function beShowTab(tab) {
  BE_TAB = tab;
  ['runs', 'charges'].forEach(t => {
    const el = document.getElementById('billTab-' + t);
    if (el) el.style.display = (t === tab) ? '' : 'none';
  });
  if (tab === 'charges') loadBilling();
  if (tab === 'runs')    loadAccrualRuns();
}

function bePrevMonth() {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth();
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------------------
 * Accrual runs — list
 * ------------------------------------------------------------------------- */
const BE_RUN_COLS = [
  { key: 'period', label: 'Period', mono: true },
  { key: 'status', label: 'Status', render: r => uiChip(r.status) },
  { key: 'charges', label: 'Charges', num: true },
  { key: 'total', label: 'Total', money: true },
  { key: 'unbilled', label: 'Unbilled', render: r => r.unbilled > 0
      ? `<span class="ui-chip ui-chip-danger">${esc(r.unbilled)} unbilled</span>`
      : '<span class="ui-chip ui-chip-ok">0</span>' },
  { key: 'by', label: 'By' },
  { key: 'started', label: 'Started', mono: true },
];

async function loadAccrualRuns() {
  document.getElementById('beRunReview').style.display = 'none';
  document.getElementById('beRunList').style.display = '';
  const per = document.getElementById('beRunPeriod');
  if (per && !per.value) per.value = bePrevMonth();
  beCheckCoverage();

  uiTableLoading('beRunsWrap', BE_RUN_COLS);
  const d = await apiGet('/billing/accrual-runs');
  const rows = (d?.rows || []).map(r => ({
    id: r.id,
    period: String(r.as_of_date).slice(0, 7),
    status: r.status,
    charges: (r.summary || {}).charges_written ?? r.rows_written ?? '',
    total: (r.summary || {}).total_amount || 0,
    unbilled: (r.summary || {}).unpriced_count || 0,
    by: r.created_by_email || 'scheduler',
    started: String(r.started_at).slice(0, 16).replace('T', ' '),
  }));
  uiTable('beRunsWrap', {
    columns: BE_RUN_COLS, rows, rowKey: 'id',
    onRowClick: r => openAccrualReview(r.id),
    empty: 'No accrual runs yet — pick a period and click Run accrual.',
  });
}

async function beCheckCoverage() {
  const period = document.getElementById('beRunPeriod').value;
  const el = document.getElementById('beCoverage');
  if (!period) { el.textContent = ''; return; }
  const d = await apiGet('/billing/snapshot-runs?limit=500');
  const days = new Set((d?.rows || [])
    .filter(r => r.status === 'COMPLETED' && String(r.as_of_date).slice(0, 7) === period)
    .map(r => String(r.as_of_date).slice(0, 10)));
  const [y, m] = period.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);
  let expected = 0; const missing = [];
  for (let i = 1; i <= dim; i++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
    if (ds > today) break;
    expected++;
    if (!days.has(ds)) missing.push(ds.slice(8));
  }
  if (!expected) { el.innerHTML = '<span class="ui-chip ui-chip-neutral">future period</span>'; return; }
  el.innerHTML = missing.length === 0
    ? `<span class="ui-chip ui-chip-ok">✓ ${esc(days.size)}/${esc(expected)} snapshot days</span>`
    : `<span class="ui-chip ui-chip-warn">⚠ missing ${esc(missing.length)} day(s): ${esc(missing.join(', '))}</span>`;
}

async function beRunAccrual() {
  const period = document.getElementById('beRunPeriod').value;
  if (!period) return uiToast('Pick a period first', 'error');
  const btn = document.getElementById('beRunBtn');
  btn.disabled = true; btn.textContent = 'Running…';
  try {
    const r = await fetch(`${API}/billing/accrual-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
      body: JSON.stringify({ period }),
    });
    const d = await r.json();
    if (!r.ok) return uiToast(d.error || 'Run failed', 'error');
    uiToast(`Accrual for ${period} complete — review the draft`);
    openAccrualReview(d.id);
  } finally { btn.disabled = false; btn.textContent = 'Run accrual'; }
}

/* ---------------------------------------------------------------------------
 * Accrual review — tiles, THE unbilled panel, grouped charges, post/discard
 * ------------------------------------------------------------------------- */
async function openAccrualReview(id) {
  const d = await apiGet(`/billing/accrual-runs/${id}`);
  if (!d || !d.id) return uiToast('Could not load run', 'error');
  const sum = d.summary || {};
  document.getElementById('beRunList').style.display = 'none';
  document.getElementById('beRunReview').style.display = '';

  document.getElementById('beRevTitle').innerHTML =
    `Accrual — ${esc(String(d.as_of_date).slice(0, 7))} ${uiChip(d.status)}`;

  // Ledger hero tiles.
  const strip = document.getElementById('beRevStrip');
  strip.className = 'ui-tiles';
  strip.innerHTML =
    uiTile({ label: 'Total — period', value: sum.total_amount || 0, money: true }) +
    uiTile({ label: 'Charges', value: sum.charges_written ?? 0 }) +
    uiTile({ label: 'Skipped (posted)', value: sum.skipped_posted ?? 0 }) +
    uiTile({ label: 'Ageless license plates', value: sum.ageless_skipped_lps ?? 0,
             tone: (sum.ageless_skipped_lps > 0 ? 'warn' : null) }) +
    uiTile({ label: 'No-dims rows', value: sum.no_dims_skipped ?? 0,
             tone: (sum.no_dims_skipped > 0 ? 'warn' : null) });

  const warn = document.getElementById('beRevWarn');
  const missing = sum.missing_snapshot_days || [];
  warn.style.display = missing.length ? '' : 'none';
  if (missing.length) {
    warn.innerHTML = `⚠ ${esc(missing.length)} snapshot day(s) missing in this period: ${esc(missing.join(', '))}. Daily/weekly/anniversary charges on those days are NOT accrued — backfill the snapshot(s), then Re-run.`;
  }

  // THE UNBILLED PANEL — first, always, red-bordered when hot.
  const up = document.getElementById('beUnbilled');
  const unpriced = sum.unpriced || [];
  if ((sum.unpriced_count || 0) === 0) {
    up.className = 'card be-unbilled-ok';
    up.innerHTML = `<div style="padding:14px 18px;color:var(--st-ok);font-weight:600;">✓ Every occupied space is priced — no unbilled occupancies.</div>`;
  } else {
    up.className = 'card be-unbilled';
    up.innerHTML = `
      <div class="card-head"><div class="card-title" style="color:var(--st-danger);">⚠ Unbilled occupancies — ${esc(sum.unpriced_count)} license plate(s) occupy space with NO matching rate line</div></div>
      <div style="overflow:auto;max-height:240px;" id="beUnbilledTable"></div>`;
    uiTable('beUnbilledTable', {
      columns: [
        { key: 'lp_number', label: 'LP', mono: true },
        { key: 'slot_type', label: 'Slot', render: r => `<span class="ui-chip ui-chip-warn">${esc(r.slot_type || '?')}</span>` },
        { key: 'location_code', label: 'Location', mono: true },
        { key: 'why', label: 'Why', render: r => `<span style="color:var(--text2);">no rate-card line matches slot "${esc(r.slot_type || '?')}"</span>` },
        { key: 'fix', label: '', render: r => `<button class="ui-btn js-fix-card" data-client="${esc(r.client_id || '')}">View rate card →</button>` },
      ],
      rows: unpriced, rowKey: 'lp_number',
    });
    up.querySelectorAll('.js-fix-card').forEach(b =>
      b.addEventListener('click', uiBusyHandler(async (e) => {
        e.stopPropagation();
        navigateTo('clients');
        await openClientDetail(b.dataset.client);
        switchClientTab('ratecard');
      })));
  }

  // Charges grouped client -> charge code (uiTable per code group).
  const groups = {};
  for (const c of (d.charges || [])) {
    const g = (groups[c.client_name] = groups[c.client_name] || {});
    (g[c.charge_type] = g[c.charge_type] || []).push(c);
  }
  const chargeCols = [
    { key: '_lp', label: 'LP', render: r => uiId((r.metadata || {}).lp_number || '') },
    { key: '_loc', label: 'Location', render: r => uiId((r.metadata || {}).location_code || '') },
    { key: '_age', label: 'Age', render: r => uiNum(((r.metadata || {}).age_days ?? '') + 'd') },
    { key: 'quantity', label: 'Qty', num: true },
    { key: 'unit_rate', label: 'Rate', money: true },
    { key: '_mode', label: 'Mode', render: r => {
        const md = r.metadata || {};
        const frac = md.fraction != null && md.fraction !== 1 ? ` ${Math.round(md.fraction * 1000) / 1000}` : '';
        const band = md.aged_band ? ` · aged ${md.aged_band}+` : '';
        return `<span class="ui-chip ui-chip-neutral">${esc((md.mode || '').replace(/_/g, ' ') + frac + band)}</span>`;
      } },
    { key: 'total_amount', label: 'Amount', money: true },
  ];
  const wrap = document.getElementById('beRevCharges');
  wrap.innerHTML = Object.keys(groups).sort().map((clientName, ci) => {
    const codes = groups[clientName];
    let clientTotal = 0, clientCount = 0;
    const inner = Object.keys(codes).sort().map((code, gi) => {
      const list = codes[code];
      const sub = list.reduce((s, c) => s + Number(c.total_amount), 0);
      clientTotal += sub; clientCount += list.length;
      return `<div class="be-code-group">
        <div class="be-code-head">${uiId(code)} <span style="color:var(--text2);">· ${esc(list.length)} charge(s)</span><span style="flex:1"></span>${uiMoney(sub)}</div>
        <div id="beGrp_${ci}_${gi}"></div>
      </div>`;
    }).join('');
    return `<details class="be-client-group" open>
      <summary><strong>${esc(clientName)}</strong><span style="color:var(--text2);"> · ${esc(clientCount)} charge(s)</span><span style="flex:1"></span>${uiMoney(clientTotal)}</summary>
      ${inner}</details>`;
  }).join('') || uiEmpty('No charges in this run.');
  // Fill the group tables after the shells exist.
  Object.keys(groups).sort().forEach((clientName, ci) => {
    const codes = groups[clientName];
    Object.keys(codes).sort().forEach((code, gi) => {
      uiTable(`beGrp_${ci}_${gi}`, { columns: chargeCols, rows: codes[code], rowKey: 'id' });
    });
  });

  // Footer actions.
  const acts = document.getElementById('beRevActions');
  if (d.status === 'DRAFT') {
    acts.innerHTML = `
      <button class="ui-btn" id="beRerunBtn">Re-run period</button>
      <button class="ui-btn ui-btn-danger" id="beDiscardBtn">Discard</button>
      <button class="ui-btn ui-btn-primary" id="bePostBtn">Post run — make invoiceable</button>`;
    document.getElementById('bePostBtn').addEventListener('click', uiBusyHandler(() => bePostRun(d.id)));
    document.getElementById('beDiscardBtn').addEventListener('click', uiBusyHandler(() => beDiscardRun(d.id)));
    document.getElementById('beRerunBtn').addEventListener('click', uiBusyHandler(async () => {
      document.getElementById('beRunPeriod').value = String(d.as_of_date).slice(0, 7);
      await beRunAccrual();
    }));
  } else if (d.status === 'POSTED') {
    acts.innerHTML = `<span style="color:var(--text2);font-size:13px;">Posted — charges are invoiceable. Corrections are credits.</span>
      <button class="ui-btn ui-btn-primary" id="beGoInvoices">Generate invoices →</button>`;
    document.getElementById('beGoInvoices').addEventListener('click', () => navigateTo('invoices'));
  } else {
    acts.innerHTML = `<span style="color:var(--text2);font-size:13px;">${esc(d.status)} run — read-only.</span>`;
  }
}

async function bePostRun(id) {
  const ok = await uiConfirm({
    title: 'Post this accrual run?',
    body: 'All draft charges become <strong>invoiceable and immutable</strong>. After posting, corrections are credits — the charges themselves can never be edited or deleted.',
    confirmLabel: 'Post run',
  });
  if (!ok) return;
  const r = await fetch(`${API}/billing/accrual-runs/${id}/post`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json();
  if (!r.ok) return uiToast(d.error || 'Post failed', 'error');
  uiToast(`Run posted — ${d.charges_posted} charge(s) now invoiceable`);
  openAccrualReview(id);
}

async function beDiscardRun(id) {
  const ok = await uiConfirm({
    title: 'Discard this run?',
    body: 'All its DRAFT charges are deleted. You can re-run the period any time.',
    confirmLabel: 'Discard', danger: true,
  });
  if (!ok) return;
  const r = await fetch(`${API}/billing/accrual-runs/${id}/discard`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json();
  if (!r.ok) return uiToast(d.error || 'Discard failed', 'error');
  uiToast(`Run discarded — ${d.charges_deleted} draft charge(s) deleted`);
  loadAccrualRuns();
}

/* ---------------------------------------------------------------------------
 * RATE CARD — client detail tab
 * ------------------------------------------------------------------------- */
const BE_CARD_COLS = [
  { key: 'name', label: 'Card' },
  { key: 'status', label: 'Status', render: r => uiChip(r.status) },
  { key: '_eff', label: 'Effective', render: r =>
      uiId(String(r.effective_from).slice(0, 10) + (r.effective_to ? ' → ' + String(r.effective_to).slice(0, 10) : '')) },
  { key: 'line_count', label: 'Lines', num: true },
];

async function loadClientRateCardTab() {
  BE_CARD_CLIENT = (typeof _currentClient !== 'undefined' && _currentClient) ? _currentClient.id : BE_CARD_CLIENT;
  document.getElementById('beCardDetail').style.display = 'none';
  document.getElementById('beCardList').style.display = '';
  uiTableLoading('beCardsWrap', BE_CARD_COLS);
  const d = await apiGet(`/billing/rate-cards?clientId=${encodeURIComponent(BE_CARD_CLIENT || '')}`);
  uiTable('beCardsWrap', {
    columns: BE_CARD_COLS, rows: d?.rows || [], rowKey: 'id',
    onRowClick: r => openRateCard(r.id),
    empty: 'No rate cards yet — generate one from legacy rates or create one.',
  });
}

async function beGenerateFromLegacy() {
  if (!BE_CARD_CLIENT) return uiToast('Open a client first', 'error');
  const r = await fetch(`${API}/billing/rate-cards/generate-from-legacy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ clientId: BE_CARD_CLIENT }),
  });
  const d = await r.json();
  if (!r.ok) return uiToast(d.error || 'Generate failed', 'error');
  uiToast(`Draft card created from ${d.lines_created} legacy rate(s) — review before activating`);
  openRateCard(d.id);
}

async function beEnsureCodes() {
  if (!BE_CODES.length) {
    const d = await apiGet('/billing/charge-codes');
    BE_CODES = d?.rows || [];
  }
  return BE_CODES;
}

/* The prompt() flow is dead: a real modal form creates the draft. */
async function beNewCard() {
  if (!BE_CARD_CLIENT) return uiToast('Open a client first', 'error');
  await beEnsureCodes();
  const today = new Date().toISOString().slice(0, 10);
  const m = uiModal({
    title: 'New rate card',
    body:
      uiField({ id: 'ncName', label: 'Card name', placeholder: 'e.g. 2026 pricing' }) +
      uiField({ id: 'ncEff', label: 'Effective from', type: 'date', value: today,
                hint: 'The date this pricing takes effect. Activating later supersedes the current card as of this date.' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Create draft', primary: true, onClick: async (m) => {
          const name = m.el.querySelector('#ncName').value.trim();
          const eff = m.el.querySelector('#ncEff').value;
          uiFieldError(m.el, 'ncName', name ? '' : 'Name is required');
          uiFieldError(m.el, 'ncEff', eff ? '' : 'Effective date is required');
          if (!name || !eff) return false;
          const pick = BE_CODES.find(c => c.code === 'PICK_FEE') || BE_CODES[0];
          const r = await fetch(`${API}/billing/rate-cards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
            body: JSON.stringify({
              clientId: BE_CARD_CLIENT, name, effectiveFrom: eff,
              lines: [{ charge_code_id: pick.id, basis: 'PER_EVENT', unit: 'pick', rate: 0, cadence: 'PER_EVENT' }],
            }),
          });
          const d = await r.json();
          if (!r.ok) { uiFieldError(m.el, 'ncName', d.error || 'Create failed'); return false; }
          uiToast('Draft card created — add its lines');
          await openRateCard(d.id);
          beEditCardLines(await apiGet(`/billing/rate-cards/${d.id}`));
        } },
    ],
  });
}

const BE_LINE_COLS = [
  { key: 'charge_code', label: 'Charge code', mono: true },
  { key: 'basis', label: 'Basis' },
  { key: '_slot', label: 'Slot', render: r => esc(r.slot_type || '(any)') },
  { key: 'unit', label: 'Unit' },
  { key: 'rate', label: 'Rate', money: true },
  { key: 'cadence', label: 'Cadence' },
  { key: 'free_days', label: 'Free days', num: true },
  { key: 'proration_mode', label: 'Proration' },
  { key: '_rules', label: 'Rules', render: r =>
      `<span style="font-size:11px;color:var(--text2);">${r.aged_escalation ? 'aged: ' + esc(JSON.stringify(r.aged_escalation)) : ''}${r.tier_rules ? ' tiers: ' + esc(JSON.stringify(r.tier_rules)) : ''}</span>` },
];

async function openRateCard(id) {
  const d = await apiGet(`/billing/rate-cards/${id}`);
  if (!d || !d.id) return uiToast('Could not load card', 'error');
  BE_EDITING_CARD = d;
  await beEnsureCodes();
  document.getElementById('beCardList').style.display = 'none';
  document.getElementById('beCardDetail').style.display = '';
  const editable = d.status === 'DRAFT';

  document.getElementById('beCardTitle').innerHTML =
    `${esc(d.client_name)} — ${esc(d.name)} ${uiChip(d.status)}`;
  document.getElementById('beCardSub').textContent =
    `Effective ${String(d.effective_from).slice(0, 10)}${d.effective_to ? ' → ' + String(d.effective_to).slice(0, 10) : ''}` +
    (editable ? '' : ' — frozen: create a new card to change pricing');

  uiTable('beCardLinesWrap', { columns: BE_LINE_COLS, rows: d.lines || [], rowKey: 'id', empty: 'No lines' });

  const acts = document.getElementById('beCardActions');
  let html = '<button class="ui-btn" id="beCardBack">← Cards</button><span style="flex:1"></span>';
  if (editable) {
    html += `<button class="ui-btn" id="beCardEdit">Edit lines</button>
             <button class="ui-btn ui-btn-danger" id="beCardArchive">Archive</button>
             <button class="ui-btn ui-btn-primary" id="beCardActivate">Activate</button>`;
  }
  acts.innerHTML = html;
  document.getElementById('beCardBack').addEventListener('click', uiBusyHandler(loadClientRateCardTab));
  if (editable) {
    document.getElementById('beCardActivate').addEventListener('click', uiBusyHandler(async () => {
      const ok = await uiConfirm({
        title: `Activate "${d.name}"?`,
        body: `It becomes this client's live pricing as of <strong>${esc(String(d.effective_from).slice(0, 10))}</strong> and supersedes the current ACTIVE card. Activated cards are frozen — price changes need a new card.`,
        confirmLabel: 'Activate',
      });
      if (!ok) return;
      const r = await fetch(`${API}/billing/rate-cards/${d.id}/activate`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` } });
      const j = await r.json();
      if (!r.ok) return uiToast(j.error || 'Activate failed', 'error');
      uiToast('Rate card activated — this is now the live pricing');
      openRateCard(d.id);
    }));
    document.getElementById('beCardArchive').addEventListener('click', uiBusyHandler(async () => {
      const ok = await uiConfirm({ title: 'Archive this draft?', confirmLabel: 'Archive', danger: true });
      if (!ok) return;
      const r = await fetch(`${API}/billing/rate-cards/${d.id}/archive`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` } });
      const j = await r.json();
      if (!r.ok) return uiToast(j.error || 'Archive failed', 'error');
      uiToast('Draft archived');
      loadClientRateCardTab();
    }));
    document.getElementById('beCardEdit').addEventListener('click', uiBusyHandler(() => beEditCardLines(d)));
  }
  document.getElementById('beCardEditor').style.display = 'none';
}

/* Line editor — structured rows; aged/tier stay validated-JSON advanced
 * fields in v1 (the API re-validates shape on save). */
function beLineRowHtml(l, codes) {
  const opt = (list, sel) => list.map(v =>
    `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const codeOpts = codes.map(c =>
    `<option value="${esc(c.id)}"${c.id === l.charge_code_id ? ' selected' : ''}>${esc(c.code)}</option>`).join('');
  return `<tr class="be-edit-row">
    <td><select class="ui-input be-f-code">${codeOpts}</select></td>
    <td><select class="ui-input be-f-basis">${opt(['LP_OCCUPANCY', 'PER_EVENT'], l.basis || 'LP_OCCUPANCY')}</select></td>
    <td><input class="ui-input be-f-slot" value="${esc(l.slot_type || '')}" placeholder="(any)" style="width:80px;"></td>
    <td><select class="ui-input be-f-unit">${opt(['lp', 'each', 'cuft', 'pick', 'order', 'label', 'hour'], l.unit || 'lp')}</select></td>
    <td><input class="ui-input be-f-rate" type="number" step="0.0001" value="${esc(l.rate ?? '')}" style="width:90px;"></td>
    <td><select class="ui-input be-f-cadence">${opt(['MONTHLY_CALENDAR', 'MONTHLY_ANNIVERSARY', 'DAILY', 'WEEKLY', 'PER_EVENT', 'ONE_TIME'], l.cadence || 'MONTHLY_CALENDAR')}</select></td>
    <td><input class="ui-input be-f-free" type="number" value="${esc(l.free_days || 0)}" style="width:60px;"></td>
    <td><select class="ui-input be-f-pro">${opt(['NONE', 'RECEIPT_STUB_THEN_CALENDAR', 'SPLIT_ON_RECEIPT', 'PURE_DAILY', 'WEEKLY'], l.proration_mode || 'NONE')}</select></td>
    <td><input class="ui-input be-f-aged" value="${esc(l.aged_escalation ? JSON.stringify(l.aged_escalation) : '')}" placeholder='[{"after_days":90,"rate":18}]' style="width:170px;font-size:11px;"></td>
    <td><input class="ui-input be-f-tiers" value="${esc(l.tier_rules ? JSON.stringify(l.tier_rules) : '')}" placeholder='[{"from_qty":0,"to_qty":100,"rate":14.5}]' style="width:170px;font-size:11px;"></td>
    <td><button class="ui-btn js-del-line" style="color:var(--st-danger);padding:2px 8px;">✕</button></td>
  </tr>`;
}

async function beEditCardLines(card) {
  const codes = await beEnsureCodes();
  const ed = document.getElementById('beCardEditor');
  ed.style.display = '';
  document.getElementById('beEditRows').innerHTML =
    (card.lines || []).map(l => beLineRowHtml(l, codes)).join('');
  ed.querySelectorAll('.js-del-line').forEach(b =>
    b.addEventListener('click', () => b.closest('tr').remove()));
}

function beAddLine() {
  document.getElementById('beEditRows').insertAdjacentHTML('beforeend',
    beLineRowHtml({}, BE_CODES));
  const rows = document.querySelectorAll('#beEditRows .js-del-line');
  rows[rows.length - 1].addEventListener('click', (e) => e.target.closest('tr').remove());
}

function beParseJsonField(val, label) {
  if (!val || !val.trim()) return null;
  try { return JSON.parse(val); }
  catch (e) { throw new Error(`${label}: invalid JSON — ${e.message}`); }
}

async function beSaveCardLines() {
  const card = BE_EDITING_CARD;
  const lines = [];
  try {
    document.querySelectorAll('#beEditRows tr').forEach((tr, i) => {
      lines.push({
        charge_code_id: tr.querySelector('.be-f-code').value,
        basis: tr.querySelector('.be-f-basis').value,
        slot_type: tr.querySelector('.be-f-slot').value.trim() || null,
        unit: tr.querySelector('.be-f-unit').value,
        rate: Number(tr.querySelector('.be-f-rate').value),
        cadence: tr.querySelector('.be-f-cadence').value,
        free_days: Number(tr.querySelector('.be-f-free').value) || 0,
        proration_mode: tr.querySelector('.be-f-pro').value,
        aged_escalation: beParseJsonField(tr.querySelector('.be-f-aged').value, `line ${i + 1} aged`),
        tier_rules: beParseJsonField(tr.querySelector('.be-f-tiers').value, `line ${i + 1} tiers`),
        sort_order: i,
      });
    });
  } catch (e) { return uiToast(e.message, 'error'); }
  if (!lines.length) return uiToast('A card needs at least one line', 'error');
  const r = await fetch(`${API}/billing/rate-cards/${card.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ lines }),
  });
  const d = await r.json();
  if (!r.ok) return uiToast(d.error || 'Save failed', 'error');
  uiToast('Lines saved');
  openRateCard(card.id);
}

/* ---------------------------------------------------------------------------
 * SETTINGS — Billable Service Catalog
 * ------------------------------------------------------------------------- */
function loadSettingsPage() {
  // Mount only what this role may read — every card is [data-perm] in index.html,
  // and an unmounted card never fires the admin-only GET behind it.
  if (can('billing.rate_cards')) loadChargeCodesTab();
  if (typeof spMountTemplates === 'function' && can('settings.scan_view')) spMountTemplates();   // js/scanProfiles.js
  if (typeof mgMount === 'function' && can('integrations.excalibur')) { mgLoadLocations().finally(mgMount); }  // js/migration.js — mount even if /locations fails
  if (typeof ssiMount === 'function' && can('integrations.shipstation')) ssiMount();   // js/shipstation.js
  if (typeof pkgMount === 'function' && can('packing.pack')) pkgMount();   // js/packaging.js — Settings → Packaging (box catalog)
  if (typeof loadRolesCard === 'function' && can('settings.roles')) loadRolesCard();   // js/roles.js — admin only
}

async function loadChargeCodesTab() {
  const d = await apiGet('/billing/charge-codes?all=true');
  BE_CODES = (d?.rows || []).filter(c => c.is_active);
  const rows = d?.rows || [];
  const byCat = {};
  for (const c of rows) (byCat[c.category] = byCat[c.category] || []).push(c);
  const wrap = document.getElementById('beCodesWrap');
  wrap.innerHTML = Object.keys(byCat).sort().map((cat, i) => `
    <div class="be-code-group">
      <div class="be-code-head">${esc(cat)}</div>
      <div id="beCodesCat_${i}"></div>
    </div>`).join('') || uiEmpty('No charge codes — click Seed defaults.');
  Object.keys(byCat).sort().forEach((cat, i) => {
    uiTable(`beCodesCat_${i}`, {
      columns: [
        { key: 'code', label: 'Code', mono: true },
        { key: 'name', label: 'Name' },
        { key: 'default_unit', label: 'Unit' },
        { key: '_gl', label: 'GL account', render: r =>
            `<input class="ui-input js-gl" data-id="${esc(r.id)}" value="${esc(r.gl_account || '')}" placeholder="—" style="width:110px;">` },
        { key: '_active', label: 'Active', render: r =>
            `<input type="checkbox" class="js-cc-active" data-id="${esc(r.id)}" ${r.is_active ? 'checked' : ''}>` },
      ],
      rows: byCat[cat], rowKey: 'id',
    });
  });
  wrap.querySelectorAll('.js-gl').forEach(inp =>
    inp.addEventListener('change', () => bePatchCode(inp.dataset.id, { glAccount: inp.value.trim() || null })));
  wrap.querySelectorAll('.js-cc-active').forEach(cb =>
    cb.addEventListener('change', () => bePatchCode(cb.dataset.id, { isActive: cb.checked })));
}

async function bePatchCode(id, body) {
  const r = await fetch(`${API}/billing/charge-codes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) return uiToast((await r.json()).error || 'Save failed', 'error');
  uiToast('Saved');
}

async function beSeedDefaults() {
  const r = await fetch(`${API}/billing/charge-codes/seed-defaults`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json();
  uiToast(`Seeded ${d.seeded} of ${d.catalogSize} default codes (existing untouched)`);
  loadChargeCodesTab();
}

async function beNewCode() {
  uiModal({
    title: 'New charge code',
    body:
      uiField({ id: 'ccCode', label: 'Code', placeholder: 'FREEZER_SURCHARGE',
                hint: 'UPPER_SNAKE — stable identifier, shows on charges and (later) GL exports' }) +
      uiField({ id: 'ccName', label: 'Display name', placeholder: 'Freezer surcharge' }) +
      uiFieldSelect({ id: 'ccCat', label: 'Category',
        options: ['STORAGE', 'RECEIVING', 'PICK', 'PACK', 'VAS', 'RETURNS', 'HAZMAT', 'MATERIALS', 'SHIPPING', 'ADMIN', 'OTHER']
          .map(v => ({ value: v, label: v })), value: 'OTHER' }) +
      uiField({ id: 'ccUnit', label: 'Default unit', placeholder: 'each' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onClick: async (m) => {
          const code = m.el.querySelector('#ccCode').value.trim();
          const name = m.el.querySelector('#ccName').value.trim();
          uiFieldError(m.el, 'ccCode', code ? '' : 'Code is required');
          uiFieldError(m.el, 'ccName', name ? '' : 'Name is required');
          if (!code || !name) return false;
          const r = await fetch(`${API}/billing/charge-codes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
            body: JSON.stringify({
              code, name,
              category: m.el.querySelector('#ccCat').value,
              defaultUnit: m.el.querySelector('#ccUnit').value.trim() || null,
            }),
          });
          const d = await r.json();
          if (!r.ok) { uiFieldError(m.el, 'ccCode', d.error || 'Create failed'); return false; }
          uiToast(`Charge code ${code} created`);
          loadChargeCodesTab();
        } },
    ],
  });
}
