'use strict';
/* =============================================================================
 * PORTAL — 3PL client portal (Phase 3), on TERMINAL LEDGER (batch D2c).
 * =============================================================================
 * Activated by bootPortal() from app.js when the JWT carries userType='client'.
 * The portal reuses the ops inventory / orders / billing / reports pages — the
 * API locks those reads to req.user.clientId via scopeClient — and adds three
 * portal-only pages:
 *   - page-portalHome      : KPI tiles + SLA terms + a card hub
 *   - page-portalNewOrder  : simplified manual order entry
 *   - page-portalIntake    : PDF upload -> AI extraction
 *
 * Sidebar layout in portal mode is driven by body.portal-mode (CSS in app.css):
 * .nav-ops-only hides, .nav-portal-only shows, .ops-only controls inside pages
 * hide too.
 *
 * This is the screen family a CUSTOMER sees. Native dialogs, hand-formatted
 * money, and stray inline styles are not acceptable here — everything renders
 * through the ui.js components.
 * ========================================================================== */

let _portalNewOrderLines       = [];   // pending lines in the new-order form
let _portalShipToCache         = null; // prior ship-to addresses for the combo
let _portalNewOrderAttachments = [];   // staged File objects, uploaded post-create

const PNO_MAX_FILE = 25 * 1024 * 1024; // matches the API's multer limit

function isPortalMode() {
  return typeof U !== 'undefined' && U && U.userType === 'client';
}

