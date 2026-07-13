'use strict';
// =============================================================================
// ORDERS — list, detail, allocation, new-order modal.
// TERMINAL LEDGER (batch D3). Tables via uiTable, statuses via uiChip, no
// native dialogs, mutations report through uiToast.
// =============================================================================

let COI = null;          // current order id
let COD = null;          // current order data
let AIC = {};            // allocation inventory cache by order line id
let orderLines = [];     // new-order modal: pending lines

const ORD_COLS = [
  { key: 'order_number', label: 'Order #', mono: true },
  { key: 'client_name', label: 'Client' },
  { key: 'channel', label: 'Channel' },
  { key: 'order_type', label: 'Type' },
  { key: 'customer_name', label: 'Customer' },
  { key: '_shipTo', label: 'Ship to', render: o =>
      `<span class="ui-muted">${esc([o.ship_to_city, o.ship_to_state].filter(Boolean).join(', ') || '—')}</span>` },
  { key: 'carrier_code', label: 'Carrier' },
  { key: 'line_count', label: 'Lines', num: true },
  { key: 'total_units', label: 'Units', num: true },
  { key: '_shipBy', label: 'Ship by', render: o => {
      if (!o.required_ship_date) return '<span class="ui-muted">—</span>';
      const d = new Date(o.required_ship_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      // Past SLA is the one thing on this row ops must not miss.
      return o.is_past_sla
        ? `<span class="ui-chip ui-chip-danger">${esc(d)}</span>`
        : uiId(d);
    } },
  { key: 'status', label: 'Status', render: o => uiChip(o.status) },
];

async function loadOrders(){
  document.getElementById('ordDetailView').style.display = 'none';
  document.getElementById('ordListView').style.display = 'block';

  const s  = document.getElementById('ordSearch')?.value || '';
  const st = (_cbState['ordStatusFilterWrap']?.selected?.value) || '';
  let u = '/orders?limit=100';
  if(st) u += `&status=${encodeURIComponent(st)}`;
  if(s)  u += `&search=${encodeURIComponent(s)}`;

  uiTableLoading('ordListWrap', ORD_COLS);
  const d = await apiGet(u);
  if(d === null) return uiTableError('ordListWrap', ORD_COLS, 'Could not load orders', loadOrders);

  uiTable('ordListWrap', {
    columns: ORD_COLS, rows: (d.data || d.rows || d || []), rowKey: 'id',
    onRowClick: o => openOrderDetail(o.id),
    empty: s || st ? 'No orders match that filter.' : 'No orders yet.',
  });
}

const ORD_LINE_COLS = [
  { key: 'line_number', label: 'Line', num: true },
  { key: '_sku', label: 'SKU', render: ln => `${uiId(ln.sku_code || '')} ${severityChip(ln, { size: 'sm' })}` },
  { key: 'sku_name', label: 'Description' },
  { key: '_uom', label: 'Type', render: ln => esc(ln.sku_type || ln.uom || '') },
  { key: 'ordered_qty', label: 'Ordered', num: true },
  { key: '_alloc', label: 'Allocated', num: true, render: ln => {
      const a = Number(ln.allocated_qty || 0), o = Number(ln.ordered_qty || 0);
      // Short lines are the reason orders stall — flag them in the row itself.
      return a < o ? `<span class="ui-chip ui-chip-danger">${esc(a)} of ${esc(o)}</span>` : uiNum(a);
    } },
  { key: 'picked_qty', label: 'Picked', num: true },
  { key: 'shipped_qty', label: 'Shipped', num: true },
];

async function openOrderDetail(id){
  COI = id;
  document.getElementById('ordListView').style.display = 'none';
  document.getElementById('ordDetailView').style.display = 'block';

  const d = await apiGet(`/orders/${id}`);
  if(!d){ uiToast('Could not load that order', 'error'); closeOrderDetail(); return; }
  COD = d;

  document.getElementById('ordDetailTitle').innerHTML =
    `${esc(d.order_number || '')} ${uiChip(d.status)}`;
  document.getElementById('ordDetailSub').textContent = `${d.client_name || ''} · ${d.channel || ''}`;

  // ---- Banners. Both live in a fixed host div now (no more DOM-insert
  // gymnastics against detailView.children[1], which broke ordering).
  const banners = document.getElementById('ordBanners');
  banners.innerHTML = '';

  // Under-allocated: the order cannot legitimately advance. Front and center.
  const shortLines = (d.lines || []).filter(l =>
    Number(l.allocated_qty || 0) < Number(l.ordered_qty || 0));
  if(shortLines.length){
    const totalShort = shortLines.reduce((s, l) =>
      s + (Number(l.ordered_qty || 0) - Number(l.allocated_qty || 0)), 0);
    banners.innerHTML += `<div class="ui-banner ui-banner-danger">
      ⚠ <strong>${esc(shortLines.length)} line${shortLines.length === 1 ? '' : 's'} not fully allocated</strong>
      — ${esc(totalShort)} unit${totalShort === 1 ? '' : 's'} short. The order can't be picked or shipped
      until every line is fully allocated.</div>`;
  }

  // Pessimistic pick lock — someone else is on this order. Auto-releases at 30m.
  const lockedAt = d.picking_started_at ? new Date(d.picking_started_at) : null;
  const lockFresh = lockedAt && (Date.now() - lockedAt.getTime() < 30 * 60 * 1000);
  const myId = (typeof U !== 'undefined' && U) ? U.id : null;
  const lockedByOther = d.picking_user_id && d.picking_user_id !== myId && lockFresh;
  if(lockedByOther){
    const elapsed = Math.round((Date.now() - lockedAt.getTime()) / 60000);
    banners.innerHTML += `<div class="ui-banner ui-banner-warn">
      🔒 Being picked by <strong>${esc(d.picking_user_name || 'another user')}</strong> — started
      ${esc(elapsed)}m ago. Wait for them to finish, or the lock auto-releases at 30m.</div>`;
  }
  document.querySelectorAll('button[onclick*="openMobilePicker"]').forEach(b => {
    b.disabled = !!lockedByOther;
    b.title = lockedByOther ? `Locked by ${d.picking_user_name}` : '';
  });

  // Edit + Delete disappear once SHIPPED — the order has left the building.
  // (Both endpoints reject SHIPPED anyway; this keeps the UI honest.)
  const isShipped = d.status === 'SHIPPED';
  document.querySelectorAll('.js-ord-edit-btn, .js-ord-delete-btn').forEach(b => {
    b.style.display = isShipped ? 'none' : '';
  });

  document.getElementById('ordInfoGrid').innerHTML = uiMeta([
    { k: 'Order #',  v: uiId(d.order_number) },
    { k: 'External', v: d.external_order_number ? uiId(d.external_order_number) : '<span class="ui-muted">—</span>' },
    { k: 'PRO #',    v: d.pro_number ? uiId(d.pro_number) : '<span class="ui-muted">—</span>' },
    { k: 'Channel',  v: esc(d.channel || '—') },
    { k: 'Type',     v: esc(d.order_type || '—') },
    { k: 'Customer', v: esc(d.customer_name || '—') },
    { k: 'Carrier',  v: esc(`${d.carrier_code || '—'} / ${d.ship_method || '—'}`) },
    { k: 'Ship by',  v: d.required_ship_date
        ? uiId(new Date(d.required_ship_date).toLocaleDateString()) : '<span class="ui-muted">—</span>' },
    { k: 'Created',  v: d.created_at ? uiId(fmtTimeShort(d.created_at)) : '<span class="ui-muted">—</span>' },
  ]);

  uiTable('ordLinesWrap', {
    columns: ORD_LINE_COLS, rows: d.lines || [], rowKey: 'id', empty: 'No lines on this order.',
  });

  const ci = WF.indexOf(d.status);
  document.getElementById('ordWorkflowSteps').innerHTML = WF.map((s, i) => {
    const cls = i < ci ? 'done' : s === d.status ? 'current' : 'pending';
    const icon = i < ci ? '✓' : s === d.status ? '●' : '○';
    const cur = s === d.status ? '<span class="wf-current-label">CURRENT</span>' : '';
    return `<div class="workflow-step ${cls}"><div class="workflow-icon">${icon}</div>${esc(s)}${cur}</div>`;
  }).join('') + (d.status === 'CANCELLED'
    ? '<div class="workflow-step" style="color:var(--red);"><div class="workflow-icon">✕</div>CANCELLED</div>'
    : '');

  // Phase 3: portal users (clients) only see status, not actions.
  // /orders/:id/valid-transitions is requireOps and would 403 anyway, and
  // the allocate / pick / ship buttons are not exposed to clients — ops
  // handles all fulfilment.
  const transBtns = document.getElementById('ordTransitionBtns');
  if(typeof isPortalMode === 'function' && isPortalMode()){
    transBtns.innerHTML = '<div class="ui-hint">Status is read-only here — our team handles fulfilment.</div>';
  } else {
    const tr = await apiGet(`/orders/${id}/valid-transitions`);
    // The workflow panel groups actions by intent so it doesn't feel like
    // a wall of buttons:
    //   PRIMARY   — the most natural next step (forward state transition
    //               or Ship). Big, prominent, full-width.
    //   SECONDARY — backward / lateral state changes. Smaller, side-by-side.
    //   DESTRUCTIVE — Unallocate Order. Smaller, amber-styled, separated
    //               by a divider so ops doesn't bump into it accidentally.

    const canShip = ['PACKING', 'STAGED'].includes(d.status);
    const hasPickedAlloc = (d.allocations || []).some(a => a.status === 'PICKED');
    const canUnallocateAll = ['ALLOCATED', 'PICKING'].includes(d.status) && !hasPickedAlloc;

    const labelFor = (t) => {
      if (t === 'CANCELLED') return 'Cancel order';
      if (t === 'ALLOCATED') return 'Allocate';
      if (t === 'PICKING')   return 'Start picking';
      if (t === 'PACKING')   return 'Complete picking';
      if (t === 'STAGED')    return 'Mark staged';
      if (t === 'NEW')       return '← Back to NEW';
      return '→ ' + t;
    };

    // Forward state transitions (the main "next step" — at most one is
    // typically the dominant choice; we render them all but mark the
    // most-forward one as primary if there are multiple).
    const allowed = tr?.allowed || [];
    const blockForward = shortLines.length > 0;
    const exempt = new Set(['CANCELLED', 'NEW', 'ALLOCATED']);
    const forwardOrder = ['ALLOCATED', 'PICKING', 'PACKING', 'STAGED'];
    const primary  = allowed.filter(t => forwardOrder.includes(t))
                            .sort((a,b) => forwardOrder.indexOf(a) - forwardOrder.indexOf(b));
    const backward = allowed.filter(t => t === 'NEW');
    const cancel   = allowed.filter(t => t === 'CANCELLED');

    let html = '';

    // PRIMARY — forward transitions. Ship takes precedence at PACKING/STAGED,
    // which collapses two clicks into one.
    if(canShip){
      html += '<button class="ui-btn ui-btn-primary ord-act-primary js-ship-btn">Ship order</button>';
    }
    primary.forEach((t) => {
      const blocked = blockForward && !exempt.has(t);
      const title = blocked ? 'Allocate every line first' : '';
      html += `<button class="ui-btn ui-btn-primary ord-act-primary js-trans-btn${blocked ? ' ord-act-blocked' : ''}"
               data-target="${esc(t)}" data-blocked="${blocked ? '1' : '0'}"
               title="${esc(title)}">${esc(labelFor(t))}</button>`;
    });

    // SECONDARY — backward + cancel, side by side, smaller.
    const secondary = [...backward, ...cancel];
    if(secondary.length){
      html += '<div class="ord-act-row">' + secondary.map(t =>
        `<button class="ui-btn ${t === 'CANCELLED' ? 'ui-btn-danger' : ''} js-trans-btn"
                 data-target="${esc(t)}" data-blocked="0">${esc(labelFor(t))}</button>`).join('') + '</div>';
    }

    // DESTRUCTIVE — Unallocate. Fenced off below a divider so nobody
    // fat-fingers it on the way to a normal transition.
    if(canUnallocateAll){
      html += `<div class="ord-act-danger-zone">
        <div class="ui-label">Edit allocations</div>
        <button class="ui-btn js-unallocate-all-btn"
          title="Release all allocations and demote the order to NEW so lines can be edited">↺ Unallocate order</button>
      </div>`;
    }

    if(!html) html = '<div class="ui-hint">Terminal state — no actions available.</div>';
    transBtns.innerHTML = html;
    transBtns.querySelectorAll('.js-trans-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        if(btn.dataset.blocked === '1'){
          return uiToast('Some lines aren\'t fully allocated — finish allocating before advancing', 'error');
        }
        transitionOrder(id, btn.dataset.target);
      })
    );
    transBtns.querySelectorAll('.js-ship-btn').forEach(btn =>
      btn.addEventListener('click', () => showShipOrderModal())
    );
    transBtns.querySelectorAll('.js-unallocate-all-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        const allocCount = (d.allocations || []).filter(a => a.status === 'PENDING').length;
        showDestructiveEdit({
          title: '↺ Unallocate Entire Order',
          description: `Release all <strong>${allocCount}</strong> allocation${allocCount === 1 ? '' : 's'} on order <strong>${esc(d.order_number || '')}</strong> back to inventory and demote the order to <strong>NEW</strong>?<br><br>This is the right move when you need to <em>edit lines</em> (change qty, swap lots, add/remove SKUs) on an already-allocated order. After unallocating you can edit freely, then click 🎯 Allocate again to re-allocate fresh.<br><br><span style="color:var(--amber);">Inventory returns to available at the same lot/LP/location it came from. The cancelled allocations stay in history with reason and your name.</span>`,
          url: `${API}/orders/${d.id}/unallocate-all`,
        });
      })
    );
  }

  document.getElementById('ordShipTo').innerHTML = `
    <div class="ord-shipto-name">${esc(d.ship_to_name || d.customer_name || '—')}</div>
    <div class="ord-shipto-addr">
      ${esc(d.ship_to_line1 || '')}<br>
      ${d.ship_to_line2 ? esc(d.ship_to_line2) + '<br>' : ''}
      ${esc([d.ship_to_city, d.ship_to_state, d.ship_to_postal].filter(Boolean).join(', '))}<br>
      ${esc(d.ship_to_country || 'US')}
    </div>
    ${d.customer_email ? `<div class="ui-hint">${esc(d.customer_email)}</div>` : ''}`;

  // Attachments — supporting docs bound to the order. Ops + portal both.
  loadOrderAttachments(id);

  uiTable('ordShipmentsWrap', {
    columns: [
      { key: 'shipment_number', label: 'Shipment', mono: true },
      { key: 'status', label: 'Status', render: sh => uiChip(sh.status) },
      { key: 'tracking_number', label: 'Tracking', mono: true },
      { key: '_label', label: '', render: sh => sh.label_url
          ? `<a class="ui-link" href="${esc(sh.label_url)}" target="_blank" rel="noopener">Label ↗</a>` : '' },
    ],
    rows: d.shipments || [], rowKey: 'id',
    empty: 'No shipments yet.',
  });

  document.getElementById('allocPanel').style.display = 'none';

  // Pick List takes over from Allocations history when order is actively pickable.
  // Hidden entirely for portal users — picking is an ops workflow.
  const portal = (typeof isPortalMode === 'function' && isPortalMode());
  const isPickable = !portal && ['ALLOCATED', 'PICKING'].includes(d.status);
  renderPickList(d, isPickable);

  const ah = document.getElementById('allocHistPanel');
  if(d.allocations?.length && !isPickable){
    ah.style.display = 'block';
    document.getElementById('allocHistBadge').textContent = d.allocations.length;
    // Destructive actions are hidden once SHIPPED (server rejects them anyway)
    // and for portal users (they're requireOps).
    const canEdit = !portal && d.status !== 'SHIPPED';

    uiTable('allocHistWrap', {
      columns: [
        { key: 'sku_code', label: 'SKU', mono: true },
        { key: '_lot', label: 'Lot', render: a => a.lot_number
            ? uiId(a.lot_number) : '<span class="ui-muted">—</span>' },
        { key: '_lp', label: 'LP', render: a => a.lp_number
            ? `<span class="lp-badge ${a.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(a.lp_number)}</span>`
            : '<span class="ui-muted">—</span>' },
        { key: 'location_code', label: 'Location', mono: true },
        { key: 'quantity', label: 'Qty', num: true },
        { key: 'status', label: 'Status', render: a => uiChip(a.status || 'PENDING') },
        { key: '_act', label: '', render: a => {
            if (!canEdit) return '';
            if (a.status === 'PENDING') return `<button class="ui-btn js-unallocate-btn" data-alloc-id="${esc(a.id)}">↺ Unallocate</button>`;
            if (a.status === 'PICKED')  return `<button class="ui-btn js-unpick-btn" data-alloc-id="${esc(a.id)}">↺ Unpick</button>`;
            return '';
          } },
      ],
      rows: d.allocations, rowKey: 'id',
    });

    ah.querySelectorAll('.js-unallocate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = d.allocations.find(x => x.id === btn.dataset.allocId);
        showDestructiveEdit({
          title: 'Unallocate',
          description: `Release <strong>${esc(a?.quantity || 0)}</strong> units of <strong>${esc(a?.sku_code || '')}</strong> from lot <strong>${esc(a?.lot_number || 'no lot')}</strong> back to available inventory? The allocation is marked CANCELLED and stays in history.`,
          url: `${API}/orders/${d.id}/allocations/${btn.dataset.allocId}/unallocate`,
        });
      });
    });
    ah.querySelectorAll('.js-unpick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = d.allocations.find(x => x.id === btn.dataset.allocId);
        showDestructiveEdit({
          title: 'Unpick',
          description: `Reverse the pick of <strong>${esc(a?.sku_code || '')}</strong> (${esc(a?.picked_qty || a?.quantity || 0)} units)? The allocation goes back to PENDING and has to be re-picked. The billing charge from the original pick stays on the order.`,
          url: `${API}/orders/${d.id}/allocations/${btn.dataset.allocId}/unpick`,
        });
      });
    });
  } else {
    ah.style.display = 'none';
  }
}

