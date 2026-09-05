// =============================================================================
// REPORTS (Phase 9) — drill-down: Item History → LP Trace
// =============================================================================
// Level 1: search by SKU or Lot → item-level summary table
// Level 2: click a row → full LP trace for that (SKU, lot) — family,
//          receiving, allocations, timeline.
// =============================================================================

let _itemHistory = null;       // last item-history query result
let _traceData   = null;       // last trace query result
let _traceContext = null;      // {sku, lot} we drilled into
let _reportsClient = '';       // selected client id, '' = all clients

// Catalog of available reports — add a new entry per report as it's built.
// status:'live' renders a clickable card; 'soon' renders a disabled placeholder.
const REPORTS_CATALOG = [
  {
    id:    'item-history',
    title: 'Item history and LP trace',
    desc:  'Search by SKU or lot, then follow the licence-plate family — receiving, picks, shipments, full timeline. Used for recall.',
    phase: '9.16 / 9.17',
    open:  () => openItemHistoryReport(),
    status:'live',
  },
  // NOTE: there used to be a block of commented-out "future report" stubs here.
  // It was actively misleading — inventory-as-of and case-breaks were listed as
  // unbuilt, but both have been live in the API's report registry since D6.
  // Reports are DEFINITIONS now (src/queries/reportRegistry.js): add one there
  // and it appears in /reports/catalog automatically. There is nothing to
  // uncomment here.
];

// =============================================================================
// LEVEL 1 — ITEM HISTORY
// =============================================================================

/* =============================================================================
 * GENERIC REPORT RUNNER
 *
 * The dashboard knows nothing about any individual report. It asks the API what
 * reports exist, renders their parameters, runs them, and exports them. A new
 * report is a definition in the API's reportRegistry — it appears here with no
 * dashboard change at all.
 *
 * Client scoping is NOT done here. The server forces a portal user's client_id.
 * Doing it in the UI would mean trusting the browser with the one rule that
 * must not be got wrong.
 * ========================================================================== */
let _reportCatalog = [];
let _reportDef     = null;   // definition currently open
let _reportParams  = {};     // its parameter values
let _reportLimit   = 200;
let _reportOffset  = 0;

// Default landing — a card grid of every available report.
async function loadReports(){
  document.getElementById('reportsIndexView').style.display = 'block';
  document.getElementById('reportsContent').style.display = 'none';

  const d = await apiGet('/reports/catalog');
  _reportCatalog = d?.rows || [];
  renderReportsIndex();
  rpRenderSchedules();
}

/* The report catalog is a working index, not a landing page. Grouped rows,
 * dense, scannable, no decoration — you come here to run a report, not to
 * admire it. */
const REPORT_GROUP_ORDER = ['Inventory', 'Inbound', 'Outbound', 'Labor', 'Activity', 'Compliance', 'Billing', 'Traceability'];

function renderReportsIndex(){
  const host = document.getElementById('reportsIndexGrid');
  host.className = '';   // drop the card-grid; this is a list

  // Server-defined reports + the hand-built ones that predate the registry.
  const all = _reportCatalog.map(r => ({
    id: r.id, title: r.title, desc: r.description, group: r.group || 'Other', portalVisible: !!r.portalVisible,
    open: () => openReport(r.id),
  })).concat(REPORTS_CATALOG.filter(r => r.status === 'live').map(r => ({
    id: r.id, title: r.title, desc: r.desc, group: 'Traceability', open: r.open,
  })));

  if(!all.length){ host.innerHTML = uiEmpty('No reports available.'); return; }

  const groups = {};
  all.forEach(r => { (groups[r.group] = groups[r.group] || []).push(r); });
  const order = REPORT_GROUP_ORDER.filter(g => groups[g])
    .concat(Object.keys(groups).filter(g => !REPORT_GROUP_ORDER.includes(g)));

  host.innerHTML = order.map(g => `
    <div class="card rep-group">
      <div class="card-head"><div class="card-title">${esc(g)}</div></div>
      ${groups[g].map(r => `
        <button class="rep-row js-report-card" data-id="${esc(r.id)}">
          <span class="rep-row-title">${esc(r.title)}${r.portalVisible && !rpPortal() ? ' <span class="ui-chip ui-chip-neutral rep-portal-chip">PORTAL</span>' : ''}</span>
          <span class="rep-row-desc">${esc(r.desc || '')}</span>
          <span class="rep-row-go">Run →</span>
        </button>`).join('')}
    </div>`).join('');

  host.querySelectorAll('.js-report-card').forEach(card => {
    const r = all.find(x => x.id === card.dataset.id);
    if(r) card.addEventListener('click', uiBusyHandler(() => r.open()));
  });
}

/* ---- Generic runner: parameters -> results -> export --------------------- */
let _reportPresets = [];      // the caller's saved presets for the open report
let _reportDrillBack = null;  // { id, params } — the report a drill-down came from

// A param default -> a value, the same way the server does it: 'today' | 'monthStart' | '-30d' | '+30d' | literal.
function reportDefault(def){
  if(def === undefined || def === null) return '';
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  if(def === 'today') return iso(now);
  if(def === 'monthStart') return iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const m = /^([+-])(\d+)d$/.exec(String(def));
  if(m) return iso(new Date(now.getTime() + (m[1] === '-' ? -1 : 1) * Number(m[2]) * 86400000));
  return String(def);
}
function rpPortal(){ return typeof isPortalMode === 'function' && isPortalMode(); }

