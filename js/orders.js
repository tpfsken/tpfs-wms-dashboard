// =============================================================================
// ORDERS — list, detail, allocation, new-order modal
// =============================================================================

let COI = null;          // current order id
let COD = null;          // current order data
let AIC = {};            // allocation inventory cache by order line id
let orderLines = [];     // new-order modal: pending lines

async function loadOrders(){
  const s  = document.getElementById('ordSearch')?.value || '';
  const st = (_cbState['ordStatusFilterWrap']?.selected?.value) || '';
  let u = '/orders?limit=100';
  if(st) u += `&status=${encodeURIComponent(st)}`;
  if(s)  u += `&search=${encodeURIComponent(s)}`;
  const d = await apiGet(u);
  if(!d) return;

  const b = document.getElementById('ordBody');
  const rows = d.data || d.rows || d;
  if(!rows?.length){
    b.innerHTML = '<tr><td colspan="11" class="empty-state">No orders</td></tr>';
    return;
  }

  b.innerHTML = rows.map(o => {
    const s = SM[o.status] || {c:'chip-new', l:o.status};
    const sd = o.required_ship_date
      ? new Date(o.required_ship_date).toLocaleDateString('en-US', {month:'short', day:'numeric'})
      : '—';
    const cityState = [o.ship_to_city, o.ship_to_state].filter(Boolean).join(', ');
    return `
      <tr class="js-order-row" data-order-id="${esc(o.id)}" style="cursor:pointer;">
        <td style="font-weight:600;color:var(--blue);">${esc(o.order_number || '')}</td>
        <td>${esc(o.client_name || '')}</td>
        <td>${esc(o.channel || '')}</td>
        <td><span class="chip chip-new">${esc(o.order_type || '')}</span></td>
        <td>${esc(o.customer_name || '—')}</td>
        <td style="color:var(--text2);font-size:12px;">${esc(cityState)}</td>
        <td>${esc(o.carrier_code || '—')}</td>
        <td class="right">${esc(o.line_count || 0)}</td>
        <td class="right" style="font-weight:600;">${esc(o.total_units || 0)}</td>
        <td style="color:${o.is_past_sla ? 'var(--red)' : 'var(--text2)'};">${esc(sd)}</td>
        <td><span class="chip ${s.c}">${esc(s.l)}</span></td>
      </tr>`;
  }).join('');

  b.querySelectorAll('.js-order-row').forEach(row => {
    row.addEventListener('click', () => openOrderDetail(row.dataset.orderId));
  });
}

