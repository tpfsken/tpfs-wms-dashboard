'use strict';
/* BILLING ENGINE UI (S3b) — tabs on the Billing page.
 *
 *   Accrual Runs (default) — month-end: run, review, post/discard.
 *   Charges                — the existing per-client meter (billing.js).
 *   Rate Cards             — per-client pricing, DRAFT->ACTIVE lifecycle.
 *   Charge Codes           — the billable-service catalog + GL accounts.
 *
 * Portal users see only the Charges tab (tab bar hidden).
 * Conventions: every untrusted value through esc(); handlers via data-* +
 * addEventListener; API via apiGet / fetch with Bearer T.
 */

let BE_TAB = 'runs';
let BE_RUN = null;
let BE_CODES = [];
let BE_CARD_CLIENT = '';
let BE_EDITING_CARD = null;

// ---------------------------------------------------------------------------
// Section entry + tabs
// ---------------------------------------------------------------------------
function loadBillingSection() {
  const isPortal = (U && U.userType === 'client');
  const tabs = document.getElementById('billTabs');
  if (tabs) tabs.style.display = isPortal ? 'none' : 'flex';
  beShowTab(isPortal ? 'charges' : (BE_TAB || 'runs'));
}

function beShowTab(tab) {
  BE_TAB = tab;
  document.querySelectorAll('#billTabs .bill-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  ['runs', 'charges', 'cards', 'codes'].forEach(t => {
    const el = document.getElementById('billTab-' + t);
    if (el) el.style.display = (t === tab) ? '' : 'none';
  });
  if (tab === 'charges') loadBilling();
  if (tab === 'runs')    loadAccrualRuns();
  if (tab === 'cards')   loadRateCardsTab();
  if (tab === 'codes')   loadChargeCodesTab();
}

function bePrevMonth() {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth(); // 0-based; m===0 -> Dec last year
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

const BE_RUN_CHIP = { DRAFT: 'warning', POSTED: 'success', DISCARDED: 'muted', FAILED: 'danger', RUNNING: 'active' };
function beChip(status) {
  return `<span class="chip chip-${esc(BE_RUN_CHIP[status] || 'muted')}">${esc(status)}</span>`;
}

// ---------------------------------------------------------------------------
// TAB: Accrual Runs
// ---------------------------------------------------------------------------
async function loadAccrualRuns() {
  document.getElementById('beRunReview').style.display = 'none';
  document.getElementById('beRunList').style.display = '';
  const per = document.getElementById('beRunPeriod');
  if (per && !per.value) per.value = bePrevMonth();
  beCheckCoverage();

  const d = await apiGet('/billing/accrual-runs');
  const rows = d?.rows || [];
  const body = document.getElementById('beRunsBody');
  body.innerHTML = rows.map(r => {
    const sum = r.summary || {};
    const unpriced = sum.unpriced_count || 0;
    return `<tr class="js-open-run" data-id="${esc(r.id)}" style="cursor:pointer;">
      <td>${esc(String(r.as_of_date).slice(0, 7))}</td>
      <td>${beChip(r.status)}</td>
      <td class="right">${esc(sum.charges_written ?? r.rows_written ?? '')}</td>
      <td class="right" style="font-weight:600;">${fmtDollars(sum.total_amount || 0)}</td>
      <td class="right">${unpriced > 0 ? `<span class="chip chip-danger">${esc(unpriced)} unbilled</span>` : '<span style="color:var(--green);">0</span>'}</td>
      <td>${esc(r.created_by_email || 'scheduler')}</td>
      <td>${esc(String(r.started_at).slice(0, 16).replace('T', ' '))}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7"><div class="empty-state">No accrual runs yet — pick a period and click Run accrual.</div></td></tr>';
  body.querySelectorAll('.js-open-run').forEach(tr =>
    tr.addEventListener('click', () => openAccrualReview(tr.dataset.id)));
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
  let expected = 0, missing = [];
  for (let i = 1; i <= dim; i++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
    if (ds > today) break;
    expected++;
    if (!days.has(ds)) missing.push(ds.slice(8));
  }
  if (!expected) { el.innerHTML = '<span style="color:var(--muted);">future period</span>'; return; }
  el.innerHTML = missing.length === 0
    ? `<span style="color:var(--green);">✓ ${esc(days.size)}/${esc(expected)} snapshot days</span>`
    : `<span style="color:var(--amber);">⚠ missing ${esc(missing.length)} day(s): ${esc(missing.join(', '))}</span>`;
}

async function beRunAccrual() {
  const period = document.getElementById('beRunPeriod').value;
  if (!period) return alert('Pick a period first');
  const btn = document.getElementById('beRunBtn');
  btn.disabled = true; btn.textContent = 'Running…';
  try {
    const r = await fetch(`${API}/billing/accrual-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
      body: JSON.stringify({ period }),
    });
    const d = await r.json();
    if (!r.ok) return alert(d.error || 'Run failed');
    openAccrualReview(d.id);
  } finally { btn.disabled = false; btn.textContent = 'Run accrual'; }
}