function bootPortal() {
  document.body.classList.add('portal-mode');

  // Ops user looking at this client's portal ("View portal as client"):
  // persistent bar naming the client and the ops user, with End.
  if (U && U.preview) {
    document.body.classList.add('portal-preview');
    const bar = document.getElementById('portalPreviewBar');
    if (bar) {
      bar.hidden = false;
      const who = U.preview.impersonatorName || U.fullName || U.email || '';
      const modeLabel = U.preview.mode === 'act' ? 'acting as the client' : 'view only';
      document.getElementById('portalPreviewText').textContent = `Viewing ${U.clientName || U.clientCode || 'client'} portal as ${who} · ${modeLabel}`;
      const endBtn = bar.querySelector('.js-preview-end');
      if (endBtn && !endBtn._wired) { endBtn._wired = true; endBtn.addEventListener('click', uiBusyHandler(() => endPortalPreview())); }
    }
  }

  // Client name from the JWT (login LEFT JOINs clients). Falls back to the
  // client code, then a generic label — the UI never shows the word "client".
  const clientLabel = (U && (U.clientName || U.clientCode)) || 'Customer';

  if (U) {
    document.getElementById('userAvatar').textContent =
      (U.fullName || U.email || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('userName').textContent = U.fullName || U.email;
    const role = document.querySelector('.topbar-user-info .role');
    if (role) role.textContent = clientLabel;
  }

  const portalTitle = document.querySelector('#page-portalHome .page-title');
  if (portalTitle) portalTitle.textContent = clientLabel;

  const bannerName = document.getElementById('portalBannerName');
  const bannerSub  = document.getElementById('portalBannerSub');
  if (bannerName) bannerName.textContent = clientLabel;
  if (bannerSub && U && U.fullName) bannerSub.textContent = `Customer Portal · ${U.fullName}`;

  // The Inventory / Orders filter bars (status combos included) are built at
  // DOM-ready by uiFilterBar for both modes; the Client combo is .ops-only and
  // stays on its "All clients" placeholder here, so nothing to stub.

  // Pre-stub the Billing client filter so loadBilling() skips its first-run
  // init — that branch calls loadCC() -> GET /clients, which is requireOps and
  // would 403 a portal user.
  initCombo('billClientFilterWrap', [{ value: '', label: 'My Account' }],
    { placeholder: 'My Account' });

  navigateTo('portalHome');
}

/** End the preview: revoke the token server-side, then close the tab (or fall back to the login screen). */
async function endPortalPreview() {
  try {
    await fetch(`${API}/auth/portal-session/end`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{}' });
  } catch (_) {}
  try { sessionStorage.clear(); sessionStorage.setItem('tpfs_login_notice', 'Portal preview ended — you can close this tab.'); } catch (_) {}
  window.close();
  setTimeout(portalPreviewLeave, 300);   // a tab the user opened by hand cannot be closed by script
}
/** Fallback after End when the tab could not close: back to the login screen (shows the notice). */
function portalPreviewLeave() { if (!window.closed) location.href = location.pathname; }

/* ---------------------------------------------------------------------------
 * PORTAL HOME — KPI tiles, SLA terms, card hub
 * ------------------------------------------------------------------------- */
// No icons. This is a warehouse system a customer runs their business on, not
// an app store — the words carry the meaning.
// Each card carries the portal permission it needs (js/perms.js can():
// portal role AND company entitlement). Cards the user lacks are hidden by
// applyPermGates, both at first render and again once /auth/me has answered.
const PORTAL_CARDS = [
  { id: 'portalNewOrder', perm: 'portal.orders.create', title: 'Place an order',
    desc: 'Manual outbound order — choose SKUs, quantities and a ship-to.' },
  { id: 'portalIntake', perm: 'portal.orders.create', title: 'Upload documents',
    desc: 'Drop a PDF (PO, BOL, ASN, packing slip). It is read automatically and turned into an order.' },
  { id: 'inventory', perm: 'portal.inventory.view', title: 'Inventory',
    desc: 'On-hand SKUs, lots and licence plates held at the warehouse.' },
  { id: 'orders', perm: 'portal.orders.view', title: 'Orders',
    desc: 'Status of every order placed — open, picking, shipped.' },
  { id: 'billing', perm: 'portal.invoices.view', title: 'Billing',
    desc: 'Charges accrued on the account, by period.' },
  { id: 'reports', perm: 'portal.reports.run', title: 'Reports',
    desc: 'Activity, receiving, shipments and full lot traceability.' },
  { id: 'portalUsers', perm: 'portal.users.manage', title: 'Users',
    desc: 'Who at your company can sign in, and what they can do.' },
];

async function loadPortalHome() {
  const grid = document.getElementById('portalHomeGrid');
  grid.innerHTML = PORTAL_CARDS.map(c => `
    <button class="portal-card" data-target="${esc(c.id)}" data-perm="${esc(c.perm)}">
      <span class="portal-card-title">${esc(c.title)}</span>
      <span class="portal-card-desc">${esc(c.desc)}</span>
      <span class="portal-card-go">Open →</span>
    </button>`).join('');
  grid.querySelectorAll('.portal-card').forEach(card =>
    card.addEventListener('click', () => navigateTo(card.dataset.target)));
  if (typeof applyPermGates === 'function') applyPermGates(grid);

  const hi = document.getElementById('portalHomeGreeting');
  if (hi && U) hi.textContent = `Welcome, ${U.fullName || U.email || ''}`;

  if (!U || !U.clientId) return;

  // SLA metrics and terms are report data: hidden (not 403-toasted) when the
  // company is not entitled to reports or the role lacks them.
  const slaCard = document.getElementById('portalSlaTermsCard');
  const metricsRow = document.getElementById('portalMetricsRow');
  if (!can('portal.reports.run')) {
    if (slaCard) slaCard.style.display = 'none';
    if (metricsRow) metricsRow.innerHTML = '';
    return;
  }

  // /clients/:id/performance returns one item per ENABLED metric with its
  // value, target, and a server-derived status (good/warn/breach/info) — no
  // threshold logic here, we only map status -> tone.
  const perf = await apiGet(`/clients/${U.clientId}/performance`);
  renderPortalMetrics(perf?.items || [], perf?.raw || {});

  // The other half of the SLA: the rules themselves, and what gets billed when
  // an order falls outside them.
  const rules = await apiGet(`/clients/${U.clientId}/sla-rules`);
  renderPortalSlaTerms(rules || []);
}

// Metric status -> the frozen five-tone scale. Never a new color.
const PORTAL_METRIC_TONE = { good: 'ok', warn: 'warn', breach: 'danger' };

function fmtMetricValue(v, unit) {
  if (v == null) return '—';
  if (unit === 'pct')     return v + '%';
  if (unit === 'hours')   return Number(v).toLocaleString() + 'h';
  if (unit === 'minutes') return Number(v).toLocaleString() + 'm';
  return Number(v).toLocaleString();
}

function renderPortalMetrics(items, raw) {
  const row = document.getElementById('portalMetricsRow');
  if (!row) return;
  if (!items.length) {
    row.className = '';
    row.innerHTML = uiEmpty('No KPIs configured on your account yet — ask us to enable them.');
    return;
  }
  row.className = 'ui-tiles';
  row.innerHTML = items.map(it => {
    let sub = '';
    if (it.direction !== 'info' && it.target_value != null) {
      sub = `Target ${it.direction === 'higher_is_better' ? '≥' : '≤'} ${fmtMetricValue(it.target_value, it.unit)}`;
    } else if (it.metric_key === 'on_time_pct') {
      sub = `${raw._onTimeShipped || 0} of ${raw._shippedWithSla || 0} on time`;
    } else if (it.metric_key === 'orders_this_month') {
      sub = `${raw._ordersLastMonth || 0} last month`;
    }
    return uiTile({
      label: it.custom_label || it.label,
      value: fmtMetricValue(it.value, it.unit),
      tone: PORTAL_METRIC_TONE[it.status] || null,
      sub,
    });
  }).join('');
}

const PORTAL_SLA_COLS = [
  { key: '_rule', label: 'Rule', render: r =>
      `<div>${esc(r.rule_label || '')}</div>` +
      (r.notes ? `<div class="ui-hint">${esc(r.notes)}</div>` : '') },
  { key: '_value', label: 'Value', render: r => r.rule_value
      ? uiId(`${r.rule_value}${r.unit ? ' ' + r.unit : ''}`)
      : '<span class="ui-muted">—</span>' },
  { key: '_exc', label: 'If outside the rule', render: r =>
      `<span class="ui-muted">${esc(r.exception_charge_label || '—')}</span>` },
  { key: '_fee', label: 'Fee', money: false, render: r => r.exception_charge_amount != null
      ? uiMoney(r.exception_charge_amount)
      : '<span class="ui-muted">—</span>' },
];

function renderPortalSlaTerms(rules) {
  const card = document.getElementById('portalSlaTermsCard');
  const body = document.getElementById('portalSlaTermsBody');
  if (!card || !body) return;
  if (!rules.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  uiTable(body, { columns: PORTAL_SLA_COLS, rows: rules, rowKey: 'id' });
  // Fee column is right-aligned like the money column it is.
  body.querySelectorAll('tr').forEach(tr => {
    const cells = tr.children;
    if (cells.length === 4) cells[3].classList.add('right');
  });
}

/* ---------------------------------------------------------------------------
 * PORTAL NEW ORDER
 * ------------------------------------------------------------------------- */
const PNO_FIELDS = ['pnoCustName', 'pnoCustEmail', 'pnoAddr1', 'pnoAddr2', 'pnoCity',
                    'pnoState', 'pnoPostal', 'pnoPhone', 'pnoShipDate', 'pnoSkuSearch'];

async function loadPortalNewOrder() {
  _portalNewOrderLines = [];
  _portalNewOrderAttachments = [];
  PNO_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
    uiFieldError(document, id, '');
  });
  document.getElementById('pnoCountry').value = 'US';
  document.getElementById('pnoSkuResults').style.display = 'none';
  renderPortalNewOrderLines();
  renderPortalNewOrderAttachments();

  const attachInput = document.getElementById('pnoAttachInput');
  if (attachInput && !attachInput._wired) {
    attachInput._wired = true;
    attachInput.addEventListener('change', e => {
      for (const f of Array.from(e.target.files || [])) {
        if (f.size > PNO_MAX_FILE) {
          uiToast(`${f.name} is ${(f.size / 1024 / 1024).toFixed(1)}MB — 25MB max`, 'error');
          continue;
        }
        _portalNewOrderAttachments.push(f);
      }
      renderPortalNewOrderAttachments();
      e.target.value = '';   // allow re-picking the same file
    });
  }

  // Prior ship-to addresses, for one-click reuse.
  const addrs = await apiGet('/ship-to-addresses');
  _portalShipToCache = Array.isArray(addrs) ? addrs : [];
  initCombo('pnoPriorAddrWrap',
    [{ value: '', label: '— Use a saved ship-to —' }].concat(
      _portalShipToCache.map((a, i) => ({
        value: String(i),
        label: `${a.ship_to_name || a.customer_name || ''} — ${[a.ship_to_city, a.ship_to_state].filter(Boolean).join(', ')}`,
      }))),
    {
      placeholder: '— Use a saved ship-to —',
      onChange: (v) => {
        if (v === '' || v == null) return;
        const a = _portalShipToCache[parseInt(v)];
        if (!a) return;
        const set = (id, val) => { document.getElementById(id).value = val || ''; };
        set('pnoCustName',  a.ship_to_name || a.customer_name);
        set('pnoCustEmail', a.customer_email);
        set('pnoAddr1',     a.ship_to_line1);
        set('pnoAddr2',     a.ship_to_line2);
        set('pnoCity',      a.ship_to_city);
        set('pnoState',     a.ship_to_state);
        set('pnoPostal',    a.ship_to_postal);
        set('pnoCountry',   a.ship_to_country || 'US');
        set('pnoPhone',     a.ship_to_phone);
        uiToast('Ship-to filled in');
      },
    });

  document.getElementById('pnoCustName').focus?.();
}

// SKU search — /skus is auto-scoped to the user's client by the API.
const searchPortalSkus = debounce(async function () {
  const s   = document.getElementById('pnoSkuSearch').value.trim();
  const div = document.getElementById('pnoSkuResults');
  const list = await apiGet('/skus' + (s ? `?search=${encodeURIComponent(s)}` : ''));
  if (!list) { div.style.display = 'none'; return; }
  const rows = Array.isArray(list) ? list : (list.rows || list.data || []);
  div.style.display = 'block';
  if (!rows.length) {
    div.innerHTML = uiEmpty(s ? `No SKUs matching “${s}”` : 'No SKUs on your account yet');
    return;
  }
  div.innerHTML = rows.map(r => `
    <div class="pno-sku">
      <div class="pno-sku-row js-pno-sku" data-payload='${esc(JSON.stringify({
             skuId: r.id, sku_code: r.sku_code, sku_name: r.name || '',
             uom: r.uom || 'EA', sku_type: r.sku_type || '',
             qty_available: Number(r.qty_available || 0),
           }))}'>
        <span class="pno-sku-arrow">▸</span>
        ${uiId(r.sku_code)}
        <span class="pno-sku-name">${esc(r.name || '')}</span>
        <span class="ui-muted">${esc(r.uom || '')}</span>
        <span class="pno-sku-avail">${uiNum(Number(r.qty_available || 0).toLocaleString())} available</span>
      </div>
      <div class="pno-lots" id="pnoLots_${esc(r.id)}"></div>
    </div>`).join('');

  div.querySelectorAll('.js-pno-sku').forEach(row =>
    row.addEventListener('click', uiBusyHandler(() => {
      try { expandPortalSkuLots(row, JSON.parse(row.dataset.payload)); }
      catch (e) { uiToast('Could not read that SKU row', 'error'); }
    })));
}, 250);

// Click a SKU -> show its available lots; click a lot -> add the line.
async function expandPortalSkuLots(skuRow, sku) {
  const lots  = document.getElementById('pnoLots_' + sku.skuId);
  const arrow = skuRow.querySelector('.pno-sku-arrow');
  if (!lots) return;

  if (lots.classList.contains('open')) {          // toggle closed
    lots.classList.remove('open');
    lots.innerHTML = '';
    if (arrow) arrow.textContent = '▸';
    return;
  }
  lots.classList.add('open');
  if (arrow) arrow.textContent = '▾';
  lots.innerHTML = uiSpinner('Loading lots…');

  const d = await apiGet(
    `/inventory?limit=200&status=available&skuCode=${encodeURIComponent('%' + sku.sku_code + '%')}`);
  // Match on sku_code (sku_id representation varies) and require positive qty.
  const rows = (d?.rows || d || []).filter(r => r.sku_code === sku.sku_code && Number(r.quantity) > 0);
  if (!rows.length) { lots.innerHTML = uiEmpty('No available inventory for this SKU.'); return; }

  uiTable(lots, {
    columns: [
      { key: 'lot_number', label: 'Lot', render: r => uiId(r.lot_number || 'No lot') },
      { key: '_exp', label: 'Expiry', render: r => {
          if (!r.expiry_date) return '<span class="ui-muted">—</span>';
          const soon = new Date(r.expiry_date) < new Date(Date.now() + 30 * 864e5);
          const txt = new Date(r.expiry_date).toLocaleDateString();
          return soon ? `<span class="ui-chip ui-chip-danger">${esc(txt)}</span>` : uiId(txt);
        } },
      { key: 'location_code', label: 'Location', mono: true },
      { key: 'quantity', label: 'Available', num: true },
      { key: '_add', label: '', render: () => '<span class="pno-add">+ Add</span>' },
    ],
    rows, rowKey: 'lp_number',
    onRowClick: (r) => addPortalNewOrderLine({
      skuId: sku.skuId, sku_code: sku.sku_code, sku_name: sku.sku_name,
      uom: sku.uom, sku_type: sku.sku_type,
      lot_id: r.lot_id || null, lot_number: r.lot_number || null,
      expiry_date: r.expiry_date || null, location_code: r.location_code || null,
      qty_available: Number(r.quantity || 0),
    }),
  });
}

function addPortalNewOrderLine(p) {
  // De-dupe by (sku, lot) so one SKU across two lots is two lines.
  const key = p.skuId + '_' + (p.lot_id || 'nolot');
  const exists = _portalNewOrderLines.find(l => l._key === key);
  if (exists) {
    exists.qty = (Number(exists.qty) || 0) + 1;
  } else {
    _portalNewOrderLines.push({ _key: key, ...p, qty: 1 });
  }
  document.getElementById('pnoSkuSearch').value = '';
  document.getElementById('pnoSkuResults').style.display = 'none';
  renderPortalNewOrderLines();
  uiToast(`${p.sku_code} added`);
}

const PNO_LINE_COLS = [
  { key: 'sku_code', label: 'SKU', mono: true },
  { key: 'sku_name', label: 'Description' },
  { key: '_lot', label: 'Lot', render: l => l.lot_number
      ? uiId(l.lot_number) : '<span class="ui-muted">—</span>' },
  { key: '_exp', label: 'Expiry', render: l => {
      if (!l.expiry_date) return '<span class="ui-muted">—</span>';
      const soon = new Date(l.expiry_date) < new Date(Date.now() + 30 * 864e5);
      const txt = new Date(l.expiry_date).toLocaleDateString();
      return soon ? `<span class="ui-chip ui-chip-danger">${esc(txt)}</span>` : uiId(txt);
    } },
  { key: 'uom', label: 'UOM' },
  { key: 'qty_available', label: 'Available', num: true },
  { key: '_qty', label: 'Quantity', render: (l) => {
      const over = Number(l.qty) > Number(l.qty_available);
      return `<input type="number" min="1" step="1" class="ui-input pno-qty js-pno-qty${over ? ' pno-qty-over' : ''}"
                data-key="${esc(l._key)}" value="${esc(l.qty)}">`;
    } },
  { key: '_rm', label: '', render: (l) =>
      `<button class="ui-btn js-pno-rm" data-key="${esc(l._key)}" aria-label="Remove line">✕</button>` },
];

function renderPortalNewOrderLines() {
  const count = document.getElementById('pnoLinesCount');
  if (count) {
    const n = _portalNewOrderLines.length;
    const qty = _portalNewOrderLines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    count.textContent = n ? `${n} ${n === 1 ? 'line' : 'lines'} · ${qty} units` : '';
  }

  const host = document.getElementById('pnoLinesWrap');
  uiTable(host, {
    columns: PNO_LINE_COLS, rows: _portalNewOrderLines, rowKey: '_key',
    empty: 'No lines yet — search a SKU above, then pick the lot you want.',
  });

  host.querySelectorAll('.js-pno-qty').forEach(inp =>
    inp.addEventListener('input', () => {
      const l = _portalNewOrderLines.find(x => x._key === inp.dataset.key);
      if (!l) return;
      l.qty = parseInt(inp.value) || 0;
      inp.classList.toggle('pno-qty-over', Number(l.qty) > Number(l.qty_available));
      const n = _portalNewOrderLines.length;
      const qty = _portalNewOrderLines.reduce((s, x) => s + (Number(x.qty) || 0), 0);
      if (count) count.textContent = `${n} ${n === 1 ? 'line' : 'lines'} · ${qty} units`;
    }));
  host.querySelectorAll('.js-pno-rm').forEach(btn =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _portalNewOrderLines = _portalNewOrderLines.filter(l => l._key !== btn.dataset.key);
      renderPortalNewOrderLines();
    }));
}

