// =============================================================================
// ITEM IMPORT — Clients → client → Item master → "Import items" (items.import)
//
// Five-step wizard in one modal:
//   1 Upload (CSV / XLSX)  → POST /clients/:id/item-imports/upload
//   2 Map columns          → PUT  …/:importId/mapping  (+ save / load templates)
//   3 Preview & validate   → POST …/:importId/validate (dry run, nothing written)
//   4 Commit               → POST …/:importId/commit { existing: update | skip }
//   5 Result               → counts + error-file download
// History of imports renders under the button (GET /clients/:id/item-imports).
// The API decides every row; this file only shows what it says.
// =============================================================================

'use strict';

let _ii = null;   // wizard state: { m, clientId, step, importId, fileName, headers, preview, fields, required, hints, mapping, templates, mode, validation, result }

const II_STEPS = ['Upload', 'Map columns', 'Preview & validate', 'Commit', 'Result'];
const II_ACTION_TONE = { create: 'ok', update: 'info', skip: 'neutral', error: 'danger', created: 'ok', updated: 'info', skipped: 'neutral' };

function _iiAuthFetch(path, opts = {}){
  return fetch(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${T}`, ...(opts.headers || {}) } });
}
async function _iiJson(path, opts){
  const r = await _iiAuthFetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if(!r.ok){
    if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Request failed', 'error');
    return null;
  }
  return d;
}
/** Download an authenticated file (template / error file) without leaking the token into a URL. */
async function _iiDownload(path, fallbackName){
  const r = await _iiAuthFetch(path);
  if(!r.ok){ const d = await r.json().catch(() => ({})); if(d.code === 'PERMISSION_DENIED') permDeniedToast(d); else uiToast(d.error || 'Download failed', 'error'); return false; }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}
function downloadItemImportTemplate(){ return _iiDownload('/item-imports/template.xlsx', 'item-import-template.xlsx'); }

// ---- wizard shell --------------------------------------------------------------------------

async function openItemImportWizard(){
  const c = typeof _currentClient !== 'undefined' ? _currentClient : null;
  if(!c) return uiToast('Open a client first', 'error');
  _ii = { clientId: c.id, clientCode: c.code, step: 1, mode: 'update', mapping: {}, templates: [] };
  _ii.m = uiModal({
    title: `Import items — ${c.code}`,
    width: 960,
    body: `<div class="ii-steps" id="iiSteps"></div><div id="iiWarn"></div><div id="iiBody"></div>`,
    actions: [{ label: 'Close' }],
    onClose: () => { _ii = null; if(typeof loadItemImportHistory === 'function') loadItemImportHistory(); },
  });
  _iiRender();
}

function _iiRender(){
  if(!_ii) return;
  const steps = document.getElementById('iiSteps');
  if(steps) steps.innerHTML = II_STEPS.map((s, i) => `<div class="ii-step${i + 1 === _ii.step ? ' active' : ''}${i + 1 < _ii.step ? ' done' : ''}"><span class="ii-step-n">${i + 1}</span>${esc(s)}</div>`).join('');
  const warn = document.getElementById('iiWarn');
  if(warn){
    const w = _ii.clientWarning;
    warn.innerHTML = (w && _ii.step > 1)
      ? `<div class="ui-banner ui-banner-warn ii-client-warn"><strong>Check the client.</strong> This file mentions <strong>${esc(w.other.code)} — ${esc(w.other.name)}</strong> (${esc(w.where)}: "${esc(String(w.value).slice(0, 60))}"). You are importing into <strong>${esc(w.current.code)} — ${esc(w.current.name)}</strong>. Continue only if that is intended.</div>`
      : '';
  }
  const body = document.getElementById('iiBody');
  if(!body) return;
  ({ 1: _iiStepUpload, 2: _iiStepMap, 3: _iiStepValidate, 4: _iiStepCommit, 5: _iiStepResult })[_ii.step](body);
}

/** Resume an uncommitted import at its furthest completed step (history → Resume). */
async function resumeItemImport(importId){
  const c = typeof _currentClient !== 'undefined' ? _currentClient : null;
  if(!c) return;
  const d = await apiGet(`/clients/${c.id}/item-imports/${importId}`);
  if(!d) return uiToast('Could not load that import', 'error');
  if(d.status === 'committed') return openItemImportResult(importId, d);
  _ii = { clientId: c.id, clientCode: c.code, importId: d.id, fileName: d.fileName, headers: d.headers, preview: d.preview || [], rowCount: d.rowCount,
          fields: d.fields || [], required: d.required || [], hints: d.hints || {}, mapping: { ...(d.mapping || {}) }, templateId: d.templateId || null,
          mode: d.mode || 'update', clientWarning: d.clientWarning || null, templates: [], step: d.resumeStep || 2,
          validation: d.status === 'validated' && Array.isArray(d.validation) ? { id: d.id, mode: d.mode, counts: d.counts, rows: d.validation } : null };
  _ii.templates = ((await apiGet(`/clients/${c.id}/item-imports/templates`)) || {}).rows || [];
  _ii.m = uiModal({
    title: `Import items — ${c.code} · resumed ${d.fileName}`,
    width: 960,
    body: `<div class="ii-steps" id="iiSteps"></div><div id="iiWarn"></div><div id="iiBody"></div>`,
    actions: [{ label: 'Close' }],
    onClose: () => { _ii = null; if(typeof loadItemImportHistory === 'function') loadItemImportHistory(); },
  });
  _iiRender();
  if(_ii.step === 3 && !_ii.validation) _iiValidate();   // mapped but never validated: run the dry run now
}

/** Committed import: counts, failed rows, error file (history → View result). */
async function openItemImportResult(importId, detail){
  const c = typeof _currentClient !== 'undefined' ? _currentClient : null;
  if(!c) return;
  const d = detail || await apiGet(`/clients/${c.id}/item-imports/${importId}`);
  if(!d) return uiToast('Could not load that import', 'error');
  const counts = d.counts || {};
  const rows = Array.isArray(d.validation) ? d.validation : [];
  _ii = { clientId: c.id, clientCode: c.code, importId, fileName: d.fileName, step: 5, mode: d.mode, result: { counts: { created: counts.created || 0, updated: counts.updated || 0, skipped: counts.skipped || 0, errors: counts.errors || 0 }, rows, errorFile: d.errorFile || null } };
  _ii.m = uiModal({
    title: `Import result — ${c.code} · ${d.fileName}`,
    width: 800,
    body: `<div class="ii-steps" id="iiSteps"></div><div id="iiWarn"></div><div id="iiBody"></div>`,
    actions: [{ label: 'Close' }],
    onClose: () => { _ii = null; },
  });
  _iiRender();
}

async function deleteItemImport(importId, fileName){
  const c = typeof _currentClient !== 'undefined' ? _currentClient : null;
  if(!c) return false;
  const ok = await uiConfirm({ title: `Delete the import of ${fileName || 'this file'}?`, body: 'The uploaded rows and any mapping or validation are removed. Nothing was written to the item master by this import.', confirmLabel: 'Delete import', danger: true });
  if(!ok) return false;
  const d = await _iiJson(`/clients/${c.id}/item-imports/${importId}`, { method: 'DELETE' });
  if(!d) return false;
  uiToast('Import deleted');
  loadItemImportHistory();
}

// ---- 1 Upload -------------------------------------------------------------------------------

function _iiStepUpload(body){
  body.innerHTML = `
    <div class="ii-upload">
      <p>Upload the client's item list as <strong>CSV</strong> or <strong>Excel (.xlsx)</strong>, up to 10 MB and 5,000 rows. The first row must hold the column titles; you map them to item fields in the next step, so the file does not need to match our template.</p>
      <div class="usr-actions">
        <label class="ui-btn ui-btn-primary ii-file-label">Choose file… <input type="file" id="iiFile" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>
        <button type="button" class="ui-btn js-ii-template">Download template</button>
        <span class="ui-hint" id="iiFileName"></span>
      </div>
      <div class="ui-hint" style="margin-top:12px;">Existing items are matched by SKU code within this client. Blank cells on an existing item leave the field unchanged. Nothing is written until step 4.</div>
      <div id="iiUploadErr" class="ui-field-err" style="display:none;"></div>
    </div>`;
  body.querySelector('.js-ii-template').addEventListener('click', uiBusyHandler(() => downloadItemImportTemplate()));
  body.querySelector('#iiFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if(f) _iiUpload(f); });
}

async function _iiUpload(file){
  const errEl = document.getElementById('iiUploadErr'); const nameEl = document.getElementById('iiFileName');
  if(nameEl) nameEl.textContent = `Uploading ${file.name}…`;
  if(errEl) errEl.style.display = 'none';
  const fd = new FormData(); fd.append('file', file, file.name);
  const r = await _iiAuthFetch(`/clients/${_ii.clientId}/item-imports/upload`, { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){
    if(nameEl) nameEl.textContent = '';
    if(d.code === 'PERMISSION_DENIED') return permDeniedToast(d);
    if(errEl){ errEl.textContent = d.error || 'Upload failed'; errEl.style.display = 'block'; }
    return;
  }
  Object.assign(_ii, { importId: d.id, fileName: d.fileName, headers: d.headers, preview: d.preview || [], rowCount: d.rowCount, fields: d.fields || [], required: d.required || [], hints: d.hints || {}, mapping: { ...(d.suggested || {}) }, clientWarning: d.clientWarning || null, step: 2 });
  _ii.templates = ((await _iiJson(`/clients/${_ii.clientId}/item-imports/templates`)) || {}).rows || [];
  _iiRender();
}

// ---- 2 Map columns --------------------------------------------------------------------------

function _iiFieldOptions(selected){
  const groups = [];
  for(const f of _ii.fields){ let g = groups.find(x => x.name === f.group); if(!g){ g = { name: f.group, rows: [] }; groups.push(g); } g.rows.push(f); }
  const used = new Set(Object.values(_ii.mapping));
  return `<option value="">— not imported —</option>` + groups.map(g => `<optgroup label="${esc(g.name)}">${g.rows.map(f =>
    `<option value="${esc(f.key)}"${f.key === selected ? ' selected' : ''}${used.has(f.key) && f.key !== selected ? ' disabled' : ''}>${esc(f.label)}${f.required ? ' *' : ''}</option>`).join('')}</optgroup>`).join('');
}

function _iiStepMap(body){
  const mapped = new Set(Object.values(_ii.mapping));
  const missing = _ii.required.filter(k => !mapped.has(k));
  const fieldLabel = (k) => (_ii.fields.find(f => f.key === k) || {}).label || k;
  body.innerHTML = `
    <div class="roles-toolbar">
      <span class="ui-hint"><strong>${esc(_ii.fileName)}</strong> · ${esc(_ii.rowCount)} row${_ii.rowCount === 1 ? '' : 's'} · ${esc(_ii.headers.length)} columns. Pick the item field for each column; columns left as "not imported" are ignored.</span>
      <span style="flex:1"></span>
      <label class="ui-label" for="iiTemplate">Load template</label>
      <select class="ui-input ii-select" id="iiTemplate"><option value="">— choose —</option>${_ii.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.shared ? ' (shared)' : ''}</option>`).join('')}</select>
    </div>
    <div id="iiMissing" class="ui-banner ${missing.length ? 'ui-banner-warn' : 'ui-banner-info'}">${missing.length ? `Required: ${missing.map(fieldLabel).map(esc).join(', ')} — map ${missing.length === 1 ? 'it' : 'them'} to continue.` : 'Both required fields are mapped.'}</div>
    <div class="roles-grid-wrap" style="max-height:48vh;">
      <table class="ui-table ii-map-table">
        <thead><tr><th>Column in file</th><th>Sample values</th><th>Import as</th><th></th></tr></thead>
        <tbody>${_ii.headers.map((h, i) => {
          const sample = _ii.preview.slice(0, 3).map(r => r[i]).filter(v => v !== '' && v != null).slice(0, 3);
          const hint = _ii.hints[h];
          const req = _ii.required.includes(_ii.mapping[h]);
          return `<tr data-header="${esc(h)}" class="${req ? 'ii-required' : ''}">
            <td><strong>${esc(h)}</strong></td>
            <td class="ui-mono ui-hint">${sample.map(v => esc(String(v).slice(0, 24))).join(' · ') || '<span class="ui-muted">empty</span>'}</td>
            <td><select class="ui-input ii-select js-ii-map" data-header="${esc(h)}">${_iiFieldOptions(_ii.mapping[h] || '')}</select></td>
            <td class="ui-hint">${hint && hint.why ? esc(hint.confidence === 'sample' ? `guessed from values: ${hint.why}` : hint.confidence === 'header' ? 'matched the title' : hint.why) : ''}</td>
          </tr>`; }).join('')}
        </tbody>
      </table>
    </div>
    <div class="ii-map-foot">
      <label class="ui-check"><input type="checkbox" id="iiSaveTpl"> Save as template</label>
      <input class="ui-input ii-tpl-name" id="iiTplName" placeholder="Template name, e.g. Acme onboarding" hidden>
      <label class="ui-check" id="iiTplSharedWrap" hidden><input type="checkbox" id="iiTplShared"> Share with every client</label>
      <span style="flex:1"></span>
      <button type="button" class="ui-btn js-ii-back">Back</button>
      <button type="button" class="ui-btn ui-btn-primary js-ii-next" ${missing.length ? 'disabled' : ''}>Validate</button>
    </div>`;
  body.querySelectorAll('.js-ii-map').forEach(sel => sel.addEventListener('change', () => {
    if(sel.value) _ii.mapping[sel.dataset.header] = sel.value; else delete _ii.mapping[sel.dataset.header];
    _iiRender();
  }));
  body.querySelector('#iiTemplate').addEventListener('change', (e) => {
    const t = _ii.templates.find(x => x.id === e.target.value);
    if(!t) return;
    // apply only to columns this file has
    _ii.mapping = {}; for(const [h, k] of Object.entries(t.mapping || {})) if(_ii.headers.includes(h)) _ii.mapping[h] = k;
    _ii.templateId = t.id;
    uiToast(`Template "${t.name}" applied to ${Object.keys(_ii.mapping).length} column${Object.keys(_ii.mapping).length === 1 ? '' : 's'}`);
    _iiRender();
  });
  const saveCb = body.querySelector('#iiSaveTpl');
  saveCb.addEventListener('change', () => { body.querySelector('#iiTplName').hidden = !saveCb.checked; body.querySelector('#iiTplSharedWrap').hidden = !saveCb.checked; });
  body.querySelector('.js-ii-back').addEventListener('click', uiBusyHandler(() => { _ii.step = 1; _iiRender(); }));
  body.querySelector('.js-ii-next').addEventListener('click', uiBusyHandler(() => _iiSaveMapping()));
}

async function _iiSaveMapping(){
  const save = document.getElementById('iiSaveTpl')?.checked;
  const name = (document.getElementById('iiTplName')?.value || '').trim();
  if(save && !name){ uiToast('Give the template a name', 'error'); return false; }
  const bodyReq = { mapping: _ii.mapping, templateId: _ii.templateId || undefined };
  if(save) bodyReq.saveTemplate = { name, shared: !!document.getElementById('iiTplShared')?.checked };
  const d = await _iiJson(`/clients/${_ii.clientId}/item-imports/${_ii.importId}/mapping`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyReq) });
  if(!d) return false;
  if(save) uiToast(`Template "${name}" saved`);
  _ii.step = 3; _ii.validation = null;
  _iiRender();
  return _iiValidate();
}

