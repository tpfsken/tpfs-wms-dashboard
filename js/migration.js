'use strict';
// =============================================================================
// SETTINGS > MIGRATION > EXCALIBUR — preview -> review -> commit -> reconcile.
// Nothing is written to inventory until "Commit selected". Every count and
// decision shown here comes from the API; this file only renders and polls.
// =============================================================================

const _mg = { run: null, report: null, poll: null, selected: new Set() };

async function mgMount(){
  const host = document.getElementById('mgExcaliburBody');
  if(!host) return;
  host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint">Reads Excalibur (Camelot 3PL OData) into staging, shows a per-client review, and writes inventory only for the clients you commit. Re-runs skip pieces already migrated and report pieces that changed.</div>
      <div class="sp-toolbar-actions">
        <button type="button" class="ui-btn js-mg-test">Connect test</button>
        <button type="button" class="ui-btn ui-btn-primary js-mg-run">Run preview</button>
      </div>
    </div>
    <div class="mg-status" id="mgStatus"></div>
    <div id="mgRuns"></div>
    <div id="mgReport"></div>
    <div id="mgReconcile"></div>`;
  host.querySelector('.js-mg-test').addEventListener('click', mgTest);
  host.querySelector('.js-mg-run').addEventListener('click', mgRun);
  await mgLoadRuns();
}

function mgStatus(msg, tone){
  const el = document.getElementById('mgStatus');
  if(!el) return;
  el.innerHTML = msg ? `<div class="ui-banner ui-banner-${tone || 'info'}">${esc(msg)}</div>` : '';
}

async function mgTest(){
  mgStatus('Testing connection…');
  const r = await fetch(`${API}/migration/excalibur/test`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ mgStatus(d.error || 'Connection failed', 'danger'); return; }
  mgStatus(`Connected — ${d.name} (${d.ms} ms)`, 'info');
  uiToast('Excalibur reachable', 'success');
}

async function mgLoadRuns(){
  const d = await apiGet('/migration/excalibur/runs');
  const rows = d?.rows || [];
  const el = document.getElementById('mgRuns');
  if(!el) return;
  if(!rows.length){ el.innerHTML = uiEmpty('No runs yet — Run preview to fetch Excalibur into staging.'); return; }
  uiTable(el, {
    columns: [
      { key: 'started_at', label: 'Started', render: r => esc(String(r.started_at || '').slice(0, 16).replace('T', ' ')) },
      { key: 'status', label: 'Status', render: r => uiChip(r.status === 'previewed' ? 'DRAFT' : r.status === 'committed' ? 'POSTED' : r.status === 'failed' ? 'FAILED' : 'RUNNING', r.status.toUpperCase()) },
      { key: '_fetched', label: 'Fetched', render: r => esc(r.counts && r.counts.fetched ? `${r.counts.fetched.pieces || 0} pieces · ${r.counts.fetched.items || 0} items` : '—') },
      { key: '_staged', label: 'Staged', num: true, render: r => esc(r.counts && r.counts.staged != null ? r.counts.staged : '') },
      { key: 'created_by_name', label: 'By' },
      { key: 'error', label: 'Error', render: r => esc(r.error || '') },
    ],
    rows, rowKey: 'id', onRowClick: (r) => mgOpenRun(r.id),
  });
}

async function mgRun(){
  const r = await fetch(`${API}/migration/excalibur/runs`, { method: 'POST', headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ mgStatus(d.error || 'Could not start a run', 'danger'); return; }
  mgStatus('Preview running — fetching clients…');
  mgPollRun(d.id);
}

function mgPollRun(runId){
  clearInterval(_mg.poll);
  _mg.poll = setInterval(async () => {
    const d = await apiGet(`/migration/excalibur/runs/${runId}`);
    if(!d) return;
    const f = d.counts && d.counts.fetched || {};
    mgStatus(`Preview ${d.counts && d.counts.phase || d.status} — clients ${f.clients || 0} · items ${f.items || 0} · pieces ${f.pieces || 0} · lots ${f.lots || 0}`);
    if(['previewed', 'failed', 'committed'].includes(d.status)){
      clearInterval(_mg.poll);
      if(d.status === 'failed'){ mgStatus(d.error || 'Preview failed', 'danger'); }
      else { mgStatus(`Preview ready — ${d.counts.staged} piece(s) staged, ${d.counts.skipped || 0} skipped`, 'info'); }
      await mgLoadRuns();
      if(d.status !== 'failed') mgOpenRun(runId);
    }
  }, 1500);
}

async function mgOpenRun(runId){
  const d = await apiGet(`/migration/excalibur/runs/${runId}/report`);
  if(!d){ mgStatus('Could not load the report', 'danger'); return; }
  _mg.run = d.run; _mg.report = d; _mg.selected = new Set();
  mgRenderReport();
  document.getElementById('mgReconcile').innerHTML = '';
}

const MG_RULES = {
  sublot_as:  [['attribute', 'keep as LP attribute'], ['uid', 'unit ID (qty must be 1)'], ['lot_suffix', 'append to lot number'], ['ignore', 'ignore']],
  tagid_as:   [['attribute', 'keep as LP attribute'], ['lot', 'use as lot number'], ['ignore', 'ignore']],
  groupid_as: [['attribute', 'keep as LP attribute'], ['ignore', 'ignore']],
  lot_as:     [['lot', 'lot number'], ['attribute', 'keep as LP attribute'], ['ignore', 'ignore']],
};

function mgRenderReport(){
  const el = document.getElementById('mgReport');
  const rep = _mg.report;
  if(!rep) { el.innerHTML = ''; return; }
  const run = rep.run;
  const clients = (typeof clientsCache !== 'undefined' && clientsCache) ? clientsCache : [];
  el.innerHTML = `
    <div class="sp-editor-head">
      <div class="ui-dialog-title">Run ${esc(String(run.startedAt || '').slice(0, 16).replace('T', ' '))} ${uiChip(run.status === 'previewed' ? 'DRAFT' : run.status === 'committed' ? 'POSTED' : 'RUNNING', run.status.toUpperCase())}</div>
      <div class="sp-toolbar-actions">
        <button type="button" class="ui-btn js-mg-locs">Create locations for selected</button>
        <button type="button" class="ui-btn js-mg-reconcile">Reconcile</button>
        <button type="button" class="ui-btn ui-btn-primary js-mg-commit">Commit selected</button>
      </div>
    </div>
    <div class="mg-clients">${rep.clients.map(c => mgClientCard(c, clients)).join('')}</div>`;
  el.querySelectorAll('.js-mg-sel').forEach(cb => cb.addEventListener('change', () => { if(cb.checked) _mg.selected.add(cb.dataset.code); else _mg.selected.delete(cb.dataset.code); }));
  el.querySelectorAll('.js-mg-client').forEach(sel => sel.addEventListener('change', () => mgSaveMap(sel.dataset.code, { clientId: sel.value || null })));
  el.querySelectorAll('.js-mg-rule').forEach(sel => sel.addEventListener('change', () => mgSaveMap(sel.dataset.code, { rules: { [sel.dataset.rule]: sel.value } })));
  el.querySelectorAll('.js-mg-pieces').forEach(b => b.addEventListener('click', () => mgPieces(b.dataset.code, b.dataset.decision || null)));
  el.querySelectorAll('.js-mg-loc').forEach(sel => sel.addEventListener('change', () => mgSaveLoc(sel.dataset.bay, sel.dataset.bin, sel.value || null)));
  el.querySelector('.js-mg-locs').addEventListener('click', mgCreateLocations);
  el.querySelector('.js-mg-commit').addEventListener('click', mgCommit);
  el.querySelector('.js-mg-reconcile').addEventListener('click', mgReconcile);
}

function mgClientCard(c, clients){
  const caps = Object.entries(c.captions || {}).map(([k, v]) => `<span class="ui-chip ui-chip-neutral">${esc(k)} = ${esc(v)}</span>`).join(' ');
  const rule = (key) => `<label class="mg-rule"><span class="ui-muted">${esc(key.replace('_as', ''))}${c.captions && c.captions[key === 'sublot_as' ? 'SubLot' : key === 'tagid_as' ? 'TagID' : key === 'groupid_as' ? 'GroupID' : 'Lot'] ? ` (${esc(c.captions[key === 'sublot_as' ? 'SubLot' : key === 'tagid_as' ? 'TagID' : key === 'groupid_as' ? 'GroupID' : 'Lot'])})` : ''}</span>
    <select class="ui-input js-mg-rule" data-code="${esc(c.clientCode)}" data-rule="${esc(key)}">${MG_RULES[key].map(([v, l]) => `<option value="${esc(v)}" ${c.rules[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const p = c.pieces;
  return `
    <div class="ui-group mg-client ${c.mapped ? '' : 'mg-client-unmapped'}">
      <div class="sp-editor-head">
        <label class="ui-check"><input type="checkbox" class="js-mg-sel" data-code="${esc(c.clientCode)}" ${c.mapped ? '' : 'disabled'}> <strong>${esc(c.clientCode)}</strong> <span class="ui-muted">${esc(c.clientName || '')}</span></label>
        ${c.mapped ? uiChip('ACTIVE', 'MAPPED') : uiChip('FAILED', 'UNMAPPED')}
      </div>
      <div class="ui-group-body">
        <div class="ui-field-row">
          <div class="ui-field"><label class="ui-label">WMS client</label>
            <select class="ui-input js-mg-client" data-code="${esc(c.clientCode)}"><option value="">— pick —</option>${clients.map(x => `<option value="${esc(x.id)}" ${c.wmsClientId === x.id ? 'selected' : ''}>${esc(x.code)} — ${esc(x.name)}</option>`).join('')}</select></div>
          <div class="ui-field"><label class="ui-label">Captions from Excalibur</label><div class="mg-caps">${caps || '<span class="ui-muted">none reported</span>'}</div></div>
          <div class="ui-field"><label class="ui-label">Excalibur warehouse</label><div class="mg-caps">${(c.warehouses || []).length ? c.warehouses.map(w => `<span class="ui-chip ui-chip-neutral">${esc(w)}</span>`).join(' ') : '<span class="ui-muted">not reported</span>'}</div></div>
        </div>
        <div class="mg-rules">${rule('lot_as')}${rule('sublot_as')}${rule('tagid_as')}${rule('groupid_as')}</div>
        <div class="ui-tiles">
          ${uiTile({ label: 'Items to create', value: c.items.toCreate, compact: true })}
          ${uiTile({ label: 'Items existing', value: c.items.existing, compact: true })}
          ${uiTile({ label: 'Items inactive', value: c.items.inactive || 0, sub: 'closed / qty 0, not created', compact: true })}
          ${uiTile({ label: 'Piece-only items', value: c.items.pieceOnly || 0, sub: 'built from piece rows', tone: c.items.pieceOnly ? 'warn' : null, compact: true })}
          ${uiTile({ label: 'Pieces', value: p.total, sub: `qty ${p.qty}`, compact: true })}
          ${uiTile({ label: 'Flagged', value: p.flagged, sub: 'InvStatus / InvCondition', tone: p.flagged ? 'warn' : null, compact: true })}
          ${uiTile({ label: 'Create', value: p.create, compact: true })}
          ${uiTile({ label: 'Exists', value: p.exists, compact: true })}
          ${uiTile({ label: 'Changed', value: p.changed, tone: p.changed ? 'danger' : null, compact: true })}
          ${uiTile({ label: 'Blocked', value: p.blocked, tone: p.blocked ? 'warn' : null, compact: true })}
        </div>
        ${p.subLotQtyNot1 && c.rules.sublot_as === 'uid' ? `<div class="ui-banner ui-banner-warn">${esc(p.subLotQtyNot1)} piece(s) carry a SubLot with qty ≠ 1 — they will be blocked under "unit ID". Choose another SubLot rule or split them in Excalibur.</div>` : ''}
        ${c.changed.length ? `<div class="ui-banner ui-banner-danger">Changed since commit (not applied): ${c.changed.map(x => `${esc(x.pieceNo)} — ${esc(x.reason)}`).join('; ')}</div>` : ''}
        <div class="ui-label">Bay / bin → location ${c.unmappedLocations ? uiChip('DRAFT', `${c.unmappedLocations} unmapped`) : uiChip('ACTIVE', 'all mapped')}</div>
        <div class="mg-locs">${c.locations.map(l => `<div class="mg-loc"><span class="ui-id">${esc(l.bay)}${l.bin ? ' / ' + esc(l.bin) : ''}</span> <span class="ui-muted">${esc(l.pieces)} pc</span>
            <select class="ui-input js-mg-loc" data-bay="${esc(l.bay)}" data-bin="${esc(l.bin)}"><option value="">— create or pick —</option>${(_mg.locations || []).map(x => `<option value="${esc(x.id)}" ${l.locationId === x.id ? 'selected' : ''}>${esc(x.code)}</option>`).join('')}</select></div>`).join('')}</div>
        <div class="sp-toolbar-actions">
          <button type="button" class="ui-btn js-mg-pieces" data-code="${esc(c.clientCode)}">Pieces</button>
          <button type="button" class="ui-btn js-mg-pieces" data-code="${esc(c.clientCode)}" data-decision="blocked">Blocked</button>
          <button type="button" class="ui-btn js-mg-pieces" data-code="${esc(c.clientCode)}" data-decision="changed">Changed</button>
        </div>
      </div>
    </div>`;
}

async function mgSaveMap(code, body){
  const r = await fetch(`${API}/migration/excalibur/clients/${encodeURIComponent(code)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Could not save', 'error'); return; }
  uiToast(`${code} saved`, 'success');
  mgOpenRun(_mg.run.id);
}

async function mgSaveLoc(bay, bin, locationId){
  const r = await fetch(`${API}/migration/excalibur/locations`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ bay, bin, locationId }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Could not map', 'error'); return; }
  uiToast(`${bay}${bin ? ' / ' + bin : ''} mapped`, 'success');
}

async function mgCreateLocations(){
  const codes = [..._mg.selected];
  if(!codes.length) return uiToast('Select at least one client', 'error');
  const go = await uiConfirm({ title: 'Create locations?', message: `Every unmapped bay/bin for ${codes.join(', ')} becomes a bulk location in zone MIGR, named bay-bin.`, confirmLabel: 'Create' });
  if(!go) return;
  const r = await fetch(`${API}/migration/excalibur/runs/${_mg.run.id}/locations/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ clientCodes: codes }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Could not create locations', 'error'); return; }
  uiToast(`${d.created} location(s) created, ${d.mapped} mapped`, 'success');
  mgOpenRun(_mg.run.id);
}

async function mgCommit(){
  const codes = [..._mg.selected];
  if(!codes.length) return uiToast('Select at least one mapped client', 'error');
  const go = await uiConfirm({ title: `Commit ${codes.join(', ')}?`, message: 'Creates SKUs, locations, LPs, lots, inventory and units for every piece marked Create, under a MIGRATION receipt. Pieces already migrated are skipped; changed pieces are reported, not applied.', confirmLabel: 'Commit', danger: true });
  if(!go) return;
  mgStatus('Committing…');
  const r = await fetch(`${API}/migration/excalibur/runs/${_mg.run.id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ clientCodes: codes }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ mgStatus(d.error || 'Commit refused', 'danger'); uiToast(d.error || 'Commit refused', 'error'); return; }
  const summary = d.results.map(x => `${x.clientCode}: ${x.lps} LP(s), ${x.qty} qty, ${x.skusCreated} SKU(s), ${x.units} unit(s)${x.blocked.length ? `, ${x.blocked.length} blocked` : ''}${x.upcSkipped.length ? `, ${x.upcSkipped.length} UPC skipped` : ''}`).join(' · ');
  mgStatus(`Committed — ${summary}`, 'info');
  uiToast('Committed', 'success');
  mgOpenRun(_mg.run.id);
}

async function mgPieces(code, decision){
  const d = await apiGet(`/migration/excalibur/runs/${_mg.run.id}/pieces?client=${encodeURIComponent(code)}${decision ? '&decision=' + decision : ''}`);
  const rows = d?.rows || [];
  const m = uiModal({ title: `${code} — ${decision || 'all'} pieces (${rows.length})`, width: 900, body: `<div id="mgPieceTable"></div>` });
  uiTable(m.el.querySelector('#mgPieceTable'), {
    columns: [
      { key: 'piece_no', label: 'Piece', mono: true },
      { key: 'item', label: 'Item', mono: true },
      { key: '_lot', label: 'Lot / SubLot / TagID', render: r => esc([r.mapped.lot, r.mapped.subLot, r.mapped.tagId].filter(Boolean).join(' · ')) },
      { key: '_bin', label: 'Bay / bin', render: r => esc([r.mapped.bay, r.mapped.bin].filter(Boolean).join(' / ')) },
      { key: '_qty', label: 'Qty', num: true, render: r => esc(r.mapped.qty) },
      { key: '_flag', label: 'Status', render: r => esc([r.mapped.invStatus, r.mapped.invCondition].filter(Boolean).join(' / ')) },
      { key: 'decision', label: 'Decision', render: r => uiChip(r.decision === 'committed' ? 'POSTED' : r.decision === 'blocked' ? 'FAILED' : r.decision === 'changed' ? 'BACKORDERED' : r.decision === 'exists' ? 'ACTIVE' : 'NEW', r.decision.toUpperCase()) },
      { key: 'reason', label: 'Reason' },
    ], rows, rowKey: 'piece_no',
  });
}

async function mgReconcile(){
  const d = await apiGet(`/migration/excalibur/runs/${_mg.run.id}/reconcile`);
  const el = document.getElementById('mgReconcile');
  if(!d){ el.innerHTML = uiError('Could not reconcile'); return; }
  el.innerHTML = `<div class="ui-label">Reconcile — Excalibur vs WMS on-hand</div>` + d.clients.map(c => `
    <div class="ui-group mg-client">
      <div class="sp-editor-head"><div class="ui-dialog-title">${esc(c.clientCode)} ${c.differences ? uiChip('FAILED', `${c.differences} differences`) : uiChip('ACTIVE', 'MATCHES')}</div>
        <div class="ui-muted">Excalibur ${esc(c.excaliburQty)} · WMS ${esc(c.wmsQty)}</div></div>
      <div class="ui-group-body"><div id="mgRec_${esc(c.clientCode.replace(/[^A-Za-z0-9]/g, '_'))}"></div>
        ${c.lotFeedMismatches.length ? `<div class="ui-banner ui-banner-warn">Lot feed vs pieces: ${c.lotFeedMismatches.map(x => `${esc(x.item)} ${esc(x.lot)} feed ${esc(x.lotFeed)} / pieces ${esc(x.pieces)}`).join('; ')}</div>` : ''}</div>
    </div>`).join('');
  for(const c of d.clients){
    uiTable(`mgRec_${c.clientCode.replace(/[^A-Za-z0-9]/g, '_')}`, {
      columns: [
        { key: 'item', label: 'Item', mono: true }, { key: 'lot', label: 'Lot', mono: true },
        { key: 'excalibur', label: 'Excalibur', num: true }, { key: 'wms', label: 'WMS', num: true },
        { key: 'diff', label: 'Diff', num: true, render: r => r.diff === 0 ? '<span class="ui-muted">0</span>' : `<span class="ui-err-text">${esc(r.diff)}</span>` },
      ], rows: c.rows, rowKey: 'item', empty: 'Nothing on hand on either side.',
    });
  }
}

async function mgLoadLocations(){
  const d = await apiGet('/locations');
  _mg.locations = (d?.rows || d?.data || d || []).map(l => ({ id: l.id, code: l.code }));
}
