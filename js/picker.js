// =============================================================================
// MOBILE PICKER — full-screen takeover for the warehouse picker on a
// tablet. Loads one order's pending allocations and walks the picker
// through them one at a time. Each line shows: location, SKU, name,
// LP, lot, hazmat chip, special-handling banner. Big confirm button.
// Phase 1: no AI yet — just a phone/tablet-first UI on top of the
// existing /orders/:id/picks/:allocationId/confirm endpoint.
// =============================================================================

let _pickerOrder        = null;  // full /orders/:id payload
let _pickerPending      = [];    // pending allocations (filtered + sorted)
let _pickerIdx          = 0;     // current index into _pickerPending
let _pickerLastVerifyId = null;  // pick_attachment id of the last AI verification
let _pickerLastMatch    = null;  // 'yes' | 'partial' | 'no' | 'unreadable' | null

// =============================================================================
// ENTRY / EXIT
// =============================================================================

async function openMobilePicker(orderId){
  if(!orderId){ alert('No order selected'); return; }
  _pickerOrder = await apiGet(`/orders/${orderId}`);
  if(!_pickerOrder){ alert('Could not load order'); return; }

  // Pending = allocations that haven't been picked or cancelled yet,
  // sorted by location pick_sequence (the receive flow sets this).
  // Cancelled or already-picked rows are filtered out so the picker
  // only sees what's left to do.
  _pickerPending = (_pickerOrder.allocations || [])
    .filter(a => a.status !== 'PICKED' && a.status !== 'CANCELLED')
    .sort((a, b) => {
      const sa = a.pick_sequence == null ? Infinity : Number(a.pick_sequence);
      const sb = b.pick_sequence == null ? Infinity : Number(b.pick_sequence);
      return sa - sb;
    });
  _pickerIdx = 0;

  // Wire confirm + skip + verify (idempotent)
  const c = document.getElementById('pickerConfirmBtn');
  if(c && !c._wired){
    c._wired = true;
    c.addEventListener('click', confirmCurrentPick);
  }
  const s = document.getElementById('pickerSkipBtn');
  if(s && !s._wired){
    s._wired = true;
    s.addEventListener('click', skipCurrentPick);
  }
  const v = document.getElementById('pickerVerifyBtn');
  const camIn = document.getElementById('pickerCameraInput');
  if(v && !v._wired){
    v._wired = true;
    v.addEventListener('click', () => camIn.click());
  }
  if(camIn && !camIn._wired){
    camIn._wired = true;
    camIn.addEventListener('change', e => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if(file) verifyCurrentPickPhoto(file);
    });
  }

  document.getElementById('pickerOrderNum').textContent = _pickerOrder.order_number || '—';
  document.getElementById('pickerOrderSub').textContent = _pickerOrder.client_name || '';
  document.getElementById('pickerShell').style.display  = 'flex';
  document.getElementById('pickerStatus').textContent   = '';

  // Lock scroll on the underlying page so swiping inside picker doesn't
  // bleed through to the dashboard
  document.body.style.overflow = 'hidden';

  renderCurrentPick();
}

function exitMobilePicker(){
  document.getElementById('pickerShell').style.display = 'none';
  document.body.style.overflow = '';
  // If we just finished an order, refresh its detail view if open
  if(typeof COI !== 'undefined' && COI && _pickerOrder && COI === _pickerOrder.id) {
    if(typeof openOrderDetail === 'function') openOrderDetail(COI);
  }
  _pickerOrder = null;
  _pickerPending = [];
  _pickerIdx = 0;
}

// =============================================================================
// RENDER — current pick OR all-done
// =============================================================================

