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
let PK_ROWS     = [];     // packages already created (each HAS a label)
let PK_MARKUP   = 0;      // % applied to carrier cost when buying
// The box being entered right now: rated, but not yet created. A box is only
// written to the database at the moment its label is bought, so this is the one
// piece of state that lives purely in the browser.
let PK_NEW      = { epShipmentId: null, rates: [], selectedRateId: null };

// Markup is OURS. The client is billed cost + markup; they never see the cost.
// Persisted per-session only — it's typed per shipment on purpose, because the
// number varies by client and by how the quote was sold.
function pkMarkup(){ return Number(PK_MARKUP) || 0; }

async function openPackagesModal(){
  if(!COI) return;
  // (P2d review) A stale `PK_RATES = {}` survived here after its declaration
  // was deleted — in sloppy mode that silently re-created the very global this
  // batch removed. The in-progress box state lives in PK_NEW; reset it per open.
  PK_NEW = { epShipmentId: null, rates: [], selectedRateId: null };

  PK_M = uiModal({
    title: `Packages — ${esc(COD?.order_number || '')}`,
    width: 760,
    body: `
      <div class="ui-banner ui-banner-info" style="margin-bottom:12px;">
        For each box: enter the weight and dimensions, <strong>Get rates</strong>, pick the
        service, then <strong>Create label</strong>. Repeat per box, then
        <strong>Complete shipment</strong> — that is the only thing that ships the order.
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
        <div class="ui-label">Next box</div>
        <span style="flex:1"></span>
      </div>
      <div class="ship-dims">
        ${uiField({ id: 'pkWeight', label: 'Weight (lbs) *', type: 'number' })}
        ${uiField({ id: 'pkLength', label: 'Length (in)',    type: 'number' })}
        ${uiField({ id: 'pkWidth',  label: 'Width (in)',     type: 'number' })}
        ${uiField({ id: 'pkHeight', label: 'Height (in)',    type: 'number' })}
      </div>
      <div class="ship-rates-bar">
        <button class="ui-btn ui-btn-primary" id="pkRateBtn">Get rates</button>
        <span class="ui-hint" id="pkAddHint">Prices this box. Nothing is created until you pick a service.</span>
      </div>
      <!-- Rates for the box being entered. The box does not exist yet: it is
           created together with its label once a service is chosen. There is no
           such thing here as a box without a label — the warehouse has no use for
           one, and it was the state that made the old flow feel inside-out. -->
      <div id="pkNewRates"></div>`,
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
    pkRenderList();       // billed figures on existing boxes move with the markup
    pkRenderNewRates();   // ...and so do the prices in the rate list being chosen from
  });
  PK_M.el.querySelector('#pkRateBtn').addEventListener('click', pkRateNew);

  // Changing the weight or dims invalidates the quote — those rates were for a
  // different parcel. Throw them away rather than let someone buy a label priced
  // for the box they typed a minute ago.
  ['pkWeight','pkLength','pkWidth','pkHeight'].forEach(id =>
    PK_M.el.querySelector('#' + id).addEventListener('input', () => {
      if(PK_NEW.epShipmentId) pkResetNewRates();
    }));

  await pkLoad();
}

// The box currently being entered — rated, but not yet created.
function pkResetNewRates(){
  PK_NEW = { epShipmentId: null, rates: [], selectedRateId: null };
  pkRenderNewRates();
}

function pkNewBoxInput(){
  const num = (id) => parseFloat(PK_M.el.querySelector('#' + id).value) || null;
  return {
    weightLbs: num('pkWeight'),
    lengthIn:  num('pkLength'),
    widthIn:   num('pkWidth'),
    heightIn:  num('pkHeight'),
  };
}

async function pkRateNew(){
  const box = pkNewBoxInput();
  if(!box.weightLbs || box.weightLbs <= 0){
    uiFieldError(PK_M.el, 'pkWeight', 'Weight is required to get rates');
    return;
  }
  uiFieldError(PK_M.el, 'pkWeight', '');

  const btn = PK_M.el.querySelector('#pkRateBtn');
  btn.disabled = true;
  PK_M.el.querySelector('#pkAddHint').textContent = 'Fetching rates…';

  try {
    const r = await fetch(`${API}/orders/${COI}/packages/rate`, {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
      body: JSON.stringify(box),
    });
    const d = await r.json().catch(() => ({}));
    if(!r.ok){
      PK_M.el.querySelector('#pkAddHint').textContent = '';
      return uiToast(d.error || 'Rate lookup failed', 'error');
    }
    PK_NEW = { epShipmentId: d.epShipmentId, rates: d.rates || [], selectedRateId: null };
    PK_M.el.querySelector('#pkAddHint').textContent =
      `${PK_NEW.rates.length} service${PK_NEW.rates.length === 1 ? '' : 's'} — cheapest first`;
    pkRenderNewRates();
  } finally {
    btn.disabled = false;
  }
}