function renderPortalNewOrderAttachments() {
  const wrap  = document.getElementById('pnoAttachList');
  const count = document.getElementById('pnoAttachCount');
  if (!wrap) return;
  if (count) {
    const n = _portalNewOrderAttachments.length;
    count.textContent = n ? `${n} ${n === 1 ? 'file' : 'files'}` : '';
  }
  if (!_portalNewOrderAttachments.length) {
    wrap.innerHTML = uiEmpty('No documents attached');
    return;
  }
  wrap.innerHTML = _portalNewOrderAttachments.map((f, i) => {
    const size = f.size > 1024 * 1024
      ? `${(f.size / 1048576).toFixed(2)} MB`
      : `${(f.size / 1024).toFixed(0)} KB`;
    const ext = (f.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
    return `<div class="ui-file">
      <span class="ui-file-ext">${esc(ext)}</span>
      <span class="ui-file-meta">
        <span class="ui-file-name">${esc(f.name)}</span>
        <span class="ui-hint">${esc(size)} · ${esc(f.type || 'unknown type')}</span>
      </span>
      <button class="ui-btn js-att-rm" data-idx="${esc(i)}" aria-label="Remove file">✕</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.js-att-rm').forEach(btn =>
    btn.addEventListener('click', () => {
      _portalNewOrderAttachments.splice(parseInt(btn.dataset.idx), 1);
      renderPortalNewOrderAttachments();
    }));
}

// Attachments upload after the order exists (/orders/:id/attachments is
// multipart, one file per call, and needs the order id).
async function uploadPortalNewOrderAttachments(orderId) {
  let failed = 0;
  for (const file of _portalNewOrderAttachments) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`${API}/orders/${orderId}/attachments`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd,
      });
      if (!r.ok) { failed++; uiToast(`${file.name} did not upload — you can add it later`, 'error'); }
    } catch (e) {
      failed++;
      uiToast(`${file.name} did not upload — network error`, 'error');
    }
  }
  return failed;
}

async function submitPortalNewOrder() {
  const val = (id) => document.getElementById(id).value.trim();
  const req = {
    pnoCustName: 'Ship-to name is required',
    pnoAddr1:    'Address line 1 is required',
    pnoCity:     'City is required',
    pnoState:    'State is required',
    pnoPostal:   'Postal code is required',
  };
  let bad = null;
  for (const [id, msg] of Object.entries(req)) {
    const empty = !val(id);
    uiFieldError(document, id, empty ? msg : '');
    if (empty && !bad) bad = id;
  }
  if (bad) {
    document.getElementById(bad).focus();
    return uiToast('Check the highlighted fields', 'error');
  }
  if (!_portalNewOrderLines.length) return uiToast('Add at least one SKU', 'error');
  const badQty = _portalNewOrderLines.find(l => !l.qty || l.qty <= 0);
  if (badQty) return uiToast(`Quantity must be greater than 0 for ${badQty.sku_code}`, 'error');

  const over = _portalNewOrderLines.filter(l => Number(l.qty) > Number(l.qty_available));
  if (over.length) {
    const ok = await uiConfirm({
      title: 'Order more than is available?',
      body: `${over.map(l => `<strong>${esc(l.sku_code)}</strong>: ${esc(l.qty)} requested, ${esc(l.qty_available)} available`).join('<br>')}
             <br><br>We will place the order and backorder the shortfall.`,
      confirmLabel: 'Place it anyway',
    });
    if (!ok) return;
  }

  // clientId / channel='PORTAL' / orderNumber are auto-filled by the API for
  // client users — the JWT is the source of truth, so we don't send them.
  const body = {
    customerName:     val('pnoCustName'),
    customerEmail:    val('pnoCustEmail') || null,
    requiredShipDate: document.getElementById('pnoShipDate').value || null,
    shipTo: {
      name:  val('pnoCustName'),
      line1: val('pnoAddr1'),
      line2: val('pnoAddr2') || null,
      city:  val('pnoCity'),
      state: val('pnoState'),
      postal: val('pnoPostal'),
      country: val('pnoCountry') || 'US',
      phone: val('pnoPhone') || null,
    },
    lines: _portalNewOrderLines.map(l => ({
      skuId: l.skuId, qty: Number(l.qty), uom: l.uom || 'EACH',
      // Requested lot — ops honors it during allocation.
      lotId: l.lot_id || null, lotNumber: l.lot_number || null,
    })),
  };
  const lotSummary = _portalNewOrderLines
    .filter(l => l.lot_number)
    .map(l => `${l.sku_code} → ${l.lot_number}${l.expiry_date ? ` (exp ${new Date(l.expiry_date).toLocaleDateString()})` : ''}`)
    .join('; ');
  if (lotSummary) body.notes = `Customer requested lots: ${lotSummary}`;

  const btn = document.getElementById('pnoSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const r = await fetch(`${API}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) return uiToast(d.error || 'Order could not be created', 'error');

    const n = _portalNewOrderAttachments.length;
    let failed = 0;
    if (n) {
      btn.textContent = `Uploading ${n} document${n === 1 ? '' : 's'}…`;
      failed = await uploadPortalNewOrderAttachments(d.id);
    }
    uiToast(`Order ${d.order_number} placed${n ? ` with ${n - failed} document(s)` : ''} — we'll allocate and ship it`);

    _portalNewOrderLines = [];
    _portalNewOrderAttachments = [];
    renderPortalNewOrderLines();
    renderPortalNewOrderAttachments();
    setTimeout(() => navigateTo('orders'), 900);
  } catch (e) {
    uiToast('Network error — the order was not placed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit order';
  }
}

/* ---------------------------------------------------------------------------
 * PORTAL INTAKE — PDF upload -> AI extraction -> ops review
 * ------------------------------------------------------------------------- */
function loadPortalIntake() {
  const drop = document.getElementById('portalIntakeDrop');
  if (drop && !drop._wired) {
    drop._wired = true;
    ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => {
      ev.preventDefault(); ev.stopPropagation();
      drop.classList.add('ui-drop-hot');
    }));
    ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => {
      ev.preventDefault(); ev.stopPropagation();
      drop.classList.remove('ui-drop-hot');
    }));
    drop.addEventListener('drop', ev => {
      const files = Array.from(ev.dataTransfer.files || [])
        .filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (files.length) uploadPortalIntakeFiles(files);
      else uiToast('PDFs only — that file type is not supported', 'error');
    });
  }

  const input = document.getElementById('portalIntakeUpload');
  if (input && !input._wired) {
    input._wired = true;
    input.addEventListener('change', ev => {
      const files = Array.from(ev.target.files || []);
      if (files.length) uploadPortalIntakeFiles(files);
      ev.target.value = '';
    });
  }

  refreshPortalIntakeList();
}

