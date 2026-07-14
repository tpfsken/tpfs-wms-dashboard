// =============================================================================
// PACKAGES — multi-box outbound (P2b).
//
// Replaces the old single-parcel ship modal, which bought ONE label and shipped
// the order in the same click. That made a 4-box order impossible: the first
// label closed the order. Ops was shipping box by box.
//
// The flow now:
//   add box -> rate it -> buy its label   (repeat per box; ORDER DOES NOT MOVE)
//   -> Complete shipment                  (the ONLY thing that ships the order)
//
// LTL/FTL is NOT parcel. The manual "Ship without label" path stays exactly as
// it was — forcing a pallet through EasyPost rating would be nonsense.
//
// Globals are prefixed pk* / PK_. No module system: every top-level name here is
// a global, and a collision is a SyntaxError that kills login.
// =============================================================================

let PK_M        = null;   // the open packages uiModal
let PK_ROWS     = [];     // packages on the current order
let PK_RATES    = {};     // packageId -> rates[] (fetched on demand)
let PK_MARKUP   = 0;      // % applied to carrier cost when buying

// Markup is OURS. The client is billed cost + markup; they never see the cost.
// Persisted per-session only — it's typed per shipment on purpose, because the
// number varies by client and by how the quote was sold.
function pkMarkup(){ return Number(PK_MARKUP) || 0; }

async function openPackagesModal(){
  if(!COI) return;
  PK_RATES = {};

  PK_M = uiModal({
    title: `Packages — ${esc(COD?.order_number || '')}`,
    width: 760,
    body: `
      <div class="ui-banner ui-banner-info" style="margin-bottom:12px;">
        Add every box, buy a label for each, then <strong>Complete shipment</strong>.
        Buying a label no longer ships the order — the order closes only when all
        boxes have labels.
      </div>

      <!-- A percentage is 1-3 characters. A full-width input for it reads as if we
           expect a paragraph, and it dwarfs the boxes list underneath. -->
      <div class="pk-markup-row">
        <div class="ui-field pk-markup" data-field="pkMarkupPct">
          <label class="ui-label" for="pkMarkupPct">Markup %</label>
          <input class="ui-input pk-markup-input" id="pkMarkupPct" type="number" value="${esc(String(pkMarkup()))}" step="0.5">
          <div class="ui-field-err" style="display:none;"></div>
        </div>
        <div class="ui-hint pk-markup-hint">
          Applied to the carrier cost. Internal — the client never sees the raw rate.
        </div>
      </div>

      <div class="item-sec-head" style="margin-top:6px;">
        <div class="ui-label">Boxes</div>
        <span style="flex:1"></span>
      </div>
      <div id="pkList"></div>

      <div class="item-sec-head" style="margin-top:14px;">
        <div class="ui-label">Add a box</div>
        <span style="flex:1"></span>
      </div>
      <div class="ship-dims">
        ${uiField({ id: 'pkWeight', label: 'Weight (lbs) *', type: 'number' })}
        ${uiField({ id: 'pkLength', label: 'Length (in)',    type: 'number' })}
        ${uiField({ id: 'pkWidth',  label: 'Width (in)',     type: 'number' })}
        ${uiField({ id: 'pkHeight', label: 'Height (in)',    type: 'number' })}
      </div>
      <div class="ship-rates-bar">
        <!-- Primary-styled ON PURPOSE. Filling the fields above does not create a
             box — this button does. Ops filled the four fields and reached for
             "Complete shipment" (the other blue button), got told there were no
             boxes, and reasonably thought the screen was broken. -->
        <button class="ui-btn ui-btn-primary" id="pkAddBtn">Add box</button>
        <span class="ui-hint" id="pkAddHint">Adds the box above to this order. You'll rate and label it next.</span>
      </div>`,
    actions: [
      { label: 'Close' },
      // Kept for LTL/FTL and any carrier we don't buy postage for. A pallet is
      // not a parcel; do not route it through rate-shopping.
      { label: 'Ship without label (LTL / manual)', onClick: () => { PK_M.close(); showShipOrderModal(); return false; } },
      { label: 'Complete shipment', primary: true, onClick: pkComplete },
    ],
    onClose: () => { PK_M = null; PK_ROWS = []; },
  });

  PK_M.el.querySelector('#pkMarkupPct').addEventListener('input', e => {
    PK_MARKUP = parseFloat(e.target.value) || 0;
    pkRenderList();   // billed figures move with the markup
  });
  PK_M.el.querySelector('#pkAddBtn').addEventListener('click', pkAddBox);

  await pkLoad();
}

async function pkLoad(){
  const r = await apiGet(`/orders/${COI}/packages`);
  PK_ROWS = (r && r.rows) || [];
  pkRenderList();
}