// ---- 3 Preview & validate ---------------------------------------------------------------------

async function _iiValidate(){
  const host = document.getElementById('iiValBody');
  if(host) host.innerHTML = uiSpinner('Checking every row — nothing is written yet…');
  const d = await _iiJson(`/clients/${_ii.clientId}/item-imports/${_ii.importId}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ existing: _ii.mode }) });
  if(!d){ if(host) host.innerHTML = uiError('Validation failed'); return false; }
  _ii.validation = d;
  _iiRender();
}

function _iiCountChips(c, keys){
  return keys.map(([k, label, tone]) => `<span class="ui-chip ui-chip-${tone}${(c[k] || 0) ? '' : ' ii-chip-zero'}">${esc(c[k] || 0)} ${esc(label)}</span>`).join(' ');
}

function _iiStepValidate(body){
  const v = _ii.validation;
  body.innerHTML = `
    <div class="roles-toolbar">
      <div class="ii-mode">
        <span class="ui-label">Items that already exist:</span>
        <label class="ui-check"><input type="radio" name="iiMode" value="update" ${_ii.mode === 'update' ? 'checked' : ''}> update mapped fields</label>
        <label class="ui-check"><input type="radio" name="iiMode" value="skip" ${_ii.mode === 'skip' ? 'checked' : ''}> skip them</label>
      </div>
      <span style="flex:1"></span>
      <label class="ui-check"><input type="checkbox" id="iiErrOnly"> Show errors only</label>
    </div>
    <div id="iiValBody"></div>
    <div class="ii-map-foot">
      <button type="button" class="ui-btn js-ii-back">Back to mapping</button>
      <span style="flex:1"></span>
      <button type="button" class="ui-btn ui-btn-primary js-ii-next" ${v && (v.counts.create + v.counts.update) > 0 ? '' : 'disabled'}>Continue to commit</button>
    </div>`;
  body.querySelectorAll('input[name="iiMode"]').forEach(r => r.addEventListener('change', () => { _ii.mode = r.value; _iiValidate(); }));
  body.querySelector('#iiErrOnly').addEventListener('change', () => _iiRenderValidationTable());
  body.querySelector('.js-ii-back').addEventListener('click', uiBusyHandler(() => { _ii.step = 2; _iiRender(); }));
  body.querySelector('.js-ii-next').addEventListener('click', uiBusyHandler(() => { _ii.step = 4; _iiRender(); }));
  if(v) _iiRenderValidationTable(); else document.getElementById('iiValBody').innerHTML = uiSpinner('Checking every row — nothing is written yet…');
}

function _iiRenderValidationTable(){
  const host = document.getElementById('iiValBody'); const v = _ii.validation;
  if(!host || !v) return;
  const errOnly = !!document.getElementById('iiErrOnly')?.checked;
  const rows = errOnly ? v.rows.filter(r => r.action === 'error') : v.rows;
  host.innerHTML = `
    <div class="ii-counts">${_iiCountChips(v.counts, [['create', 'to create', 'ok'], ['update', 'to update', 'info'], ['skip', 'to skip', 'neutral'], ['error', 'with errors', 'danger']])}
      <span class="ui-hint">${v.counts.error ? 'Rows with errors are left out of the import; fix the file and upload again, or continue without them.' : 'Every row checks out.'}</span></div>
    <div class="roles-grid-wrap" style="max-height:44vh;">
      <table class="ui-table ii-val-table">
        <thead><tr><th>Row</th><th>Result</th><th>SKU code</th><th>Name</th><th>Details</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="ii-row-${esc(r.action)}">
          <td class="ui-mono">${esc(r.n)}</td>
          <td><span class="ui-chip ui-chip-${esc(II_ACTION_TONE[r.action] || 'neutral')}">${esc(r.action)}</span></td>
          <td class="ui-mono">${esc(r.values.sku_code || '')}</td>
          <td>${esc(r.values.name || '')}</td>
          <td>${r.reasons.length ? `<ul class="ii-reasons">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : `<span class="ui-hint">${esc(_iiRowSummary(r.values))}</span>`}</td>
        </tr>`).join('') || `<tr><td colspan="5">${uiEmpty(errOnly ? 'No errors.' : 'No rows.')}</td></tr>`}</tbody>
      </table>
    </div>`;
}
function _iiRowSummary(values){
  const bits = [];
  for(const k of ['upc', 'ean', 'gtin14', 'asin', 'customer_sku']) if(values[k] != null) bits.push(`${k.toUpperCase()} ${values[k]}`);
  if(values.case_sku_code) bits.push(`case ${values.case_sku_code}${values.units_per_case ? ` × ${values.units_per_case}` : ''}`);
  if(values.is_hazmat === true) bits.push(`hazmat UN${values.un_number || '?'} class ${values.hazard_class || '?'}`);
  const other = Object.keys(values).filter(k => !['sku_code', 'name', 'upc', 'ean', 'gtin14', 'asin', 'customer_sku', 'case_sku_code', 'units_per_case', 'is_hazmat', 'un_number', 'hazard_class'].includes(k));
  if(other.length) bits.push(`+ ${other.length} more field${other.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

// ---- 4 Commit ---------------------------------------------------------------------------------

function _iiStepCommit(body){
  const c = _ii.validation.counts;
  body.innerHTML = `
    <div class="ii-commit">
      <p>Ready to import into <strong>${esc(_ii.clientCode)}</strong> from <strong>${esc(_ii.fileName)}</strong>:</p>
      <div class="ii-counts">${_iiCountChips(c, [['create', 'new items', 'ok'], ['update', `existing items ${_ii.mode === 'update' ? 'updated' : 'skipped'}`, _ii.mode === 'update' ? 'info' : 'neutral'], ['skip', 'skipped', 'neutral'], ['error', 'rows left out', 'danger']])}</div>
      <div class="ii-mode" style="margin:12px 0;">
        <span class="ui-label">Existing items:</span>
        <label class="ui-check"><input type="radio" name="iiMode2" value="update" ${_ii.mode === 'update' ? 'checked' : ''}> update mapped fields (blank cells leave a field unchanged)</label>
        <label class="ui-check"><input type="radio" name="iiMode2" value="skip" ${_ii.mode === 'skip' ? 'checked' : ''}> skip them</label>
      </div>
      <div class="ui-hint">Each row is written on its own: a row that fails is listed in the error file and does not stop the others. Hazmat, HTS and country-of-origin changes on existing items are recorded in the compliance audit.</div>
    </div>
    <div class="ii-map-foot">
      <button type="button" class="ui-btn js-ii-back">Back</button>
      <span style="flex:1"></span>
      <button type="button" class="ui-btn ui-btn-primary js-ii-commit">Import ${esc(c.create + (_ii.mode === 'update' ? c.update : 0))} item${(c.create + (_ii.mode === 'update' ? c.update : 0)) === 1 ? '' : 's'}</button>
    </div>`;
  body.querySelectorAll('input[name="iiMode2"]').forEach(r => r.addEventListener('change', async () => { _ii.mode = r.value; _ii.step = 3; _iiRender(); await _iiValidate(); _ii.step = 4; _iiRender(); }));
  body.querySelector('.js-ii-back').addEventListener('click', uiBusyHandler(() => { _ii.step = 3; _iiRender(); }));
  body.querySelector('.js-ii-commit').addEventListener('click', uiBusyHandler(() => _iiCommit()));
}

async function _iiCommit(){
  const d = await _iiJson(`/clients/${_ii.clientId}/item-imports/${_ii.importId}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ existing: _ii.mode }) });
  if(!d) return false;
  _ii.result = d; _ii.step = 5;
  _iiRender();
  if(typeof fetchClientItems === 'function') fetchClientItems(document.getElementById('cliItemsSearch')?.value.trim() || '');
  if(typeof loadItemImportHistory === 'function') loadItemImportHistory();
}

// ---- 5 Result ---------------------------------------------------------------------------------

function _iiStepResult(body){
  const r = _ii.result; const c = r.counts;
  const failed = (r.rows || []).filter(x => x.action === 'error');
  body.innerHTML = `
    <div class="ii-commit">
      <div class="ui-banner ${c.errors ? 'ui-banner-warn' : 'ui-banner-info'}">Import finished: ${esc(c.created)} created, ${esc(c.updated)} updated, ${esc(c.skipped)} skipped, ${esc(c.errors)} error${c.errors === 1 ? '' : 's'}.</div>
      <div class="ii-counts">${_iiCountChips(c, [['created', 'created', 'ok'], ['updated', 'updated', 'info'], ['skipped', 'skipped', 'neutral'], ['errors', 'errors', 'danger']])}</div>
      ${failed.length ? `<div class="roles-grid-wrap" style="max-height:36vh;margin-top:12px;"><table class="ui-table ii-val-table"><thead><tr><th>Row</th><th>Why it failed</th></tr></thead>
        <tbody>${failed.map(x => `<tr><td class="ui-mono">${esc(x.n)}</td><td>${esc(x.reasons.join(' | '))}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>
    <div class="ii-map-foot">
      ${r.errorFile ? '<button type="button" class="ui-btn js-ii-errfile">Download error file (CSV)</button>' : ''}
      <span style="flex:1"></span>
      <button type="button" class="ui-btn ui-btn-primary js-ii-done">Done</button>
    </div>`;
  body.querySelector('.js-ii-errfile')?.addEventListener('click', uiBusyHandler(() => _iiDownload(r.errorFile, 'item-import-errors.csv')));
  body.querySelector('.js-ii-done').addEventListener('click', uiBusyHandler(() => { const m = _ii && _ii.m; if(m) m.close(); }));
}

// ---- history under the button -------------------------------------------------------------------

async function loadItemImportHistory(){
  const host = document.getElementById('cliImportHistory');
  const c = typeof _currentClient !== 'undefined' ? _currentClient : null;
  if(!host || !c) return;
  if(!can('items.import')){ host.innerHTML = ''; return; }
  const d = await apiGet(`/clients/${c.id}/item-imports`);
  if(!d){ host.innerHTML = ''; return; }
  if(!d.rows.length){ host.innerHTML = `<div class="ui-hint ii-history-empty">No item imports yet for ${esc(c.code)}.</div>`; return; }
  host.innerHTML = `
    <div class="ii-history-title">Import history</div>
    <table class="ui-table ii-history">
      <thead><tr><th>When</th><th>Who</th><th>File</th><th>Status</th><th>Result</th><th>Template</th><th>Actions</th></tr></thead>
      <tbody>${d.rows.map(r => {
        const cnt = r.counts || {};
        const res = r.status === 'committed' ? `${cnt.created || 0} created · ${cnt.updated || 0} updated · ${cnt.skipped || 0} skipped · ${cnt.errors || 0} errors`
                  : r.status === 'validated' ? `${cnt.create || 0} to create · ${cnt.update || 0} to update · ${cnt.error || 0} errors` : `${r.rowCount} rows`;
        return `<tr>
          <td>${uiId(fmtTimeShort(r.createdAt))}</td>
          <td>${esc(r.createdByName || '')}</td>
          <td class="ui-mono">${esc(r.fileName)}</td>
          <td>${uiChip(r.status, r.status)}</td>
          <td class="ui-hint">${esc(res)}</td>
          <td class="ui-hint">${esc(r.templateName || '')}</td>
          <td class="ii-hist-acts">${r.status === 'committed'
            ? `<button type="button" class="ui-btn js-ii-hist-view" data-id="${esc(r.id)}">View result</button>${r.hasErrorFile ? `<button type="button" class="ui-btn js-ii-hist-err" data-id="${esc(r.id)}">Error file</button>` : ''}`
            : `<button type="button" class="ui-btn ui-btn-primary js-ii-hist-resume" data-id="${esc(r.id)}">Resume</button><button type="button" class="ui-btn ui-btn-danger js-ii-hist-del" data-id="${esc(r.id)}" data-file="${esc(r.fileName)}">Delete</button>`}</td>
        </tr>`; }).join('')}</tbody>
    </table>
    <div class="ui-hint">Uncommitted imports are removed automatically after 7 days. Committed imports stay in the history.</div>`;
  host.querySelectorAll('.js-ii-hist-err').forEach(b => b.addEventListener('click', uiBusyHandler(() => _iiDownload(`/clients/${c.id}/item-imports/${b.dataset.id}/error-file.csv`, 'item-import-errors.csv'))));
  host.querySelectorAll('.js-ii-hist-view').forEach(b => b.addEventListener('click', uiBusyHandler(() => openItemImportResult(b.dataset.id))));
  host.querySelectorAll('.js-ii-hist-resume').forEach(b => b.addEventListener('click', uiBusyHandler(() => resumeItemImport(b.dataset.id))));
  host.querySelectorAll('.js-ii-hist-del').forEach(b => b.addEventListener('click', uiBusyHandler(() => deleteItemImport(b.dataset.id, b.dataset.file))));
}
