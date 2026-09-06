'use strict';
// =============================================================================
// UNITS — one renderer for "which physical units are these", used by:
//   Order detail (picked UIDs under allocations; UIDs per package with tracking)
//   Inventory detail (Units section on an LP, click → event history)
//   Inventory page "Find unit" (UID → jump to its LP with the unit highlighted)
//   LP trace report (Units per LP)
//   Client portal order detail (shipped UIDs + tracking, read-only)
// Reads: GET /orders/:id/units, GET /lps/:id/units, GET /units/:id, GET /units/lookup?uid=
// =============================================================================

const UNIT_STATUS_LABEL = { in_stock: 'IN STOCK', allocated: 'ALLOCATED', picked: 'PICKED', packed: 'PACKED', shipped: 'SHIPPED', returned: 'RETURNED', scrapped: 'SCRAPPED' };
function unitChip(status){ return uiChip(status, UNIT_STATUS_LABEL[status] || String(status || '').toUpperCase()); }
function unitWhen(v){ return v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }

/** A list of units. opts: { highlight: uid, showOrder, showPackage, showPicked, clickable } */
function unitsList(units, opts = {}){
  if(!units || !units.length) return '<div class="ui-muted unit-empty">No units</div>';
  return `<div class="unit-list">${units.map(u => `
    <div class="unit-row ${opts.highlight && u.uid === opts.highlight ? 'unit-hl' : ''} ${opts.clickable ? 'unit-row-click' : ''}" data-unit-id="${esc(u.id)}" data-uid="${esc(u.uid)}">
      <span class="ui-id unit-uid">${esc(u.uid)}</span>
      ${unitChip(u.status)}
      ${u.lotCode ? `<span class="ui-muted">lot ${esc(u.lotCode)}</span>` : ''}
      ${u.cartonCode ? `<span class="ui-id unit-carton">${esc(u.cartonCode)}</span>` : (opts.showLp && u.lpNumber ? `<span class="ui-id unit-carton">${esc(u.lpNumber)}</span>` : '')}
      ${opts.showOrder !== false && u.orderNumber && ['allocated', 'picked', 'packed', 'shipped'].includes(u.status) ? `<span class="ui-muted">order ${esc(u.orderNumber)}</span>` : ''}
      ${opts.showPicked && u.pickedAt ? `<span class="ui-muted">picked ${esc(unitWhen(u.pickedAt))}${u.pickedBy ? ' by ' + esc(u.pickedBy) : ''}</span>` : ''}
      ${opts.showPackage && u.packageNumber ? `<span class="ui-muted">${esc(u.packageNumber)}${u.trackingNumber ? ' · ' + esc(u.trackingNumber) : ''}</span>` : ''}
      ${opts.showLast && u.lastEventAt ? `<span class="ui-muted unit-last">${esc(unitWhen(u.lastEventAt))}</span>` : ''}
    </div>`).join('')}</div>`;
}
function unitsCountHeader(units){
  const n = units.length;
  const by = units.reduce((a, u) => (a[u.status] = (a[u.status] || 0) + 1, a), {});
  const parts = Object.keys(UNIT_STATUS_LABEL).filter(k => by[k]).map(k => `${by[k]} ${UNIT_STATUS_LABEL[k].toLowerCase()}`);
  return `${n} unit${n === 1 ? '' : 's'}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
}
function unitsWire(host, onOpen){
  host.querySelectorAll('.unit-row-click').forEach(row => row.addEventListener('click', uiBusyHandler(() => onOpen(row.dataset.unitId, row.dataset.uid))));
}

/** Unit event history modal. */
async function openUnitHistory(unitId){
  const m = uiModal({ title: 'Unit', width: 640, body: uiSpinner('Loading…'), actions: [{ label: 'Close' }] });
  const body = m.el.querySelector('.ui-modal-body');
  const d = await apiGet(`/units/${unitId}`);
  if(!d){ body.innerHTML = uiError('Could not load this unit'); return; }
  m.el.querySelector('.ui-dialog-title').innerHTML = `${uiId(d.uid)} ${unitChip(d.status)}`;
  body.innerHTML = `
    ${uiMeta([
      { k: 'SKU', v: `${uiId(d.skuCode || '')} <span class="ui-muted">${esc(d.skuName || '')}</span>` },
      { k: 'Client', v: esc(d.clientCode || '—') },
      { k: 'Lot', v: d.lotCode ? uiId(d.lotCode) : '<span class="ui-muted">—</span>' },
      { k: 'LP', v: d.lpNumber ? uiId(d.lpNumber) : '<span class="ui-muted">—</span>' },
      { k: 'Carton', v: d.cartonCode ? uiId(d.cartonCode) : '<span class="ui-muted">—</span>' },
      { k: 'Location', v: esc(d.locationCode || '—') },
      { k: 'Order', v: d.orderNumber ? uiId(d.orderNumber) : '<span class="ui-muted">—</span>' },
      { k: 'Package', v: d.packageNumber ? `${uiId(d.packageNumber)}${d.trackingNumber ? ' <span class="ui-muted">' + esc(d.trackingNumber) + '</span>' : ''}` : '<span class="ui-muted">—</span>' },
    ])}
    <div class="ui-label unit-hist-label">History</div>
    ${(d.events || []).length ? `<table class="ui-table"><thead><tr><th>When</th><th>Event</th><th>From</th><th>To</th><th>Order</th><th>Who</th><th>Note</th></tr></thead><tbody>
      ${d.events.map(e => `<tr>
        <td>${esc(unitWhen(e.created_at))}</td>
        <td>${uiChip(e.event_type, String(e.event_type).toUpperCase())}</td>
        <td>${esc([e.from_lp_number, e.from_location_code].filter(Boolean).join(' @ ') || '—')}</td>
        <td>${esc([e.to_lp_number, e.to_location_code].filter(Boolean).join(' @ ') || '—')}</td>
        <td>${e.order_id ? uiId(d.orderId === e.order_id && d.orderNumber ? d.orderNumber : e.order_id.slice(0, 8)) : '—'}</td>
        <td>${esc(e.user_name || '—')}</td>
        <td>${esc(e.note || e.scan_raw || '')}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="ui-muted">No events recorded.</div>'}`;
}

/** Order detail: units under the allocations + per package. Portal users get the same, read-only. */
async function renderOrderUnits(orderId, d){
  const host = document.getElementById('ordUnitsWrap');
  if(!host) return;
  host.innerHTML = '';
  const r = await apiGet(`/orders/${orderId}/units`);
  const units = (r && r.rows) || [];
  if(!units.length) return;
  const groups = new Map();
  for(const u of units){ const k = `${u.skuCode}|${u.lpNumber || ''}`; (groups.get(k) || groups.set(k, { sku: u.skuCode, lp: u.lpNumber, carton: u.cartonCode, units: [] }).get(k)).units.push(u); }
  const packages = new Map();
  for(const u of units){ if(u.packageNumber){ (packages.get(u.packageNumber) || packages.set(u.packageNumber, { tracking: u.trackingNumber, status: u.packageStatus, units: [] }).get(u.packageNumber)).units.push(u); } }
  host.innerHTML = `
    <div class="card inv-sec">
      <div class="card-head"><div class="card-title">Units</div><div class="ui-muted unit-count">${esc(unitsCountHeader(units))}</div></div>
      <div class="inv-sec-body">
        ${[...groups.values()].map(g => `
          <div class="unit-group">
            <div class="unit-group-head">${uiId(g.sku)} ${g.carton ? `<span class="ui-id unit-carton">${esc(g.carton)}</span>` : (g.lp ? `<span class="ui-id unit-carton">${esc(g.lp)}</span>` : '')} <span class="ui-muted">${esc(g.units.length)} unit${g.units.length === 1 ? '' : 's'}</span></div>
            ${unitsList(g.units, { showOrder: false, showPicked: true, showPackage: true, clickable: !(typeof isPortalMode === 'function' && isPortalMode()) })}
          </div>`).join('')}
        ${packages.size ? `<div class="ui-label unit-hist-label">Packages</div>${[...packages.entries()].map(([n, p]) => `
          <div class="unit-group">
            <div class="unit-group-head">${uiId(n)} ${p.tracking ? `<span class="ui-id">${esc(p.tracking)}</span>` : '<span class="ui-muted">no tracking yet</span>'} <span class="ui-muted">${esc(p.units.length)} unit${p.units.length === 1 ? '' : 's'}</span></div>
            ${unitsList(p.units, { showOrder: false, clickable: false })}
          </div>`).join('')}` : ''}
      </div>
    </div>`;
  unitsWire(host, (id) => openUnitHistory(id));
}

/** Inventory page "Find unit": UID → its LP's inventory record with the unit highlighted. */
async function invFindUnit(raw){
  const uid = String(raw || '').trim();
  if(!uid) return;
  const r = await fetch(`${API}/units/lookup?uid=${encodeURIComponent(uid)}`, { headers: { Authorization: `Bearer ${T}` } });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Unit not found', 'error'); return false; }
  if(!d.lpId){ uiToast(`${d.uid} is ${UNIT_STATUS_LABEL[d.status] || d.status} and not on a license plate${d.orderNumber ? ' (order ' + d.orderNumber + ')' : ''}`, 'warning'); return openUnitHistory(d.id); }
  const inv = await apiGet(`/inventory?search=${encodeURIComponent(d.lpNumber || '')}&limit=50`);
  const rows = inv?.rows || inv?.data || inv || [];
  const row = rows.find(x => x.lp_id === d.lpId) || rows[0];
  if(!row){ uiToast(`${d.uid} is on ${d.lpNumber} but that license plate has no inventory record`, 'warning'); return openUnitHistory(d.id); }
  uiToast(`${d.uid} — ${d.lpNumber}${d.cartonCode ? ' (' + d.cartonCode + ')' : ''} @ ${d.locationCode || '?'}`, 'success');
  return openInventoryDetail(row.id, { highlightUid: d.uid });
}

/** Units section for an LP (inventory detail, trace report). Returns HTML; wires clicks on the host afterwards. */
async function lpUnitsSection(lpId, host, opts = {}){
  const d = await apiGet(`/lps/${lpId}/units`);
  if(!d) return '';
  const units = Object.values(d.byStatus || {}).flat();
  const html = `
    <div class="card inv-sec" id="${esc(opts.id || 'lpUnitsSec')}">
      <div class="card-head"><div class="card-title">Units</div><div class="ui-muted unit-count">${esc(unitsCountHeader(units))}</div></div>
      <div class="inv-sec-body">${unitsList(units, { highlight: opts.highlight, showOrder: true, showLast: true, clickable: true })}</div>
    </div>`;
  if(host){
    host.insertAdjacentHTML('beforeend', html);
    unitsWire(host, (id) => openUnitHistory(id));
    const hl = host.querySelector('.unit-hl'); if(hl) hl.scrollIntoView({ block: 'center' });
  }
  return html;
}
