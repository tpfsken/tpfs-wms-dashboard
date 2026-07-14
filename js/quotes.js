'use strict';
// =============================================================================
// PARCEL QUOTES — ops-only. "What would it cost to send this to 33101?"
//
// A quote is lines (ZIP + weight + dims) -> Get prices (rates every line,
// shows the BEST price per line) -> Save -> Download PDF. Saved quotes are
// listed below so last week's quote can be re-opened and re-printed.
//
// MONEY: this screen shows BOTH our carrier cost and the customer price —
// deliberately. It is requireOps on every endpoint and the margin is the
// point. The PDF the customer gets never carries cost or markup (the API
// builds it from a projection that structurally lacks them).
//
// TEST RATES: if the API says rate_mode='test' (sandbox EasyPost key), a
// persistent, non-dismissable banner renders at the top of the page. Sandbox
// rates look completely real; they must not reach a customer.
// =============================================================================

let QT_LINES  = [];      // form lines: {toPostal, weightLbs, lengthIn, widthIn, heightIn, description}
let QT_RESULT = null;    // last /quotes/rate response (lines carry .best/.rates)
let QT_SAVED  = null;    // last saved quote header (for Download PDF)
let QT_OFFSET = 0;
const QT_LIMIT = 25;

function qtBlankLine() {
  return { toPostal: '', weightLbs: '', lengthIn: '', widthIn: '', heightIn: '', description: '' };
}

function loadQuotes() {
  if (!QT_LINES.length) QT_LINES = [qtBlankLine()];
  qtRenderForm();
  qtLoadList();
}

// --- Rate-mode banner --------------------------------------------------------
// Rendered into its own host. No close button on purpose: a dismissable
// warning about wrong prices is a warning that gets dismissed.
function qtRenderModeBanner(mode) {
  const host = document.getElementById('qtModeBanner');
  if (!host) return;
  if (mode === 'test') {
    host.innerHTML = `<div class="ui-banner ui-banner-warn">
      <strong>TEST RATES — do not send to a customer.</strong>
      The shipping key is an EasyPost sandbox key; every price on this screen is synthetic.
      Saved quotes and PDFs are watermarked accordingly.
    </div>`;
  } else if (mode === 'live') {
    host.innerHTML = '';
  }
}

// --- The form ----------------------------------------------------------------

function qtRenderForm() {
  const host = document.getElementById('qtFormHost');
  if (!host) return;

  const rated = QT_RESULT ? Object.fromEntries(QT_RESULT.lines.map(l => [l.lineSeq, l])) : {};

  host.innerHTML = `
    <div class="ui-field-row">
      ${uiField({ id: 'qtCustomer', label: 'Customer', value: '', placeholder: 'Name on the quote (prospect or client)' })}
      ${uiField({ id: 'qtMarkup', label: 'Markup %', type: 'number', value: '', placeholder: '0', hint: 'Applied to every line at purchase price' })}
    </div>

    <div id="qtLineRows">
      ${QT_LINES.map((l, i) => qtLineRow(l, i, rated[i + 1])).join('')}
    </div>

    <div class="ui-field-row">
      <button class="ui-btn" id="qtAddLine">Add line</button>
      <button class="ui-btn ui-btn-primary" id="qtGetPrices">Get prices</button>
      <button class="ui-btn" id="qtSave" disabled>Save quote</button>
      <button class="ui-btn" id="qtPdf" disabled>Download PDF</button>
    </div>
    <div class="ui-hint" id="qtFormHint"></div>
  `;

  // Re-fill the customer/markup fields across re-renders.
  if (qtRenderForm._customer != null) document.getElementById('qtCustomer').value = qtRenderForm._customer;
  if (qtRenderForm._markup   != null) document.getElementById('qtMarkup').value   = qtRenderForm._markup;

  document.getElementById('qtAddLine').addEventListener('click', () => {
    qtCaptureForm();
    QT_LINES.push(qtBlankLine());
    QT_RESULT = null;          // the rates no longer match the lines
    qtRenderForm();
  });
  document.getElementById('qtGetPrices').addEventListener('click', qtGetPrices);
  document.getElementById('qtSave').addEventListener('click', qtSaveQuote);
  document.getElementById('qtPdf').addEventListener('click', () => QT_SAVED && qtOpenPdf(QT_SAVED.id, QT_SAVED.quote_number));

  host.querySelectorAll('[data-qt-remove]').forEach(b =>
    b.addEventListener('click', () => {
      qtCaptureForm();
      QT_LINES.splice(Number(b.dataset.qtRemove), 1);
      if (!QT_LINES.length) QT_LINES = [qtBlankLine()];
      QT_RESULT = null;
      qtRenderForm();
    }));

  // Any edit invalidates the current rates — a changed weight must not keep
  // the old price. Same rule the ship modal enforces on parcel edits.
  host.querySelectorAll('#qtLineRows input').forEach(inp =>
    inp.addEventListener('input', () => {
      if (!QT_RESULT) return;
      QT_RESULT = null;
      QT_SAVED = null;
      document.getElementById('qtSave').disabled = true;
      document.getElementById('qtPdf').disabled = true;
      document.getElementById('qtFormHint').textContent = 'Lines changed — run Get prices again.';
      host.querySelectorAll('[data-qt-result]').forEach(el => { el.innerHTML = ''; });
    }));

  if (QT_RESULT) {
    document.getElementById('qtSave').disabled = !QT_RESULT.lines.every(l => l.best);
    qtRenderModeBanner(QT_RESULT.rateMode);
  }
  if (QT_SAVED) document.getElementById('qtPdf').disabled = false;
}