function pkRenderList(){
  const el = PK_M && PK_M.el.querySelector('#pkList');
  if(!el) return;

  const live = PK_ROWS.filter(p => !p.voided_at);
  if(!live.length){
    el.innerHTML = `<div class="ui-empty">No boxes yet. Add the first one below.</div>`;
    return;
  }

  el.innerHTML = live.map(p => {
    const dims = [p.length_in, p.width_in, p.height_in].every(v => v)
      ? `${esc(p.length_in)}×${esc(p.width_in)}×${esc(p.height_in)} in`
      : '<span class="ui-muted">no dims</span>';

    const labelled = !!p.tracking_number;

    // Once bought, billed_amount is FROZEN server-side — show that, not a
    // recomputed figure, or the panel would disagree with the invoice.
    const billed = labelled
      ? (p.billed_amount != null ? uiMoney(p.billed_amount) : '—')
      : '<span class="ui-muted">—</span>';

    const right = labelled
      ? `<div style="text-align:right;">
           <div>${uiChip(p.status)}</div>
           <div class="ui-hint" style="margin-top:4px;">${esc(p.carrier_code || '')} ${esc(p.service_level || '')}</div>
           <div class="ui-mono" style="font-size:12px;">${esc(p.tracking_number)}</div>
           <div style="margin-top:6px;">Client pays ${billed}</div>
           <div style="margin-top:6px;display:flex;gap:6px;justify-content:flex-end;">
             ${p.label_url ? `<a class="ui-btn" href="${esc(p.label_url)}" target="_blank" rel="noopener">Label</a>` : ''}
             <button class="ui-btn ui-btn-danger js-pk-void" data-id="${esc(p.id)}">Void</button>
           </div>
         </div>`
      : `<div style="text-align:right;">
           <span class="ui-chip ui-chip-warn">no label</span>
           <div style="margin-top:6px;display:flex;gap:6px;justify-content:flex-end;">
             <button class="ui-btn js-pk-rate" data-id="${esc(p.id)}">Get rates</button>
             <button class="ui-btn ui-btn-danger js-pk-void" data-id="${esc(p.id)}">Remove</button>
           </div>
         </div>`;

    const rates = PK_RATES[p.id];
    const ratesHtml = (!labelled && rates)
      ? `<div class="ship-rates" style="margin-top:10px;">
           ${rates.map(rt => {
             // What WE pay vs what the CLIENT pays. Both shown — this screen is
             // ops-only, and the margin is the point of the markup field.
             const client = Math.round(rt.rate * (1 + pkMarkup()/100) * 100) / 100;
             return `
              <label class="ship-rate">
                <input type="radio" name="pkrate-${esc(p.id)}" value="${esc(rt.rateId)}">
                <span class="ship-rate-svc">
                  <strong>${esc(rt.carrierDisplay || rt.carrier)}</strong> ${esc(rt.service)}
                  ${rt.deliveryDays ? `<span class="ui-hint"> · ${esc(rt.deliveryDays)}d</span>` : ''}
                </span>
                <span class="ui-hint" style="margin-right:10px;">cost ${uiMoney(rt.rate)}</span>
                <strong>${uiMoney(client)}</strong>
              </label>`;
           }).join('')}
           <div style="display:flex;justify-content:flex-end;margin-top:8px;">
             <button class="ui-btn ui-btn-primary js-pk-buy" data-id="${esc(p.id)}">Buy label for box ${esc(p.package_seq)}</button>
           </div>
         </div>`
      : '';

    return `
      <div class="ui-group" style="padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="flex:1;">
            <div><strong>Box ${esc(p.package_seq)}</strong></div>
            <div class="ui-hint">${esc(p.weight_lbs)} lbs · ${dims}</div>
          </div>
          ${right}
        </div>
        ${ratesHtml}
      </div>`;
  }).join('');

  el.querySelectorAll('.js-pk-rate').forEach(b =>
    b.addEventListener('click', () => pkGetRates(b.dataset.id)));
  el.querySelectorAll('.js-pk-buy').forEach(b =>
    b.addEventListener('click', () => pkBuy(b.dataset.id)));
  el.querySelectorAll('.js-pk-void').forEach(b =>
    b.addEventListener('click', () => pkVoid(b.dataset.id)));
}

