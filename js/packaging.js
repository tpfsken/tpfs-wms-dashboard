'use strict';
// =============================================================================
// PACKAGING — Settings → Packaging: the box catalog (API /packaging/boxes).
// -----------------------------------------------------------------------------
//   A table of the standard boxes on the pack bench: name, L×W×H (in), tare (lb),
//   the auto-generated BOX-xxxx barcode, active. "Print box sheet" opens the
//   API's PDF of every active box as a scannable barcode for the bench.
//   Pack & Ship (js/ship.js) scans these barcodes after the units go in.
// =============================================================================

let _pkgBoxes = [];            // last loaded catalog (all boxes, active first)
let _pkgShowInactive = false;

async function pkgLoadBoxes(all){
  const d = await apiGet(`/packaging/boxes${all ? '?all=1' : ''}`);
  return d?.rows || [];
}

function pkgDims(b){ return `${esc(b.lengthIn)} × ${esc(b.widthIn)} × ${esc(b.heightIn)}`; }

async function pkgMount(){
  const host = document.getElementById('pkgBoxesBody');
  if(!host) return;
  host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint">Standard boxes for label-at-pack clients. The packer scans the box after the units; its dims and tare fill the package, the gross weight is entered, and Close buys the label. Print the sheet and hang it at the bench.</div>
      <div class="sp-toolbar-actions">
        <label class="ui-check pkg-inactive"><input type="checkbox" class="js-pkg-inactive" ${_pkgShowInactive ? 'checked' : ''}> Show inactive</label>
        <button type="button" class="ui-btn js-pkg-sheet">Print box sheet</button>
        <button type="button" class="ui-btn ui-btn-primary js-pkg-add">+ Add box</button>
      </div>
    </div>
    <div id="pkgBoxesTable"></div>`;
  host.querySelector('.js-pkg-add').addEventListener('click', uiBusyHandler(() => pkgEditBox(null)));
  host.querySelector('.js-pkg-sheet').addEventListener('click', uiBusyHandler(pkgPrintSheet));
  host.querySelector('.js-pkg-inactive').addEventListener('change', (e) => { _pkgShowInactive = e.target.checked; pkgRenderTable(); });
  await pkgRenderTable();
}

async function pkgRenderTable(){
  const el = document.getElementById('pkgBoxesTable');
  if(!el) return;
  try { _pkgBoxes = await pkgLoadBoxes(true); }
  catch(_) { uiTableError(el, [], 'Could not load boxes', pkgRenderTable); return; }
  const rows = _pkgBoxes.filter(b => _pkgShowInactive || b.active);
  uiTable(el, {
    columns: [
      { key: 'name', label: 'Box' },
      { key: '_dims', label: 'L × W × H (in)', render: b => pkgDims(b) },
      { key: 'tareLbs', label: 'Tare (lb)', num: true, render: b => esc(b.tareLbs ?? 0) },
      { key: 'barcode', label: 'Barcode', mono: true },
      { key: 'active', label: 'Status', render: b => uiChip(b.active ? 'ACTIVE' : 'INACTIVE', b.active ? 'ACTIVE' : 'INACTIVE') },
      { key: '_act', label: '', render: b => `<button type="button" class="ui-btn js-pkg-edit" data-id="${esc(b.id)}">Edit</button>` },
    ],
    rows,
    empty: 'No boxes yet — add the standard boxes on the bench.',
  });
  el.querySelectorAll('.js-pkg-edit').forEach(btn => btn.addEventListener('click', uiBusyHandler((e) => { e.stopPropagation(); return pkgEditBox(_pkgBoxes.find(b => b.id === btn.dataset.id) || null); })));
}

function pkgEditBox(box){
  const isNew = !box;
  uiModal({
    title: isNew ? 'Add box' : `Edit ${box.name}`,
    body: `${uiField({ id: 'pkgName', label: 'Name', value: box?.name || '', placeholder: 'Small mailer 8×6×4' })}
           <div class="ui-field-row sp-row-3">
             ${uiField({ id: 'pkgL', label: 'Length (in)', type: 'number', value: box?.lengthIn ?? '' })}
             ${uiField({ id: 'pkgW', label: 'Width (in)', type: 'number', value: box?.widthIn ?? '' })}
             ${uiField({ id: 'pkgH', label: 'Height (in)', type: 'number', value: box?.heightIn ?? '' })}
           </div>
           ${uiField({ id: 'pkgTare', label: 'Tare weight (lb)', type: 'number', value: box?.tareLbs ?? '', hint: 'The empty box with packing. Subtracted from nothing — the label is rated on the gross weight — but shown to the packer.' })}
           ${isNew ? '<div class="ui-hint">The barcode is generated when the box is saved (BOX-xxxx).</div>'
                   : `<div class="ui-field"><label class="ui-label">Barcode</label><div class="ui-mono">${esc(box.barcode)}</div></div>
                      <label class="ui-check"><input type="checkbox" id="pkgActive" ${box.active ? 'checked' : ''}> Active (on the sheet and scannable at the bench)</label>`}`,
    actions: [{ label: 'Cancel' }, { label: isNew ? 'Add box' : 'Save', primary: true, onClick: async (api) => {
      const v = (id) => api.el.querySelector('#' + id).value;
      let bad = false;
      if(!v('pkgName').trim()){ uiFieldError(api.el, 'pkgName', 'Name is required'); bad = true; }
      for(const [id, label] of [['pkgL', 'Length'], ['pkgW', 'Width'], ['pkgH', 'Height']]) if(!(Number(v(id)) > 0)){ uiFieldError(api.el, id, `${label} must be more than 0`); bad = true; }
      if(v('pkgTare') !== '' && Number(v('pkgTare')) < 0){ uiFieldError(api.el, 'pkgTare', 'Tare cannot be negative'); bad = true; }
      if(bad) return false;
      const body = { name: v('pkgName').trim(), lengthIn: Number(v('pkgL')), widthIn: Number(v('pkgW')), heightIn: Number(v('pkgH')), tareLbs: v('pkgTare') === '' ? 0 : Number(v('pkgTare')) };
      if(!isNew) body.active = api.el.querySelector('#pkgActive').checked;
      const r = await fetch(`${API}/packaging/boxes${isNew ? '' : '/' + box.id}`, { method: isNew ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok){ uiToast(d.error || 'Could not save the box', 'error'); return false; }
      uiToast(isNew ? `${d.name} added — barcode ${d.barcode}` : `${d.name} saved`, 'success');
      await pkgRenderTable();
    } }],
  });
}

async function pkgPrintSheet(){
  const r = await fetch(`${API}/packaging/boxes/sheet.pdf`, { headers: { Authorization: `Bearer ${T}` } });
  if(!r.ok){ const d = await r.json().catch(() => ({})); uiToast(d.error || 'Could not build the box sheet', 'error'); return; }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if(!w) uiToast('Pop-up blocked — allow pop-ups to print the box sheet', 'error');
  else uiToast('Box sheet opened — print it for the bench', 'success');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