function qtLineRow(l, i, rated) {
  return `<div class="ui-group"><div class="ui-group-body">
    <div class="item-sec-head">Box ${i + 1}
      ${QT_LINES.length > 1 ? `<button class="ui-btn" data-qt-remove="${i}">Remove</button>` : ''}
    </div>
    <div class="ui-field-row ship-dims">
      ${uiField({ id: `qtZip${i}`,  label: 'Dest. ZIP', value: l.toPostal, placeholder: '33101' })}
      ${uiField({ id: `qtWt${i}`,   label: 'Weight (lbs)', type: 'number', value: l.weightLbs })}
      ${uiField({ id: `qtL${i}`,    label: 'L (in)', type: 'number', value: l.lengthIn })}
      ${uiField({ id: `qtW${i}`,    label: 'W (in)', type: 'number', value: l.widthIn })}
      ${uiField({ id: `qtH${i}`,    label: 'H (in)', type: 'number', value: l.heightIn })}
    </div>
    ${uiField({ id: `qtDesc${i}`, label: 'Description', value: l.description, placeholder: 'What it is (shows on the PDF)' })}
    <div data-qt-result="${i}">${rated ? qtResultLine(rated) : ''}</div>
  </div></div>`;
}

function qtResultLine(r) {
  if (r.error) return `<div class="ui-banner ui-banner-warn">${esc(r.error)}</div>`;
  if (!r.best) return '';
  const b = r.best;
  return `<div class="ui-hint">
    <span class="ui-chip">${esc(b.carrierDisplay || b.carrier)}</span>
    ${esc(b.service || '')}
    ${b.deliveryDays != null ? ` · ${esc(String(b.deliveryDays))} day${b.deliveryDays === 1 ? '' : 's'}` : ''}
    · customer price <strong>${uiMoney(b.price)}</strong>
    <span class="ui-muted">(our cost ${uiMoney(b.cost)} · ${esc(String(r.rates.length))} rates seen)</span>
  </div>`;
}

function qtCaptureForm() {
  qtRenderForm._customer = document.getElementById('qtCustomer')?.value ?? qtRenderForm._customer;
  qtRenderForm._markup   = document.getElementById('qtMarkup')?.value   ?? qtRenderForm._markup;
  QT_LINES = QT_LINES.map((l, i) => ({
    toPostal:    document.getElementById(`qtZip${i}`)?.value.trim() ?? l.toPostal,
    weightLbs:   document.getElementById(`qtWt${i}`)?.value ?? l.weightLbs,
    lengthIn:    document.getElementById(`qtL${i}`)?.value ?? l.lengthIn,
    widthIn:     document.getElementById(`qtW${i}`)?.value ?? l.widthIn,
    heightIn:    document.getElementById(`qtH${i}`)?.value ?? l.heightIn,
    description: document.getElementById(`qtDesc${i}`)?.value.trim() ?? l.description,
  }));
}