function renderCurrentPick(){
  const total = _pickerPending.length + (_pickerOrder.allocations || []).filter(a => a.status === 'PICKED').length;
  const doneCount = (_pickerOrder.allocations || []).filter(a => a.status === 'PICKED').length;
  document.getElementById('pickerProgress').textContent = `${doneCount} / ${total}`;

  if(_pickerIdx >= _pickerPending.length){
    renderAllDone();
    return;
  }

  const a = _pickerPending[_pickerIdx];
  const body = document.getElementById('pickerBody');

  // Hazmat banner (top of screen)
  const hazBanner = document.getElementById('pickerHazBanner');
  if(a.is_hazmat){
    hazBanner.style.display = '';
    hazBanner.innerHTML = `⚠ HAZMAT${a.un_number ? ' &middot; ' + esc(a.un_number) : ''}${a.hazard_class ? ' &middot; Class ' + esc(a.hazard_class) : ''} &middot; Follow handling instructions below`;
  } else {
    hazBanner.style.display = 'none';
  }

  // Special handling banner
  const hBanner = document.getElementById('pickerHandlingBanner');
  if(a.special_handling_instructions){
    hBanner.style.display = '';
    document.getElementById('pickerHandlingText').textContent = a.special_handling_instructions;
  } else {
    hBanner.style.display = 'none';
  }

  body.innerHTML = `
    <div style="background:#2a2a2a;border-radius:14px;padding:18px;margin-bottom:14px;border:2px solid #2a4a8c;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;font-weight:600;">📍 Location</div>
      <div style="font-size:42px;font-weight:800;letter-spacing:0.04em;font-family:ui-monospace,Menlo,monospace;color:#7eb6ff;margin-top:4px;">${esc(a.location_code || 'TBD')}</div>
    </div>

    <div style="background:#2a2a2a;border-radius:14px;padding:18px;margin-bottom:14px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;font-weight:600;">📦 SKU</div>
      <div style="font-size:24px;font-weight:700;font-family:ui-monospace,Menlo,monospace;color:#7eb6ff;margin-top:4px;">${esc(a.sku_code || '—')}</div>
      <div style="font-size:16px;opacity:.85;margin-top:6px;line-height:1.3;">${esc(a.sku_name || '')}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
      <div style="background:#2a2a2a;border-radius:14px;padding:16px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;font-weight:600;">License Plate</div>
        <div style="font-size:18px;font-weight:700;font-family:ui-monospace,Menlo,monospace;color:#fff;margin-top:4px;word-break:break-all;">${esc(a.lp_number || '—')}</div>
      </div>
      <div style="background:#2a2a2a;border-radius:14px;padding:16px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;font-weight:600;">Lot</div>
        <div style="font-size:18px;font-weight:700;font-family:ui-monospace,Menlo,monospace;color:${a.lot_number ? '#ffd591' : '#666'};margin-top:4px;">${esc(a.lot_number || 'no lot')}</div>
        ${a.expiry_date ? `<div style="font-size:11px;opacity:.7;margin-top:4px;">exp ${esc(new Date(a.expiry_date).toLocaleDateString())}</div>` : ''}
      </div>
    </div>

    <div style="background:#2a2a2a;border-radius:14px;padding:18px;margin-bottom:14px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;font-weight:600;margin-bottom:8px;">Quantity</div>
      <div style="display:flex;align-items:center;gap:14px;">
        <button onclick="adjustPickerQty(-1)" style="width:56px;height:56px;font-size:28px;font-weight:700;background:#3a3a3a;color:#fff;border:none;border-radius:12px;cursor:pointer;">−</button>
        <input id="pickerQtyInput" type="number" min="0" max="${esc(a.quantity || 0)}" value="${esc(a.quantity || 0)}"
               style="flex:1;font-size:36px;font-weight:800;text-align:center;background:#1a1a1a;color:#fff;border:2px solid #444;border-radius:12px;padding:12px;font-family:ui-monospace,Menlo,monospace;">
        <button onclick="adjustPickerQty(1)" style="width:56px;height:56px;font-size:28px;font-weight:700;background:#3a3a3a;color:#fff;border:none;border-radius:12px;cursor:pointer;">+</button>
      </div>
      <div style="font-size:12px;opacity:.6;margin-top:8px;text-align:center;">requested ${esc(a.quantity || 0)} ${esc(a.uom || 'EA')}</div>
    </div>
  `;

  // Reset state for the new pick — clear any prior verify result
  _pickerLastVerifyId = null;
  _pickerLastMatch    = null;
  document.getElementById('pickerVerifyBanner').style.display = 'none';
  document.getElementById('pickerVerifyBanner').innerHTML = '';
  document.getElementById('pickerConfirmBtn').style.background = '#28a745';
  document.getElementById('pickerConfirmBtn').textContent = '✓ CONFIRM PICK';
  document.getElementById('pickerVerifyBtn').disabled = false;
  document.getElementById('pickerVerifyBtn').style.opacity = '';
  document.getElementById('pickerVerifyBtn').textContent = '📷 Verify with Photo (AI)';
  document.getElementById('pickerStatus').textContent = '';
}

function adjustPickerQty(delta){
  const inp = document.getElementById('pickerQtyInput');
  if(!inp) return;
  const cur = Number(inp.value) || 0;
  const max = Number(inp.max) || 99999;
  inp.value = Math.max(0, Math.min(max, cur + delta));
}

