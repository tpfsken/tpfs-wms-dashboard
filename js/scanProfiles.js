'use strict';
// =============================================================================
// SCAN PROFILE BUILDER — client "Scanning" tab + Settings "Scan templates".
// -----------------------------------------------------------------------------
// One editor, one live tester, two hosts:
//   spMountClientTab()   — #cliScanBody, profiles of _currentClient
//   spMountTemplates()   — #spTemplatesBody, tenant templates (ops)
//
// The tester posts the UNSAVED editor state to POST /scan/test on every scan
// or paste and renders the trace step by step. Saving before a good test is a
// soft warning (uiConfirm), never a hard block.
// =============================================================================

const SP_RESOLVE_AS = ['sku', 'uid', 'lp', 'location', 'lot', 'carton', 'pallet'];
const SP_FIELDS     = ['sku', 'uid', 'lot', 'sublot', 'carton', 'pallet', 'qty', 'timestamp', 'expiry', 'ignore'];
const SP_WORKFLOWS  = ['receive', 'putaway', 'pick', 'pack', 'ship', 'count'];
const SP_DECODE_OPTIONS = [
  { value: '',            label: 'None — the scan is plain text' },
  { value: 'base64',      label: 'Base64 → text' },
  { value: 'gs1',         label: 'GS1 application identifiers (01 10 17 21 30 37…)' },
  { value: 'base64,gs1',  label: 'Base64 → text → GS1' },
];

// One host state per mount point.
const _sp = { client: null, templates: null };

// -----------------------------------------------------------------------------
// Hosts
// -----------------------------------------------------------------------------
async function spMountClientTab(){
  if(!_currentClient) return;
  const host = document.getElementById('cliScanBody');
  const st = _sp.client = { host, mode: 'client', clientId: _currentClient.id, rows: [], editing: null, goodTest: false, tester: null };
  await spRefreshList(st);
}

async function spMountTemplates(){
  const host = document.getElementById('spTemplatesBody');
  if(!host) return;
  const st = _sp.templates = { host, mode: 'template', clientId: null, rows: [], editing: null, goodTest: false, tester: null };
  await spRefreshList(st);
}

async function spRefreshList(st){
  const d = st.mode === 'client'
    ? await apiGet(`/clients/${st.clientId}/barcode-profiles`)
    : await apiGet('/scan/templates?all=true');
  st.rows = d?.rows || [];
  spRenderHost(st);
}