async function openAccrualReview(id) {
  const d = await apiGet(`/billing/accrual-runs/${id}`);
  if (!d || !d.id) return alert('Could not load run');
  BE_RUN = d;
  const sum = d.summary || {};
  document.getElementById('beRunList').style.display = 'none';
  const view = document.getElementById('beRunReview');
  view.style.display = '';

  document.getElementById('beRevTitle').innerHTML =
    `Accrual — ${esc(String(d.as_of_date).slice(0, 7))} ${beChip(d.status)}`;
  document.getElementById('beRevStrip').innerHTML = `
    <div><span class="be-k">Total</span><span class="be-v" style="color:var(--green);font-size:22px;font-weight:700;">${fmtDollars(sum.total_amount || 0)}</span></div>
    <div><span class="be-k">Charges</span><span class="be-v">${esc(sum.charges_written ?? 0)}</span></div>
    <div><span class="be-k">Skipped (posted)</span><span class="be-v">${esc(sum.skipped_posted ?? 0)}</span></div>
    <div><span class="be-k">Ageless LPs</span><span class="be-v">${esc(sum.ageless_skipped_lps ?? 0)}</span></div>
    <div><span class="be-k">No-dims rows</span><span class="be-v">${esc(sum.no_dims_skipped ?? 0)}</span></div>`;

  const warn = document.getElementById('beRevWarn');
  const missing = sum.missing_snapshot_days || [];
  warn.style.display = missing.length ? '' : 'none';
  if (missing.length) {
    warn.innerHTML = `⚠ ${esc(missing.length)} snapshot day(s) missing in this period: ${esc(missing.join(', '))}. Daily/weekly/anniversary charges on those days are NOT accrued — backfill the snapshot(s), then Re-run.`;
  }

  // THE UNBILLED PANEL — first, always.
  const up = document.getElementById('beUnbilled');
  const unpriced = sum.unpriced || [];
  if ((sum.unpriced_count || 0) === 0) {
    up.className = 'card be-unbilled-ok';
    up.innerHTML = `<div style="padding:14px 18px;color:var(--green);font-weight:600;">✓ Every occupied space is priced — no unbilled occupancies.</div>`;
  } else {
    up.className = 'card be-unbilled';
    up.innerHTML = `
      <div class="card-head"><div class="card-title" style="color:var(--red);">⚠ Unbilled occupancies — ${esc(sum.unpriced_count)} LP(s) occupy space with NO matching rate line</div></div>
      <div style="overflow:auto;max-height:220px;">
        <table class="data-table"><thead><tr><th>LP</th><th>Slot type</th><th>Location</th><th>Why</th><th></th></tr></thead><tbody>
        ${unpriced.map(u => `<tr>
          <td>${esc(u.lp_number || '')}</td>
          <td><span class="chip chip-warning">${esc(u.slot_type || '?')}</span></td>
          <td>${esc(u.location_code || '')}</td>
          <td style="color:var(--text2);">no rate-card line matches slot "${esc(u.slot_type || '?')}"</td>
          <td><button class="btn btn-ghost js-fix-card" data-client="${esc(u.client_id || '')}" style="padding:2px 10px;">View rate card →</button></td>
        </tr>`).join('')}
        </tbody></table>
      </div>`;
    up.querySelectorAll('.js-fix-card').forEach(b =>
      b.addEventListener('click', () => { BE_CARD_CLIENT = b.dataset.client; beShowTab('cards'); }));
  }

  // Charges grouped client -> charge code.
  const groups = {};
  for (const c of (d.charges || [])) {
    const g = (groups[c.client_name] = groups[c.client_name] || {});
    (g[c.charge_type] = g[c.charge_type] || []).push(c);
  }
  const wrap = document.getElementById('beRevCharges');
  wrap.innerHTML = Object.keys(groups).sort().map(clientName => {
    const codes = groups[clientName];
    let clientTotal = 0, clientCount = 0;
    const inner = Object.keys(codes).sort().map(code => {
      const list = codes[code];
      const sub = list.reduce((s, c) => s + Number(c.total_amount), 0);
      clientTotal += sub; clientCount += list.length;
      return `<div class="be-code-group">
        <div class="be-code-head">${esc(code)} <span style="color:var(--text2);">· ${esc(list.length)} charge(s)</span><span style="flex:1"></span><strong>${fmtDollars(sub)}</strong></div>
        <table class="data-table"><thead><tr><th>LP</th><th>Location</th><th>Age</th><th class="right">Qty</th><th class="right">Rate</th><th>Mode</th><th class="right">Amount</th></tr></thead><tbody>
        ${list.map(c => {
          const md = c.metadata || {};
          const mode = md.mode || '';
          const frac = md.fraction != null && md.fraction !== 1 ? ` ${esc(Math.round(md.fraction * 1000) / 1000)}` : '';
          const band = md.aged_band ? ` · aged ${esc(md.aged_band)}+` : '';
          return `<tr title="received ${esc(md.received_local || '?')} · key ${esc(c.period_key || '')}">
            <td>${esc(md.lp_number || '')}</td>
            <td>${esc(md.location_code || '')}</td>
            <td>${esc(md.age_days ?? '')}d</td>
            <td class="right">${esc(c.quantity)}</td>
            <td class="right">${fmtDollars(c.unit_rate)}</td>
            <td><span class="chip chip-muted">${esc(mode.replace(/_/g, ' '))}${frac}${band}</span></td>
            <td class="right" style="font-weight:600;">${fmtDollars(c.total_amount)}</td>
          </tr>`;
        }).join('')}
        </tbody></table></div>`;
    }).join('');
    return `<details class="be-client-group" open>
      <summary><strong>${esc(clientName)}</strong><span style="color:var(--text2);"> · ${esc(clientCount)} charge(s)</span><span style="flex:1"></span><strong style="color:var(--green);">${fmtDollars(clientTotal)}</strong></summary>
      ${inner}</details>`;
  }).join('') || '<div class="empty-state">No charges in this run.</div>';

  // Footer actions by status.
  const acts = document.getElementById('beRevActions');
  if (d.status === 'DRAFT') {
    acts.innerHTML = `
      <button class="btn btn-ghost" id="beRerunBtn">Re-run period</button>
      <button class="btn btn-ghost" id="beDiscardBtn" style="color:var(--red);">Discard</button>
      <button class="btn btn-success" id="bePostBtn">Post run — make invoiceable</button>`;
    document.getElementById('bePostBtn').addEventListener('click', () => bePostRun(d.id));
    document.getElementById('beDiscardBtn').addEventListener('click', () => beDiscardRun(d.id));
    document.getElementById('beRerunBtn').addEventListener('click', async () => {
      document.getElementById('beRunPeriod').value = String(d.as_of_date).slice(0, 7);
      await beRunAccrual();
    });
  } else if (d.status === 'POSTED') {
    acts.innerHTML = `<span style="color:var(--text2);font-size:13px;">Posted — charges are invoiceable. Corrections are credits.</span>
      <button class="btn btn-primary" onclick="navigateTo('invoices')">Generate invoices →</button>`;
  } else {
    acts.innerHTML = `<span style="color:var(--text2);font-size:13px;">${esc(d.status)} run — read-only.</span>`;
  }
}

