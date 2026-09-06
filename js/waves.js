'use strict';
// =============================================================================
// WAVES (office) — a ShipStation label batch is one wave; the office can also
// build a manual wave from order numbers. Wave contents + status.
// =============================================================================

const WAVE_STATUS_CHIP = { PLANNING: ['DRAFT', 'OPEN'], RELEASED: ['NEW', 'RELEASED'], IN_PROGRESS: ['PICKING', 'PICKING'], COMPLETED: ['POSTED', 'CLOSED'], CANCELLED: ['CANCELLED', 'CANCELLED'] };
const waveChip = (st) => { const m = WAVE_STATUS_CHIP[st] || ['DRAFT', st]; return uiChip(m[0], m[1]); };

async function loadWaves(){
  const host = document.getElementById('wavesBody');
  if(!host) return;
  host.innerHTML = `
    <div class="sp-toolbar">
      <div class="ui-hint" title="The shipping system is ShipStation.">Each label batch from the shipping system becomes a wave automatically. Build a manual wave from order numbers for anything unbatched.</div>
      <div class="sp-toolbar-actions"><button type="button" class="ui-btn ui-btn-primary js-wave-new">New manual wave</button></div>
    </div>
    <div id="wavesTable"></div>`;
  host.querySelector('.js-wave-new').addEventListener('click', uiBusyHandler(waveNew));
  if(!can('waves.manage')) host.querySelector('.js-wave-new').classList.add('perm-denied');
  const d = await apiGet('/waves');
  const rows = d?.rows || [];
  const el = host.querySelector('#wavesTable');
  if(!rows.length){ el.innerHTML = uiEmpty('No waves yet.'); return; }
  uiTable(el, {
    columns: [
      { key: 'wave_number', label: 'Wave', mono: true },
      { key: 'source', label: 'Source', render: r => r.source === 'shipstation_batch' ? uiChip('ACTIVE', 'SHIPSTATION BATCH') : uiChip('NEW', 'MANUAL') },
      { key: 'status', label: 'Status', render: r => waveChip(r.status) },
      { key: 'order_count', label: 'Orders', num: true },
      { key: 'units', label: 'Units', num: true },
      { key: 'started_count', label: 'Started', num: true },
      { key: 'shipped_count', label: 'Shipped', num: true },
      { key: 'created_at', label: 'Created', render: r => esc(String(r.created_at || '').slice(0, 16).replace('T', ' ')) },
      { key: 'created_by_name', label: 'By' },
    ], rows, rowKey: 'id', onRowClick: (r) => waveOpen(r.id),
  });
}

async function waveOpen(id){
  const d = await apiGet(`/waves/${id}`);
  if(!d){ uiToast('Could not load the wave', 'error'); return; }
  const w = d.wave;
  const m = uiModal({
    title: `Wave ${w.wave_number}`,
    width: 900,
    body: `<div class="sp-editor-head">${waveChip(w.status)} <span class="ui-muted">${esc(w.source === 'shipstation_batch' ? 'ShipStation batch ' + (w.external_batch_number || '') : 'manual')}</span>
             <div class="sp-toolbar-actions">
               ${w.status === 'PLANNING' ? '<button type="button" class="ui-btn js-wave-release">Release</button>' : ''}
               ${['PLANNING', 'RELEASED', 'IN_PROGRESS'].includes(w.status) ? '<button type="button" class="ui-btn js-wave-complete">Mark complete</button><button type="button" class="ui-btn js-wave-cancel">Cancel wave</button>' : ''}
             </div></div>
           <div id="waveOrders"></div>`,
  });
  uiTable(m.el.querySelector('#waveOrders'), {
    columns: [
      { key: 'order_number', label: 'Order', mono: true },
      { key: 'external_order_number', label: 'Label batch #', mono: true },
      { key: 'client_code', label: 'Client' },
      { key: 'status', label: 'Status', render: r => uiChip(r.status) },
      { key: 'customer_name', label: 'Customer' },
      { key: '_to', label: 'Ship to', render: r => esc([r.ship_to_city, r.ship_to_state].filter(Boolean).join(', ')) },
      { key: 'requested_service', label: 'Service' },
      { key: 'line_count', label: 'Lines', num: true },
      { key: 'units', label: 'Units', num: true },
      { key: 'tracking', label: 'Tracking', mono: true },
    ], rows: d.orders, rowKey: 'id', empty: 'No orders in this wave.',
  });
  const set = async (status) => {
    const go = status === 'CANCELLED' ? await uiConfirm({ title: 'Cancel this wave?', body: esc('Orders are released from the wave; nothing else changes.'), confirmLabel: 'Cancel wave', danger: true }) : true;
    if(!go) return;
    const r = await fetch(`${API}/waves/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ status }) });
    const dd = await r.json().catch(() => ({}));
    if(!r.ok) return uiToast(dd.error || 'Could not update the wave', 'error');
    uiToast(`Wave ${w.wave_number} ${status.toLowerCase().replace('_', ' ')}`, 'success');
    m.close(); loadWaves();
  };
  const rl = m.el.querySelector('.js-wave-release'); if(rl) rl.addEventListener('click', uiBusyHandler(() => set('RELEASED')));
  const cp = m.el.querySelector('.js-wave-complete'); if(cp) cp.addEventListener('click', uiBusyHandler(() => set('COMPLETED')));
  const cn = m.el.querySelector('.js-wave-cancel'); if(cn) cn.addEventListener('click', uiBusyHandler(() => set('CANCELLED')));
}

async function waveNew(){
  const text = await uiPrompt({ title: 'New manual wave', label: 'Order numbers (comma or space separated)', placeholder: 'ORD-500010, ORD-500011', confirmLabel: 'Create wave' });
  if(!text) return;
  const orderNumbers = String(text).split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
  if(!orderNumbers.length) return;
  const r = await fetch(`${API}/waves`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: JSON.stringify({ orderNumbers }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not create the wave', 'error');
  uiToast(`${d.wave.wave_number} created with ${d.orders.length} order(s)`, 'success');
  loadWaves();
}