// -----------------------------------------------------------------------------
// Host render: list + editor + tester
// -----------------------------------------------------------------------------
function spRenderHost(st){
  const isClient = st.mode === 'client';
  st.host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint">${isClient
        ? 'Profiles are tried top-down by priority, then the tenant-wide ones, then exact LP / location / SKU / order lookups.'
        : 'Templates never resolve a scan. Clients get a copy when a template is assigned; editing a template afterwards leaves those copies alone.'}</div>
      <div class="sp-toolbar-actions">
        ${isClient ? '<button type="button" class="ui-btn js-sp-from-template">Add from template</button>' : ''}
        <button type="button" class="ui-btn ui-btn-primary js-sp-new">${isClient ? 'New profile' : 'New template'}</button>
      </div>
    </div>
    <div class="sp-list"></div>
    <div class="sp-editor-wrap" hidden></div>`;

  uiTable(st.host.querySelector('.sp-list'), {
    columns: [
      { key: 'name',       label: 'Name' },
      { key: 'resolve_as', label: 'Resolves as', render: r => uiId(r.resolve_as) },
      { key: '_wf',        label: 'Workflows', render: r => esc((r.workflow_scope || []).join(', ')) },
      { key: '_decode',    label: 'Decode', render: r => esc((r.decode_steps || []).join(' → ') || '—') },
      { key: 'priority',   label: 'Priority', num: true },
      { key: '_active',    label: 'Active', render: r =>
          `<label class="ui-check"><input type="checkbox" class="js-sp-active" data-id="${esc(r.id)}" ${r.active ? 'checked' : ''}> ${r.active ? uiChip('ACTIVE') : uiChip('INACTIVE', 'INACTIVE')}</label>` },
      ...(isClient ? [{ key: '_from', label: 'From', render: r => r.template_id ? '<span class="ui-chip ui-chip-info">TEMPLATE</span>' : '<span class="ui-muted">—</span>' }] : []),
    ],
    rows: st.rows, rowKey: 'id',
    empty: isClient ? 'No scan profiles yet — add one from a template.' : 'No templates.',
    onRowClick: (r) => spOpenEditor(st, r),
  });

  st.host.querySelectorAll('.js-sp-active').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => spToggleActive(st, cb.dataset.id, cb.checked));
  });
  st.host.querySelector('.js-sp-new').addEventListener('click', () => spOpenEditor(st, null));
  const ft = st.host.querySelector('.js-sp-from-template');
  if(ft) ft.addEventListener('click', uiBusyHandler(() => spFromTemplate(st)));

  if(st.editing) spOpenEditor(st, st.editing);
}

async function spToggleActive(st, id, active){
  const row = st.rows.find(r => r.id === id);
  if(!row) return;
  const ok = await spSave(st, { ...row, active }, id, { quiet: true });
  if(ok) uiToast(`${row.name}: ${active ? 'active' : 'inactive'}`, 'success');
  else await spRefreshList(st);
}

// -----------------------------------------------------------------------------
// Add from template (client only)
// -----------------------------------------------------------------------------
async function spFromTemplate(st){
  const d = await apiGet('/scan/templates');
  const templates = d?.rows || [];
  if(!templates.length){ uiToast('No templates defined — add them under Settings › Scan templates', 'error'); return; }
  const m = uiModal({
    title: 'Add profile from template',
    body: `
      ${uiFieldSelect({ id: 'spTplPick', label: 'Template', options: templates.map(t => ({ value: t.id, label: `${t.name} — ${t.resolve_as}` })) })}
      ${uiField({ id: 'spTplName', label: 'Profile name', placeholder: 'Leave blank to keep the template name', hint: 'The client gets its own copy. Later edits to the template do not touch it.' })}`,
    actions: [
      { label: 'Cancel' },
      { label: 'Add', primary: true, onClick: async (api) => {
          const templateId = api.el.querySelector('#spTplPick').value;
          const name = api.el.querySelector('#spTplName').value.trim();
          const r = await fetch(`${API}/clients/${st.clientId}/barcode-profiles/from-template`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
            body: JSON.stringify({ templateId, overrides: name ? { name } : {} }),
          });
          const body = await r.json();
          if(!r.ok){ uiToast(body.error || 'Could not add profile', 'error'); return false; }
          uiToast(`Added "${body.name}"`, 'success');
          await spRefreshList(st);
          spOpenEditor(st, body);
        } },
    ],
  });
  return m;
}

// -----------------------------------------------------------------------------
// Editor
// -----------------------------------------------------------------------------
function spBlank(){
  return { name: '', priority: 100, active: true, workflow_scope: ['all'], match_rule: {}, decode_steps: [],
           delimiter: '', strip_prefix: '', strip_suffix: '', field_map: {}, resolve_as: 'sku' };
}

function spOpenEditor(st, row){
  st.editing = row;
  st.goodTest = false;
  const p = row ? row : spBlank();
  const wrap = st.host.querySelector('.sp-editor-wrap');
  wrap.hidden = false;
  const mr = p.match_rule || {};
  const scope = p.workflow_scope || ['all'];
  const isClient = st.mode === 'client';

  wrap.innerHTML = `
    <div class="ui-group sp-editor">
      <div class="sp-editor-head">
        <div class="ui-dialog-title">${row ? `Edit: ${esc(p.name)}` : (isClient ? 'New profile' : 'New template')}</div>
        <div class="sp-toolbar-actions">
          ${row ? '<button type="button" class="ui-btn ui-btn-danger js-sp-delete">Delete</button>' : ''}
          <button type="button" class="ui-btn js-sp-cancel">Close</button>
          <button type="button" class="ui-btn ui-btn-primary js-sp-save">Save</button>
        </div>
      </div>
      <div class="ui-group-body">
        <div class="ui-field-row">
          ${uiField({ id: 'spName', label: 'Name', value: p.name })}
          ${uiField({ id: 'spPriority', label: 'Priority (lower runs first)', value: p.priority ?? 100, type: 'number' })}
        </div>
        <div class="ui-field-row">
          ${uiFieldSelect({ id: 'spResolveAs', label: 'Resolves as', options: SP_RESOLVE_AS.map(v => ({ value: v, label: v })), value: p.resolve_as })}
          ${uiFieldSelect({ id: 'spDecode', label: 'Decode', options: SP_DECODE_OPTIONS, value: (p.decode_steps || []).join(',') })}
        </div>
        <div class="ui-field">
          <label class="ui-label">Workflows</label>
          <div class="sp-scope">
            <label class="ui-check"><input type="checkbox" class="js-sp-scope" value="all" ${scope.includes('all') ? 'checked' : ''}> all</label>
            ${SP_WORKFLOWS.map(w => `<label class="ui-check"><input type="checkbox" class="js-sp-scope" value="${w}" ${scope.includes(w) ? 'checked' : ''}> ${w}</label>`).join('')}
          </div>
        </div>
        <div class="ui-field-row">
          ${uiField({ id: 'spRegex', label: 'Match: regex', value: mr.regex ?? '', placeholder: '^[A-Za-z0-9+/]+={0,2}$', hint: 'Every rule present must hold before the profile is tried.' })}
          ${uiField({ id: 'spPrefix', label: 'Match: prefix', value: mr.prefix ?? '', placeholder: 'CLIENT-' })}
        </div>
        <div class="ui-field-row sp-row-3">
          ${uiField({ id: 'spLen', label: 'Match: exact length', value: mr.length ?? '', type: 'number' })}
          ${uiField({ id: 'spMinLen', label: 'Min length', value: mr.minLength ?? '', type: 'number' })}
          ${uiField({ id: 'spMaxLen', label: 'Max length', value: mr.maxLength ?? '', type: 'number' })}
        </div>
        <div class="ui-field-row sp-row-3">
          ${uiField({ id: 'spStripPrefix', label: 'Strip prefix', value: p.strip_prefix ?? '' })}
          ${uiField({ id: 'spStripSuffix', label: 'Strip suffix', value: p.strip_suffix ?? '' })}
          ${uiField({ id: 'spDelimiter', label: 'Delimiter', value: p.delimiter ?? '', placeholder: '@  |  ,', hint: 'Blank = the whole payload is one field.' })}
        </div>
        <div class="ui-field">
          <label class="ui-label">Field map <span class="ui-muted">position (or GS1 AI) → field</span></label>
          <div class="sp-map"></div>
          <button type="button" class="ui-btn js-sp-map-add">+ Add field</button>
        </div>
        <label class="ui-check"><input type="checkbox" id="spActive" ${p.active !== false ? 'checked' : ''}> Active</label>
      </div>
    </div>

    <div class="ui-group sp-tester">
      <div class="sp-editor-head">
        <div class="ui-dialog-title">Live tester</div>
        <label class="ui-check"><input type="checkbox" id="spSound" ${scanSoundEnabled() ? 'checked' : ''}> Beep on scan</label>
      </div>
      <div class="ui-group-body">
        <div class="ui-hint">Scan, paste, or type a label and press Enter. The unsaved profile above is used as-is.</div>
        ${isClient ? '' : `<div class="ui-field"><label class="ui-label">Resolve against client</label><div class="cb-wrap" id="spTesterClientWrap"></div></div>`}
        <div id="spTesterInput"></div>
        <div class="sp-trace" id="spTrace">${uiEmpty('No scans yet.')}</div>
      </div>
    </div>`;

  // Field map rows
  const mapEl = wrap.querySelector('.sp-map');
  const addMapRow = (k = '', f = 'sku') => {
    const r = document.createElement('div');
    r.className = 'sp-map-row';
    r.innerHTML = `<input class="ui-input sp-map-key" value="${esc(k)}" placeholder="0">
      <span class="ui-muted">→</span>
      <select class="ui-input sp-map-field">${SP_FIELDS.map(x => `<option value="${x}" ${x === f ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <button type="button" class="ui-btn js-sp-map-del" aria-label="Remove">✕</button>`;
    r.querySelector('.js-sp-map-del').addEventListener('click', () => r.remove());
    mapEl.appendChild(r);
  };
  Object.entries(p.field_map || {}).forEach(([k, f]) => addMapRow(k, f));
  wrap.querySelector('.js-sp-map-add').addEventListener('click', () => addMapRow());

  // "all" excludes the rest
  wrap.querySelectorAll('.js-sp-scope').forEach(cb => cb.addEventListener('change', () => {
    const all = wrap.querySelector('.js-sp-scope[value="all"]');
    if(cb.value === 'all' && cb.checked) wrap.querySelectorAll('.js-sp-scope').forEach(x => { if(x !== all) x.checked = false; });
    else if(cb.checked) all.checked = false;
  }));

  wrap.querySelector('#spSound').addEventListener('change', (e) => scanSoundSet(e.target.checked));
  wrap.querySelector('.js-sp-cancel').addEventListener('click', () => { st.editing = null; wrap.hidden = true; wrap.innerHTML = ''; });
  wrap.querySelector('.js-sp-save').addEventListener('click', uiBusyHandler(() => spSaveFromEditor(st, row)));
  const del = wrap.querySelector('.js-sp-delete');
  if(del) del.addEventListener('click', uiBusyHandler(() => spDelete(st, row)));

  if(!isClient){
    const clients = (typeof clientsCache !== 'undefined' && clientsCache) ? clientsCache : [];
    initCombo('spTesterClientWrap', clients.map(c => ({ value: c.id, label: `${c.code} — ${c.name}` })), { placeholder: 'Optional — needed to resolve SKUs / LPs' });
  }

  if(st.tester) st.tester.destroy();
  st.tester = scanInputMount(wrap.querySelector('#spTesterInput'), {
    placeholder: 'Scan or paste a label, then Enter',
    autofocus: false,
    onScan: (raw, meta) => spRunTest(st, raw, meta),
  });
  wrap.scrollIntoView({ block: 'nearest' });
}