async function bePostRun(id) {
  if (!confirm('Post this accrual run?\n\nAll draft charges become INVOICEABLE and IMMUTABLE. After posting, corrections are credits — the charges themselves can never be edited or deleted.')) return;
  const r = await fetch(`${API}/billing/accrual-runs/${id}/post`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json();
  if (!r.ok) return alert(d.error || 'Post failed');
  openAccrualReview(id);
}

async function beDiscardRun(id) {
  if (!confirm('Discard this run? All its DRAFT charges are deleted. (You can re-run the period any time.)')) return;
  const r = await fetch(`${API}/billing/accrual-runs/${id}/discard`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json();
  if (!r.ok) return alert(d.error || 'Discard failed');
  loadAccrualRuns();
}

// ---------------------------------------------------------------------------
// TAB: Rate Cards
// ---------------------------------------------------------------------------
async function loadRateCardsTab() {
  document.getElementById('beCardDetail').style.display = 'none';
  document.getElementById('beCardList').style.display = '';
  if (!clientsCache || !clientsCache.length) await loadCC();
  initCombo('beCardClientWrap', clientsCache.map(c => ({ value: c.id, label: c.name })), {
    placeholder: 'All clients…', value: BE_CARD_CLIENT || '',
    onChange: v => { BE_CARD_CLIENT = v; renderRateCards(); },
  });
  renderRateCards();
}

async function renderRateCards() {
  const q = BE_CARD_CLIENT ? `?clientId=${encodeURIComponent(BE_CARD_CLIENT)}` : '';
  const d = await apiGet(`/billing/rate-cards${q}`);
  const rows = d?.rows || [];
  const CHIP = { DRAFT: 'warning', ACTIVE: 'success', SUPERSEDED: 'muted', ARCHIVED: 'muted' };
  document.getElementById('beCardsBody').innerHTML = rows.map(c => `
    <tr class="js-open-card" data-id="${esc(c.id)}" style="cursor:pointer;">
      <td>${esc(c.client_name)}</td>
      <td>${esc(c.name)}</td>
      <td><span class="chip chip-${esc(CHIP[c.status] || 'muted')}">${esc(c.status)}</span></td>
      <td>${esc(String(c.effective_from).slice(0, 10))}${c.effective_to ? ' → ' + esc(String(c.effective_to).slice(0, 10)) : ''}</td>
      <td class="right">${esc(c.line_count)}</td>
    </tr>`).join('') || '<tr><td colspan="5"><div class="empty-state">No rate cards yet — generate one from legacy rates or create one.</div></td></tr>';
  document.querySelectorAll('#beCardsBody .js-open-card').forEach(tr =>
    tr.addEventListener('click', () => openRateCard(tr.dataset.id)));
}

async function beGenerateFromLegacy() {
  if (!BE_CARD_CLIENT) return alert('Pick a client first (the combo top-right).');
  const r = await fetch(`${API}/billing/rate-cards/generate-from-legacy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ clientId: BE_CARD_CLIENT }),
  });
  const d = await r.json();
  if (!r.ok) return alert(d.error || 'Generate failed');
  openRateCard(d.id);
}

async function beEnsureCodes() {
  if (!BE_CODES.length) {
    const d = await apiGet('/billing/charge-codes');
    BE_CODES = d?.rows || [];
  }
  return BE_CODES;
}

async function openRateCard(id) {
  const d = await apiGet(`/billing/rate-cards/${id}`);
  if (!d || !d.id) return alert('Could not load card');
  BE_EDITING_CARD = d;
  await beEnsureCodes();
  document.getElementById('beCardList').style.display = 'none';
  const view = document.getElementById('beCardDetail');
  view.style.display = '';
  const editable = d.status === 'DRAFT';
  const CHIP = { DRAFT: 'warning', ACTIVE: 'success', SUPERSEDED: 'muted', ARCHIVED: 'muted' };

  document.getElementById('beCardTitle').innerHTML =
    `${esc(d.client_name)} — ${esc(d.name)} <span class="chip chip-${esc(CHIP[d.status] || 'muted')}">${esc(d.status)}</span>`;
  document.getElementById('beCardSub').textContent =
    `Effective ${String(d.effective_from).slice(0, 10)}${d.effective_to ? ' → ' + String(d.effective_to).slice(0, 10) : ''}` +
    (editable ? '' : ' — frozen: create a new card to change pricing');

  document.getElementById('beCardLines').innerHTML = (d.lines || []).map(l => `
    <tr>
      <td>${esc(l.charge_code)}</td>
      <td>${esc(l.basis)}</td>
      <td>${esc(l.slot_type || '(any)')}</td>
      <td>${esc(l.unit)}</td>
      <td class="right" style="font-weight:600;">${fmtDollars(l.rate)}</td>
      <td>${esc(l.cadence)}</td>
      <td class="right">${esc(l.free_days || 0)}</td>
      <td>${esc(l.proration_mode)}</td>
      <td style="font-size:12px;color:var(--text2);">${l.aged_escalation ? 'aged: ' + esc(JSON.stringify(l.aged_escalation)) : ''}${l.tier_rules ? ' tiers: ' + esc(JSON.stringify(l.tier_rules)) : ''}</td>
    </tr>`).join('') || '<tr><td colspan="9"><div class="empty-state">No lines</div></td></tr>';

  const acts = document.getElementById('beCardActions');
  let html = '<button class="btn btn-ghost" id="beCardBack">← Cards</button><span style="flex:1"></span>';
  if (editable) {
    html += `<button class="btn btn-ghost" id="beCardEdit">Edit lines</button>
             <button class="btn btn-ghost" id="beCardArchive" style="color:var(--red);">Archive</button>
             <button class="btn btn-success" id="beCardActivate">Activate</button>`;
  }
  acts.innerHTML = html;
  document.getElementById('beCardBack').addEventListener('click', loadRateCardsTab);
  if (editable) {
    document.getElementById('beCardActivate').addEventListener('click', async () => {
      if (!confirm(`Activate "${d.name}"?\n\nIt becomes this client's live pricing as of ${String(d.effective_from).slice(0, 10)} and supersedes the current ACTIVE card. Activated cards are frozen.`)) return;
      const r = await fetch(`${API}/billing/rate-cards/${d.id}/activate`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` } });
      const j = await r.json();
      if (!r.ok) return alert(j.error || 'Activate failed');
      openRateCard(d.id);
    });
    document.getElementById('beCardArchive').addEventListener('click', async () => {
      if (!confirm('Archive this draft?')) return;
      const r = await fetch(`${API}/billing/rate-cards/${d.id}/archive`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` } });
      const j = await r.json();
      if (!r.ok) return alert(j.error || 'Archive failed');
      loadRateCardsTab();
    });
    document.getElementById('beCardEdit').addEventListener('click', () => beEditCardLines(d));
  }
  document.getElementById('beCardEditor').style.display = 'none';
}