function qtValidate() {
  let ok = true;
  QT_LINES.forEach((l, i) => {
    uiFieldError(document, `qtZip${i}`, '');
    uiFieldError(document, `qtWt${i}`, '');
    if (!l.toPostal) { uiFieldError(document, `qtZip${i}`, 'Required'); ok = false; }
    if (!Number(l.weightLbs) || Number(l.weightLbs) <= 0) { uiFieldError(document, `qtWt${i}`, 'Weight required'); ok = false; }
  });
  return ok;
}

async function qtGetPrices() {
  qtCaptureForm();
  if (!qtValidate()) return;

  const btn = document.getElementById('qtGetPrices');
  btn.disabled = true;
  document.getElementById('qtFormHint').textContent = 'Rating every line…';
  try {
    const r = await fetch(`${API}/quotes/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${T}` },
      body: JSON.stringify({
        markupPct: Number(qtRenderForm._markup) || 0,
        lines: QT_LINES.map(l => ({
          toPostal: l.toPostal, weightLbs: Number(l.weightLbs),
          lengthIn: Number(l.lengthIn) || null, widthIn: Number(l.widthIn) || null,
          heightIn: Number(l.heightIn) || null, description: l.description || null,
        })),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { uiToast(d.error || 'Could not get rates', 'error'); return; }

    QT_RESULT = d;
    QT_SAVED = null;
    qtRenderModeBanner(d.rateMode);
    qtRenderForm();
    const failed = d.lines.filter(l => !l.best).length;
    document.getElementById('qtFormHint').textContent =
      failed ? `${failed} line(s) could not be rated — fix them or remove them before saving.` : '';
  } catch (e) {
    uiToast('Network error — no rates fetched', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function qtSaveQuote() {
  if (!QT_RESULT || !QT_RESULT.lines.every(l => l.best)) {
    uiToast('Run Get prices first — every line needs a rate', 'error');
    return;
  }
  qtCaptureForm();

  const btn = document.getElementById('qtSave');
  btn.disabled = true;
  try {
    const r = await fetch(`${API}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${T}` },
      body: JSON.stringify({
        customerName: qtRenderForm._customer || null,
        markupPct: Number(qtRenderForm._markup) || 0,
        lines: QT_RESULT.lines.map((rl, i) => ({
          toPostal: rl.toPostal, toCountry: rl.toCountry,
          weightLbs: rl.weightLbs, lengthIn: rl.lengthIn, widthIn: rl.widthIn, heightIn: rl.heightIn,
          description: QT_LINES[i]?.description || rl.description,
          carrierCode: rl.best.carrierDisplay || rl.best.carrier,
          serviceLevel: rl.best.service,
          deliveryDays: rl.best.deliveryDays,
          quotedCost: rl.best.cost,
          rates: rl.rates,
        })),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { uiToast(d.error || 'Could not save the quote', 'error'); btn.disabled = false; return; }

    QT_SAVED = d;
    document.getElementById('qtPdf').disabled = false;
    uiToast(`Quote ${d.quote_number} saved`, 'success');
    qtLoadList();
  } catch (e) {
    uiToast('Network error — the quote was not saved', 'error');
    btn.disabled = false;
  }
}

// Fetch with the bearer token, then open — same pattern the report PDF export
// uses. A bare <a href> would arrive without the Authorization header.
async function qtOpenPdf(quoteId, quoteNumber) {
  uiToast('Building the PDF…');
  const r = await fetch(`${API}/quotes/${quoteId}.pdf`, { headers: { 'Authorization': `Bearer ${T}` } });
  if (!r.ok) return uiToast('Could not build the PDF', 'error');
  const url = URL.createObjectURL(await r.blob());
  if (!window.open(url, '_blank', 'noopener')) {
    uiToast(`Pop-up blocked — allow pop-ups to view ${quoteNumber}`, 'error');
  }
}

// --- Saved quotes ------------------------------------------------------------

async function qtLoadList() {
  const wrap = document.getElementById('qtListWrap');
  if (!wrap) return;
  try {
    const r = await fetch(`${API}/quotes?limit=${QT_LIMIT}&offset=${QT_OFFSET}`, {
      headers: { 'Authorization': `Bearer ${T}` },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { uiTableError(wrap, qtListColumns(), d.error || 'Could not load quotes', qtLoadList); return; }

    // If ANY saved quote is test-mode and the banner isn't up yet, raise it —
    // re-opening old sandbox quotes must carry the same warning.
    if (!QT_RESULT && d.rows.some(q => q.rate_mode === 'test')) qtRenderModeBanner('test');

    uiTable(wrap, {
      columns: qtListColumns(),
      rows: d.rows,
      empty: 'No saved quotes yet.',
      onRowClick: (row) => qtOpenQuote(row.id),
    });
    uiPager(document.getElementById('qtListPager'), {
      total: d.total, limit: QT_LIMIT, offset: QT_OFFSET, noun: 'quotes',
      onChange: (off) => { QT_OFFSET = off; qtLoadList(); },
    });
  } catch (e) {
    uiTableError(wrap, qtListColumns(), 'Network error', qtLoadList);
  }
}

function qtListColumns() {
  return [
    { key: 'quote_number',   label: 'Quote #', render: r => `<span class="ui-mono">${esc(r.quote_number)}</span>` },
    { key: 'customer_name',  label: 'Customer', render: r => esc(r.customer_name || r.client_name || '—') },
    { key: 'line_count',     label: 'Lines', num: true },
    { key: 'total_price',    label: 'Total', money: true, render: r => uiMoney(r.total_price) },
    { key: 'rate_mode',      label: 'Rates', render: r => r.rate_mode === 'live'
        ? '<span class="ui-chip">LIVE</span>'
        : '<span class="ui-chip ui-chip-warn">TEST</span>' },
    { key: 'created_at',     label: 'Created', render: r => new Date(r.created_at).toLocaleDateString() },
    { key: 'expires_at',     label: 'Valid to', render: r => r.expires_at ? new Date(r.expires_at).toLocaleDateString() : '—' },
  ];
}

async function qtOpenQuote(id) {
  const r = await fetch(`${API}/quotes/${id}`, { headers: { 'Authorization': `Bearer ${T}` } });
  const q = await r.json().catch(() => ({}));
  if (!r.ok) return uiToast(q.error || 'Could not open the quote', 'error');

  const expired = q.expires_at && new Date(q.expires_at) < new Date();
  uiModal({
    title: `Quote ${q.quote_number}`,
    width: 640,
    body: `
      ${q.rate_mode === 'test' ? `<div class="ui-banner ui-banner-warn"><strong>TEST RATES</strong> — this quote was built on a sandbox key. Not a valid price.</div>` : ''}
      ${expired ? `<div class="ui-banner ui-banner-warn">This quote expired ${new Date(q.expires_at).toLocaleDateString()} — rates have moved; re-quote before promising it.</div>` : ''}
      ${uiMeta([
        { k: 'Customer', v: esc(q.customer_name || q.client_name || '—') },
        { k: 'Created',  v: new Date(q.created_at).toLocaleString() },
        { k: 'Valid to', v: q.expires_at ? new Date(q.expires_at).toLocaleDateString() : '—' },
        { k: 'Markup',   v: esc(String(Number(q.markup_pct))) + '%' },
      ])}
      <div id="qtDetailLines"></div>
    `,
    actions: [
      { label: 'Download PDF', primary: true, onClick: () => { qtOpenPdf(q.id, q.quote_number); return false; } },
      { label: 'Close' },
    ],
  });

  uiTable(document.getElementById('qtDetailLines'), {
    columns: [
      { key: 'line_seq',     label: '#', num: true },
      { key: 'to_postal',    label: 'Dest.', render: l => `<span class="ui-mono">${esc(l.to_postal)}</span>` },
      { key: 'weight_lbs',   label: 'Lbs', num: true },
      { key: 'carrier_code', label: 'Carrier', render: l => esc(l.carrier_code || '—') },
      { key: 'service_level',label: 'Service', render: l => esc(l.service_level || '—') },
      { key: 'quoted_cost',  label: 'Our cost', money: true, render: l => uiMoney(l.quoted_cost) },
      { key: 'quoted_price', label: 'Price', money: true, render: l => uiMoney(l.quoted_price) },
    ],
    rows: q.lines,
    empty: 'No lines.',
  });
}