function pkRenderNewRates(){
  const el = PK_M && PK_M.el.querySelector('#pkNewRates');
  if(!el) return;

  if(!PK_NEW.rates.length){ el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="ship-rates" style="margin-top:10px;">
      ${PK_NEW.rates.map(rt => {
        // Ops sees BOTH: what we pay, and what the client is billed. This screen is
        // ops-only — the margin is the reason the markup field exists.
        const client = Math.round(rt.rate * (1 + pkMarkup()/100) * 100) / 100;
        return `
          <label class="ship-rate">
            <input type="radio" name="pknewrate" value="${esc(rt.rateId)}"${PK_NEW.selectedRateId === rt.rateId ? ' checked' : ''}>
            <span class="ship-rate-svc">
              <strong>${esc(rt.carrierDisplay || rt.carrier)}</strong> ${esc(rt.service)}
              ${rt.deliveryDays ? `<span class="ui-hint"> · ${esc(rt.deliveryDays)}d</span>` : ''}
            </span>
            <span class="ui-hint" style="margin-right:10px;">cost ${uiMoney(rt.rate)}</span>
            <strong>${uiMoney(client)}</strong>
          </label>`;
      }).join('')}
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:8px;">
      <button class="ui-btn ui-btn-primary" id="pkCreateBtn">Create label</button>
    </div>`;

  el.querySelectorAll('input[name="pknewrate"]').forEach(inp =>
    inp.addEventListener('change', () => { PK_NEW.selectedRateId = inp.value; }));
  el.querySelector('#pkCreateBtn').addEventListener('click', pkCreateWithLabel);
}

// Creates the box AND buys its label in one call. There is no intermediate box.
async function pkCreateWithLabel(){
  if(!PK_NEW.selectedRateId) return uiToast('Pick a service first', 'error');

  const box  = pkNewBoxInput();
  const rate = PK_NEW.rates.find(r => r.rateId === PK_NEW.selectedRateId);
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

  const r = await fetch(`${API}/orders/${COI}/packages/label`, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${T}`},
    body: JSON.stringify({
      ...box,
      epShipmentId: PK_NEW.epShipmentId,
      rateId:       PK_NEW.selectedRateId,
      markupPct:    pkMarkup(),
    }),
  });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) return uiToast(d.error || 'Could not create the label', 'error');

  // Clear the form for the next box — ops packs several in a row.
  ['pkWeight','pkLength','pkWidth','pkHeight'].forEach(id => { PK_M.el.querySelector('#' + id).value = ''; });
  PK_M.el.querySelector('#pkAddHint').textContent = '';
  pkResetNewRates();

  uiToast(`Box ${d.package_seq} labelled`, 'success');
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
    el.innerHTML = `<div class="ui-empty">No boxes yet. Enter the first one below and get rates.</div>`;
    return;
  }

  // Every box in this list HAS a label — a box is created at the moment its label
  // is bought. There is no "no label" state to render any more.
  el.innerHTML = live.map(p => {
    const dims = [p.length_in, p.width_in, p.height_in].every(v => v)
      ? `${esc(p.length_in)}×${esc(p.width_in)}×${esc(p.height_in)} in`
      : '<span class="ui-muted">no dims</span>';

    // billed_amount is FROZEN server-side at purchase. Show that, never a
    // recomputed figure — the panel must agree with the invoice.
    const billed = p.billed_amount != null ? uiMoney(p.billed_amount) : '—';

    return `
      <div class="ui-group" style="padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="flex:1;">
            <div><strong>Box ${esc(p.package_seq)}</strong></div>
            <div class="ui-hint">${esc(p.weight_lbs)} lbs · ${dims}</div>
          </div>
          <div style="text-align:right;">
            <div>${uiChip(p.status)}</div>
            <div class="ui-hint" style="margin-top:4px;">${esc(p.carrier_code || '')} ${esc(p.service_level || '')}</div>
            <div class="ui-mono">${esc(p.tracking_number || '')}</div>
            <div style="margin-top:6px;">Client pays ${billed}</div>
            <div style="margin-top:6px;display:flex;gap:6px;justify-content:flex-end;">
              ${p.label_url ? `<a class="ui-btn" href="${esc(p.label_url)}" target="_blank" rel="noopener">Print label</a>` : ''}
              <button class="ui-btn ui-btn-danger js-pk-void" data-id="${esc(p.id)}">Void</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.js-pk-void').forEach(b =>
    b.addEventListener('click', () => pkVoid(b.dataset.id)));
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
    // The old flow had a trap here: ops typed the weight and dims, hit the big
    // blue button, and got told there were no boxes while staring at a filled-in
    // box form. That state no longer exists — a box is created together with its
    // label — but ops can still reach Complete with an un-rated box on screen.
    const typed = ['pkWeight','pkLength','pkWidth','pkHeight']
      .some(id => (PK_M.el.querySelector('#' + id) || {}).value);
    if(typed){
      await uiAlert({
        title: 'That box has no label yet',
        body: 'You\'ve entered the box, but no label has been bought for it — so there is '
            + 'nothing to ship.<br><br>Press <strong>Get rates</strong>, pick a service, then '
            + '<strong>Create label</strong>.',
      });
    } else {
      uiToast('Add at least one box first', 'error');
    }
    return false;
  }

  // No unlabelled-box check any more: a box cannot exist without a label.
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