/** Read the editor into a profile object (unsaved). */
function spReadEditor(st){
  const w = st.host.querySelector('.sp-editor-wrap');
  const v = (id) => w.querySelector('#' + id).value;
  const num = (id) => { const s = v(id).trim(); return s === '' ? undefined : Number(s); };
  const scope = [...w.querySelectorAll('.js-sp-scope:checked')].map(c => c.value);
  const match_rule = {};
  if(v('spRegex').trim())  match_rule.regex  = v('spRegex').trim();
  if(v('spPrefix'))        match_rule.prefix = v('spPrefix');
  if(num('spLen')    != null) match_rule.length    = num('spLen');
  if(num('spMinLen') != null) match_rule.minLength = num('spMinLen');
  if(num('spMaxLen') != null) match_rule.maxLength = num('spMaxLen');
  const field_map = {};
  w.querySelectorAll('.sp-map-row').forEach(r => {
    const k = r.querySelector('.sp-map-key').value.trim();
    if(k) field_map[k] = r.querySelector('.sp-map-field').value;
  });
  return {
    name: v('spName').trim(),
    priority: num('spPriority') ?? 100,
    active: w.querySelector('#spActive').checked,
    workflow_scope: scope.length ? scope : ['all'],
    resolve_as: v('spResolveAs'),
    decode_steps: v('spDecode') ? v('spDecode').split(',') : [],
    match_rule, field_map,
    delimiter: v('spDelimiter') || null,
    strip_prefix: v('spStripPrefix') || null,
    strip_suffix: v('spStripSuffix') || null,
  };
}