// Line editor: one row per line; tier/aged as validated-JSON advanced fields.
function beLineRowHtml(l, codes) {
  const opt = (list, sel) => list.map(v =>
    `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const codeOpts = codes.map(c =>
    `<option value="${esc(c.id)}"${c.id === l.charge_code_id ? ' selected' : ''}>${esc(c.code)}</option>`).join('');
  return `<tr class="be-edit-row">
    <td><select class="be-f-code">${codeOpts}</select></td>
    <td><select class="be-f-basis">${opt(['LP_OCCUPANCY', 'PER_EVENT'], l.basis || 'LP_OCCUPANCY')}</select></td>
    <td><input class="be-f-slot" value="${esc(l.slot_type || '')}" placeholder="(any)" style="width:80px;"></td>
    <td><select class="be-f-unit">${opt(['lp', 'each', 'cuft', 'pick', 'order', 'label', 'hour'], l.unit || 'lp')}</select></td>
    <td><input class="be-f-rate" type="number" step="0.0001" value="${esc(l.rate ?? '')}" style="width:90px;"></td>
    <td><select class="be-f-cadence">${opt(['MONTHLY_CALENDAR', 'MONTHLY_ANNIVERSARY', 'DAILY', 'WEEKLY', 'PER_EVENT', 'ONE_TIME'], l.cadence || 'MONTHLY_CALENDAR')}</select></td>
    <td><input class="be-f-free" type="number" value="${esc(l.free_days || 0)}" style="width:60px;"></td>
    <td><select class="be-f-pro">${opt(['NONE', 'RECEIPT_STUB_THEN_CALENDAR', 'SPLIT_ON_RECEIPT', 'PURE_DAILY', 'WEEKLY'], l.proration_mode || 'NONE')}</select></td>
    <td><input class="be-f-aged" value="${esc(l.aged_escalation ? JSON.stringify(l.aged_escalation) : '')}" placeholder='[{"after_days":90,"rate":18}]' style="width:170px;font-size:11px;"></td>
    <td><input class="be-f-tiers" value="${esc(l.tier_rules ? JSON.stringify(l.tier_rules) : '')}" placeholder='[{"from_qty":0,"to_qty":100,"rate":14.5}]' style="width:170px;font-size:11px;"></td>
    <td><button class="btn btn-ghost js-del-line" style="color:var(--red);padding:2px 8px;">✕</button></td>
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
  const tr = document.createElement('tr');
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
  } catch (e) { return alert(e.message); }
  if (!lines.length) return alert('A card needs at least one line.');
  const r = await fetch(`${API}/billing/rate-cards/${card.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ lines }),
  });
  const d = await r.json();
  if (!r.ok) return alert(d.error || 'Save failed');
  openRateCard(card.id);
}

async function beNewCard() {
  if (!BE_CARD_CLIENT) return alert('Pick a client first (the combo top-right).');
  await beEnsureCodes();
  const name = prompt('Name for the new rate card (e.g. "2026 pricing"):');
  if (!name) return;
  const eff = prompt('Effective from (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
  if (!eff) return;
  const pick = BE_CODES.find(c => c.code === 'PICK_FEE');
  const r = await fetch(`${API}/billing/rate-cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({
      clientId: BE_CARD_CLIENT, name, effectiveFrom: eff,
      lines: [{ charge_code_id: pick.id, basis: 'PER_EVENT', unit: 'pick', rate: 0, cadence: 'PER_EVENT' }],
    }),
  });
  const d = await r.json();
  if (!r.ok) return alert(d.error || 'Create failed');
  await openRateCard(d.id);
  beEditCardLines(await apiGet(`/billing/rate-cards/${d.id}`));
}