function renderAllDone(){
  document.getElementById('pickerHazBanner').style.display = 'none';
  document.getElementById('pickerHandlingBanner').style.display = 'none';
  const total = (_pickerOrder.allocations || []).filter(a => a.status !== 'CANCELLED').length;
  const done  = (_pickerOrder.allocations || []).filter(a => a.status === 'PICKED').length;

  document.getElementById('pickerBody').innerHTML = `
    <div style="text-align:center;padding:48px 16px;">
      <div style="font-size:64px;line-height:1;margin-bottom:16px;">${done >= total ? '✓' : '⏸'}</div>
      <div style="font-size:24px;font-weight:700;margin-bottom:8px;">${done >= total ? 'All Done' : 'Nothing Left to Pick'}</div>
      <div style="font-size:14px;opacity:.7;margin-bottom:24px;">${esc(done)} of ${esc(total)} allocations picked on order ${esc(_pickerOrder.order_number || '')}</div>
      ${done >= total ? `
        <button onclick="exitMobilePicker()" style="background:#28a745;color:#fff;border:none;padding:18px 36px;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;">Exit Picker</button>
      ` : `
        <div style="font-size:13px;opacity:.7;margin-bottom:14px;">Some allocations were skipped or aren't pickable yet.</div>
        <button onclick="exitMobilePicker()" style="background:#444;color:#fff;border:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">Exit</button>
      `}
    </div>
  `;
  // Hide the confirm/skip footer when done
  document.getElementById('pickerFooter').style.display = 'none';
}

// =============================================================================
// AI VERIFICATION — picker takes a photo, server runs Claude vision,
// result banner shows green / yellow / red. Picker can override on a
// "no" match (override gets logged on the pick_attachments row).
// =============================================================================

async function verifyCurrentPickPhoto(file){
  if(_pickerIdx >= _pickerPending.length) return;
  const a = _pickerPending[_pickerIdx];

  const banner = document.getElementById('pickerVerifyBanner');
  const vbtn   = document.getElementById('pickerVerifyBtn');

  // Loading state
  vbtn.disabled = true;
  vbtn.style.opacity = '0.6';
  vbtn.textContent = 'Analyzing photo…';
  banner.style.display = 'block';
  banner.style.background = '#1f3a5e';
  banner.style.color = '#cfe3ff';
  banner.style.borderTop = '2px solid #2c7be5';
  banner.innerHTML = `<div>🤖 Claude is reading the photo… (typically 3-5 sec)</div>`;

  try {
    const fd = new FormData();
    fd.append('photo', file);
    const r = await fetch(`${API}/orders/${_pickerOrder.id}/picks/${a.id}/verify`, {
      method:'POST', headers:{ 'Authorization': `Bearer ${T}` }, body: fd,
    });
    const d = await r.json();
    if(!r.ok){
      banner.style.background = '#5a2c2c';
      banner.style.color = '#ffb3b3';
      banner.style.borderTop = '2px solid #d22';
      banner.innerHTML = `<div>❌ Verification failed: ${esc(d.error || 'unknown error')}</div>`;
      vbtn.disabled = false;
      vbtn.style.opacity = '';
      vbtn.textContent = '📷 Retry Photo';
      return;
    }

    _pickerLastVerifyId = d.attachment_id;
    _pickerLastMatch    = d.extracted?.match || 'unreadable';
    renderVerifyBanner(d.extracted || {});
    vbtn.disabled = false;
    vbtn.style.opacity = '';
    vbtn.textContent = '📷 Retake Photo';
  } catch(e){
    banner.style.background = '#5a2c2c';
    banner.style.color = '#ffb3b3';
    banner.innerHTML = `<div>❌ Network error reading photo</div>`;
    vbtn.disabled = false;
    vbtn.style.opacity = '';
    vbtn.textContent = '📷 Retry Photo';
  }
}

function renderVerifyBanner(e){
  const banner = document.getElementById('pickerVerifyBanner');
  const confirmBtn = document.getElementById('pickerConfirmBtn');
  const conf = e.confidence == null ? '' : ` ${Math.round(Number(e.confidence) * 100)}%`;

  let bg, fg, border, headline;
  if(e.match === 'yes'){
    bg = '#1f4d2e'; fg = '#a3ffb3'; border = '#28a745';
    headline = `✓ AI verified${conf}`;
    confirmBtn.style.background = '#28a745';
    confirmBtn.textContent = '✓ CONFIRM PICK (verified)';
  } else if(e.match === 'partial'){
    bg = '#5a4500'; fg = '#ffe4a3'; border = '#d6a700';
    headline = `⚠ Partial match${conf}`;
    confirmBtn.style.background = '#d6a700';
    confirmBtn.textContent = '✓ CONFIRM (partial)';
  } else if(e.match === 'no'){
    bg = '#5a2c2c'; fg = '#ffb3b3'; border = '#d22';
    headline = `✕ AI says wrong product${conf}`;
    confirmBtn.style.background = '#a14040';
    confirmBtn.textContent = '⚠ Override & Confirm';
  } else { // unreadable
    bg = '#3a3a3a'; fg = '#ddd'; border = '#888';
    headline = `📷 Photo unreadable${conf}`;
    confirmBtn.style.background = '#28a745';
    confirmBtn.textContent = '✓ CONFIRM PICK';
  }

  banner.style.background = bg;
  banner.style.color = fg;
  banner.style.borderTop = `2px solid ${border}`;

  const detected = (e.detected_text && e.detected_text.length)
    ? `<div style="font-size:11px;opacity:.85;margin-top:6px;"><strong>Detected:</strong> ${esc(e.detected_text.slice(0, 4).join(' · '))}</div>`
    : '';
  const matched = (e.matched_fields && e.matched_fields.length)
    ? `<div style="font-size:11px;opacity:.85;margin-top:4px;"><strong>Matched on:</strong> ${esc(e.matched_fields.join(', '))}</div>`
    : '';
  const concerns = e.concerns
    ? `<div style="font-size:11px;color:#ffd591;margin-top:6px;"><strong>Concern:</strong> ${esc(e.concerns)}</div>`
    : '';
  const reasoning = e.reasoning
    ? `<div style="font-size:12px;margin-top:6px;font-style:italic;opacity:.9;">${esc(e.reasoning)}</div>`
    : '';

  banner.innerHTML = `
    <div style="font-weight:700;font-size:14px;">${esc(headline)}</div>
    ${reasoning}
    ${matched}
    ${detected}
    ${concerns}
  `;
}