// -----------------------------------------------------------------------------
// Live tester
// -----------------------------------------------------------------------------
async function spRunTest(st, raw, meta){
  const profile = spReadEditor(st);
  if(!profile.name) profile.name = '(unsaved)';
  const clientId = st.mode === 'client' ? st.clientId : (cbVal('spTesterClientWrap') || null);
  const box = st.host.querySelector('#spTrace');
  box.innerHTML = uiSpinner('Testing…');
  st.tester.setBusy(true);
  try {
    const r = await fetch(`${API}/scan/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
      body: JSON.stringify({ raw, profile, clientId }),
    });
    const d = await r.json();
    if(!r.ok){
      box.innerHTML = `<div class="ui-banner ui-banner-danger">${esc(d.error || 'Test failed')}${Array.isArray(d.errors) ? '<ul class="sp-errors">' + d.errors.map(e => `<li>${esc(e)}</li>`).join('') + '</ul>' : ''}</div>`;
      return;
    }
    spRenderTrace(box, d, meta);
    if(d.result && d.result.ok){ st.goodTest = true; }
  } catch(e) {
    box.innerHTML = uiError('Network error');
  } finally {
    st.tester.setBusy(false);
    st.tester.focus();
  }
}

function spFmtOut(out){
  if(out == null) return '';
  if(typeof out === 'string') return out;
  if(Array.isArray(out)) return out.map((x, i) => `[${i}] ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n');
  if(out.ais) return Object.entries(out.ais).map(([k, v]) => `(${k}) ${v}`).join('\n');
  return Object.entries(out).map(([k, v]) => `${k} = ${typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)}`).join('\n');
}

function spEntityLabel(res){
  const e = res.entity || {};
  const code = e.code || e.uid || '';
  const extra = res.type === 'uid' && e.sku ? ` (${e.sku.code})` : (e.name ? ` — ${e.name}` : '');
  return `Resolves to: ${String(res.type || '').toUpperCase()} ${code}${extra}`;
}

function spRenderTrace(box, d, meta){
  const steps = d.trace || [];
  const res = d.result || {};
  const rows = steps.map(s => {
    if(s.step === 'resolve'){
      if(s.ok){
        const v = s.out && s.out.validation;
        return `<div class="sp-step sp-step-final sp-step-ok">
          <div class="sp-step-name">resolve</div>
          <div class="sp-step-out">${esc(spEntityLabel(s.out))}${v && !v.ok ? `<div class="sp-step-sub">${esc(v.message)}</div>` : ''}</div></div>`;
      }
      return `<div class="sp-step sp-step-final sp-step-bad"><div class="sp-step-name">resolve</div><div class="sp-step-out">${esc(String(s.out))}</div></div>`;
    }
    const cls = s.ok === false ? 'sp-step sp-step-bad' : 'sp-step';
    return `<div class="${cls}">
      <div class="sp-step-name">${esc(s.step)}</div>
      <pre class="sp-step-out ui-mono">${esc(spFmtOut(s.out))}</pre></div>`;
  });
  const head = `<div class="sp-trace-head"><span class="ui-muted">source</span> ${uiChip(meta && meta.source === 'wedge' ? 'ACTIVE' : 'NEW', meta ? meta.source : '—')}
                ${meta && meta.format ? `<span class="ui-muted">format</span> ${uiId(meta.format)}` : ''}
                ${res.ok ? uiChip('PICKED', 'RESOLVED') : uiChip('FAILED', 'NO MATCH')}</div>`;
  box.innerHTML = head + rows.join('');
}

// -----------------------------------------------------------------------------
// Save / delete
// -----------------------------------------------------------------------------
async function spSaveFromEditor(st, row){
  const profile = spReadEditor(st);
  const w = st.host.querySelector('.sp-editor-wrap');
  uiFieldError(w, 'spName', '');
  if(!profile.name){ uiFieldError(w, 'spName', 'Required'); return; }
  if(!st.goodTest){
    const go = await uiConfirm({ title: 'Save without a passing test?',
      message: 'The live tester has not resolved a scan with this profile yet. You can save and test later.',
      confirmLabel: 'Save anyway' });
    if(!go) return;
  }
  const ok = await spSave(st, profile, row ? row.id : null);
  if(ok){ st.editing = null; await spRefreshList(st); }
}

async function spSave(st, profile, id, { quiet = false } = {}){
  const isClient = st.mode === 'client';
  const url = isClient
    ? `${API}/clients/${st.clientId}/barcode-profiles${id ? '/' + id : ''}`
    : `${API}/scan/templates${id ? '/' + id : ''}`;
  const r = await fetch(url, {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
    body: JSON.stringify(profile),
  });
  const d = await r.json();
  if(!r.ok){
    uiToast((d.error || 'Save failed') + (Array.isArray(d.errors) ? ': ' + d.errors.join('; ') : ''), 'error');
    return false;
  }
  if(!quiet) uiToast(`Saved "${d.name}"`, 'success');
  return true;
}

async function spDelete(st, row){
  const go = await uiConfirm({ title: `Delete "${row.name}"?`, message: st.mode === 'client'
    ? 'Scans that relied on this profile will stop resolving.'
    : 'Client profiles copied from it are not affected.', confirmLabel: 'Delete', danger: true });
  if(!go) return;
  const url = st.mode === 'client' ? `${API}/clients/${st.clientId}/barcode-profiles/${row.id}` : `${API}/scan/templates/${row.id}`;
  const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Delete failed', 'error'); return; }
  uiToast(`Deleted "${row.name}"`, 'success');
  st.editing = null;
  await spRefreshList(st);
}