// =============================================================================
// DESTRUCTIVE EDIT MODAL — reusable PIN+reason gate for unallocate / unpick
// (and any future destructive action). Pops up the red-bordered modal,
// captures reason + PIN, POSTs to the supplied URL.
// =============================================================================

/* The PIN gate is a uiModal now — same two-factor discipline (reason + PIN),
 * validated per-field. The old fixed #destructiveEditModal markup is gone.
 * `description` is trusted HTML built by the caller (already esc()'d). */
function showDestructiveEdit(opts){
  uiModal({
    title: opts.title,
    width: 560,
    body:
      `<div class="ui-banner ui-banner-danger">${opts.description}</div>` +
      uiField({ id: 'deReason', label: 'Reason', placeholder: 'Why is this being reversed?',
                hint: 'Recorded against the allocation, with your name. Minimum 5 characters.' }) +
      uiField({ id: 'dePin', label: 'Supervisor PIN', type: 'password', placeholder: '4–8 digits' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Confirm', danger: true, onClick: async (m) => {
          const reason = m.el.querySelector('#deReason').value.trim();
          const pin    = m.el.querySelector('#dePin').value.trim();
          uiFieldError(m.el, 'deReason', reason.length >= 5 ? '' : 'At least 5 characters');
          uiFieldError(m.el, 'dePin', /^\d{4,8}$/.test(pin) ? '' : 'PIN must be 4–8 digits');
          if(reason.length < 5 || !/^\d{4,8}$/.test(pin)) return false;

          const r = await fetch(opts.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
            body: JSON.stringify({ pin, reason }),
          });
          const d = await r.json();
          if(!r.ok){ uiFieldError(m.el, 'dePin', d.error || 'Action rejected'); return false; }
          uiToast(`${opts.title} complete`);
          if(COI) openOrderDetail(COI);
        } },
    ],
  });
  setTimeout(() => document.getElementById('deReason')?.focus(), 50);
}

// =============================================================================
// PICK LIST (Phase 1C.2 — single-order picking)
// =============================================================================