// ---------------------------------------------------------------------------
// TAB: Charge Codes
// ---------------------------------------------------------------------------
async function loadChargeCodesTab() {
  const d = await apiGet('/billing/charge-codes?all=true');
  BE_CODES = (d?.rows || []).filter(c => c.is_active);
  const rows = d?.rows || [];
  const byCat = {};
  for (const c of rows) (byCat[c.category] = byCat[c.category] || []).push(c);
  document.getElementById('beCodesWrap').innerHTML = Object.keys(byCat).sort().map(cat => `
    <div class="be-code-group">
      <div class="be-code-head">${esc(cat)}</div>
      <table class="data-table"><thead><tr><th>Code</th><th>Name</th><th>Unit</th><th>GL account</th><th>Active</th></tr></thead><tbody>
      ${byCat[cat].map(c => `<tr>
        <td style="font-family:monospace;font-size:12px;">${esc(c.code)}</td>
        <td>${esc(c.name)}</td>
        <td>${esc(c.default_unit || '')}</td>
        <td><input class="js-gl" data-id="${esc(c.id)}" value="${esc(c.gl_account || '')}" placeholder="—" style="width:110px;font-size:12px;"></td>
        <td><input type="checkbox" class="js-cc-active" data-id="${esc(c.id)}" ${c.is_active ? 'checked' : ''}></td>
      </tr>`).join('')}
      </tbody></table>
    </div>`).join('') || '<div class="empty-state">No charge codes — click Seed defaults.</div>';

  document.querySelectorAll('#beCodesWrap .js-gl').forEach(inp =>
    inp.addEventListener('change', () => bePatchCode(inp.dataset.id, { glAccount: inp.value.trim() || null })));
  document.querySelectorAll('#beCodesWrap .js-cc-active').forEach(cb =>
    cb.addEventListener('change', () => bePatchCode(cb.dataset.id, { isActive: cb.checked })));
}

async function bePatchCode(id, body) {
  const r = await fetch(`${API}/billing/charge-codes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) alert((await r.json()).error || 'Save failed');
}

async function beSeedDefaults() {
  const r = await fetch(`${API}/billing/charge-codes/seed-defaults`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json();
  alert(`Seeded ${d.seeded} of ${d.catalogSize} default codes (existing ones untouched).`);
  loadChargeCodesTab();
}

async function beNewCode() {
  const code = prompt('Code (UPPER_SNAKE, e.g. FREEZER_SURCHARGE):');
  if (!code) return;
  const name = prompt('Display name:');
  if (!name) return;
  const category = prompt('Category (STORAGE/RECEIVING/PICK/PACK/VAS/RETURNS/HAZMAT/MATERIALS/SHIPPING/ADMIN/OTHER):', 'OTHER');
  if (!category) return;
  const r = await fetch(`${API}/billing/charge-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify({ code, name, category }),
  });
  const d = await r.json();
  if (!r.ok) return alert(d.error || 'Create failed');
  loadChargeCodesTab();
}