async function uploadPortalIntakeFiles(files) {
  const status = document.getElementById('portalIntakeStatus');
  let done = 0;
  for (const file of files) {
    if (file.size > PNO_MAX_FILE) {
      uiToast(`${file.name} is ${(file.size / 1048576).toFixed(1)}MB — 25MB max`, 'error');
      continue;
    }
    status.innerHTML = uiSpinner(`Uploading ${file.name} (${done + 1} of ${files.length})…`);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`${API}/intake/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload failed');
      done++;
      // Kick extraction off in the background.
      fetch(`${API}/intake/${d.id}/extract`, {
        method: 'POST', headers: { Authorization: `Bearer ${T}` },
      }).catch(() => {});
    } catch (e) {
      uiToast(`${file.name}: ${e.message}`, 'error');
    }
  }
  status.innerHTML = '';
  if (done) uiToast(`${done} document${done === 1 ? '' : 's'} uploaded — our AI is reading ${done === 1 ? 'it' : 'them'} now`);
  refreshPortalIntakeList();
  setTimeout(refreshPortalIntakeList, 2500);   // extraction usually lands by now
}

const PORTAL_INTAKE_COLS = [
  { key: '_when', label: 'Uploaded', render: r => uiId(fmtTimeShort(r.uploaded_at)) },
  { key: '_file', label: 'File', render: r => uiId((r.pdf_filename || '').slice(0, 60)) },
  { key: '_type', label: 'Type', render: r =>
      `<span class="ui-chip ui-chip-neutral">${esc(r.doc_type || '—')}</span>` },
  { key: '_size', label: 'Size', render: r => uiNum(fmtBytes(r.pdf_size_bytes)) },
  { key: 'status', label: 'Status', render: r => uiChip(r.status) },
  { key: '_result', label: 'Result', render: r => {
      if (r.created_order_number) return `<span class="ui-chip ui-chip-ok">SO ${esc(r.created_order_number)}</span>`;
      if (r.created_po_number)    return `<span class="ui-chip ui-chip-ok">PO ${esc(r.created_po_number)}</span>`;
      if (r.status === 'REJECTED') return '<span class="ui-muted">Not accepted — we will contact you</span>';
      if (r.status === 'APPROVED') return '<span class="ui-muted">—</span>';
      return '<span class="ui-muted">Pending our review</span>';
    } },
];

async function refreshPortalIntakeList() {
  const host = document.getElementById('portalIntakeWrap');
  if (!host) return;
  uiTableLoading(host, PORTAL_INTAKE_COLS);
  const data = await apiGet('/intake?limit=100');
  if (!data) return uiTableError(host, PORTAL_INTAKE_COLS, 'Could not load your uploads', refreshPortalIntakeList);
  uiTable(host, {
    columns: PORTAL_INTAKE_COLS, rows: data, rowKey: 'id',
    empty: 'No uploads yet — drop a PDF above to get started.',
  });
}