async function openReport(id, initialParams = {}){
  _reportDef = _reportCatalog.find(r => r.id === id);
  if(!_reportDef) return uiToast('Unknown report', 'error');
  _reportParams = {};
  _reportOffset = 0;

  document.getElementById('reportsIndexView').style.display = 'none';
  document.getElementById('reportsContent').style.display = 'block';
  document.getElementById('itemHistoryView').style.display = 'none';
  document.getElementById('traceView').style.display = 'none';
  document.getElementById('genericReportView').style.display = 'block';

  document.getElementById('reportsCurrentTitle').textContent = _reportDef.title;
  document.getElementById('reportsCurrentSub').textContent   = _reportDef.description || '';

  const clients = rpPortal() ? [] : (await apiGet('/clients')) || [];
  const hasDates = _reportDef.params.some(p => p.key === 'dateFrom');
  _reportPresets = (await apiGet(`/reports/presets?reportId=${encodeURIComponent(id)}`))?.rows || [];
  const val = (p) => initialParams[p.key] !== undefined && initialParams[p.key] !== null ? String(initialParams[p.key]) : reportDefault(p.default);

  document.getElementById('genericReportParams').innerHTML =
    _reportDef.params.map(p => {
      if(p.type === 'client'){
        // Portal users don't get a client picker — the server forces their scope.
        if(!clients.length) return '';
        return `<div class="ui-field rep-field rep-field-wide">
          <label class="ui-label">${esc(p.label)}</label>
          <select class="ui-input js-rp" data-key="${esc(p.key)}">
            <option value="">All clients</option>
            ${clients.map(c => `<option value="${esc(c.id)}" ${String(c.id) === val(p) ? 'selected' : ''}>${esc(c.code)} — ${esc(c.name)}</option>`).join('')}
          </select>
        </div>`;
      }
      if(p.type === 'select'){
        return `<div class="ui-field rep-field">
          <label class="ui-label">${esc(p.label)}</label>
          <select class="ui-input js-rp" data-key="${esc(p.key)}">
            ${(p.options || []).map(o => `<option value="${esc(o.value)}" ${String(o.value) === val(p) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
        </div>`;
      }
      if(p.type === 'uidlist'){
        return `<div class="ui-field rep-field rep-field-wide">
          <label class="ui-label">${esc(p.label)}</label>
          <textarea class="ui-input rep-textarea js-rp" data-key="${esc(p.key)}" placeholder="one per line, or comma separated">${esc(val(p))}</textarea>
        </div>`;
      }
      return `<div class="ui-field rep-field">
        <label class="ui-label">${esc(p.label)}${p.required ? ' *' : ''}</label>
        <input class="ui-input js-rp" data-key="${esc(p.key)}" type="${p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'}" value="${esc(val(p))}">
      </div>`;
    }).join('') +
    `<button class="ui-btn ui-btn-primary" onclick="uiRun(this, () => runGenericReport())">Run</button>
     ${_reportDrillBack ? `<button class="ui-btn js-rp-back">← ${esc(_reportDrillBack.title || 'Back')}</button>` : ''}
     <div class="rep-spacer"></div>
     ${hasDates ? '<label class="ui-check rep-since" title="Start the window where your last run of this report ended"><input type="checkbox" id="rpSince"> Since last run</label>' : ''}
     <div class="rep-presets">
       <select class="ui-input" id="rpPresetSel" title="Saved filters">
         <option value="">Presets…</option>
         ${_reportPresets.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
       </select>
       <button class="ui-btn" onclick="uiRun(this, () => rpSavePreset())">Save preset</button>
       <button class="ui-btn" id="rpDelPreset" onclick="uiRun(this, () => rpDeletePreset())" hidden>Delete preset</button>
     </div>
     <button class="ui-btn" onclick="uiRun(this, () => exportGenericReport('csv'))">CSV</button>
     <button class="ui-btn" onclick="uiRun(this, () => exportGenericReport('xlsx'))">Excel</button>
     <button class="ui-btn" onclick="uiRun(this, () => exportGenericReport('pdf'))">PDF</button>
     ${rpPortal() ? '' : '<button class="ui-btn" onclick="uiRun(this, () => rpScheduleModal())">Schedule…</button>'}
     <div class="rep-hint ui-hint" id="rpHint" hidden></div>`;

  const host = document.getElementById('genericReportParams');
  const sel = host.querySelector('#rpPresetSel');
  sel.addEventListener('change', () => {
    const p = _reportPresets.find(x => x.id === sel.value);
    host.querySelector('#rpDelPreset').hidden = !p;
    if(p){ rpApplyParams(p.params); runGenericReport(); }
  });
  const since = host.querySelector('#rpSince');
  if(since) since.addEventListener('change', uiBusyHandler(async () => {
    if(since.checked){
      const d = await apiGet(`/reports/last-run/${_reportDef.id}`);
      rpHint(d?.lastRun ? `Since your last run: ${fmtTimeShort(d.lastRun.ranAt)} (${d.lastRun.rowCount ?? '?'} rows then)` : 'No previous run — the dates above apply');
    } else rpHint('');
    await runGenericReport();
  }));
  const back = host.querySelector('.js-rp-back');
  if(back) back.addEventListener('click', uiBusyHandler(() => { const b = _reportDrillBack; _reportDrillBack = null; return openReport(b.id, b.params); }));
  host.querySelectorAll('.js-rp').forEach(el => el.addEventListener('keydown', (e) => { if(e.key === 'Enter' && el.tagName !== 'TEXTAREA'){ e.preventDefault(); runGenericReport(); } }));

  runGenericReport();
}

function rpHint(text){
  const h = document.getElementById('rpHint');
  if(!h) return;
  h.textContent = text || '';
  h.hidden = !text;
}
function rpApplyParams(params){
  document.querySelectorAll('#genericReportParams .js-rp').forEach(el => { el.value = params && params[el.dataset.key] !== undefined ? String(params[el.dataset.key]) : (el.tagName === 'SELECT' ? '' : ''); });
}
function collectReportParams(){
  const p = {};
  document.querySelectorAll('#genericReportParams .js-rp').forEach(el => {
    if(el.value) p[el.dataset.key] = el.value;
  });
  return p;
}

function reportQuery(extra = {}){
  const since = document.getElementById('rpSince');
  const qs = new URLSearchParams({ ..._reportParams, ...(since && since.checked ? { sinceLastRun: 1 } : {}), ...extra });
  return qs.toString();
}

function rpColumns(){
  const cols = _reportDef.columns.map(c => ({
    key: c.key,
    label: c.label,
    num:   c.type === 'num',
    money: c.type === 'money',
    mono:  c.type === 'mono',
    render: c.type === 'datetime'
      ? (r) => r[c.key] ? uiId(fmtTimeShort(r[c.key])) : '<span class="ui-muted">—</span>'
      : c.type === 'date'
        ? (r) => r[c.key] ? uiId(new Date(r[c.key]).toLocaleDateString()) : '<span class="ui-muted">—</span>'
        : undefined,
  }));
  const drill = _reportDef.drill;
  if(drill && _reportCatalog.some(r => r.id === drill.report)){
    cols.push({ key: '_drill', label: '', render: (r) => {
      if(drill.when && !r[drill.when]) return '';
      const target = {};
      for(const [param, key] of Object.entries(drill.map || {})) if(r[key] !== undefined && r[key] !== null) target[param] = r[key];
      return `<button type="button" class="ui-btn rep-drill js-rp-drill" data-payload="${esc(JSON.stringify(target))}">${esc(drill.label || 'Open')} ›</button>`;
    } });
  }
  return cols;
}

async function runGenericReport(){
  if(!_reportDef) return;
  _reportParams = collectReportParams();

  const missing = _reportDef.params.filter(p => p.required && !_reportParams[p.key]);
  if(missing.length) return uiToast(`${missing.map(m => m.label).join(' and ')} required`, 'error');

  const cols = rpColumns();
  uiTableLoading('genericReportWrap', cols);
  const r = await fetch(`${API}/reports/run/${_reportDef.id}?${reportQuery({ limit: _reportLimit, offset: _reportOffset })}`, { headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => null);
  if(!r.ok || !d){ uiToast((d && d.error) || 'Report failed', 'error'); return uiTableError('genericReportWrap', cols, (d && d.error) || 'Report failed', runGenericReport); }

  // the window that actually ran (defaults or since-last-run applied) goes back into the inputs
  if(d.params){ document.querySelectorAll('#genericReportParams .js-rp').forEach(el => { if(d.params[el.dataset.key] !== undefined && !el.value) el.value = String(d.params[el.dataset.key]); }); }
  if(d.since && d.since.applied){ rpApplyParams({ ...collectReportParams(), dateFrom: d.since.dateFrom, dateTo: d.since.dateTo }); rpHint(`Since your last run: ${fmtTimeShort(d.since.lastRunAt)} → window ${d.since.dateFrom} to ${d.since.dateTo}`); }

  uiTable('genericReportWrap', {
    columns: cols, rows: d.rows || [], rowKey: 'id',
    empty: 'Nothing happened in that window — no rows match.',
  });
  const drill = _reportDef.drill;
  document.querySelectorAll('#genericReportWrap .js-rp-drill').forEach(b => b.addEventListener('click', uiBusyHandler((e) => {
    e.stopPropagation();
    _reportDrillBack = { id: _reportDef.id, title: _reportDef.title, params: collectReportParams() };
    return openReport(drill.report, JSON.parse(b.dataset.payload || '{}'));
  })));

  uiPager('genericReportPager', {
    total: Number(d.total || 0), limit: _reportLimit, offset: _reportOffset,
    noun: 'rows',
    onChange: (limit, offset) => { _reportLimit = limit; _reportOffset = offset; runGenericReport(); },
  });
}

/* Every export runs the SAME definition as the screen, so a CSV someone works
 * from, the spreadsheet the office pivots, and the PDF a client files away can
 * never disagree with what ops saw. CSV / Excel download; PDF opens for review. */
async function exportGenericReport(fmt){
  if(!_reportDef) return;
  _reportParams = collectReportParams();

  const missing = _reportDef.params.filter(p => p.required && !_reportParams[p.key]);
  if(missing.length) return uiToast(`${missing.map(m => m.label).join(' and ')} required`, 'error');

  const r = await fetch(`${API}/reports/export/${_reportDef.id}.${fmt}?${reportQuery()}`, {
    headers: { Authorization: `Bearer ${T}` },
  });
  if(!r.ok){ const d = await r.json().catch(() => ({})); return uiToast(d.error || 'Export failed', 'error'); }

  const blob = await r.blob();
  const url  = URL.createObjectURL(blob);
  const name = `${_reportDef.id}-${new Date().toISOString().slice(0, 10)}.${fmt}`;

  if(fmt === 'pdf'){
    // Open it — nobody should email a client a report they haven't looked at.
    if(!window.open(url, '_blank', 'noopener')) uiToast('Pop-up blocked — allow pop-ups to view the PDF', 'error');
    else uiToast('PDF opened');
  } else {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    uiToast(fmt === 'xlsx' ? 'Excel file downloaded' : 'CSV downloaded', 'success');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---- presets: the caller's saved filters, per report ------------------------ */
async function rpSavePreset(){
  if(!_reportDef) return;
  const params = collectReportParams();
  const name = await uiPrompt({ title: 'Save these filters as a preset', label: 'Preset name', placeholder: 'e.g. Client A — last month', confirmLabel: 'Save' });
  if(!name) return;
  const r = await fetch(`${API}/reports/presets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ reportKey: _reportDef.id, name, params }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not save the preset', 'error');
  _reportPresets = (await apiGet(`/reports/presets?reportId=${encodeURIComponent(_reportDef.id)}`))?.rows || [];
  const sel = document.getElementById('rpPresetSel');
  if(sel){ sel.innerHTML = '<option value="">Presets…</option>' + _reportPresets.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join(''); sel.value = d.id; document.getElementById('rpDelPreset').hidden = false; }
  uiToast(`Preset "${d.name}" saved`, 'success');
}
async function rpDeletePreset(){
  const sel = document.getElementById('rpPresetSel');
  const p = _reportPresets.find(x => x.id === (sel && sel.value));
  if(!p) return;
  if(!(await uiConfirm({ title: `Delete preset "${p.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
  const r = await fetch(`${API}/reports/presets/${p.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${T}` } });
  if(!r.ok) return uiToast('Could not delete the preset', 'error');
  _reportPresets = _reportPresets.filter(x => x.id !== p.id);
  sel.innerHTML = '<option value="">Presets…</option>' + _reportPresets.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  document.getElementById('rpDelPreset').hidden = true;
  uiToast('Preset deleted', 'success');
}

/* ---- scheduled delivery (ops) -------------------------------------------------- */
const RP_HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));
const RP_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => ({ value: String(i), label: d }));

function rpScheduleModal(){
  if(!_reportDef) return;
  const params = collectReportParams();
  const summary = Object.entries(params).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'default filters';
  const m = uiModal({
    title: `Schedule "${_reportDef.title}"`,
    body: `<div class="ui-hint">Runs with the filters on screen now (${esc(summary)}). The file is built on schedule and handed to the email hook — mail delivery is wired separately, so until then each run is logged as built.</div>
           ${uiField({ id: 'rsName', label: 'Name', value: _reportDef.title })}
           <div class="ui-field-row">
             ${uiFieldSelect({ id: 'rsFreq', label: 'Frequency', options: [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }] })}
             ${uiFieldSelect({ id: 'rsWeekday', label: 'Weekday', options: RP_WEEKDAYS, value: '1' })}
             ${uiField({ id: 'rsMonthDay', label: 'Day of month (1-28)', type: 'number', value: '1' })}
             ${uiFieldSelect({ id: 'rsHour', label: 'At', options: RP_HOURS, value: '6' })}
           </div>
           <div class="ui-field-row">
             ${uiField({ id: 'rsTz', label: 'Timezone', value: 'America/Los_Angeles' })}
             ${uiFieldSelect({ id: 'rsFormat', label: 'Format', options: [{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV' }, { value: 'pdf', label: 'PDF' }], value: 'xlsx' })}
           </div>
           <div class="ui-field"><label class="ui-label">Recipients</label><textarea class="ui-input rep-textarea" id="rsTo" placeholder="one email per line"></textarea></div>
           ${_reportDef.params.some(p => p.key === 'dateFrom') ? '<label class="ui-check"><input type="checkbox" id="rsSince" checked> Since last run (each delivery covers the period since the previous one)</label>' : ''}`,
    actions: [{ label: 'Cancel' }, { label: 'Schedule', primary: true, onClick: async (api) => {
      const v = (id) => { const el = api.el.querySelector('#' + id); return el ? el.value : ''; };
      const recipients = v('rsTo').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
      if(!recipients.length){ uiToast('Add at least one recipient', 'error'); return false; }
      const since = api.el.querySelector('#rsSince');
      const body = { reportKey: _reportDef.id, name: v('rsName'), params, frequency: v('rsFreq'), weekday: v('rsWeekday'), monthDay: v('rsMonthDay'), runHour: v('rsHour'), timezone: v('rsTz'), format: v('rsFormat'), recipients, sinceLastRun: !!(since && since.checked) };
      const r = await fetch(`${API}/reports/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok){ uiToast(d.error || 'Could not create the schedule', 'error'); return false; }
      uiToast(`Scheduled — next run ${fmtTimeShort(d.nextRunAt)}`, 'success');
    } }],
  });
  const freq = m.el.querySelector('#rsFreq');
  const sync = () => { m.el.querySelector('#rsWeekday').closest('.ui-field').hidden = freq.value !== 'weekly'; m.el.querySelector('#rsMonthDay').closest('.ui-field').hidden = freq.value !== 'monthly'; };
  freq.addEventListener('change', sync); sync();
}

async function rpRenderSchedules(){
  const host = document.getElementById('reportsSchedules');
  if(!host || rpPortal()) return;
  const d = await apiGet('/reports/schedules');
  const rows = d?.rows || [];
  const when = (s) => s.frequency === 'weekly' ? `${RP_WEEKDAYS[s.weekday || 0].label}s ${String(s.runHour).padStart(2, '0')}:00` : s.frequency === 'monthly' ? `day ${s.monthDay} ${String(s.runHour).padStart(2, '0')}:00` : `daily ${String(s.runHour).padStart(2, '0')}:00`;
  uiTable(host, {
    columns: [
      { key: 'name', label: 'Schedule' },
      { key: '_report', label: 'Report', render: s => esc((_reportCatalog.find(r => r.id === s.reportKey) || {}).title || s.reportKey) },
      { key: '_when', label: 'When', render: s => `${esc(when(s))} <span class="ui-muted">${esc(s.timezone)}</span>` },
      { key: 'format', label: 'Format', mono: true },
      { key: '_to', label: 'Recipients', render: s => esc((s.recipients || []).join(', ')) },
      { key: '_next', label: 'Next run', render: s => s.isActive && s.nextRunAt ? uiId(fmtTimeShort(s.nextRunAt)) : uiChip('INACTIVE', 'PAUSED') },
      { key: '_last', label: 'Last run', render: s => s.lastRunAt ? `${uiId(fmtTimeShort(s.lastRunAt))} ${uiChip(s.lastStatus === 'sent' ? 'ACTIVE' : s.lastStatus === 'failed' ? 'CANCELLED' : 'DRAFT', (s.lastStatus || '').toUpperCase())}` : '<span class="ui-muted">never</span>' },
      { key: '_act', label: '', render: s => `<button type="button" class="ui-btn js-rs-run" data-id="${esc(s.id)}">Run now</button> <button type="button" class="ui-btn js-rs-toggle" data-id="${esc(s.id)}" data-active="${s.isActive ? '1' : ''}">${s.isActive ? 'Pause' : 'Resume'}</button> <button type="button" class="ui-btn js-rs-del" data-id="${esc(s.id)}">Delete</button>` },
    ],
    rows, empty: 'No scheduled deliveries. Open a report and click Schedule…',
  });
  const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` };
  host.querySelectorAll('.js-rs-run').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const r = await fetch(`${API}/reports/schedules/${b.dataset.id}/run-now`, { method: 'POST', headers: hdr });
    const d2 = await r.json().catch(() => ({}));
    if(!r.ok) return uiToast(d2.error || 'Run failed', 'error');
    uiToast(`Run ${d2.status}: ${d2.rowCount ?? 0} rows${d2.error ? ' — ' + d2.error : ''}`, d2.status === 'failed' ? 'error' : 'success');
    await rpRenderSchedules();
  })));
  host.querySelectorAll('.js-rs-toggle').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    const r = await fetch(`${API}/reports/schedules/${b.dataset.id}`, { method: 'PATCH', headers: hdr, body: JSON.stringify({ isActive: !b.dataset.active }) });
    if(!r.ok) return uiToast('Could not update the schedule', 'error');
    uiToast(b.dataset.active ? 'Schedule paused' : 'Schedule resumed', 'success');
    await rpRenderSchedules();
  })));
  host.querySelectorAll('.js-rs-del').forEach(b => b.addEventListener('click', uiBusyHandler(async () => {
    if(!(await uiConfirm({ title: 'Delete this schedule?', confirmLabel: 'Delete', danger: true }))) return;
    const r = await fetch(`${API}/reports/schedules/${b.dataset.id}`, { method: 'DELETE', headers: hdr });
    if(!r.ok) return uiToast('Could not delete the schedule', 'error');
    uiToast('Schedule deleted', 'success');
    await rpRenderSchedules();
  })));
}

function backToReportsIndex(){
  document.getElementById('reportsContent').style.display = 'none';
  document.getElementById('genericReportView').style.display = 'none';
  document.getElementById('reportsIndexView').style.display = 'block';
  _reportDef = null;
  _reportDrillBack = null;
  rpRenderSchedules();
}

// =============================================================================
// REPORT — Item History → LP Trace
// =============================================================================

async function openItemHistoryReport(){
  document.getElementById('reportsIndexView').style.display = 'none';
  document.getElementById('reportsContent').style.display = 'block';
  document.getElementById('genericReportView').style.display = 'none';
  document.getElementById('reportsCurrentTitle').textContent = 'Item History';
  document.getElementById('reportsCurrentSub').textContent   = 'Item history → LP traceability';

  document.getElementById('itemHistoryView').style.display = 'block';
  document.getElementById('traceView').style.display = 'none';

  // Phase 3: in portal mode the client picker is hidden (.ops-only on the
  // form-group in index.html) and /clients is requireOps anyway, so skip
  // both the fetch and the combo init. Reports are auto-scoped server-side
  // by scopeClient.
  if(typeof isPortalMode === 'function' && isPortalMode()){
    _reportsClient = '';
  } else {
    // Always fetch fresh — bypass any cache state that might be empty.
    const clientsList = await apiGet('/clients');
    const clients = Array.isArray(clientsList) ? clientsList : [];

    initCombo('reportsClientWrap',
      [{value:'', label:'All clients'}].concat(
        clients.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`}))
      ),
      {
        placeholder: 'All clients',
        value: _reportsClient || '',
        onChange: (v) => {
          _reportsClient = v || '';
          if(document.getElementById('traceView').style.display !== 'none'){
            backToItemHistory();
          }
          runItemHistory();
        },
      }
    );
  }

  if(!_itemHistory) runItemHistory();
  document.getElementById('reportSkuInput').focus?.();
}

const IH_COLS = [
  { key: '_sku', label: 'SKU', sortValue: r => r.sku_code, render: r =>
      `<div>${uiId(r.sku_code)}</div><div class="ui-hint">${esc(r.sku_name || '')}</div>` },
  { key: 'client_code', label: 'Client', mono: true },
  { key: '_lot', label: 'Lot', sortValue: r => r.lot_number, render: r => {
      if(!r.lot_number) return '<span class="ui-muted">—</span>';
      const soon = r.expiry_date && new Date(r.expiry_date) < new Date(Date.now() + 30 * 864e5);
      return soon
        ? `<span class="ui-chip ui-chip-warn">${esc(r.lot_number)}</span>`
        : uiId(r.lot_number);
    } },
  { key: '_exp', label: 'Expiry', sortValue: r => r.expiry_date, render: r => r.expiry_date
      ? uiId(new Date(r.expiry_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }))
      : '<span class="ui-muted">—</span>' },
  { key: 'total_received', label: 'Received', num: true },
  { key: 'total_picked', label: 'Picked', num: true },
  { key: 'total_shipped', label: 'Shipped', num: true },
  { key: 'on_hand', label: 'On hand', num: true },
  { key: 'allocated_qty', label: 'Allocated', num: true },
  { key: '_lps', label: 'LPs', num: true, sortValue: r => Number(r.lp_count || 0), render: r =>
      `<span title="${esc(r.lp_original_count)} original / ${esc(r.lp_child_count)} child · ${esc(r.lp_active_count)} active / ${esc(r.lp_empty_count)} empty / ${esc(r.lp_shipped_count)} shipped">${uiNum(r.lp_count)}</span>` },
  { key: '_last', label: 'Last activity', sortValue: r => r.last_activity_at, render: r => r.last_activity_at
      ? uiId(new Date(r.last_activity_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
      : '<span class="ui-muted">—</span>' },
];

async function runItemHistory(){
  const sku = document.getElementById('reportSkuInput').value.trim();
  const lot = document.getElementById('reportLotInput').value.trim();

  const qs = [];
  if(sku) qs.push(`skuCode=${encodeURIComponent(sku)}`);
  if(lot) qs.push(`lotNumber=${encodeURIComponent(lot)}`);
  if(_reportsClient) qs.push(`clientId=${encodeURIComponent(_reportsClient)}`);

  uiTableLoading('itemHistoryWrap', IH_COLS);
  const data = await apiGet(`/reports/item-history?${qs.join('&')}`);
  if(data === null) return uiTableError('itemHistoryWrap', IH_COLS, 'Search failed', runItemHistory);
  _itemHistory = data;
  renderItemHistory();
}

function renderItemHistory(){
  const rows = _itemHistory?.rows || [];

  // Recall totals. On a recall these are the numbers someone reads down the
  // phone — "how much went out" is the one that matters, so it leads.
  const t = rows.reduce((a, r) => ({
    received: a.received + Number(r.total_received || 0),
    picked:   a.picked   + Number(r.total_picked   || 0),
    shipped:  a.shipped  + Number(r.total_shipped  || 0),
    onHand:   a.onHand   + Number(r.on_hand        || 0),
    lps:      a.lps      + Number(r.lp_count       || 0),
  }), { received: 0, picked: 0, shipped: 0, onHand: 0, lps: 0 });

  const strip = document.getElementById('ihSummary');
  strip.className = 'ui-tiles';
  strip.innerHTML = rows.length
    ? uiTile({ label: 'Shipped out', value: t.shipped.toLocaleString(),
               tone: t.shipped > 0 ? 'warn' : null,
               sub: t.shipped > 0 ? 'already left the building' : 'nothing shipped' }) +
      uiTile({ label: 'Still on hand', value: t.onHand.toLocaleString(),
               sub: 'can still be quarantined' }) +
      uiTile({ label: 'Received', value: t.received.toLocaleString() }) +
      uiTile({ label: 'Picked', value: t.picked.toLocaleString() }) +
      uiTile({ label: 'Items', value: rows.length }) +
      uiTile({ label: 'License plates', value: t.lps.toLocaleString() })
    : '';

  uiTable('itemHistoryWrap', {
    columns: IH_COLS, rows, rowKey: '_k',
    sortable: true,
    onRowClick: r => openTraceFromItem({
      skuId: r.sku_id, skuCode: r.sku_code, skuName: r.sku_name,
      lotId: r.lot_id || null, lotNumber: r.lot_number || null,
      clientName: r.client_name,
    }),
    empty: 'No activity matches that search.',
  });
}

// =============================================================================
// LEVEL 2 — LP TRACE for a chosen item
// =============================================================================

async function openTraceFromItem(ctx){
  _traceContext = ctx;

  document.getElementById('itemHistoryView').style.display = 'none';
  document.getElementById('traceView').style.display = 'block';
  document.getElementById('traceContextLabel').innerHTML =
    `<span style="color:var(--blue);font-weight:600;">${esc(ctx.skuCode)}</span>` +
    `<span style="color:var(--text2);"> · ${esc(ctx.skuName || '')}</span>` +
    (ctx.lotNumber ? ` <span style="color:var(--text2);"> · Lot </span><span style="color:var(--blue);">${esc(ctx.lotNumber)}</span>` : '');

  document.getElementById('traceResults').style.display = 'none';
  document.getElementById('traceEmptyState').style.display = 'block';
  document.getElementById('traceEmptyState').textContent = 'Loading LP trace…';
  document.getElementById('traceError').textContent = '';

  // If we have a specific lot, use it. Otherwise fall back to LP search by SKU
  // (less precise, but at least returns LPs for that SKU).
  let url;
  if(ctx.lotNumber){
    url = `/reports/trace?lotNumber=${encodeURIComponent(ctx.lotNumber)}`;
  } else {
    // No lot — show all LPs whose number contains the SKU code (heuristic)
    url = `/reports/trace?lpNumber=${encodeURIComponent(ctx.skuCode)}`;
  }
  if(_reportsClient) url += `&clientId=${encodeURIComponent(_reportsClient)}`;

  const data = await apiGet(url);
  if(!data){
    document.getElementById('traceError').textContent = 'Trace failed (network or auth error)';
    document.getElementById('traceEmptyState').textContent = 'No results';
    return;
  }
  _traceData = data;
  renderTrace();
}

function backToItemHistory(){
  document.getElementById('traceView').style.display = 'none';
  document.getElementById('itemHistoryView').style.display = 'block';
}

// Manual LP search inside the trace view (when user wants to look up a specific LP).
async function runManualTrace(){
  const lp = document.getElementById('manualLpInput').value.trim();
  const err = document.getElementById('traceError');
  err.textContent = '';
  if(!lp){ err.textContent = 'Enter an LP number'; return; }

  document.getElementById('traceResults').style.display = 'none';
  document.getElementById('traceEmptyState').style.display = 'block';
  document.getElementById('traceEmptyState').textContent = 'Loading…';

  let url = `/reports/trace?lpNumber=${encodeURIComponent(lp)}`;
  if(_reportsClient) url += `&clientId=${encodeURIComponent(_reportsClient)}`;
  const data = await apiGet(url);
  if(!data){ err.textContent = 'Trace failed'; return; }
  _traceData = data;
  _traceContext = { skuCode: 'Manual LP search', skuName: '', lotNumber: '' };
  document.getElementById('traceContextLabel').textContent = `Manual LP search: ${lp}`;
  renderTrace();
}

function renderTrace(){
  const data = _traceData || {};
  const results = document.getElementById('traceResults');
  const empty   = document.getElementById('traceEmptyState');

  const hasFamily = data.lpFamily?.length > 0;
  const hasAllocs = data.allocations?.length > 0;
  if(!hasFamily && !hasAllocs){
    results.style.display = 'none';
    empty.style.display = 'block';
    empty.textContent = 'No LPs or allocations found.';
    return;
  }

  results.style.display = 'block';
  empty.style.display = 'none';

  // -------- summary tiles
  const s = data.summary || {};
  document.getElementById('traceSumFamily').textContent     = String(s.familySize || 0);
  document.getElementById('traceSumOrigCh').textContent     = `${s.originalLps || 0} orig · ${s.childLps || 0} child`;
  document.getElementById('traceSumOrders').textContent     = String(s.distinctOrders || 0);
  document.getElementById('traceSumCustomers').textContent  = String(s.distinctCustomers || 0);
  document.getElementById('traceSumQty').textContent        = String(Number(s.totalQuantity || 0));
  document.getElementById('traceSumEvents').textContent     = String(s.timelineEvents || 0);
  document.getElementById('traceSumReceiving').textContent  = String(s.receivingEvents || 0);

  renderLpFamily(data.lpFamily || []);
  renderReceiving(data.receiving || []);
  renderTraceAllocations(data.allocations || []);
  renderTimeline(data.timeline || []);
}

// -------- LP family tree (parent → children, indented)
function renderLpFamily(family){
  const card = document.getElementById('lpFamilyCard');
  const tbody = document.getElementById('lpFamilyBody');
  if(!family.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  const byParent = {};
  family.forEach(lp => {
    const k = lp.parent_lp_id || 'ROOT';
    if(!byParent[k]) byParent[k] = [];
    byParent[k].push(lp);
  });

  const rendered = [];
  function emit(lp, depth){
    rendered.push({lp, depth});
    (byParent[lp.id] || []).forEach(child => emit(child, depth + 1));
  }
  (byParent['ROOT'] || []).forEach(root => emit(root, 0));
  family.forEach(lp => {
    if(!rendered.find(r => r.lp.id === lp.id)){
      rendered.push({lp, depth: 0});
    }
  });

  tbody.innerHTML = rendered.map(({lp, depth}) => {
    const indent = '&nbsp;'.repeat(depth * 4) + (depth > 0 ? '↳ ' : '');
    const lpBadge = `<span class="lp-badge ${lp.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(lp.lp_number)}</span>`;
    const stChip = lp.status === 'ACTIVE'   ? 'chip-success'
                 : lp.status === 'EMPTY'    ? 'chip-warning'
                 : lp.status === 'SHIPPED'  ? 'chip-active'
                 : 'chip-new';
    const recv = lp.received_at
      ? new Date(lp.received_at).toLocaleString('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'})
      : '—';
    return `
      <tr>
        <td>${indent}${lpBadge}</td>
        <td>${esc(lp.sku_code || '—')}</td>
        <td style="color:var(--blue);">${esc(lp.lot_number || '—')}</td>
        <td>${esc(lp.location_code || '—')}</td>
        <td class="right">${esc(lp.current_qty ?? 0)}</td>
        <td><span class="chip ${stChip}">${esc(lp.status || '')}</span></td>
        <td style="color:var(--text2);font-size:12px;">${esc(recv)}</td>
        <td><button type="button" class="ui-btn js-trace-units" data-lp="${esc(lp.id)}">Units</button></td>
      </tr>`;
  }).join('');
  // Units per LP, on demand, in a row under the LP: UID, status, lot, order, last event; click a unit for its history.
  tbody.querySelectorAll('.js-trace-units').forEach(btn => btn.addEventListener('click', uiBusyHandler(async () => {
    const tr = btn.closest('tr');
    const next = tr.nextElementSibling;
    if(next && next.classList.contains('trace-units-row')){ next.remove(); return; }
    const row = document.createElement('tr'); row.className = 'trace-units-row';
    row.innerHTML = '<td colspan="8"><div class="js-trace-units-host"></div></td>';
    tr.insertAdjacentElement('afterend', row);
    await lpUnitsSection(btn.dataset.lp, row.querySelector('.js-trace-units-host'), { id: 'traceUnits-' + btn.dataset.lp });
  })));
}

function renderReceiving(rows){
  const card = document.getElementById('traceReceivingCard');
  const tbody = document.getElementById('traceReceivingBody');
  if(!rows.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  tbody.innerHTML = rows.map(r => {
    const recv = r.received_line_at
      ? new Date(r.received_line_at).toLocaleString('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'})
      : '—';
    return `
      <tr>
        <td style="font-weight:600;color:var(--blue);">${esc(r.po_number || '—')}</td>
        <td>${esc(r.supplier_name || '—')}</td>
        <td class="right">${esc(r.received_qty || 0)}</td>
        <td>${esc(r.condition || '—')}</td>
        <td>${esc(r.received_by_name || '—')}</td>
        <td style="color:var(--text2);font-size:12px;">${esc(recv)}</td>
      </tr>`;
  }).join('');
}

function renderTraceAllocations(rows){
  const card = document.getElementById('traceAllocCard');
  const tbody = document.getElementById('traceAllocBody');
  if(!rows.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  tbody.innerHTML = rows.map(r => {
    const shipped = r.shipment_shipped_at
      ? new Date(r.shipment_shipped_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})
      : (r.allocated_at ? new Date(r.allocated_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '—');
    const orderChip = SM[r.order_status]
      ? `<span class="chip ${SM[r.order_status].c}">${esc(SM[r.order_status].l)}</span>`
      : `<span class="chip chip-new">${esc(r.order_status)}</span>`;
    const cityState = [r.ship_to_city, r.ship_to_state].filter(Boolean).join(', ');
    const lpBadge = r.lp_number
      ? `<span class="lp-badge ${r.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(r.lp_number)}</span>`
      : '—';
    const ship = r.shipment_number
      ? `<div style="font-size:12px;"><span style="color:var(--blue);">${esc(r.shipment_number)}</span>${r.tracking_number ? `<br><span style="color:var(--muted);font-size:11px;">${esc(r.tracking_number)}</span>` : ''}</div>`
      : '<span style="color:var(--muted);">—</span>';

    return `
      <tr class="js-trace-row" data-order-id="${esc(r.order_id)}" style="cursor:pointer;">
        <td>${lpBadge}</td>
        <td style="font-weight:600;color:var(--blue);">${esc(r.order_number || '')}</td>
        <td><div>${esc(r.client_name || '')}</div><div style="font-size:11px;color:var(--muted);">${esc(r.client_code || '')}</div></td>
        <td>
          <div style="font-weight:600;">${esc(r.customer_name || r.ship_to_name || '—')}</div>
          <div style="font-size:11px;color:var(--text2);">${esc(r.customer_email || '')}</div>
        </td>
        <td>
          <div>${esc(r.ship_to_line1 || '')}${r.ship_to_line2 ? ', ' + esc(r.ship_to_line2) : ''}</div>
          <div style="font-size:11px;color:var(--text2);">${esc(cityState)} ${esc(r.ship_to_postal || '')}</div>
        </td>
        <td><span style="font-weight:600;color:var(--blue);">${esc(r.sku_code || '')}</span></td>
        <td style="color:var(--blue);">${esc(r.lot_number || '—')}</td>
        <td class="right" style="font-weight:600;">${esc(Number(r.picked_qty || r.allocated_qty || 0))}</td>
        <td>${esc(shipped)}</td>
        <td>${ship}</td>
        <td>${orderChip}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.js-trace-row').forEach(row => {
    row.addEventListener('click', uiBusyHandler(() => {
      navigateTo('orders');
      setTimeout(() => openOrderDetail(row.dataset.orderId), 100);
    }));
  });
}

function renderTimeline(rows){
  const card = document.getElementById('traceTimelineCard');
  const list = document.getElementById('traceTimelineList');
  if(!rows.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';

  list.innerHTML = rows.map(e => {
    const ts = e.created_at
      ? new Date(e.created_at).toLocaleString('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'})
      : '—';
    const colors = {
      // Typographic marks only — no emoji. These render identically on the
      // warehouse tablet, in a client's browser, and in a printed/PDF report;
      // colour emoji do not, and they read as toys on a client-facing audit trail.
      // Stock IN is ↓, stock OUT is ↑ — direction is the fastest thing to scan.
      'receipt':    {icon:'↓',  bg:'var(--blue-bg)',  fg:'var(--blue)'},
      'case_break': {icon:'⊞',  bg:'var(--purple-bg)',fg:'var(--purple)'},
      'pick':       {icon:'✓',  bg:'var(--amber-bg)', fg:'var(--amber)'},
      'ship':       {icon:'↑',  bg:'var(--green-bg)', fg:'var(--green)'},
      'adjustment': {icon:'±',  bg:'var(--red-bg)',   fg:'var(--red)'},
    };
    const c = colors[e.transaction_type] || {icon:'•', bg:'rgba(255,255,255,.06)', fg:'var(--text2)'};
    const lpBadge = e.lp_number
      ? `<span class="lp-badge ${e.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(e.lp_number)}</span>`
      : '';
    const flow = (e.from_location_code || e.to_location_code)
      ? `<span style="color:var(--muted);font-size:11px;">${esc(e.from_location_code || '?')} → ${esc(e.to_location_code || '?')}</span>`
      : '';
    return `
      <div style="display:flex;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);align-items:flex-start;">
        <div style="width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;background:${c.bg};color:${c.fg};flex-shrink:0;">${c.icon}</div>
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:10px;font-size:13px;flex-wrap:wrap;">
            <span style="font-weight:600;color:${c.fg};">${esc(e.transaction_type)}</span>
            ${lpBadge}
            <span>${esc(e.sku_code || '')}</span>
            ${e.lot_number ? `<span style="color:var(--blue);">Lot ${esc(e.lot_number)}</span>` : ''}
            <span style="font-weight:600;">${esc(Number(e.quantity || 0))}</span>
            ${flow}
            <span style="margin-left:auto;color:var(--text2);font-size:12px;">${esc(ts)}</span>
          </div>
          ${e.notes ? `<div style="font-size:12px;color:var(--text2);margin-top:4px;">${esc(e.notes)}</div>` : ''}
          ${e.user_name ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">by ${esc(e.user_name)}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// CSV export of allocations slice (the "where it went" rows)
function exportRecallCsv(){
  if(!_traceData || !_traceData.allocations?.length) return;
  const cols = [
    ['lp_number',      'LP'],
    ['order_number',   'Order #'],
    ['client_code',    'Client Code'],
    ['client_name',    'Client'],
    ['customer_name',  'Customer'],
    ['customer_email', 'Email'],
    ['ship_to_line1',  'Address 1'],
    ['ship_to_line2',  'Address 2'],
    ['ship_to_city',   'City'],
    ['ship_to_state',  'State'],
    ['ship_to_postal', 'Postal'],
    ['ship_to_country','Country'],
    ['sku_code',       'SKU'],
    ['lot_number',     'Lot'],
    ['picked_qty',     'Qty'],
    ['shipment_shipped_at','Shipped At'],
    ['shipment_number','Shipment #'],
    ['tracking_number','Tracking #'],
    ['order_status',   'Order Status'],
  ];
  const escCsv = v => {
    if(v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.map(c => escCsv(c[1])).join(',');
  const lines = _traceData.allocations.map(r => cols.map(c => escCsv(r[c[0]])).join(','));
  const csv = [header, ...lines].join('\n');

  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  const tag = (_traceContext?.lotNumber || _traceContext?.skuCode || 'trace').replace(/[^A-Za-z0-9_-]/g, '_');
  a.href = url;
  a.download = `trace_${tag}_${stamp}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