// =============================================================================
// CONFIRM / SKIP
// =============================================================================

async function confirmCurrentPick(){
  if(_pickerIdx >= _pickerPending.length) return;
  const a = _pickerPending[_pickerIdx];
  const inp = document.getElementById('pickerQtyInput');
  const qty = Math.max(0, Number(inp.value) || 0);

  if(qty <= 0){
    showPickerStatus('Quantity must be greater than 0', 'red');
    return;
  }
  if(qty > Number(a.quantity)){
    if(!confirm(`You're confirming ${qty} but only ${a.quantity} was allocated. Continue?`)) return;
  }

  // If the AI flagged a "no" match, require an override reason. The
  // reason gets logged on the pick_attachments row so supervisors can
  // see why the picker overruled the AI.
  let overrideReason = null;
  if(_pickerLastMatch === 'no'){
    overrideReason = prompt(
      `AI says this looks like the wrong product. Override anyway?\n\nReason (required, e.g. "label damaged", "AI misread lot"):`
    );
    if(!overrideReason || !overrideReason.trim()){
      showPickerStatus('Override cancelled', 'red');
      return;
    }
  }

  // Lock the button while we save
  const btn = document.getElementById('pickerConfirmBtn');
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.textContent = 'Saving…';

  try {
    const r = await fetch(`${API}/orders/${_pickerOrder.id}/picks/${a.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${T}` },
      body: JSON.stringify({ quantity: qty }),
    });
    if(!r.ok){
      const d = await r.json().catch(() => ({}));
      showPickerStatus(d.error || 'Save failed', 'red');
      return;
    }

    // Tag the verification row (if any) with what the picker did so the
    // supervisor view can show "confirmed" vs "overridden" vs "retook".
    if(_pickerLastVerifyId){
      const action = overrideReason ? 'overridden'
                   : _pickerLastMatch === 'yes' || _pickerLastMatch === 'partial' ? 'confirmed'
                   : 'confirmed';
      try {
        await fetch(`${API}/picks/attachments/${_pickerLastVerifyId}`, {
          method:'PATCH',
          headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${T}` },
          body: JSON.stringify({ action, override_reason: overrideReason || null }),
        });
      } catch(_) { /* swallow — pick still saved */ }
    }

    // Mark this allocation as picked locally so progress updates
    a.status = 'PICKED';
    _pickerIdx++;
    showPickerStatus('✓ Picked', 'green');
    setTimeout(() => renderCurrentPick(), 300);
  } catch(e){
    showPickerStatus('Network error', 'red');
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

function skipCurrentPick(){
  if(_pickerIdx >= _pickerPending.length) return;
  // Skip moves to the next pick without confirming. The allocation
  // stays in PENDING; the picker can come back to it (it's still in
  // _pickerPending). For now we just advance the cursor; cycling
  // through the queue circles back if the picker reaches the end.
  _pickerIdx++;
  if(_pickerIdx >= _pickerPending.length){
    // If they skipped to the end, look for any still-pending picks
    // they haven't confirmed yet. If everything's been cycled through,
    // show the partial-done view.
    const stillPending = _pickerPending.filter(a => a.status !== 'PICKED');
    if(stillPending.length){
      _pickerIdx = _pickerPending.indexOf(stillPending[0]);
    }
  }
  renderCurrentPick();
}

function showPickerStatus(msg, color){
  const el = document.getElementById('pickerStatus');
  el.style.color = color === 'red' ? '#ff6b6b' : color === 'green' ? '#7eff7e' : '#ddd';
  el.textContent = msg;
  setTimeout(() => { if(el.textContent === msg) el.textContent = ''; }, 2200);
}