async function openOrderDetail(id){
  COI = id;
  document.getElementById('ordListView').style.display = 'none';
  document.getElementById('ordDetailView').style.display = 'block';
  document.getElementById('ordTransError').textContent = '';
  document.getElementById('ordTransSuccess').textContent = '';

  const d = await apiGet(`/orders/${id}`);
  if(!d){ closeOrderDetail(); return; }
  COD = d;

  document.getElementById('ordDetailTitle').textContent = d.order_number || '';
  document.getElementById('ordDetailSub').textContent   = `${d.client_name || ''} · ${d.channel || ''}`;
  const st = SM[d.status] || {c:'chip-new', l:d.status};
  const stEl = document.getElementById('ordDetailStatus');
  stEl.textContent = st.l;
  stEl.className = 'chip ' + st.c;

  // Under-allocation banner — show when any line is short on
  // allocated qty. The order can't legitimately move past NEW until
  // every line is fully allocated; surface this front-and-center so
  // ops doesn't try to push it forward.
  document.querySelectorAll('.js-ord-shortalloc-banner').forEach(el => el.remove());
  const shortLines = (d.lines || []).filter(l =>
    Number(l.allocated_qty || 0) < Number(l.ordered_qty || 0)
  );
  if(shortLines.length){
    const totalShort = shortLines.reduce((s, l) =>
      s + (Number(l.ordered_qty || 0) - Number(l.allocated_qty || 0)), 0);
    const banner = document.createElement('div');
    banner.className = 'js-ord-shortalloc-banner';
    banner.style.cssText = 'background:var(--red-bg);color:var(--red);padding:12px 16px;border-radius:8px;border-left:4px solid var(--red);margin-bottom:14px;font-size:13px;font-weight:600;';
    banner.innerHTML = `⚠ <strong>${shortLines.length} line${shortLines.length === 1 ? '' : 's'} not fully allocated</strong> — ${totalShort} unit${totalShort === 1 ? '' : 's'} short. Order can't be picked or shipped until every line is fully allocated.`;
    const detailView = document.getElementById('ordDetailView');
    detailView.insertBefore(banner, detailView.children[1] || detailView.firstChild?.nextSibling || null);
  }

  // Pessimistic lock banner — show when another picker is actively
  // working this order. Disables the Pick on Tablet button and the
  // status transition buttons further down so ops doesn't re-allocate
  // mid-pick. Lock auto-releases server-side after 30 minutes.
  const lockedAt = d.picking_started_at ? new Date(d.picking_started_at) : null;
  const lockFresh = lockedAt && (Date.now() - lockedAt.getTime() < 30 * 60 * 1000);
  const myId = (typeof U !== 'undefined' && U) ? U.id : null;
  const lockedByOther = d.picking_user_id && d.picking_user_id !== myId && lockFresh;

  // Wipe any prior lock banner from previous detail loads
  document.querySelectorAll('.js-ord-lock-banner').forEach(el => el.remove());
  if(lockedByOther){
    const banner = document.createElement('div');
    banner.className = 'js-ord-lock-banner';
    banner.style.cssText = 'background:var(--amber-bg);color:var(--amber);padding:12px 16px;border-radius:8px;border-left:4px solid var(--amber);margin-bottom:14px;font-size:13px;font-weight:600;';
    const elapsed = Math.round((Date.now() - lockedAt.getTime()) / 60000);
    banner.innerHTML = `🔒 Order is currently being picked by <strong>${esc(d.picking_user_name || 'another user')}</strong> — started ${elapsed}m ago. Wait for them to finish or auto-release at 30m.`;
    const detailView = document.getElementById('ordDetailView');
    detailView.insertBefore(banner, detailView.children[1] || detailView.firstChild?.nextSibling || null);
  }
  // Disable Pick on Tablet + transition buttons when locked by someone else
  document.querySelectorAll('button[onclick*="openMobilePicker"]').forEach(b => {
    b.disabled = !!lockedByOther;
    b.style.opacity = lockedByOther ? '0.5' : '';
    b.title = lockedByOther ? `Locked by ${d.picking_user_name}` : '';
  });

  // Edit + Delete: hidden once status='SHIPPED' (the order has left
  // the building — no more changes). Both API endpoints reject SHIPPED
  // anyway; this keeps the UI honest.
  const isShipped = d.status === 'SHIPPED';
  document.querySelectorAll('.js-ord-edit-btn, .js-ord-delete-btn').forEach(b => {
    b.style.display = isShipped ? 'none' : '';
  });

  const fields = [
    {l:'Order #',  v:d.order_number},
    {l:'External', v:d.external_order_number || '—'},
    {l:'PRO #',    v:d.pro_number || '—'},
    {l:'Channel',  v:d.channel || '—'},
    {l:'Type',     v:d.order_type || '—'},
    {l:'Customer', v:d.customer_name || '—'},
    {l:'Carrier',  v:`${d.carrier_code || '—'} / ${d.ship_method || '—'}`},
    {l:'Ship By',  v:d.required_ship_date ? new Date(d.required_ship_date).toLocaleDateString() : '—'},
    {l:'Created',  v:d.created_at ? new Date(d.created_at).toLocaleString() : '—'},
  ];
  document.getElementById('ordInfoGrid').innerHTML = fields.map(f =>
    `<div><div class="detail-label">${esc(f.l)}</div><div class="detail-value">${esc(f.v)}</div></div>`
  ).join('');

  document.getElementById('ordLinesBody').innerHTML = d.lines?.map(ln => `
    <tr>
      <td>${esc(ln.line_number)}</td>
      <td style="font-weight:600;color:var(--blue);">${esc(ln.sku_code || '')} ${severityChip(ln, {size:'sm'})}</td>
      <td>${esc(ln.sku_name || '')}</td>
      <td>${esc(ln.sku_type || ln.uom || '')}</td>
      <td class="right">${esc(ln.ordered_qty || 0)}</td>
      <td class="right" style="color:var(--blue);">${esc(ln.allocated_qty || 0)}</td>
      <td class="right" style="color:var(--amber);">${esc(ln.picked_qty || 0)}</td>
      <td class="right" style="color:var(--green);">${esc(ln.shipped_qty || 0)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty-state">No lines</td></tr>';

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
    transBtns.innerHTML = '<div style="color:var(--muted);font-size:13px;">Read-only in portal</div>';
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
      if (t === 'CANCELLED') return 'Cancel Order';
      if (t === 'ALLOCATED') return '🎯 Allocate';
      if (t === 'PICKING')   return '▶ Start Picking';
      if (t === 'PACKING')   return '✓ Complete Picking';
      if (t === 'STAGED')    return '📦 Mark Staged';
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

    // PRIMARY — forward transitions. Ship Order takes precedence when
    // status is PACKING/STAGED — collapses two clicks into one.
    if(canShip){
      html += `<button class="btn btn-success js-ship-btn" style="display:block;width:100%;padding:12px;font-size:14px;font-weight:700;margin-bottom:8px;">📦 Ship Order</button>`;
    }
    primary.forEach((t, i) => {
      const blocked = blockForward && !exempt.has(t);
      const style = `display:block;width:100%;padding:12px;font-size:14px;font-weight:700;margin-bottom:8px;${blocked ? 'opacity:0.5;cursor:not-allowed;' : ''}`;
      const title = blocked ? 'Allocate every line first before advancing' : '';
      html += `<button class="btn btn-primary js-trans-btn"
               data-target="${esc(t)}" data-blocked="${blocked ? '1' : '0'}"
               title="${esc(title)}" style="${style}">${esc(labelFor(t))}</button>`;
    });

    // SECONDARY — backward + cancel. Smaller, side-by-side row.
    const secondary = [...backward, ...cancel];
    if(secondary.length){
      html += `<div style="display:flex;gap:6px;margin-top:4px;">`;
      secondary.forEach(t => {
        const isCancel = t === 'CANCELLED';
        html += `<button class="btn ${isCancel ? 'btn-danger' : 'btn-ghost'} js-trans-btn"
                 data-target="${esc(t)}" data-blocked="0"
                 style="flex:1;padding:8px;font-size:12px;">${esc(labelFor(t))}</button>`;
      });
      html += `</div>`;
    }

    // DESTRUCTIVE — Unallocate Order. Visually separated by a divider,
    // small + amber so ops doesn't fat-finger it.
    if(canUnallocateAll){
      html += `<div style="border-top:1px solid var(--border);margin:14px 0 8px;padding-top:10px;">
        <div style="font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Edit allocations</div>
        <button class="btn js-unallocate-all-btn"
          style="display:block;width:100%;padding:8px;font-size:12px;background:#2a1f00;color:#ffd591;border:1px solid #4d3800;"
          title="Release all allocations and demote order to NEW so you can edit lines freely">↺ Unallocate Order</button>
      </div>`;
    }

    if(!html){
      html = '<div style="color:var(--muted);font-size:13px;">Terminal state</div>';
    }
    transBtns.innerHTML = html;
    transBtns.querySelectorAll('.js-trans-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        if(btn.dataset.blocked === '1'){
          alert('This order has lines that aren\'t fully allocated yet. Finish allocating before advancing the status.');
          return;
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

  const shipTo = `
    <div style="font-weight:600;font-size:15px;margin-bottom:6px;">${esc(d.ship_to_name || d.customer_name || '—')}</div>
    <div style="color:var(--text2);line-height:1.7;">
      ${esc(d.ship_to_line1 || '')}<br>
      ${d.ship_to_line2 ? esc(d.ship_to_line2) + '<br>' : ''}
      ${esc([d.ship_to_city, d.ship_to_state, d.ship_to_postal].filter(Boolean).join(', '))}<br>
      ${esc(d.ship_to_country || 'US')}
    </div>
    ${d.customer_email ? `<div style="color:var(--muted);margin-top:8px;">${esc(d.customer_email)}</div>` : ''}`;
  document.getElementById('ordShipTo').innerHTML = shipTo;

  // Attachments — supporting docs (PDFs, images) bound to the order.
  // Rendered in both ops + portal modes.
  loadOrderAttachments(id);

  document.getElementById('ordShipments').innerHTML = d.shipments?.length
    ? d.shipments.map(sh => `
        <div style="padding:14px 20px;border-bottom:1px solid var(--border);">
          <div style="font-weight:600;color:var(--blue);">${esc(sh.shipment_number || '')} <span class="chip chip-success">${esc(sh.status || '')}</span></div>
          <div style="font-size:12px;color:var(--text2);margin-top:4px;">Tracking: ${esc(sh.tracking_number || '—')}${sh.label_url ? ` · <a href="${esc(sh.label_url)}" target="_blank" rel="noopener">🏷 Label</a>` : ''}</div>
        </div>`).join('')
    : '<div class="empty-state">No shipments</div>';

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
    // Hide destructive actions if order has shipped — server rejects
    // them anyway. Also hide for portal users (.ops-only check).
    const isShipped = d.status === 'SHIPPED';
    const portal = (typeof isPortalMode === 'function' && isPortalMode());
    document.getElementById('allocHistBody').innerHTML = d.allocations.map(a => {
      const lp = a.lp_number
        ? `<span class="lp-badge ${a.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(a.lp_number)}</span>`
        : '—';
      const stChip = a.status === 'PICKED' ? 'chip-success'
                   : a.status === 'CANCELLED' ? 'chip-danger'
                   : 'chip-active';

      let actions = '';
      if (!portal && !isShipped) {
        if (a.status === 'PENDING') {
          actions = `<button class="btn btn-ghost js-unallocate-btn" data-alloc-id="${esc(a.id)}" style="padding:4px 10px;font-size:11px;color:var(--amber);">↺ Unallocate</button>`;
        } else if (a.status === 'PICKED') {
          actions = `<button class="btn btn-ghost js-unpick-btn" data-alloc-id="${esc(a.id)}" data-sku="${esc(a.sku_code || '')}" style="padding:4px 10px;font-size:11px;color:var(--red);">↺ Unpick</button>`;
        } else if (a.status === 'CANCELLED') {
          actions = '<span style="font-size:11px;color:var(--muted);">cancelled</span>';
        }
      }

      return `
        <tr>
          <td style="color:var(--blue);">${esc(a.sku_code || '')}</td>
          <td style="color:var(--blue);">${esc(a.lot_number || '—')}</td>
          <td>${lp}</td>
          <td>${esc(a.location_code || '')}</td>
          <td class="right" style="font-weight:600;">${esc(a.quantity || 0)}</td>
          <td><span class="chip ${stChip}">${esc(a.status || 'PENDING')}</span></td>
          <td style="text-align:right;">${actions}</td>
        </tr>`;
    }).join('');

    // Wire the destructive buttons
    document.querySelectorAll('.js-unallocate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = d.allocations.find(x => x.id === btn.dataset.allocId);
        showDestructiveEdit({
          title: '⚠ Unallocate',
          description: `Release ${a?.quantity || 0} units of <strong>${esc(a?.sku_code || '')}</strong> from lot <strong>${esc(a?.lot_number || 'no lot')}</strong> back to available inventory? The allocation will be marked CANCELLED.`,
          url: `${API}/orders/${d.id}/allocations/${btn.dataset.allocId}/unallocate`,
        });
      });
    });
    document.querySelectorAll('.js-unpick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = d.allocations.find(x => x.id === btn.dataset.allocId);
        showDestructiveEdit({
          title: '⚠ Unpick',
          description: `Reverse the pick of <strong>${esc(a?.sku_code || '')}</strong> (${a?.picked_qty || a?.quantity || 0} units)? The allocation will go back to PENDING and the picker will need to re-pick. Billing charge from the original pick stays on the order.`,
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

function showDestructiveEdit(opts){
  document.getElementById('destructiveEditTitle').textContent = opts.title;
  document.getElementById('destructiveEditDescription').innerHTML = opts.description;
  document.getElementById('destructiveEditReason').value = '';
  document.getElementById('destructiveEditPin').value = '';
  document.getElementById('destructiveEditError').textContent = '';

  const btn = document.getElementById('destructiveEditConfirmBtn');
  btn.disabled = false;
  btn.textContent = 'Confirm';
  // Replace the click handler each time so we don't accumulate listeners
  btn.onclick = () => submitDestructiveEdit(opts.url);

  document.getElementById('destructiveEditModal').style.display = 'flex';
  setTimeout(() => document.getElementById('destructiveEditReason').focus(), 100);
}

async function submitDestructiveEdit(url){
  const reason = document.getElementById('destructiveEditReason').value.trim();
  const pin    = document.getElementById('destructiveEditPin').value.trim();
  const errEl  = document.getElementById('destructiveEditError');
  errEl.textContent = '';

  if(reason.length < 5){
    errEl.textContent = 'Reason is required (at least 5 characters)'; return;
  }
  if(!pin || !/^\d{4,8}$/.test(pin)){
    errEl.textContent = 'PIN must be 4–8 digits'; return;
  }

  const btn = document.getElementById('destructiveEditConfirmBtn');
  btn.disabled = true; btn.textContent = 'Working…';
  try {
    const r = await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${T}` },
      body: JSON.stringify({ pin, reason }),
    });
    const d = await r.json();
    if(!r.ok){ errEl.textContent = d.error || 'Action rejected'; return; }
    closeModal('destructiveEditModal');
    if(COI) openOrderDetail(COI); // refresh to show new state
  } catch(e){
    errEl.textContent = 'Network error';
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm';
  }
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
  document.getElementById('pickListError').textContent = '';
  document.getElementById('pickListSuccess').textContent = '';

  const tbody = document.getElementById('pickListBody');

  // Hazmat badge + special handling banner. Only render for pending rows
  // (don't clutter the picked rows). Both bits come straight off the
  // joined sku columns in /orders/:id (see queries/orders.js).
  const hazBadge = (a) => a.is_hazmat
    ? `<span class="chip chip-danger" style="font-size:10px;margin-right:6px;">⚠ HAZMAT${a.un_number ? ' ' + esc(a.un_number) : ''}${a.hazard_class ? ' · Cl ' + esc(a.hazard_class) : ''}</span>`
    : '';
  const handlingRow = (a) => a.special_handling_instructions
    ? `<tr><td colspan="8" style="background:var(--amber-bg);color:var(--amber);font-size:12px;padding:6px 10px;border-left:3px solid var(--amber);">📋 ${esc(a.special_handling_instructions)}</td></tr>`
    : '';

  tbody.innerHTML = allocs.map((a, i) => {
    const lpCell = a.lp_number
      ? `<span class="lp-badge ${a.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(a.lp_number)}</span>`
      : '—';

    if(a.status === 'PICKED'){
      const ts = a.picked_at
        ? new Date(a.picked_at).toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'})
        : '';
      const meta = a.picked_by_name || ts
        ? `<span style="font-size:11px;color:var(--muted);margin-left:6px;">${esc(a.picked_by_name || '')}${a.picked_by_name && ts ? ' · ' : ''}${esc(ts)}</span>`
        : '';
      return `
        <tr style="opacity:.7;">
          <td>${esc(i + 1)}</td>
          <td>${lpCell}</td>
          <td>${esc(a.location_code || '—')}</td>
          <td style="color:var(--blue);">${esc(a.lot_number || '—')}</td>
          <td style="color:var(--blue);font-weight:600;">${esc(a.sku_code || '')}</td>
          <td style="color:var(--text2);">${esc(a.sku_name || '')}</td>
          <td class="right">${esc(a.picked_qty || a.quantity)}</td>
          <td><span class="chip chip-success">✓ Picked</span>${meta}</td>
        </tr>`;
    }

    // PENDING (default) — severity chip + hazmat badge inline next to sku
    // name, special handling banner as a sub-row (full-width amber stripe
    // so it can't be missed by the picker on a tablet).
    const sev = severityChip(a, {size:'sm'});
    return `
      <tr>
        <td>${esc(i + 1)}</td>
        <td>${lpCell}</td>
        <td style="font-weight:600;">${esc(a.location_code || '—')}</td>
        <td style="color:var(--blue);">${esc(a.lot_number || '—')}</td>
        <td style="color:var(--blue);font-weight:600;">${esc(a.sku_code || '')} ${sev}</td>
        <td style="color:var(--text2);">${hazBadge(a)}${esc(a.sku_name || '')}</td>
        <td class="right" style="font-weight:600;">${esc(a.quantity)}</td>
        <td>
          <input type="number" class="form-input js-pick-qty" data-id="${esc(a.id)}"
                 value="${esc(a.quantity)}" min="1" max="${esc(a.quantity)}"
                 style="width:64px;padding:4px 8px;font-size:12px;display:inline-block;margin-right:4px;">
          <button class="btn btn-primary js-pick-confirm" data-id="${esc(a.id)}"
                  style="padding:4px 12px;font-size:12px;">Confirm</button>
        </td>
      </tr>
      ${handlingRow(a)}`;
  }).join('');

  tbody.querySelectorAll('.js-pick-confirm').forEach(btn => {
    btn.addEventListener('click', () => {
      const allocId = btn.dataset.id;
      const qtyInput = tbody.querySelector(`.js-pick-qty[data-id="${allocId}"]`);
      const qty = parseInt(qtyInput?.value) || 0;
      confirmPickAllocation(d.id, allocId, qty, btn);
    });
  });

  const completeBtn = document.getElementById('pickListComplete');
  completeBtn.style.display = allDone ? 'inline-flex' : 'none';
  // Complete Picking moves PICKING → PACKING (the new unified workflow,
  // post-migration 020 — there's no separate PICKED stage anymore).
  completeBtn.onclick = () => transitionOrder(d.id, 'PACKING');
}

// =============================================================================
// SHIP ORDER (Phase 1E.basic)
// =============================================================================

let shipEpShipmentId = null;   // EasyPost shipment id from the last rate quote
let shipSelectedRateId = null; // rate the user picked

function resetShipRates(){
  shipEpShipmentId = null;
  shipSelectedRateId = null;
  document.getElementById('shipRatesBox').style.display = 'none';
  document.getElementById('shipRatesList').innerHTML = '';
  document.getElementById('shipRatesHint').textContent = '';
  document.getElementById('shipBuyLabelBtn').disabled = true;
}

function showShipOrderModal(){
  if(!COI || !COD) return;
  const m = document.getElementById('shipOrderModal');
  m.style.display = 'flex'; m.style.zIndex = '10000';
  resetShipRates();

  // Quoted rates are only valid for the weight/dims they were quoted for —
  // invalidate them if the parcel changes.
  ['shipWeight','shipLength','shipWidth','shipHeight'].forEach(id => {
    document.getElementById(id).oninput = () => { if(shipEpShipmentId) resetShipRates(); };
  });

  // Reset fields
  document.getElementById('shipServiceLevel').value = '';
  document.getElementById('shipTracking').value = '';
  document.getElementById('shipWeight').value = '';
  document.getElementById('shipLength').value = '';
  document.getElementById('shipWidth').value = '';
  document.getElementById('shipHeight').value = '';
  document.getElementById('shipCost').value = '';
  document.getElementById('shipNotes').value = '';
  document.getElementById('shipOrderError').textContent = '';
  document.getElementById('shipOrderSuccess').textContent = '';
  document.getElementById('shipOrderSubmitBtn').disabled = false;

  // Carrier combo — defaults from existing carrier_code on the order if any.
  initCombo('shipCarrierWrap', [
    {value:'UPS',   label:'UPS'},
    {value:'FEDEX', label:'FedEx'},
    {value:'USPS',  label:'USPS'},
    {value:'DHL',   label:'DHL'},
    {value:'LTL',   label:'LTL Carrier'},
    {value:'OTHER', label:'Other'},
  ], {
    placeholder: 'Select carrier...',
    value:       COD.carrier_code || '',
    allowCustom: true,
  });

  // Pre-fill fields from order if known
  if(COD.ship_method){
    document.getElementById('shipServiceLevel').value = COD.ship_method;
  }
  document.getElementById('shipOrderSub').textContent =
    `Ship order ${COD.order_number || ''} (${COD.client_name || ''}) — confirms physical shipment, decrements inventory, fires billing charge.`;
}

async function getShipRates(){
  if(!COI) return;
  const err = document.getElementById('shipOrderError');
  const btn = document.getElementById('shipGetRatesBtn');
  err.textContent = '';
  resetShipRates();

  const weightLbs = parseFloat(document.getElementById('shipWeight').value);
  if(!weightLbs || weightLbs <= 0){ err.textContent = 'Enter a parcel weight to get rates'; return; }

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
    if(!r.ok){ err.textContent = d.error || 'Rate lookup failed'; return; }

    shipEpShipmentId = d.epShipmentId;
    document.getElementById('shipRatesHint').textContent =
      `${d.rates.length} rate${d.rates.length === 1 ? '' : 's'} — cheapest first`;
    document.getElementById('shipRatesList').innerHTML = d.rates.map(rt => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;">
        <input type="radio" name="shipRateChoice" value="${esc(rt.rateId)}">
        <span style="font-weight:700;min-width:70px;">$${esc(Number(rt.rate).toFixed(2))}</span>
        <span style="flex:1;">${esc(rt.carrierDisplay || rt.carrier)} · ${esc(rt.service)}</span>
        <span style="font-size:12px;color:var(--text2);">${rt.deliveryDays != null ? esc(rt.deliveryDays) + 'd' : ''}</span>
      </label>`).join('');
    document.getElementById('shipRatesBox').style.display = 'block';
    document.querySelectorAll('input[name="shipRateChoice"]').forEach(inp =>
      inp.addEventListener('change', () => {
        shipSelectedRateId = inp.value;
        document.getElementById('shipBuyLabelBtn').disabled = false;
      })
    );
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    btn.disabled = false;
    if(!shipEpShipmentId) document.getElementById('shipRatesHint').textContent = '';
  }
}

async function buyShipLabel(){
  if(!COI || !shipEpShipmentId || !shipSelectedRateId) return;
  const err = document.getElementById('shipOrderError');
  const suc = document.getElementById('shipOrderSuccess');
  err.textContent = ''; suc.textContent = '';
  const btn = document.getElementById('shipBuyLabelBtn');

  btn.disabled = true;
  document.getElementById('shipOrderSubmitBtn').disabled = true;
  try {
    const r = await fetch(`${API}/orders/${COI}/shipping/buy`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        epShipmentId: shipEpShipmentId,
        rateId:       shipSelectedRateId,
        weightLbs:    parseFloat(document.getElementById('shipWeight').value) || null,
        lengthIn:     parseFloat(document.getElementById('shipLength').value) || null,
        widthIn:      parseFloat(document.getElementById('shipWidth').value)  || null,
        heightIn:     parseFloat(document.getElementById('shipHeight').value) || null,
        notes:        document.getElementById('shipNotes').value || null,
      }),
    });
    const d = await r.json();
    if(!r.ok){
      err.textContent = d.error || 'Label purchase failed';
      btn.disabled = false;
      document.getElementById('shipOrderSubmitBtn').disabled = false;
      return;
    }

    suc.textContent = `Shipped — ${d.shipmentNumber} · tracking ${d.trackingNumber || '—'}`;
    if(d.labelUrl) window.open(d.labelUrl, '_blank', 'noopener');
    setTimeout(() => {
      closeModal('shipOrderModal');
      openOrderDetail(COI);
    }, 1200);
  } catch(e){
    err.textContent = 'Network error';
    btn.disabled = false;
    document.getElementById('shipOrderSubmitBtn').disabled = false;
  }
}

async function submitShipOrder(){
  if(!COI) return;
  const err = document.getElementById('shipOrderError');
  const suc = document.getElementById('shipOrderSuccess');
  err.textContent = ''; suc.textContent = '';
  const btn = document.getElementById('shipOrderSubmitBtn');

  const carrierCode = cbVal('shipCarrierWrap');
  if(!carrierCode){ err.textContent = 'Select a carrier'; return; }

  btn.disabled = true;
  try {
    const r = await fetch(`${API}/orders/${COI}/ship`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({
        carrierCode,
        serviceLevel:   document.getElementById('shipServiceLevel').value || null,
        trackingNumber: document.getElementById('shipTracking').value     || null,
        weightLbs:      parseFloat(document.getElementById('shipWeight').value) || null,
        lengthIn:       parseFloat(document.getElementById('shipLength').value) || null,
        widthIn:        parseFloat(document.getElementById('shipWidth').value)  || null,
        heightIn:       parseFloat(document.getElementById('shipHeight').value) || null,
        shipCost:       parseFloat(document.getElementById('shipCost').value)   || null,
        notes:          document.getElementById('shipNotes').value || null,
      }),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Ship failed'; btn.disabled = false; return; }

    suc.textContent = `Shipped — ${d.shipmentNumber}${d.billingCharge ? ` · billing ${fmtDollars(d.billingCharge.totalAmount)}` : ''}`;
    setTimeout(() => {
      closeModal('shipOrderModal');
      openOrderDetail(COI);
    }, 1200);
  } catch(e){
    err.textContent = 'Network error';
    btn.disabled = false;
  }
}

async function confirmPickAllocation(orderId, allocationId, quantity, btn){
  const err = document.getElementById('pickListError');
  const suc = document.getElementById('pickListSuccess');
  err.textContent = ''; suc.textContent = '';
  if(!quantity || quantity <= 0){ err.textContent = 'Quantity must be > 0'; return; }
  if(btn) btn.disabled = true;
  try {
    const r = await fetch(`${API}/orders/${orderId}/picks/${allocationId}/confirm`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({quantity}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Pick failed'; return; }
    suc.textContent = d.allPicked
      ? 'All picks complete — click Complete Picking when ready.'
      : `Picked. ${d.pendingPicks} remaining.`;
    setTimeout(() => openOrderDetail(orderId), 400);
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    if(btn) btn.disabled = false;
  }
}

function closeOrderDetail(){
  document.getElementById('ordDetailView').style.display = 'none';
  document.getElementById('ordListView').style.display = 'block';
  COI = null; COD = null;
  loadOrders();
}

async function transitionOrder(id, ns){
  const err = document.getElementById('ordTransError');
  const suc = document.getElementById('ordTransSuccess');
  err.textContent = ''; suc.textContent = '';
  if(ns === 'ALLOCATED' && COD?.status === 'NEW'){ showAllocPanel(id); return; }
  try {
    const r = await fetch(`${API}/orders/${id}/status`, {
      method:'PATCH',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({status: ns}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    suc.textContent = `→ ${ns}`;
    setTimeout(() => openOrderDetail(id), 500);
  } catch(e){
    err.textContent = 'Network error';
  }
}

async function showAllocPanel(id){
  document.getElementById('allocPanel').style.display = 'block';
  document.getElementById('allocError').textContent = '';
  document.getElementById('allocSuccess').textContent = '';
  const ll = document.getElementById('allocLinesList');
  ll.innerHTML = '<div class="empty-state">Loading...</div>';
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
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <span style="font-weight:700;color:var(--blue);font-size:14px;">Line ${esc(ln.line_number)}: ${esc(ln.sku_code)}</span>
          <span style="color:var(--text2);">${esc(ln.sku_name || '')}</span>
          <span style="margin-left:auto;font-weight:600;color:var(--amber);">Need: ${esc(rem)} ${esc(ln.sku_uom || ln.uom || '')}</span>
        </div>`;

    if(!av.inventory?.length){
      html += '<div class="empty-state">No inventory available</div>';
    } else {
      html += `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:12px;color:var(--muted);">Sorted ${esc(pm)}:</span>
          <input type="text" class="form-input js-alloc-search" id="als_${i}" data-idx="${i}" placeholder="Search lot # or LP #..." style="max-width:260px;padding:8px 12px;font-size:13px;">
        </div>
        <table class="data-table">
          <thead><tr><th style="width:36px">Sel</th><th>Lot</th><th>Expiry</th><th>LP</th><th>Type</th><th>Location</th><th>Zone</th><th class="right">Avail</th><th style="width:90px">Qty</th></tr></thead>
          <tbody id="atb_${i}">`;

      let rf = rem;
      av.inventory.forEach((inv, j) => {
        const sq = Math.min(rf, inv.available_qty);
        const as = sq > 0 && rf > 0;
        if(as) rf -= sq;
        const expiringSoon = inv.expiry_date && new Date(inv.expiry_date) < new Date(Date.now() + 30 * 864e5);
        const lpBadge = inv.lp_number
          ? `<span class="lp-badge ${inv.lp_type === 'CHILD' ? 'lp-child' : 'lp-original'}">${esc(inv.lp_number)}</span>`
          : '—';
        html += `
          <tr id="ar_${i}_${j}" data-lot="${esc((inv.lot_number || '').toLowerCase())}" data-lp="${esc((inv.lp_number || '').toLowerCase())}">
            <td><input type="checkbox" class="js-alloc-chk" id="ac_${i}_${j}" data-i="${i}" data-j="${j}" ${as ? 'checked' : ''} style="width:18px;height:18px;"></td>
            <td style="color:var(--blue);font-weight:500;">${esc(inv.lot_number || '—')}</td>
            <td style="color:${expiringSoon ? 'var(--red)' : 'var(--text2)'};">${esc(inv.expiry_date ? new Date(inv.expiry_date).toLocaleDateString() : '—')}</td>
            <td>${lpBadge}</td>
            <td>${esc(inv.lp_type || '')}</td>
            <td>${esc(inv.location_code || '')}</td>
            <td style="color:var(--muted);font-size:12px;">${esc(inv.zone_name || '')}</td>
            <td class="right" style="font-weight:600;">${esc(inv.available_qty)}</td>
            <td><input type="number" class="form-input" id="aq_${i}_${j}" value="${as ? sq : 0}" min="0" max="${esc(inv.available_qty)}" style="width:80px;padding:8px;" ${!as ? 'disabled' : ''}></td>
          </tr>`;
      });
      html += '</tbody></table>';
    }
    html += `<input type="hidden" id="ali_${i}" value="${esc(ln.id)}"><input type="hidden" id="aln_${i}" value="${esc(rem)}"></div>`;
  }
  ll.innerHTML = html || '<div class="empty-state">All allocated</div>';

  // Wire allocation interactions
  ll.querySelectorAll('.js-alloc-chk').forEach(chk => {
    chk.addEventListener('change', () => tar(parseInt(chk.dataset.i), parseInt(chk.dataset.j)));
  });
  ll.querySelectorAll('.js-alloc-search').forEach(inp => {
    inp.addEventListener('input', () => filterAR(parseInt(inp.dataset.idx)));
  });
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
  const err = document.getElementById('allocError');
  const suc = document.getElementById('allocSuccess');
  err.textContent = ''; suc.textContent = '';
  const allocs = [];

  for(let i = 0; ; i++){
    const el = document.getElementById(`ali_${i}`);
    if(!el) break;
    const olid = el.value;
    const need = parseInt(document.getElementById(`aln_${i}`)?.value) || 0;
    const inv = AIC[olid] || [];
    let lt = 0;
    for(let j = 0; j < inv.length; j++){
      const chk = document.getElementById(`ac_${i}_${j}`);
      const qi  = document.getElementById(`aq_${i}_${j}`);
      if(!chk?.checked) continue;
      const q = parseInt(qi?.value) || 0;
      if(q <= 0) continue;
      if(q > inv[j].available_qty){
        err.textContent = `Cannot allocate ${q} — only ${inv[j].available_qty} available`;
        return;
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
    if(lt > need && !confirm(`Allocating ${lt} but only ${need} ordered. Over-allocate?`)) return;
    if(lt < need && !confirm(`Only ${lt} of ${need}. Partial allocation?`)) return;
  }

  if(!allocs.length){ err.textContent = 'No inventory selected'; return; }

  try {
    const r = await fetch(`${API}/orders/${COI}/allocate`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify({allocations: allocs}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Failed'; return; }
    suc.textContent = `Allocated ${d.allocationsCreated} line(s)`;
    setTimeout(() => openOrderDetail(COI), 1000);
  } catch(e){
    err.textContent = 'Network error';
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

async function loadOrderAttachments(orderId){
  const list   = document.getElementById('ordAttachList');
  const count  = document.getElementById('ordAttachCount');
  const status = document.getElementById('ordAttachStatus');
  if(!list) return;

  // Wire add-button input once (delegates to current COI on each upload).
  const input = document.getElementById('ordAttachInput');
  if(input && !input._wired){
    input._wired = true;
    input.addEventListener('change', async ev => {
      const files = Array.from(ev.target.files || []);
      ev.target.value = '';
      const id = COI;
      if(!id || !files.length) return;
      const MAX = 25 * 1024 * 1024;
      let done = 0, failed = 0;
      for(const f of files){
        if(f.size > MAX){
          failed++;
          status.style.color = 'var(--red)';
          status.textContent = `${f.name} is over 25MB — skipped`;
          continue;
        }
        status.style.color = 'var(--text2)';
        status.textContent = `Uploading ${f.name} (${done + 1}/${files.length})…`;
        try {
          const fd = new FormData();
          fd.append('file', f);
          const r = await fetch(`${API}/orders/${id}/attachments`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${T}` },
            body: fd,
          });
          if(!r.ok){
            failed++;
            const d = await r.json().catch(() => ({}));
            status.style.color = 'var(--red)';
            status.textContent = `${f.name} failed: ${d.error || r.status}`;
            continue;
          }
          done++;
        } catch(e){
          failed++;
          status.style.color = 'var(--red)';
          status.textContent = `${f.name} network error`;
        }
      }
      if(!failed){
        status.style.color = 'var(--green)';
        status.textContent = `✓ Uploaded ${done} file${done === 1 ? '' : 's'}`;
      }
      setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3500);
      loadOrderAttachments(id);
    });
  }

  list.innerHTML = '<div style="padding:14px 0;color:var(--muted);font-size:13px;">Loading…</div>';
  const rows = await apiGet(`/orders/${orderId}/attachments`);
  if(!rows){
    list.innerHTML = '<div style="padding:14px 0;color:var(--red);font-size:13px;">Could not load attachments</div>';
    if(count) count.textContent = '';
    return;
  }
  if(count) count.textContent = rows.length ? `· ${rows.length} ${rows.length === 1 ? 'file' : 'files'}` : '';

  if(!rows.length){
    list.innerHTML = '<div style="padding:14px 0;color:var(--muted);font-size:13px;text-align:center;">No attachments</div>';
    return;
  }

  // Hide delete button for portal users — DELETE is requireOps.
  const portal = (typeof isPortalMode === 'function' && isPortalMode());

  list.innerHTML = rows.map(r => {
    const sizeKb = Number(r.size_bytes || 0) / 1024;
    const sizeMb = sizeKb / 1024;
    const sizeLabel = (r.size_bytes || 0) > 1024 * 1024
      ? `${sizeMb.toFixed(2)} MB`
      : `${sizeKb.toFixed(0)} KB`;
    const ext = (r.filename || '').split('.').pop()?.toUpperCase() || 'FILE';
    const when = r.uploaded_at ? new Date(r.uploaded_at).toLocaleString() : '';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <div style="width:42px;height:42px;border-radius:6px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--blue);">${esc(ext.slice(0,4))}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.filename || '')}</div>
          <div style="font-size:11px;color:var(--text2);">${esc(sizeLabel)} · ${esc(r.uploaded_by || '')} · ${esc(when)}</div>
        </div>
        <button class="btn btn-ghost js-ord-att-dl" data-att-id="${esc(r.id)}"
                style="padding:4px 12px;font-size:12px;">⬇ Open</button>
        ${portal ? '' : `<button class="btn btn-ghost js-ord-att-rm" data-att-id="${esc(r.id)}"
                  style="padding:4px 10px;font-size:12px;color:var(--red);">✕</button>`}
      </div>`;
  }).join('');

  list.querySelectorAll('.js-ord-att-dl').forEach(btn =>
    btn.addEventListener('click', () => openOrderAttachment(orderId, btn.dataset.attId))
  );
  list.querySelectorAll('.js-ord-att-rm').forEach(btn =>
    btn.addEventListener('click', () => deleteOrderAttachment(orderId, btn.dataset.attId))
  );
}

async function openOrderAttachment(orderId, attId){
  const d = await apiGet(`/orders/${orderId}/attachments/${attId}/url`);
  if(!d?.url){
    alert('Could not get a download URL.');
    return;
  }
  window.open(d.url, '_blank');
}

async function deleteOrderAttachment(orderId, attId){
  if(!confirm('Remove this attachment?')) return;
  const r = await fetch(`${API}/orders/${orderId}/attachments/${attId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${T}` },
  });
  if(!r.ok){
    const d = await r.json().catch(() => ({}));
    alert(d.error || 'Delete failed');
    return;
  }
  loadOrderAttachments(orderId);
}

// =============================================================================
// PRINT DOCS — opens a printable HTML window for the current order. The
// renderers live in printDocs.js; we just hand them the order detail
// payload from /orders/:id (which now includes client_full /
// warehouse_full / per-line hazmat + freight fields).
// =============================================================================

async function printOrderDoc(kind){
  if(!COI){ alert('No order selected'); return; }
  // Re-fetch so we always print the latest state — saves the user from
  // staring at stale data after a recent allocate / pick / ship.
  const order = await apiGet(`/orders/${COI}`);
  if(!order){ alert('Could not load order'); return; }
  if(kind === 'pick')         renderPickSlip(order);
  else if(kind === 'packing') renderPackingSlip(order);
  else if(kind === 'bol')     renderBol(order);
}

// =============================================================================
// EDIT ORDER — header-level fields only (customer / ship-to / dates /
// notes / carrier). Allowed any time before SHIPPED. Lines + allocations
// stay as-is — line edits are a future feature.
// =============================================================================

function openEditOrderModal(){
  if(!COI || !COD) return;
  if(COD.status === 'SHIPPED'){
    alert('Cannot edit a SHIPPED order — it has already left the warehouse.');
    return;
  }

  document.getElementById('editOrderTitle').textContent = `Edit Order — ${COD.order_number || ''}`;
  document.getElementById('eoExternalNum').value = COD.external_order_number || '';
  document.getElementById('eoProNum').value      = COD.pro_number || '';
  // <input type=date> wants YYYY-MM-DD; trim any time portion off ISO strings
  document.getElementById('eoShipDate').value =
    COD.required_ship_date ? String(COD.required_ship_date).slice(0, 10) : '';
  document.getElementById('eoCarrierCode').value = COD.carrier_code || '';
  document.getElementById('eoShipMethod').value  = COD.ship_method || '';
  document.getElementById('eoCustName').value    = COD.customer_name || '';
  document.getElementById('eoCustEmail').value   = COD.customer_email || '';
  document.getElementById('eoShipName').value    = COD.ship_to_name || '';
  document.getElementById('eoAddr1').value       = COD.ship_to_line1 || '';
  document.getElementById('eoAddr2').value       = COD.ship_to_line2 || '';
  document.getElementById('eoCity').value        = COD.ship_to_city || '';
  document.getElementById('eoState').value       = COD.ship_to_state || '';
  document.getElementById('eoPostal').value      = COD.ship_to_postal || '';
  document.getElementById('eoCountry').value     = COD.ship_to_country || 'US';
  document.getElementById('eoNotes').value       = COD.notes || '';
  document.getElementById('eoError').textContent = '';

  // Render the line items list
  renderEditOrderLines();
  // Wire add-line buttons (idempotent)
  wireEditOrderLineHandlers();

  document.getElementById('editOrderModal').style.display = 'flex';
}

// ---- Edit Order: line item editor ----------------------------------

function renderEditOrderLines(){
  const body = document.getElementById('eoLinesBody');
  const lines = COD?.lines || [];
  if(!lines.length){
    body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0;">No line items. Add one →</div>';
    return;
  }
  body.innerHTML = lines.map(l => {
    const allocated = Number(l.allocated_qty || 0);
    const hasAlloc  = allocated > 0;
    const lockHint  = hasAlloc
      ? `<div style="font-size:10px;color:var(--amber);margin-top:2px;">${allocated} already allocated — PIN to reduce or remove</div>`
      : '';
    return `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;">
          <div style="font-weight:600;color:var(--blue);font-family:ui-monospace,Menlo,monospace;">${esc(l.sku_code || '')}</div>
          <div style="font-size:12px;color:var(--text2);">${esc(l.sku_name || '')}</div>
          ${lockHint}
        </div>
        <div style="width:90px;">
          <input type="number" class="form-input js-eo-line-qty" data-line-id="${esc(l.id)}" data-original="${esc(l.ordered_qty)}" min="${esc(allocated)}" step="1" value="${esc(l.ordered_qty || 0)}" style="padding:6px 8px;font-size:13px;text-align:right;">
        </div>
        <div style="font-size:11px;color:var(--text2);align-self:center;">${esc(l.sku_uom || l.uom || 'EA')}</div>
        <button type="button" class="btn btn-ghost js-eo-line-rm" data-line-id="${esc(l.id)}" data-has-alloc="${hasAlloc ? '1' : '0'}" style="padding:4px 10px;font-size:12px;color:var(--red);">✕</button>
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
  if(!COD?.client_id){ return; }
  let url = `/skus?clientId=${encodeURIComponent(COD.client_id)}&limit=10`;
  if(term) url += `&search=${encodeURIComponent(term)}`;
  const list = await apiGet(url);
  const rows = Array.isArray(list) ? list : (list?.rows || list?.data || []);
  if(!rows.length){
    results.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--muted);">no matches</div>';
    results.style.display = 'block';
    return;
  }
  results.innerHTML = rows.map(r => `
    <div class="js-eo-sku-pick" data-sku-id="${esc(r.id)}" data-sku-code="${esc(r.sku_code)}" data-sku-name="${esc(r.name || '')}" data-uom="${esc(r.uom || 'EACH')}" style="padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px;">
      <div style="font-weight:600;color:var(--blue);">${esc(r.sku_code)}</div>
      <div style="color:var(--text2);">${esc(r.name || '')}</div>
    </div>
  `).join('');
  results.style.display = 'block';
  results.querySelectorAll('.js-eo-sku-pick').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('eoNewSkuId').value = el.dataset.skuId;
      document.getElementById('eoNewSkuSearch').value = `${el.dataset.skuCode} — ${el.dataset.skuName}`;
      document.getElementById('eoNewUom').value = el.dataset.uom;
      results.style.display = 'none';
      document.getElementById('eoNewQty').focus();
    });
  });
}

async function addNewOrderLine(){
  const skuId = document.getElementById('eoNewSkuId').value;
  const qty   = Number(document.getElementById('eoNewQty').value);
  const uom   = document.getElementById('eoNewUom').value.trim() || 'EACH';

  if(!skuId){ alert('Pick a SKU first'); return; }
  if(!qty || qty <= 0){ alert('Qty must be > 0'); return; }

  // Server requires PIN if order has allocations — check first to know
  // whether to prompt.
  const needsPin = (COD?.allocations || []).some(a => a.status !== 'CANCELLED');
  let pin = null;
  if(needsPin){
    pin = prompt('Order has allocations — supervisor PIN required to add a new line:');
    if(pin == null) return;
    if(!/^\d{4,8}$/.test(pin)){ alert('PIN must be 4–8 digits'); return; }
  }

  const r = await fetch(`${API}/orders/${COI}/lines`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ skuId, qty, uom, pin }),
  });
  const d = await r.json();
  if(!r.ok){ alert(d.error || 'Add line failed'); return; }
  document.getElementById('eoAddLineForm').style.display = 'none';
  // Reload order detail to refresh COD.lines
  const fresh = await apiGet(`/orders/${COI}`);
  if(fresh){ COD = fresh; renderEditOrderLines(); }
}

async function saveEditedLineQty(input){
  const lineId = input.dataset.lineId;
  const newQty = Number(input.value);
  const original = Number(input.dataset.original);
  if(newQty === original) return; // no change
  if(newQty <= 0){ alert('Qty must be > 0'); input.value = original; return; }

  const needsPin = (COD?.allocations || []).some(a => a.status !== 'CANCELLED');
  let pin = null;
  if(needsPin){
    pin = prompt(`Order has allocations — supervisor PIN required to change qty:`);
    if(pin == null){ input.value = original; return; }
    if(!/^\d{4,8}$/.test(pin)){ alert('PIN must be 4–8 digits'); input.value = original; return; }
  }

  const r = await fetch(`${API}/orders/${COI}/lines/${lineId}`, {
    method:'PATCH',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ qty: newQty, pin }),
  });
  const d = await r.json();
  if(!r.ok){ alert(d.error || 'Save failed'); input.value = original; return; }
  input.dataset.original = newQty;
  // Refresh order data so allocated_qty etc. stays in sync
  const fresh = await apiGet(`/orders/${COI}`);
  if(fresh){ COD = fresh; renderEditOrderLines(); }
}

async function removeOrderLine(lineId, hasAlloc){
  if(hasAlloc){
    alert('This line has active allocations. Unallocate first (on the order detail Allocations panel), then come back to remove the line.');
    return;
  }
  if(!confirm('Remove this line from the order?')) return;

  const needsPin = (COD?.allocations || []).some(a => a.status !== 'CANCELLED');
  let pin = null;
  if(needsPin){
    pin = prompt('Order has other allocations — supervisor PIN required to remove a line:');
    if(pin == null) return;
    if(!/^\d{4,8}$/.test(pin)){ alert('PIN must be 4–8 digits'); return; }
  }

  const r = await fetch(`${API}/orders/${COI}/lines/${lineId}`, {
    method:'DELETE',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ pin }),
  });
  const d = await r.json();
  if(!r.ok){ alert(d.error || 'Remove failed'); return; }
  const fresh = await apiGet(`/orders/${COI}`);
  if(fresh){ COD = fresh; renderEditOrderLines(); }
}

async function submitEditOrder(){
  const err = document.getElementById('eoError');
  err.textContent = '';

  // Build a body of just the editable fields. Empty strings -> null
  // so blanking a field clears it on the server side.
  const v = (id) => document.getElementById(id).value.trim();
  const body = {
    externalOrderNumber: v('eoExternalNum') || null,
    proNumber:           v('eoProNum') || null,
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

  const btn = document.getElementById('eoSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await fetch(`${API}/orders/${COI}`, {
      method: 'PATCH',
      headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Save failed'; return; }
    closeModal('editOrderModal');
    openOrderDetail(COI); // refresh the detail view to show new values
  } catch(e){
    err.textContent = 'Network error';
  } finally {
    btn.disabled = false; btn.textContent = 'Save Changes';
  }
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
    alert('Cannot delete a SHIPPED order — it has already left the warehouse.');
    return;
  }
  const reason = prompt(
    `Delete order ${COD.order_number || ''}?\n\n` +
    `This soft-deletes the order — the row stays in the DB for audit but disappears from every list. ` +
    `Type a short reason (e.g. "duplicate of ORD-...", "customer cancelled", "test data"):`
  );
  if(reason === null) return;        // user clicked Cancel
  if(!reason.trim()){
    alert('Reason is required to delete an order.');
    return;
  }
  // Final yes/no
  if(!confirm(`Delete ${COD.order_number || ''} for reason: "${reason}" ?`)) return;

  try {
    const r = await fetch(`${API}/orders/${COI}?reason=${encodeURIComponent(reason)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${T}` },
    });
    const d = await r.json();
    if(!r.ok){ alert(d.error || 'Delete failed'); return; }
    closeOrderDetail();
    loadOrders();
  } catch(e){
    alert('Network error');
  }
}