function renderPickList(d, isPickable){
  const panel = document.getElementById('pickListPanel');
  if(!panel) return;
  // Pick list only shows ACTIVE allocations (PENDING + PICKED). CANCELLED
  // rows from a prior unallocate-all stay in the order's allocation
  // history (rendered separately when not pickable) but must not bleed
  // into the active pick list — otherwise the picker sees a phantom row
  // for inventory that was already returned to stock.
  const activeAllocs = (d.allocations || []).filter(a => a.status !== 'CANCELLED');
  if(!isPickable || !activeAllocs.length){
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  const allocs = activeAllocs;
  const picked = allocs.filter(a => a.status === 'PICKED').length;
  const total  = allocs.length;
  // Don't trust just "all allocations picked" — also verify every
  // order_line is FULLY allocated. A partial allocation can otherwise
  // sneak past as 'allDone' (1 of 2 lines fully allocated, that 1 line
  // gets picked, system thinks the order is done).
  const fullyAllocated = (d.lines || []).every(l =>
    Number(l.allocated_qty || 0) >= Number(l.ordered_qty || 0)
  );
  const allDone = fullyAllocated && picked === total;
  const pct = total ? Math.round((picked / total) * 100) : 0;

  document.getElementById('pickListBadge').textContent = `${picked} of ${total} picked`;
  document.getElementById('pickListBar').style.width = pct + '%';

  // Hazmat + special-handling ride on the joined sku columns from /orders/:id.
  // The picker must not be able to miss either one.
  const hazBadge = (a) => a.is_hazmat
    ? `<span class="ui-chip ui-chip-danger">⚠ HAZMAT${a.un_number ? ' ' + esc(a.un_number) : ''}${a.hazard_class ? ' · Cl ' + esc(a.hazard_class) : ''}</span> `
    : '';

  const wrap = document.getElementById('pickListWrap');
  uiTable(wrap, {
    columns: [
      { key: '_n', label: '#', render: (a) => uiNum(allocs.indexOf(a) + 1) },
      { key: '_lp', label: 'LP', render: a => a.lp_number
          ? `<span class="lp-badge ${a.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(a.lp_number)}</span>`
          : '<span class="ui-muted">—</span>' },
      { key: 'location_code', label: 'Location', mono: true },
      { key: '_lot', label: 'Lot', render: a => a.lot_number
          ? uiId(a.lot_number) : '<span class="ui-muted">—</span>' },
      { key: '_sku', label: 'SKU', render: a => `${uiId(a.sku_code || '')} ${severityChip(a, { size: 'sm' })}` },
      { key: '_desc', label: 'Description', render: a =>
          `${hazBadge(a)}${esc(a.sku_name || '')}` +
          (a.special_handling_instructions
            ? `<div class="ui-banner ui-banner-warn ord-pick-handling">📋 ${esc(a.special_handling_instructions)}</div>`
            : '') },
      { key: 'quantity', label: 'Qty', num: true },
      { key: '_act', label: 'Action', render: a => {
          if (a.status === 'PICKED') {
            const ts = a.picked_at
              ? new Date(a.picked_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : '';
            return `${uiChip('PICKED')} <span class="ui-hint">${esc(a.picked_by_name || '')}${a.picked_by_name && ts ? ' · ' : ''}${esc(ts)}</span>`;
          }
          return `<input type="number" class="ui-input ord-pick-qty js-pick-qty" data-id="${esc(a.id)}"
                    value="${esc(a.quantity)}" min="1" max="${esc(a.quantity)}">
                  <button class="ui-btn ui-btn-primary js-pick-confirm" data-id="${esc(a.id)}">Confirm</button>`;
        } },
    ],
    rows: allocs, rowKey: 'id',
  });

  wrap.querySelectorAll('.js-pick-confirm').forEach(btn => {
    btn.addEventListener('click', () => {
      const allocId = btn.dataset.id;
      const qty = parseInt(wrap.querySelector(`.js-pick-qty[data-id="${allocId}"]`)?.value) || 0;
      confirmPickAllocation(d.id, allocId, qty, btn);
    });
  });

  const completeBtn = document.getElementById('pickListComplete');
  completeBtn.style.display = allDone ? 'inline-flex' : 'none';
  // Complete Picking moves PICKING → PACKING (unified workflow, post-020 —
  // there is no separate PICKED stage anymore).
  completeBtn.onclick = () => transitionOrder(d.id, 'PACKING');
}

// =============================================================================
// SHIP ORDER (Phase 1E.basic)
// =============================================================================

let shipEpShipmentId   = null;  // EasyPost shipment id from the last rate quote
let shipSelectedRateId = null;  // rate the user picked
let SHIP_M             = null;  // open ship uiModal
let SHIP_BUY_BTN       = null;  // "Buy label & ship" action button

function resetShipRates(){
  shipEpShipmentId = null;
  shipSelectedRateId = null;
  const box = document.getElementById('shipRatesBox');
  if(box){
    box.style.display = 'none';
    document.getElementById('shipRatesList').innerHTML = '';
    document.getElementById('shipRatesHint').textContent = '';
  }
  if(SHIP_BUY_BTN) SHIP_BUY_BTN.disabled = true;
}

function showShipOrderModal(){
  if(!COI || !COD) return;
  shipEpShipmentId = null;
  shipSelectedRateId = null;

  SHIP_M = uiModal({
    title: `Ship ${COD.order_number || 'order'}`,
    width: 640,
    body: `
      <div class="ui-dialog-body" style="margin-bottom:14px;">
        Confirms physical shipment for <strong>${esc(COD.client_name || '')}</strong>: creates the
        shipment record, decrements inventory, rolls up shipped_qty, and fires the outbound-handling
        billing charge. Get live rates to buy a label, or ship without one (LTL / will-call / manual
        tracking).
      </div>
      <div class="ui-field-row">
        <div class="ui-field" data-field="shipCarrierWrap">
          <label class="ui-label">Carrier *</label>
          <div class="cb-wrap" id="shipCarrierWrap"></div>
          <div class="ui-field-err" style="display:none;"></div>
        </div>
        ${uiField({ id: 'shipServiceLevel', label: 'Service level', placeholder: 'GROUND, EXPRESS, LTL…' })}
      </div>
      ${uiField({ id: 'shipTracking', label: 'Tracking number', placeholder: '1Z…, 7XXX…' })}
      <div class="ship-dims">
        ${uiField({ id: 'shipWeight', label: 'Weight (lbs)', type: 'number' })}
        ${uiField({ id: 'shipLength', label: 'Length (in)', type: 'number' })}
        ${uiField({ id: 'shipWidth',  label: 'Width (in)',  type: 'number' })}
        ${uiField({ id: 'shipHeight', label: 'Height (in)', type: 'number' })}
      </div>
      <div class="ship-rates-bar">
        <button class="ui-btn" id="shipGetRatesBtn" onclick="getShipRates()">Get live rates</button>
        <span class="ui-hint" id="shipRatesHint"></span>
      </div>
      <div id="shipRatesBox" class="ship-rates" style="display:none;"><div id="shipRatesList"></div></div>
      <div class="ui-field-row">
        ${uiField({ id: 'shipCost', label: 'Ship cost ($)', type: 'number' })}
        ${uiField({ id: 'shipNotes', label: 'Notes', placeholder: 'Optional internal notes' })}
      </div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Buy label & ship', primary: true, onClick: buyShipLabel },
      { label: 'Ship without label', onClick: submitShipOrder },
    ],
    onClose: () => { SHIP_M = null; SHIP_BUY_BTN = null; },
  });

  // The "buy" action only makes sense once a rate is picked.
  SHIP_BUY_BTN = [...SHIP_M.el.querySelectorAll('.ui-dialog-actions button')]
    .find(b => b.textContent.includes('Buy label'));
  if(SHIP_BUY_BTN) SHIP_BUY_BTN.disabled = true;

  // A quote is only valid for the parcel it was quoted for — changing the
  // weight or dims silently invalidates it, so throw the rates away.
  ['shipWeight','shipLength','shipWidth','shipHeight'].forEach(id =>
    document.getElementById(id).addEventListener('input', () => {
      if(shipEpShipmentId) resetShipRates();
    }));

  if(COD.ship_method) document.getElementById('shipServiceLevel').value = COD.ship_method;

  initCombo('shipCarrierWrap', [
    { value:'UPS', label:'UPS' }, { value:'FEDEX', label:'FedEx' },
    { value:'USPS', label:'USPS' }, { value:'DHL', label:'DHL' },
    { value:'LTL', label:'LTL Carrier' }, { value:'OTHER', label:'Other' },
  ], { placeholder: 'Select carrier…', value: COD.carrier_code || '', allowCustom: true });
}

async function getShipRates(){
  if(!COI) return;
  const btn = document.getElementById('shipGetRatesBtn');
  resetShipRates();

  const weightLbs = parseFloat(document.getElementById('shipWeight').value);
  if(!weightLbs || weightLbs <= 0) return uiToast('Enter a parcel weight to get rates', 'error');

  btn.disabled = true;
  document.getElementById('shipRatesHint').textContent = 'Fetching rates…';
  try {
    const r = await fetch(`${API}/orders/${COI}/shipping/rates`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        weightLbs,
        lengthIn: parseFloat(document.getElementById('shipLength').value) || null,
        widthIn:  parseFloat(document.getElementById('shipWidth').value)  || null,
        heightIn: parseFloat(document.getElementById('shipHeight').value) || null,
      }),
    });
    const d = await r.json();
    if(!r.ok){
      document.getElementById('shipRatesHint').textContent = '';
      return uiToast(d.error || 'Rate lookup failed', 'error');
    }

    shipEpShipmentId = d.epShipmentId;
    document.getElementById('shipRatesHint').textContent =
      `${d.rates.length} rate${d.rates.length === 1 ? '' : 's'} — cheapest first`;
    document.getElementById('shipRatesList').innerHTML = d.rates.map(rt => `
      <label class="ship-rate">
        <input type="radio" name="shipRateChoice" value="${esc(rt.rateId)}">
        ${uiMoney(rt.rate)}
        <span class="ship-rate-svc">${esc(rt.carrierDisplay || rt.carrier)} · ${esc(rt.service)}</span>
        <span class="ui-hint">${rt.deliveryDays != null ? esc(rt.deliveryDays) + ' day(s)' : ''}</span>
      </label>`).join('');
    document.getElementById('shipRatesBox').style.display = 'block';
    document.querySelectorAll('input[name="shipRateChoice"]').forEach(inp =>
      inp.addEventListener('change', () => {
        shipSelectedRateId = inp.value;
        if(SHIP_BUY_BTN) SHIP_BUY_BTN.disabled = false;
      }));
  } catch(e){
    document.getElementById('shipRatesHint').textContent = '';
    uiToast('Network error — could not fetch rates', 'error');
  } finally {
    btn.disabled = false;
  }
}

// uiModal action: returning false keeps the modal open.
async function buyShipLabel(){
  if(!COI) return false;
  if(!shipEpShipmentId || !shipSelectedRateId){
    uiToast('Get live rates and pick one first', 'error');
    return false;
  }
  const num = (id) => parseFloat(document.getElementById(id).value) || null;
  const r = await fetch(`${API}/orders/${COI}/shipping/buy`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({
      epShipmentId: shipEpShipmentId,
      rateId:       shipSelectedRateId,
      weightLbs: num('shipWeight'), lengthIn: num('shipLength'),
      widthIn:   num('shipWidth'),  heightIn: num('shipHeight'),
      notes: document.getElementById('shipNotes').value || null,
    }),
  });
  const d = await r.json();
  if(!r.ok){ uiToast(d.error || 'Label purchase failed', 'error'); return false; }

  uiToast(`Shipped — ${d.shipmentNumber} · tracking ${d.trackingNumber || '—'}`);
  if(d.labelUrl) window.open(d.labelUrl, '_blank', 'noopener');
  openOrderDetail(COI);
}

async function submitShipOrder(){
  if(!COI) return false;
  const carrierCode = cbVal('shipCarrierWrap');
  if(!carrierCode){
    uiFieldError(document, 'shipCarrierWrap', 'Select a carrier');
    return false;
  }
  uiFieldError(document, 'shipCarrierWrap', '');

  const num = (id) => parseFloat(document.getElementById(id).value) || null;
  const r = await fetch(`${API}/orders/${COI}/ship`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({
      carrierCode,
      serviceLevel:   document.getElementById('shipServiceLevel').value || null,
      trackingNumber: document.getElementById('shipTracking').value || null,
      weightLbs: num('shipWeight'), lengthIn: num('shipLength'),
      widthIn:   num('shipWidth'),  heightIn: num('shipHeight'),
      shipCost:  num('shipCost'),
      notes: document.getElementById('shipNotes').value || null,
    }),
  });
  const d = await r.json();
  if(!r.ok){ uiToast(d.error || 'Ship failed', 'error'); return false; }

  uiToast(`Shipped — ${d.shipmentNumber}${d.billingCharge ? ` · billed ${fmtDollars(d.billingCharge.totalAmount)}` : ''}`);
  openOrderDetail(COI);
}

async function confirmPickAllocation(orderId, allocationId, quantity, btn){
  if(!quantity || quantity <= 0) return uiToast('Quantity must be greater than 0', 'error');
  if(btn) btn.disabled = true;
  try {
    const r = await fetch(`${API}/orders/${orderId}/picks/${allocationId}/confirm`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({quantity}),
    });
    const d = await r.json();
    if(!r.ok) return uiToast(d.error || 'Pick failed', 'error');
    uiToast(d.allPicked
      ? 'All picks complete — hit Complete picking when you\'re ready'
      : `Picked — ${d.pendingPicks} left`);
    openOrderDetail(orderId);
  } catch(e){
    uiToast('Network error — pick not recorded', 'error');
  } finally {
    if(btn) btn.disabled = false;
  }
}

function closeOrderDetail(){
  COI = null; COD = null;
  loadOrders();
}

async function transitionOrder(id, ns){
  if(ns === 'ALLOCATED' && COD?.status === 'NEW'){ showAllocPanel(id); return; }
  try {
    const r = await fetch(`${API}/orders/${id}/status`, {
      method:'PATCH',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({status: ns}),
    });
    const d = await r.json();
    if(!r.ok) return uiToast(d.error || 'Status change failed', 'error');
    uiToast(`Order is now ${ns}`);
    openOrderDetail(id);
  } catch(e){
    uiToast('Network error — status not changed', 'error');
  }
}

async function showAllocPanel(id){
  document.getElementById('allocPanel').style.display = 'block';
  const ll = document.getElementById('allocLinesList');
  ll.innerHTML = uiSpinner('Finding available inventory…');
  if(!COD?.lines) return;

  let html = '';
  for(let i = 0; i < COD.lines.length; i++){
    const ln = COD.lines[i];
    const rem = (ln.ordered_qty || 0) - (ln.allocated_qty || 0);
    if(rem <= 0) continue;
    const av = await apiGet(`/orders/${id}/available-inventory?skuId=${encodeURIComponent(ln.sku_id)}`);
    if(!av) continue;
    AIC[ln.id] = av.inventory || [];
    const pm = av.pickMode || 'FEFO';
    document.getElementById('allocModeBadge').textContent = pm;

    html += `
      <div class="alloc-line">
        <div class="alloc-line-head">
          ${uiId(ln.sku_code)}
          <span class="ui-muted">Line ${esc(ln.line_number)} · ${esc(ln.sku_name || '')}</span>
          <span style="flex:1"></span>
          <span class="ui-chip ui-chip-warn">Need ${esc(rem)} ${esc(ln.sku_uom || ln.uom || '')}</span>
        </div>`;

    if(!av.inventory?.length){
      // The line cannot be filled at all — say so loudly, not as a grey empty state.
      html += `<div class="ui-banner ui-banner-danger">No available inventory for ${esc(ln.sku_code)} — this line can't be allocated.</div>`;
    } else {
      html += `
        <div class="alloc-line-tools">
          <span class="ui-hint">Sorted ${esc(pm)}</span>
          <input type="text" class="ui-input js-alloc-search" id="als_${i}" data-idx="${i}"
                 placeholder="Filter by lot # or LP #…">
        </div>
        <table class="ui-table">
          <thead><tr>
            <th style="width:36px;">Sel</th><th>Lot</th><th>Expiry</th><th>LP</th><th>Type</th>
            <th>Location</th><th>Zone</th><th class="right">Available</th><th style="width:96px;">Qty</th>
          </tr></thead>
          <tbody id="atb_${i}">`;

      // Pre-fill down the pick-mode-sorted list until the need is covered.
      let rf = rem;
      av.inventory.forEach((inv, j) => {
        const sq = Math.min(rf, inv.available_qty);
        const as = sq > 0 && rf > 0;
        if(as) rf -= sq;
        const soon = inv.expiry_date && new Date(inv.expiry_date) < new Date(Date.now() + 30 * 864e5);
        const expiry = inv.expiry_date ? new Date(inv.expiry_date).toLocaleDateString() : '';
        html += `
          <tr id="ar_${i}_${j}" data-lot="${esc((inv.lot_number || '').toLowerCase())}" data-lp="${esc((inv.lp_number || '').toLowerCase())}">
            <td><input type="checkbox" class="alloc-chk js-alloc-chk" id="ac_${i}_${j}" data-i="${i}" data-j="${j}" ${as ? 'checked' : ''}></td>
            <td>${inv.lot_number ? uiId(inv.lot_number) : '<span class="ui-muted">—</span>'}</td>
            <td>${!expiry ? '<span class="ui-muted">—</span>'
                  : soon ? `<span class="ui-chip ui-chip-danger">${esc(expiry)}</span>` : uiId(expiry)}</td>
            <td>${inv.lp_number
                  ? `<span class="lp-badge ${inv.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(inv.lp_number)}</span>`
                  : '<span class="ui-muted">—</span>'}</td>
            <td>${esc(inv.lp_type || '')}</td>
            <td>${uiId(inv.location_code || '')}</td>
            <td><span class="ui-muted">${esc(inv.zone_name || '')}</span></td>
            <td class="right">${uiNum(inv.available_qty)}</td>
            <td><input type="number" class="ui-input alloc-qty" id="aq_${i}_${j}" value="${as ? sq : 0}"
                       min="0" max="${esc(inv.available_qty)}" ${!as ? 'disabled' : ''}></td>
          </tr>`;
      });
      html += '</tbody></table>';
    }
    html += `<input type="hidden" id="ali_${i}" value="${esc(ln.id)}"><input type="hidden" id="aln_${i}" value="${esc(rem)}"></div>`;
  }
  ll.innerHTML = html || uiEmpty('Every line is fully allocated.');

  ll.querySelectorAll('.js-alloc-chk').forEach(chk =>
    chk.addEventListener('change', () => tar(parseInt(chk.dataset.i), parseInt(chk.dataset.j))));
  ll.querySelectorAll('.js-alloc-search').forEach(inp =>
    inp.addEventListener('input', () => filterAR(parseInt(inp.dataset.idx))));
}

function tar(i, j){
  const c = document.getElementById(`ac_${i}_${j}`);
  const q = document.getElementById(`aq_${i}_${j}`);
  if(c && q){
    q.disabled = !c.checked;
    if(!c.checked) q.value = 0;
  }
}

function filterAR(i){
  const sv = (document.getElementById(`als_${i}`)?.value || '').toLowerCase();
  document.getElementById(`atb_${i}`)?.querySelectorAll('tr').forEach(r => {
    if(!sv){ r.style.display = ''; return; }
    r.style.display = (r.dataset.lot || '').includes(sv) || (r.dataset.lp || '').includes(sv) ? '' : 'none';
  });
}

async function submitAllocation(){
  if(!COI || !COD) return;
  const allocs = [];
  const mismatches = [];   // lines whose selected qty != what's needed

  for(let i = 0; ; i++){
    const el = document.getElementById(`ali_${i}`);
    if(!el) break;
    const olid = el.value;
    const need = parseInt(document.getElementById(`aln_${i}`)?.value) || 0;
    const inv  = AIC[olid] || [];
    const line = (COD.lines || []).find(l => l.id === olid);
    let lt = 0;

    for(let j = 0; j < inv.length; j++){
      const chk = document.getElementById(`ac_${i}_${j}`);
      const qi  = document.getElementById(`aq_${i}_${j}`);
      if(!chk?.checked) continue;
      const q = parseInt(qi?.value) || 0;
      if(q <= 0) continue;
      if(q > inv[j].available_qty){
        return uiToast(
          `${line?.sku_code || 'Line'}: can't allocate ${q} — only ${inv[j].available_qty} available`, 'error');
      }
      lt += q;
      allocs.push({
        orderLineId: olid,
        inventoryId: inv[j].inventory_id,
        lotId:       inv[j].lot_id,
        lpId:        inv[j].lp_id,
        locationId:  inv[j].location_id,
        quantity:    q,
      });
    }
    if(lt !== need) mismatches.push({ sku: line?.sku_code || `Line ${i + 1}`, picked: lt, need });
  }

  if(!allocs.length) return uiToast('Select some inventory to allocate first', 'error');

  // One review step for the whole allocation, instead of a native confirm()
  // per line — ops used to get up to N dialogs in a row for a multi-line order.
  if(mismatches.length){
    const rows = mismatches.map(m => `<tr>
      <td>${uiId(m.sku)}</td>
      <td class="right">${uiNum(m.need)}</td>
      <td class="right">${uiNum(m.picked)}</td>
      <td>${m.picked > m.need
            ? '<span class="ui-chip ui-chip-warn">over</span>'
            : '<span class="ui-chip ui-chip-danger">short</span>'}</td></tr>`).join('');
    const ok = await uiConfirm({
      title: 'Allocation doesn\'t match the order',
      body: `<table class="ui-table"><thead><tr><th>SKU</th><th class="right">Ordered</th>
             <th class="right">Allocating</th><th>—</th></tr></thead><tbody>${rows}</tbody></table>
             <p>Short lines leave the order un-shippable until the rest is allocated.
             Over-allocated lines ship more than the customer ordered.</p>`,
      confirmLabel: 'Allocate anyway',
    });
    if(!ok) return;
  }

  try {
    const r = await fetch(`${API}/orders/${COI}/allocate`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({allocations: allocs}),
    });
    const d = await r.json();
    if(!r.ok) return uiToast(d.error || 'Allocation failed', 'error');
    uiToast(`Allocated ${d.allocationsCreated} line(s)`);
    openOrderDetail(COI);
  } catch(e){
    uiToast('Network error — nothing was allocated', 'error');
  }
}

// =============================================================================
// NEW ORDER MODAL
// =============================================================================

async function showNewOrderModal(){
  await loadCC();
  const m = document.getElementById('newOrderModal');
  m.style.display = 'flex'; m.style.zIndex = '10000';

  initCombo('noClientWrap',
    clientsCache.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`})),
    {placeholder:'Select client...', onChange:(v) => { if(v) onOrderClientChange(v); }}
  );
  initCombo('noChannelWrap', [
    {value:'MANUAL',label:'Manual'},{value:'SHOPIFY',label:'Shopify'},
    {value:'EDI',label:'EDI'},{value:'PHONE',label:'Phone'},{value:'EMAIL',label:'Email'},
  ], {placeholder:'Select...', value:'MANUAL'});
  initCombo('noTypeWrap', [
    {value:'FULFILLMENT',label:'Fulfillment'},{value:'B2B',label:'B2B'},
  ], {placeholder:'Select...', value:'FULFILLMENT'});
  initCombo('noPriorityWrap', [
    {value:'5',label:'Normal (5)'},{value:'7',label:'High (7)'},
    {value:'9',label:'Rush (9)'},{value:'3',label:'Low (3)'},
  ], {placeholder:'Select...', value:'5'});
  initCombo('noCarrierWrap', [
    {value:'UPS',label:'UPS'},{value:'FEDEX',label:'FedEx'},{value:'USPS',label:'USPS'},
    {value:'DHL',label:'DHL'},{value:'OTHER',label:'LTL/Other'},
  ], {placeholder:'Select carrier...'});
  initCombo('noPriorAddrWrap', [],
    {placeholder:'Load from prior order...', onChange:(v) => fillPriorAddress(v)});

  orderLines = [];
  renderOL();
  document.getElementById('noError').textContent = '';
  // Order number is now generated server-side via a Postgres sequence
  // (starts at 500000, increments by 1) when the field is left blank.
  // Client-side random generation removed — collisions and gaps were
  // both possible under concurrency. Ops can still type an explicit
  // number here if they want to mirror an external order.
  document.getElementById('noOrderNum').value = '';
  document.getElementById('noOrderNum').placeholder = 'Auto-generated (or type to override)';
}

async function onOrderClientChange(cid){
  if(!cid) cid = cbVal('noClientWrap');
  if(!cid) return;
  const addrs = await apiGet(`/ship-to-addresses?clientId=${encodeURIComponent(cid)}`);
  window._priorAddrs = addrs || [];
  initCombo('noPriorAddrWrap',
    (addrs || []).map((a, i) => ({
      value: String(i),
      label: `${a.ship_to_name} — ${a.ship_to_line1}, ${a.ship_to_city}`,
    })),
    {placeholder:'Load from prior order...', onChange:(v) => fillPriorAddress(v)}
  );
  orderLines = [];
  renderOL();
}

// FIX: previously referenced non-existent #noCarrier (carrier is now a combo).
function fillPriorAddress(idx){
  const i = parseInt(idx);
  const addrs = window._priorAddrs || [];
  if(isNaN(i) || !addrs.length) return;
  const a = addrs[i];
  document.getElementById('noCustName').value  = a.customer_name || a.ship_to_name || '';
  document.getElementById('noCustEmail').value = a.customer_email || '';
  document.getElementById('noAddr1').value     = a.ship_to_line1 || '';
  document.getElementById('noAddr2').value     = a.ship_to_line2 || '';
  document.getElementById('noCity').value      = a.ship_to_city || '';
  document.getElementById('noState').value     = a.ship_to_state || '';
  document.getElementById('noPostal').value    = a.ship_to_postal || '';
  document.getElementById('noCountry').value   = a.ship_to_country || 'US';
  if(a.carrier_code) cbSet('noCarrierWrap', a.carrier_code, a.carrier_code);
  if(a.ship_method)  document.getElementById('noShipMethod').value = a.ship_method;
}

async function searchOrderSkus(){
  const cid = cbVal('noClientWrap');
  const s   = document.getElementById('noSkuSearch').value;
  const div = document.getElementById('noSkuResults');
  if(!cid){ div.style.display = 'none'; return; }

  const [skuRes, invRes] = await Promise.all([
    apiGet(`/skus?clientId=${encodeURIComponent(cid)}&search=${encodeURIComponent(s)}`),
    s ? apiGet(`/inventory?limit=100&status=available&skuCode=${encodeURIComponent('%' + s + '%')}&clientId=${encodeURIComponent(cid)}`) : Promise.resolve([]),
  ]);

  // Merge SKU results with inventory lot-search results — using REAL sku_id only.
  const skuMap = {};
  (skuRes || []).forEach(x => { skuMap[String(x.id)] = x; });

  const invRows = invRes?.rows || invRes || [];
  invRows.forEach(r => {
    if(!r.sku_code || !r.sku_id) return;     // FIX: require real sku_id (no synthetic IDs)
    const key = String(r.sku_id);
    if(skuMap[key]){
      skuMap[key].qty_available = (skuMap[key].qty_available || 0) + Number(r.quantity || 0);
    } else {
      skuMap[key] = {
        id: r.sku_id,
        sku_code: r.sku_code,
        name: r.sku_name || '',
        uom: r.uom || r.sku_type || 'EACH',
        qty_available: Number(r.quantity || 0),
      };
    }
  });

  const d = Object.values(skuMap);
  if(!d?.length){
    div.innerHTML = '<div class="empty-state" style="padding:12px;">No SKUs or lots found</div>';
    div.style.display = 'block';
    return;
  }

  // SKUs that matched via lot search → auto-expand
  const autoExpand = s && invRows.length > 0
    ? new Set(invRows.map(r => r.sku_code))
    : new Set();

  div.innerHTML = d.map(x => {
    const availColor = (x.qty_available || 0) > 0 ? 'var(--green)' : 'var(--red)';
    return `
      <div style="border-bottom:1px solid var(--border);">
        <div class="js-sku-row"
             data-sku-id="${esc(x.id)}"
             data-sku-code="${esc(x.sku_code)}"
             data-sku-name="${esc(x.name || '')}"
             data-uom="${esc(x.uom)}"
             data-avail="${esc(x.qty_available || 0)}"
             style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;font-size:13px;">
          <span style="font-weight:600;color:var(--blue);">${esc(x.sku_code)}</span>
          <span style="color:var(--text2);">${esc(x.name || '')}</span>
          <span style="margin-left:auto;color:${availColor};font-weight:600;">${esc(x.qty_available || 0)} avail</span>
          <span class="js-sku-arrow" style="color:var(--muted);font-size:11px;">▶</span>
        </div>
        <div class="sku-lots" id="lots_${esc(x.id)}" style="display:none;"></div>
      </div>`;
  }).join('');
  div.style.display = 'block';

  div.querySelectorAll('.js-sku-row').forEach(row => {
    row.addEventListener('click', () => {
      const filter = document.getElementById('noSkuSearch').value;
      expandSkuLots(row, row.dataset.skuId, row.dataset.skuCode, row.dataset.skuName, row.dataset.uom, parseInt(row.dataset.avail) || 0, filter);
    });
  });

  if(autoExpand.size > 0){
    div.querySelectorAll('.js-sku-row').forEach(row => {
      if(autoExpand.has(row.dataset.skuCode)){
        expandSkuLots(row, row.dataset.skuId, row.dataset.skuCode, row.dataset.skuName, row.dataset.uom, parseInt(row.dataset.avail) || 0, s);
      }
    });
  }
}

async function expandSkuLots(el, skuId, skuCode, skuName, uom, totalAvail, lotFilter){
  const lotsDiv = document.getElementById('lots_' + skuId);
  if(!lotsDiv) return;
  const arrow = el.querySelector('.js-sku-arrow');
  if(lotsDiv.style.display === 'block'){
    lotsDiv.style.display = 'none';
    if(arrow) arrow.textContent = '▶';
    return;
  }
  if(arrow) arrow.textContent = '▼';
  lotsDiv.style.display = 'block';
  lotsDiv.innerHTML = '<div style="padding:8px 16px 8px 32px;color:var(--muted);font-size:12px;">Loading lots...</div>';

  const cid = cbVal('noClientWrap');
  const d = await apiGet(`/inventory?limit=100&clientId=${encodeURIComponent(cid)}&skuCode=${encodeURIComponent('%' + skuCode + '%')}&status=available`);
  const allRows = (d?.rows || d || []).filter(r => r.quantity > 0);

  const lf = (lotFilter || '').toLowerCase().trim();
  const skuMatches = lf && (skuCode.toLowerCase().includes(lf) || skuName.toLowerCase().includes(lf));
  const rows = (lf && !skuMatches)
    ? allRows.filter(r => (r.lot_number || '').toLowerCase().includes(lf))
    : allRows;

  if(!rows.length){
    lotsDiv.innerHTML = '<div style="padding:8px 16px 8px 32px;color:var(--muted);font-size:12px;">No available inventory</div>';
    return;
  }

  const header = `
    <div style="padding:6px 16px 6px 32px;display:grid;grid-template-columns:140px 100px 130px 120px 60px 80px;gap:8px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid var(--border);background:rgba(0,0,0,.15);">
      <span>Lot</span><span>Expiry</span><span>LP</span><span>Location</span><span>Qty</span><span></span>
    </div>`;

  const body = rows.map(r => {
    const expiringSoon = r.expiry_date && new Date(r.expiry_date) < new Date(Date.now() + 30 * 864e5);
    const lpClass = r.lp_type === 'CHILD' ? 'lp-child' : 'lp-original';
    return `
      <div class="js-lot-row"
           data-sku-id="${esc(skuId)}"
           data-sku-code="${esc(skuCode)}"
           data-sku-name="${esc(skuName)}"
           data-uom="${esc(uom)}"
           data-lot="${esc(r.lot_number || '')}"
           data-expiry="${esc(r.expiry_date || '')}"
           data-lp="${esc(r.lp_number || '')}"
           data-location="${esc(r.location_code || '')}"
           data-qty="${esc(r.quantity || 0)}"
           style="padding:8px 16px 8px 32px;border-top:1px solid var(--border);display:grid;grid-template-columns:140px 100px 130px 120px 60px 80px;align-items:center;gap:8px;font-size:12px;cursor:pointer;transition:background .1s;">
        <span style="color:var(--blue);font-weight:600;">${esc(r.lot_number || 'No lot')}</span>
        <span style="color:${expiringSoon ? 'var(--red)' : 'var(--text2)'};">${esc(r.expiry_date ? new Date(r.expiry_date).toLocaleDateString() : '—')}</span>
        <span class="lp-badge ${lpClass}">${esc(r.lp_number || '—')}</span>
        <span style="color:var(--muted);">${esc(r.location_code || '—')}</span>
        <span style="font-weight:600;color:var(--green);">${esc(r.quantity)}</span>
        <span style="color:var(--blue);font-size:11px;font-weight:600;">+ Add</span>
      </div>`;
  }).join('');

  lotsDiv.innerHTML = header + body;

  lotsDiv.querySelectorAll('.js-lot-row').forEach(row => {
    row.addEventListener('mouseover', () => row.style.background = 'var(--hover)');
    row.addEventListener('mouseout',  () => row.style.background = '');
    row.addEventListener('click', () => {
      addOLWithLot(
        row.dataset.skuId, row.dataset.skuCode, row.dataset.skuName, row.dataset.uom,
        row.dataset.lot, row.dataset.expiry, row.dataset.lp, row.dataset.location,
        Number(row.dataset.qty)
      );
    });
  });
}

function addOLWithLot(skuId, skuCode, skuName, uom, lotNum, expiry, lpNum, location, avail){
  const key = skuId + '_' + (lotNum || 'nolot');
  if(orderLines.find(l => l._key === key)) return;
  orderLines.push({
    _key: key, skuId, code: skuCode, name: skuName, uom,
    lotNum, expiry, lpNum, location, avail, qty: 1,
  });
  renderOL();
  document.getElementById('noSkuSearch').value = '';
  document.getElementById('noSkuResults').style.display = 'none';
}

function addOL(id, code, name, uom, avail){
  addOLWithLot(id, code, name, uom, '', '', '', '', avail);
}

function renderOL(){
  const b = document.getElementById('noLinesBody');
  const e = document.getElementById('noLinesEmpty');
  if(!orderLines.length){
    b.innerHTML = '';
    e.style.display = 'block';
    return;
  }
  e.style.display = 'none';

  b.innerHTML = orderLines.map((l, i) => `
    <tr>
      <td style="font-weight:600;color:var(--blue);">${esc(l.code)}</td>
      <td style="color:var(--text2);font-size:12px;">${esc(l.name)}</td>
      <td style="color:var(--blue);font-size:12px;">${esc(l.lotNum || '—')}</td>
      <td style="font-size:12px;color:var(--text2);">${esc(l.expiry ? new Date(l.expiry).toLocaleDateString() : '—')}</td>
      <td style="font-size:12px;">${l.lpNum ? `<span class="lp-badge lp-original">${esc(l.lpNum)}</span>` : '—'}</td>
      <td style="font-size:12px;color:var(--muted);">${esc(l.location || '—')}</td>
      <td class="right" style="color:var(--green);font-size:12px;">${esc(l.avail)}</td>
      <td><input type="number" class="form-input js-ol-qty" data-i="${i}" value="${esc(l.qty)}" min="1" max="${esc(l.avail)}" style="width:72px;padding:6px 8px;"></td>
      <td><button class="btn btn-ghost js-ol-remove" data-i="${i}" style="padding:4px 8px;color:var(--red);">✕</button></td>
    </tr>`).join('');

  b.querySelectorAll('.js-ol-qty').forEach(inp => {
    inp.addEventListener('change', () => {
      orderLines[parseInt(inp.dataset.i)].qty = parseInt(inp.value) || 1;
    });
  });
  b.querySelectorAll('.js-ol-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      orderLines.splice(parseInt(btn.dataset.i), 1);
      renderOL();
    });
  });
}

async function submitNewOrder(){
  const err = document.getElementById('noError');
  err.textContent = '';
  const cid = cbVal('noClientWrap');
  const num = document.getElementById('noOrderNum').value.trim();
  const cn  = document.getElementById('noCustName').value.trim();
  if(!cid){ err.textContent = 'Select a client'; return; }
  if(!orderLines.length){ err.textContent = 'Add at least one line'; return; }
  if(!cn){ err.textContent = 'Enter customer name'; return; }

  try {
    const r = await fetch(`${API}/orders`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        clientId: cid,
        // Order number is optional — backend auto-generates from the
        // orders_order_number_seq sequence when left blank. Pass null
        // (not '') so the backend's "no orderNumber" branch fires
        // cleanly.
        orderNumber: num || null,
        channel: cbVal('noChannelWrap') || 'MANUAL',
        orderType: cbVal('noTypeWrap') || 'FULFILLMENT',
        priority: parseInt(cbVal('noPriorityWrap')) || 5,
        carrierCode: cbVal('noCarrierWrap') || null,
        shipMethod: document.getElementById('noShipMethod').value || null,
        requiredShipDate: document.getElementById('noShipDate').value || null,
        customerName: cn,
        customerEmail: document.getElementById('noCustEmail').value || null,
        shipTo: {
          name: cn,
          line1:   document.getElementById('noAddr1').value,
          line2:   document.getElementById('noAddr2').value,
          city:    document.getElementById('noCity').value,
          state:   document.getElementById('noState').value,
          postal:  document.getElementById('noPostal').value,
          country: document.getElementById('noCountry').value || 'US',
        },
        lines: orderLines.map(l => ({skuId: l.skuId, qty: l.qty, uom: l.uom})),
      }),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    closeModal('newOrderModal');

    // Drop the user straight into allocation for the order they just
    // created — the most natural next step is "now decide which lots
    // fulfill it", and forcing them to bounce back to the list and find
    // the order again was a documented friction point.
    if(d.id){
      await openOrderDetail(d.id);
      // Small delay so COD is populated by the detail load before we
      // try to render allocation lines off it
      setTimeout(() => {
        if(typeof showAllocPanel === 'function') showAllocPanel(d.id);
        // Scroll the allocate panel into view
        const ap = document.getElementById('allocPanel');
        if(ap) ap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 250);
    } else {
      loadOrders();
    }
  } catch(e){
    err.textContent = 'Network error';
  }
}

// =============================================================================
// ORDER ATTACHMENTS — supporting documents bound to the order detail page.
// Wired from openOrderDetail. Available to both ops and portal users; portal
// users can only upload/view their own client's order attachments (enforced
// by the API).
// =============================================================================

const ORD_ATTACH_MAX = 25 * 1024 * 1024;   // matches the API's multer limit

async function loadOrderAttachments(orderId){
  const list  = document.getElementById('ordAttachList');
  const count = document.getElementById('ordAttachCount');
  if(!list) return;

  // Wire the file input once — it reads COI at upload time.
  const input = document.getElementById('ordAttachInput');
  if(input && !input._wired){
    input._wired = true;
    input.addEventListener('change', async ev => {
      const files = Array.from(ev.target.files || []);
      ev.target.value = '';
      const id = COI;
      if(!id || !files.length) return;
      let done = 0;
      for(const f of files){
        if(f.size > ORD_ATTACH_MAX){
          uiToast(`${f.name} is ${(f.size / 1048576).toFixed(1)}MB — 25MB max`, 'error');
          continue;
        }
        try {
          const fd = new FormData();
          fd.append('file', f);
          const r = await fetch(`${API}/orders/${id}/attachments`, {
            method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd,
          });
          if(!r.ok){
            const d = await r.json().catch(() => ({}));
            uiToast(`${f.name} failed: ${d.error || r.status}`, 'error');
            continue;
          }
          done++;
        } catch(e){
          uiToast(`${f.name} — network error`, 'error');
        }
      }
      if(done) uiToast(`${done} file${done === 1 ? '' : 's'} attached`);
      loadOrderAttachments(id);
    });
  }

  list.innerHTML = uiSpinner('Loading attachments…');
  const rows = await apiGet(`/orders/${orderId}/attachments`);
  if(!rows){
    list.innerHTML = uiError('Could not load attachments');
    if(count) count.textContent = '';
    return;
  }
  if(count) count.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? 'file' : 'files'}` : '';
  if(!rows.length){ list.innerHTML = uiEmpty('No attachments'); return; }

  // DELETE is requireOps — portal users get view/open only.
  const portal = (typeof isPortalMode === 'function' && isPortalMode());

  list.innerHTML = rows.map(r => {
    const bytes = Number(r.size_bytes || 0);
    const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
    const ext = ((r.filename || '').split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
    return `<div class="ui-file">
      <span class="ui-file-ext">${esc(ext)}</span>
      <span class="ui-file-meta">
        <span class="ui-file-name">${esc(r.filename || '')}</span>
        <span class="ui-hint">${esc(size)} · ${esc(r.uploaded_by || '')} · ${esc(r.uploaded_at ? fmtTimeShort(r.uploaded_at) : '')}</span>
      </span>
      <button class="ui-btn js-ord-att-dl" data-att-id="${esc(r.id)}">Open</button>
      ${portal ? '' : `<button class="ui-btn js-ord-att-rm" data-att-id="${esc(r.id)}" aria-label="Remove attachment">✕</button>`}
    </div>`;
  }).join('');

  list.querySelectorAll('.js-ord-att-dl').forEach(btn =>
    btn.addEventListener('click', () => openOrderAttachment(orderId, btn.dataset.attId)));
  list.querySelectorAll('.js-ord-att-rm').forEach(btn =>
    btn.addEventListener('click', () => deleteOrderAttachment(orderId, btn.dataset.attId)));
}

async function openOrderAttachment(orderId, attId){
  const d = await apiGet(`/orders/${orderId}/attachments/${attId}/url`);
  if(!d?.url) return uiToast('Could not get a download link for that file', 'error');
  window.open(d.url, '_blank', 'noopener');
}

async function deleteOrderAttachment(orderId, attId){
  const ok = await uiConfirm({
    title: 'Remove this attachment?',
    body: 'The file is deleted from the order. This cannot be undone.',
    confirmLabel: 'Remove', danger: true,
  });
  if(!ok) return;
  const r = await fetch(`${API}/orders/${orderId}/attachments/${attId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${T}` },
  });
  if(!r.ok){
    const d = await r.json().catch(() => ({}));
    return uiToast(d.error || 'Delete failed', 'error');
  }
  uiToast('Attachment removed');
  loadOrderAttachments(orderId);
}

// =============================================================================
// PRINT DOCS — opens a printable HTML window for the current order. The
// renderers live in printDocs.js; we just hand them the order detail
// payload from /orders/:id (which now includes client_full /
// warehouse_full / per-line hazmat + freight fields).
// =============================================================================

async function printOrderDoc(kind){
  if(!COI) return uiToast('No order selected', 'error');
  // Re-fetch so we always print the latest state — nobody should print a
  // stale doc after an allocate / pick / ship.
  const order = await apiGet(`/orders/${COI}`);
  if(!order) return uiToast('Could not load the order to print', 'error');
  if(kind === 'pick')         renderPickSlip(order);
  else if(kind === 'packing') renderPackingSlip(order);
  else if(kind === 'bol')     renderBol(order);
}

// =============================================================================
// EDIT ORDER — header-level fields only (customer / ship-to / dates /
// notes / carrier). Allowed any time before SHIPPED. Lines + allocations
// stay as-is — line edits are a future feature.
// =============================================================================

/* One PIN gate for every line edit that touches an allocated order — replaces
 * the three separate prompt()-for-PIN chains that used to live in
 * addNewOrderLine / saveEditedLineQty / removeOrderLine.
 * Resolves to the PIN string, or null if cancelled. */
function askSupervisorPin({ title, body }){
  return new Promise((resolve) => {
    let settled = false;
    uiModal({
      title, width: 460,
      body: `<div class="ui-banner ui-banner-warn">${body}</div>` +
            uiField({ id: 'spPin', label: 'Supervisor PIN', type: 'password', placeholder: '4–8 digits' }),
      actions: [
        { label: 'Cancel' },
        { label: 'Authorize', primary: true, onClick: (m) => {
            const pin = m.el.querySelector('#spPin').value.trim();
            if(!/^\d{4,8}$/.test(pin)){
              uiFieldError(m.el, 'spPin', 'PIN must be 4–8 digits');
              return false;
            }
            settled = true;
            resolve(pin);
          } },
      ],
      onClose: () => { if(!settled) resolve(null); },
    });
    setTimeout(() => document.getElementById('spPin')?.focus(), 50);
  });
}

// The order needs a PIN for line edits only once it has live allocations.
function editNeedsPin(){
  return (COD?.allocations || []).some(a => a.status !== 'CANCELLED');
}

let EDIT_M = null;   // open edit-order uiModal

function openEditOrderModal(){
  if(!COI || !COD) return;
  if(COD.status === 'SHIPPED'){
    return uiToast('A SHIPPED order can\'t be edited — it has already left the warehouse', 'error');
  }

  const v = (x) => x || '';
  EDIT_M = uiModal({
    title: `Edit ${COD.order_number || 'order'}`,
    width: 680,
    body: `
      <div class="ui-hint" style="margin-bottom:14px;">
        Header fields and line items. Changes that touch allocated quantity need a supervisor PIN.
      </div>
      <div class="ui-field-row">
        ${uiField({ id: 'eoExternalNum', label: 'External order #', value: v(COD.external_order_number) })}
        ${uiField({ id: 'eoProNum', label: 'PRO # (carrier tracking)', value: v(COD.pro_number), placeholder: 'e.g. 12345-6789' })}
      </div>
      <div class="ui-field-row">
        ${uiField({ id: 'eoShipDate', label: 'Required ship date', type: 'date',
                    value: COD.required_ship_date ? String(COD.required_ship_date).slice(0, 10) : '' })}
        ${uiField({ id: 'eoCarrierCode', label: 'Carrier code', value: v(COD.carrier_code) })}
      </div>
      ${uiField({ id: 'eoShipMethod', label: 'Ship method', value: v(COD.ship_method), placeholder: 'GROUND, EXPRESS, LTL…' })}

      <div class="eo-section">
        <div class="ui-label">Customer / ship to</div>
        <div class="ui-field-row">
          ${uiField({ id: 'eoCustName', label: 'Customer name', value: v(COD.customer_name) })}
          ${uiField({ id: 'eoCustEmail', label: 'Customer email', type: 'email', value: v(COD.customer_email) })}
        </div>
        ${uiField({ id: 'eoShipName', label: 'Ship-to name', value: v(COD.ship_to_name) })}
        ${uiField({ id: 'eoAddr1', label: 'Address line 1', value: v(COD.ship_to_line1) })}
        ${uiField({ id: 'eoAddr2', label: 'Address line 2', value: v(COD.ship_to_line2) })}
        <div class="eo-addr-row">
          ${uiField({ id: 'eoCity', label: 'City', value: v(COD.ship_to_city) })}
          ${uiField({ id: 'eoState', label: 'State', value: v(COD.ship_to_state) })}
          ${uiField({ id: 'eoPostal', label: 'Postal', value: v(COD.ship_to_postal) })}
          ${uiField({ id: 'eoCountry', label: 'Country', value: COD.ship_to_country || 'US' })}
        </div>
      </div>
      ${uiField({ id: 'eoNotes', label: 'Notes', value: v(COD.notes) })}

      <div class="eo-section">
        <div class="eo-lines-head">
          <div class="ui-label">Line items</div>
          <span class="ui-hint">Qty changes on allocated lines need a PIN</span>
          <span style="flex:1"></span>
          <button type="button" class="ui-btn" id="eoAddLineBtn">+ Add line</button>
        </div>
        <div id="eoLinesBody"></div>
        <div id="eoAddLineForm" class="eo-add-line" style="display:none;">
          <div class="ui-label">New line</div>
          <div class="eo-add-row">
            <div class="ui-field eo-add-sku" data-field="eoNewSkuSearch">
              <input type="text" class="ui-input" id="eoNewSkuSearch" placeholder="Search SKU code or name…">
              <div id="eoNewSkuResults" class="eo-sku-results"></div>
              <input type="hidden" id="eoNewSkuId">
              <div class="ui-field-err" style="display:none;"></div>
            </div>
            <input type="number" class="ui-input eo-add-qty" id="eoNewQty" min="1" step="1" placeholder="Qty">
            <input type="text" class="ui-input eo-add-uom" id="eoNewUom" value="EACH">
            <button type="button" class="ui-btn ui-btn-primary" id="eoSaveLineBtn">Add</button>
            <button type="button" class="ui-btn" id="eoCancelLineBtn">Cancel</button>
          </div>
        </div>
      </div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Save changes', primary: true, onClick: submitEditOrder },
    ],
    onClose: () => { EDIT_M = null; },
  });

  renderEditOrderLines();
  wireEditOrderLineHandlers();
}

// ---- Edit Order: line item editor ----------------------------------

function renderEditOrderLines(){
  const body = document.getElementById('eoLinesBody');
  if(!body) return;
  const lines = COD?.lines || [];
  if(!lines.length){
    body.innerHTML = uiEmpty('No line items — add one.');
    return;
  }
  body.innerHTML = lines.map(l => {
    const allocated = Number(l.allocated_qty || 0);
    const hasAlloc  = allocated > 0;
    return `
      <div class="eo-line">
        <div class="eo-line-info">
          <div>${uiId(l.sku_code || '')}</div>
          <div class="ui-hint">${esc(l.sku_name || '')}</div>
          ${hasAlloc ? `<div class="eo-line-lock">${esc(allocated)} already allocated — PIN needed to reduce or remove</div>` : ''}
        </div>
        <input type="number" class="ui-input eo-line-qty js-eo-line-qty" data-line-id="${esc(l.id)}"
               data-original="${esc(l.ordered_qty)}" min="${esc(allocated)}" step="1" value="${esc(l.ordered_qty || 0)}">
        <span class="ui-hint">${esc(l.sku_uom || l.uom || 'EA')}</span>
        <button type="button" class="ui-btn js-eo-line-rm" data-line-id="${esc(l.id)}"
                data-has-alloc="${hasAlloc ? '1' : '0'}" aria-label="Remove line">✕</button>
      </div>`;
  }).join('');

  // Wire qty inputs to save on blur (PIN prompted when needed by server)
  body.querySelectorAll('.js-eo-line-qty').forEach(inp => {
    inp.addEventListener('change', e => saveEditedLineQty(e.target));
  });
  body.querySelectorAll('.js-eo-line-rm').forEach(btn => {
    btn.addEventListener('click', () => removeOrderLine(btn.dataset.lineId, btn.dataset.hasAlloc === '1'));
  });
}

function wireEditOrderLineHandlers(){
  const addBtn  = document.getElementById('eoAddLineBtn');
  const saveBtn = document.getElementById('eoSaveLineBtn');
  const cancelBtn = document.getElementById('eoCancelLineBtn');
  const search  = document.getElementById('eoNewSkuSearch');
  if(addBtn && !addBtn._wired){
    addBtn._wired = true;
    addBtn.addEventListener('click', () => {
      document.getElementById('eoAddLineForm').style.display = 'block';
      document.getElementById('eoNewSkuSearch').value = '';
      document.getElementById('eoNewSkuId').value = '';
      document.getElementById('eoNewQty').value = '';
      document.getElementById('eoNewUom').value = 'EACH';
      setTimeout(() => search.focus(), 50);
    });
  }
  if(cancelBtn && !cancelBtn._wired){
    cancelBtn._wired = true;
    cancelBtn.addEventListener('click', () => {
      document.getElementById('eoAddLineForm').style.display = 'none';
    });
  }
  if(saveBtn && !saveBtn._wired){
    saveBtn._wired = true;
    saveBtn.addEventListener('click', addNewOrderLine);
  }
  if(search && !search._wired){
    search._wired = true;
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => searchEditOrderSkus(search.value.trim()), 300);
    });
  }
}

async function searchEditOrderSkus(term){
  const results = document.getElementById('eoNewSkuResults');
  if(!COD?.client_id || !results) return;
  let url = `/skus?clientId=${encodeURIComponent(COD.client_id)}&limit=10`;
  if(term) url += `&search=${encodeURIComponent(term)}`;
  const list = await apiGet(url);
  const rows = Array.isArray(list) ? list : (list?.rows || list?.data || []);
  results.style.display = 'block';
  if(!rows.length){ results.innerHTML = uiEmpty('No matching SKUs'); return; }

  results.innerHTML = rows.map(r => `
    <div class="eo-sku-pick js-eo-sku-pick" data-sku-id="${esc(r.id)}" data-sku-code="${esc(r.sku_code)}"
         data-sku-name="${esc(r.name || '')}" data-uom="${esc(r.uom || 'EACH')}">
      ${uiId(r.sku_code)} <span class="ui-muted">${esc(r.name || '')}</span>
    </div>`).join('');
  results.querySelectorAll('.js-eo-sku-pick').forEach(el =>
    el.addEventListener('click', () => {
      document.getElementById('eoNewSkuId').value = el.dataset.skuId;
      document.getElementById('eoNewSkuSearch').value = `${el.dataset.skuCode} — ${el.dataset.skuName}`;
      document.getElementById('eoNewUom').value = el.dataset.uom;
      results.style.display = 'none';
      document.getElementById('eoNewQty').focus();
    }));
}

// Refresh COD from the server after any line mutation so allocated_qty and
// friends stay honest.
async function refreshEditOrderLines(){
  const fresh = await apiGet(`/orders/${COI}`);
  if(fresh){ COD = fresh; renderEditOrderLines(); }
}

async function addNewOrderLine(){
  const skuId = document.getElementById('eoNewSkuId').value;
  const qty   = Number(document.getElementById('eoNewQty').value);
  const uom   = document.getElementById('eoNewUom').value.trim() || 'EACH';

  if(!skuId) return uiToast('Pick a SKU first', 'error');
  if(!qty || qty <= 0) return uiToast('Quantity must be greater than 0', 'error');

  let pin = null;
  if(editNeedsPin()){
    pin = await askSupervisorPin({
      title: 'Add a line to an allocated order',
      body: 'This order already has allocations. Adding a line changes what the warehouse has to fulfil, so it needs supervisor authorization.',
    });
    if(pin === null) return;
  }

  const r = await fetch(`${API}/orders/${COI}/lines`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ skuId, qty, uom, pin }),
  });
  const d = await r.json();
  if(!r.ok) return uiToast(d.error || 'Could not add the line', 'error');
  uiToast('Line added');
  document.getElementById('eoAddLineForm').style.display = 'none';
  refreshEditOrderLines();
}

async function saveEditedLineQty(input){
  const lineId   = input.dataset.lineId;
  const newQty   = Number(input.value);
  const original = Number(input.dataset.original);
  if(newQty === original) return;
  if(newQty <= 0){
    uiToast('Quantity must be greater than 0', 'error');
    input.value = original;
    return;
  }

  let pin = null;
  if(editNeedsPin()){
    pin = await askSupervisorPin({
      title: 'Change quantity on an allocated order',
      body: `Changing this line from <strong>${esc(original)}</strong> to <strong>${esc(newQty)}</strong> on an
             order that already has allocations needs supervisor authorization.`,
    });
    if(pin === null){ input.value = original; return; }
  }

  const r = await fetch(`${API}/orders/${COI}/lines/${lineId}`, {
    method:'PATCH',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ qty: newQty, pin }),
  });
  const d = await r.json();
  if(!r.ok){
    uiToast(d.error || 'Could not save the quantity', 'error');
    input.value = original;
    return;
  }
  input.dataset.original = newQty;
  uiToast('Quantity updated');
  refreshEditOrderLines();
}

async function removeOrderLine(lineId, hasAlloc){
  if(hasAlloc){
    return uiToast('This line has active allocations — unallocate it first, then remove the line', 'error');
  }
  const ok = await uiConfirm({
    title: 'Remove this line?',
    body: 'The line is removed from the order.',
    confirmLabel: 'Remove line', danger: true,
  });
  if(!ok) return;

  let pin = null;
  if(editNeedsPin()){
    pin = await askSupervisorPin({
      title: 'Remove a line from an allocated order',
      body: 'Other lines on this order are already allocated, so removing a line needs supervisor authorization.',
    });
    if(pin === null) return;
  }

  const r = await fetch(`${API}/orders/${COI}/lines/${lineId}`, {
    method:'DELETE',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ pin }),
  });
  const d = await r.json();
  if(!r.ok) return uiToast(d.error || 'Could not remove the line', 'error');
  uiToast('Line removed');
  refreshEditOrderLines();
}

// uiModal action — returning false keeps the modal open.
async function submitEditOrder(){
  // Blank fields are sent as null so clearing a field clears it server-side.
  const v = (id) => document.getElementById(id).value.trim();
  const body = {
    externalOrderNumber: v('eoExternalNum') || null,
    proNumber:           v('eoProNum')      || null,
    requiredShipDate:    v('eoShipDate')    || null,
    carrierCode:         v('eoCarrierCode') || null,
    shipMethod:          v('eoShipMethod')  || null,
    customerName:        v('eoCustName')    || null,
    customerEmail:       v('eoCustEmail')   || null,
    shipToName:          v('eoShipName')    || null,
    shipToLine1:         v('eoAddr1')       || null,
    shipToLine2:         v('eoAddr2')       || null,
    shipToCity:          v('eoCity')        || null,
    shipToState:         v('eoState')       || null,
    shipToPostal:        v('eoPostal')      || null,
    shipToCountry:       v('eoCountry')     || null,
    notes:               v('eoNotes')       || null,
  };
  const r = await fetch(`${API}/orders/${COI}`, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if(!r.ok){ uiToast(d.error || 'Save failed', 'error'); return false; }
  uiToast('Order updated');
  openOrderDetail(COI);
}

// =============================================================================
// DELETE ORDER — soft delete, requires confirmation + reason.
// Server enforces 'cannot delete SHIPPED'; we mirror that on the UI for
// a faster fail. Reason captured into delete_reason on the order row
// for audit so we know why something was tossed.
// =============================================================================

async function deleteCurrentOrder(){
  if(!COI || !COD) return;
  if(COD.status === 'SHIPPED'){
    return uiToast('A SHIPPED order can\'t be deleted — it has already left the warehouse', 'error');
  }
  // Was: prompt() -> alert() -> confirm(). One modal, one decision, reason
  // validated in place.
  uiModal({
    title: `Delete ${COD.order_number || 'order'}?`,
    width: 520,
    body:
      `<div class="ui-dialog-body" style="margin-bottom:12px;">
         This is a <strong>soft delete</strong> — the order stays in the database for audit but
         disappears from every list. The reason is recorded on the order.
       </div>` +
      uiField({ id: 'delReason', label: 'Reason',
                placeholder: 'e.g. duplicate of ORD-500123, customer cancelled, test data' }),
    actions: [
      { label: 'Keep order' },
      { label: 'Delete order', danger: true, onClick: async (m) => {
          const reason = m.el.querySelector('#delReason').value.trim();
          uiFieldError(m.el, 'delReason', reason ? '' : 'A reason is required to delete an order');
          if(!reason) return false;
          const r = await fetch(`${API}/orders/${COI}?reason=${encodeURIComponent(reason)}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${T}` },
          });
          const d = await r.json();
          if(!r.ok){ uiFieldError(m.el, 'delReason', d.error || 'Delete failed'); return false; }
          uiToast(`${COD.order_number || 'Order'} deleted`);
          closeOrderDetail();
        } },
    ],
  });
}