async function pkAddBox(){
  const num = (id) => parseFloat(PK_M.el.querySelector('#' + id).value) || null;
  const weightLbs = num('pkWeight');
  if(!weightLbs || weightLbs <= 0){
    uiFieldError(PK_M.el, 'pkWeight', 'Weight is required');
    return;
  }
  uiFieldError(PK_M.el, 'pkWeight', '');

  const r = await fetch(`${API}/orders/${COI}/packages`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({
      weightLbs, lengthIn: num('pkLength'), widthIn: num('pkWidth'), heightIn: num('pkHeight'),
    }),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not add the box', 'error');

  ['pkWeight','pkLength','pkWidth','pkHeight'].forEach(id => { PK_M.el.querySelector('#' + id).value = ''; });
  uiToast(`Box ${d.package_seq} added`, 'success');
  await pkLoad();
}

async function pkGetRates(pkgId){
  const r = await fetch(`${API}/orders/${COI}/packages/${pkgId}/rates`, {
    method:'POST', headers:{'Authorization':`Bearer ${T}`},
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Rate lookup failed', 'error');
  PK_RATES[pkgId] = d.rates || [];
  pkRenderList();
}

async function pkBuy(pkgId){
  const picked = PK_M.el.querySelector(`input[name="pkrate-${CSS.escape(pkgId)}"]:checked`);
  if(!picked) return uiToast('Pick a rate first', 'error');

  // Buying postage spends real money — confirm the number, and say plainly what
  // the client will be billed, since that is what ends up on their invoice.
  const rate = (PK_RATES[pkgId] || []).find(x => x.rateId === picked.value);
  const client = rate ? Math.round(rate.rate * (1 + pkMarkup()/100) * 100) / 100 : null;
  const ok = await uiConfirm({
    title: 'Buy this label?',
    body: rate
      ? `<strong>${esc(rate.carrierDisplay || rate.carrier)} ${esc(rate.service)}</strong><br><br>`
        + `Postage cost: <strong>${uiMoney(rate.rate)}</strong><br>`
        + `Markup: ${esc(pkMarkup())}%<br>`
        + `Client is billed: <strong>${uiMoney(client)}</strong>`
      : 'This buys postage.',
    confirmText: 'Buy label',
  });
  if(!ok) return;

  const r = await fetch(`${API}/orders/${COI}/packages/${pkgId}/buy`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({ rateId: picked.value, markupPct: pkMarkup() }),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not buy the label', 'error');

  delete PK_RATES[pkgId];
  uiToast(`Label bought for box ${d.package_seq}`, 'success');
  await pkLoad();
}

async function pkVoid(pkgId){
  const p = PK_ROWS.find(x => x.id === pkgId) || {};
  const hasLabel = !!p.tracking_number;

  const ok = await uiConfirm({
    title: hasLabel ? `Void the label on box ${esc(p.package_seq)}?` : `Remove box ${esc(p.package_seq)}?`,
    body: hasLabel
      ? 'The postage will be refunded through the carrier. The box stays on the order as a voided record — '
      + 'postage was really spent, so it is never silently deleted.'
      : 'This box has no label yet, so nothing is refunded.',
    confirmText: hasLabel ? 'Void label' : 'Remove box',
    tone: 'danger',
  });
  if(!ok) return;

  const r = await fetch(`${API}/orders/${COI}/packages/${pkgId}/void`, {
    method:'POST', headers:{'Authorization':`Bearer ${T}`},
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not void the box', 'error');

  // The refund can fail even when the void succeeds (already refunded, too old).
  // Say so — a silent "voided" would leave ops believing money came back.
  if(d.refund && String(d.refund).startsWith('refund_failed')){
    uiAlert({
      title: 'Box voided — but the refund did NOT go through',
      body: 'The box is off the order, but the carrier refused the postage refund. '
          + 'You will need to chase this with the carrier.<br><br>'
          + `<span class="ui-mono">${esc(d.refund)}</span>`,
    });
  } else {
    uiToast(hasLabel ? 'Label voided and refund requested' : 'Box removed', 'success');
  }
  await pkLoad();
}

async function pkComplete(){
  const live = PK_ROWS.filter(p => !p.voided_at);

  if(!live.length){
    // The trap: ops types the weight and dims, then hits the big blue button.
    // The fields LOOK like a box. Saying "add at least one box" while they stare
    // at a filled-in box form is gaslighting them. Say what actually happened.
    const typed = ['pkWeight','pkLength','pkWidth','pkHeight']
      .some(id => (PK_M.el.querySelector('#' + id) || {}).value);
    if(typed){
      await uiAlert({
        title: 'That box hasn\'t been added yet',
        body: 'You\'ve filled in the box details, but they haven\'t been added to the order.'
            + '<br><br>Press <strong>Add box</strong> first, then rate it and buy its label.',
      });
    } else {
      uiToast('Add at least one box first', 'error');
    }
    return false;
  }

  const unlabelled = live.filter(p => !p.tracking_number);
  if(unlabelled.length){
    // Name the boxes. "Some boxes have no label" makes ops hunt.
    uiToast(`Box ${unlabelled.map(p => p.package_seq).join(', ')} still needs a label`, 'error');
    return false;
  }

  const total = live.reduce((s, p) => s + (Number(p.billed_amount) || 0), 0);
  const ok = await uiConfirm({
    title: `Ship ${live.length} box${live.length === 1 ? '' : 'es'}?`,
    body: `This closes the order and bills the client.<br><br>`
        + `Freight billed: <strong>${uiMoney(total)}</strong> across ${live.length} box${live.length === 1 ? '' : 'es'}.`
        + `<br>Handling fees are added per your rate card.`,
    confirmText: 'Complete shipment',
  });
  if(!ok) return false;

  const r = await fetch(`${API}/orders/${COI}/shipment/complete`, {
    method:'POST', headers:{'Authorization':`Bearer ${T}`},
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ uiToast(d.error || 'Could not complete the shipment', 'error'); return false; }

  uiToast('Order shipped', 'success');
  PK_M.close();
  loadOrderDetail(COI);
  return false;   // already closed
}
