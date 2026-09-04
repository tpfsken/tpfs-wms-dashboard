'use strict';
/* =============================================================================
 * DESIGN SYSTEM — component library (D0).  Direction: TERMINAL LEDGER.
 *
 *   Terminal (Linear density) governs tables, chrome, chips, identifiers:
 *   32px rows, 13px table body, monospace identifiers, tabular numerics,
 *   color reserved for status and money.
 *
 *   Ledger (Stripe/Mercury) governs money and display figures: big
 *   confident numerics, de-emphasized cents, stat tiles as hero elements.
 *
 * RULES (also in CLAUDE.md — enforcement, not suggestion):
 *   - No native alert()/confirm()/prompt(). Use uiAlert/uiConfirm/uiPrompt.
 *   - No new inline styles. Compose the ui-* classes / these components.
 *   - Every mutation gets a uiToast (success or error). Silence is a bug.
 *   - Statuses render through uiChip() — the frozen taxonomy below.
 *   - Every value from the API still goes through esc(). Components here
 *     escape what they're given; anything you interpolate yourself, you esc().
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * STATUS TAXONOMY — one scale for the whole app. Five tones, frozen.
 * Add MAPPINGS here (never new tones) when a new domain status appears.
 * ------------------------------------------------------------------------- */
const UI_TONE = { OK: 'ok', INFO: 'info', WARN: 'warn', DANGER: 'danger', NEUTRAL: 'neutral' };

const UI_STATUS_MAP = {
  // order flow
  NEW: 'info', ALLOCATED: 'info', PICKING: 'warn', PACKING: 'warn', STAGED: 'warn',
  SHIPPED: 'ok', SHIPPED_EXTERNALLY: 'ok', CANCELLED: 'neutral', BACKORDERED: 'danger',
  // allocation lifecycle (+ PICKED/PACKED as legacy order-status fallbacks)
  PENDING: 'info', PICKED: 'ok', PACKED: 'warn',
  // billing runs / charges / invoices
  DRAFT: 'warn', POSTED: 'ok', DISCARDED: 'neutral', FAILED: 'danger', RUNNING: 'info',
  APPROVED: 'ok', SENT: 'info', PAID: 'ok', VOID: 'neutral',
  OPEN: 'info', INVOICED: 'ok',   // a charge is OPEN until it lands on an invoice
  // rate cards
  ACTIVE: 'ok', SUPERSEDED: 'neutral', ARCHIVED: 'neutral',
  // inventory
  available: 'ok', allocated: 'info', damaged: 'danger', hold_qc: 'warn',
  // receiving
  receiving: 'warn', received: 'ok', partially_received: 'warn',
  confirmed: 'info', in_transit: 'info', draft: 'warn', closed: 'neutral', cancelled: 'neutral',
  // compliance bands
  auto_applied: 'ok', review_high: 'warn', review_low: 'warn', rejected: 'danger',
  pending: 'info', withdrawn: 'neutral', error: 'danger',
  // intake
  UPLOADED: 'info', EXTRACTING: 'info', EXTRACTED: 'warn', EXTRACTION_FAILED: 'danger',
  REJECTED: 'neutral',
  // hazmat certifications. expiring_soon is the only state you can still act on
  // before someone is uncertified — it must not look the same as expired.
  active: 'ok', expiring_soon: 'warn', expired: 'danger', revoked: 'neutral',
};

function uiChip(status, labelOverride) {
  const tone = UI_STATUS_MAP[status] || 'neutral';
  return `<span class="ui-chip ui-chip-${tone}">${esc(labelOverride ?? status)}</span>`;
}

/* ---------------------------------------------------------------------------
 * MONEY + NUMERICS (Ledger)
 * uiMoney(2900)        -> $2,900.00 with de-emphasized cents
 * uiMoney(n, {display:true}) -> stat-tile sized
 * uiNum(n)             -> tabular-nums span
 * uiId(v)              -> monospace identifier (LP/SKU/order numbers)
 * ------------------------------------------------------------------------- */
function uiMoney(n, { display = false } = {}) {
  const v = Number(n || 0);
  const neg = v < 0;
  const abs = Math.abs(v);
  const [d, c] = abs.toFixed(2).split('.');
  const whole = d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `<span class="ui-money${display ? ' ui-money-display' : ''}${neg ? ' ui-money-neg' : ''}">` +
    `${neg ? '−' : ''}<span class="ui-money-sym">$</span>${esc(whole)}<span class="ui-money-cents">.${esc(c)}</span></span>`;
}
function uiNum(n) { return `<span class="ui-num">${esc(n ?? '')}</span>`; }
function uiId(v) { return `<span class="ui-id">${esc(v ?? '')}</span>`; }

/* ---------------------------------------------------------------------------
 * DIALOG SERVICE — promise-based, focus-trapped, Esc cancels, Enter confirms.
 * Replaces every native alert()/confirm()/prompt().
 *
 *   const ok  = await uiConfirm({ title, body, confirmLabel, danger });
 *   const val = await uiPrompt({ title, label, value, placeholder });  // null = cancelled
 *   await uiAlert({ title, body });
 * ------------------------------------------------------------------------- */
let _uiDlgOpen = false;

function _uiDialog({ title, body = '', danger = false, confirmLabel = 'Confirm',
                     cancelLabel = 'Cancel', input = null, alertOnly = false }) {
  return new Promise((resolve) => {
    if (_uiDlgOpen) { resolve(alertOnly ? undefined : (input ? null : false)); return; }
    _uiDlgOpen = true;
    const prevFocus = document.activeElement;

    const ov = document.createElement('div');
    ov.className = 'ui-overlay';
    ov.innerHTML = `
      <div class="ui-dialog" role="${alertOnly ? 'alertdialog' : 'dialog'}" aria-modal="true">
        <div class="ui-dialog-title">${esc(title || '')}</div>
        ${body ? `<div class="ui-dialog-body">${body}</div>` : ''}
        ${input ? `<div class="ui-field" style="margin-top:12px;">
            ${input.label ? `<label class="ui-label">${esc(input.label)}</label>` : ''}
            <input class="ui-input" id="uiDlgInput" type="${esc(input.type || 'text')}"
                   value="${esc(input.value ?? '')}" placeholder="${esc(input.placeholder ?? '')}">
          </div>` : ''}
        <div class="ui-dialog-actions">
          ${alertOnly ? '' : `<button class="ui-btn" id="uiDlgCancel">${esc(cancelLabel)}</button>`}
          <button class="ui-btn ${danger ? 'ui-btn-danger' : 'ui-btn-primary'}" id="uiDlgOk">
            ${esc(alertOnly ? 'OK' : confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const okBtn = ov.querySelector('#uiDlgOk');
    const inputEl = ov.querySelector('#uiDlgInput');
    const done = (result) => {
      _uiDlgOpen = false;
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(result);
    };
    const confirmVal = () => done(alertOnly ? undefined : (input ? inputEl.value : true));
    const cancelVal = () => done(alertOnly ? undefined : (input ? null : false));

    okBtn.addEventListener('click', confirmVal);
    const cancelBtn = ov.querySelector('#uiDlgCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelVal);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) cancelVal(); });

    // Focus trap: Tab cycles within; Esc cancels; Enter confirms.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelVal(); }
      else if (e.key === 'Enter' && (!input || e.target === inputEl)) { e.preventDefault(); confirmVal(); }
      else if (e.key === 'Tab') {
        const f = [...ov.querySelectorAll('button, input')];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    (inputEl || okBtn).focus();
    if (inputEl) inputEl.select();
  });
}

function uiConfirm(opts) { return _uiDialog(typeof opts === 'string' ? { title: opts } : opts); }
function uiPrompt(opts)  { return _uiDialog({ ...opts, input: { label: opts.label, value: opts.value, placeholder: opts.placeholder, type: opts.type } }); }
function uiAlert(opts)   { return _uiDialog({ ...(typeof opts === 'string' ? { title: opts } : opts), alertOnly: true }); }

/* ---------------------------------------------------------------------------
 * TOAST SERVICE — every mutation reports. Success auto-dismisses; errors
 * stay longer.  uiToast('Saved', 'success') / uiToast(msg, 'error')
 * ------------------------------------------------------------------------- */
function uiToast(msg, type = 'success', timeout) {
  let host = document.getElementById('uiToastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'uiToastHost';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `ui-toast ui-toast-${type}`;
  t.innerHTML = `<span>${esc(msg)}</span>`;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('ui-toast-in'));
  const ms = timeout ?? (type === 'error' ? 6000 : 2800);
  setTimeout(() => { t.classList.remove('ui-toast-in'); setTimeout(() => t.remove(), 250); }, ms);
  _uiLastToast = { type, msg: String(msg), at: Date.now() };
}
let _uiLastToast = null;

/* ---------------------------------------------------------------------------
 * BUSY — one guard for every async click.
 *
 *   uiBusy(el, work)            run `work` (a promise, or a function returning
 *                               one) on behalf of control `el`: pressed state
 *                               is CSS (:active); while the promise runs the
 *                               control is disabled, shows a spinner + "Working…"
 *                               (buttons) or just dims (rows, cards), and every
 *                               further click is ignored — a second request can
 *                               never fire. On completion: a brief success
 *                               flash, unless the handler reported an error
 *                               toast meanwhile, in which case that message is
 *                               shown next to the control. A rejection shows
 *                               the error next to the control and re-throws.
 *   uiBusyHandler(fn, opts)     wrap a click handler: el.addEventListener('click', uiBusyHandler(async (e) => …))
 *   uiRun(el, fn)               for inline onclick: onclick="uiRun(this, () => loadOrders())"
 *   Floor mode adds a short vibration on press (see floor.js).
 * ------------------------------------------------------------------------- */
const UI_BUSY_LABEL = 'Working…';
const UI_FLASH_MS = 700;
function uiBusy(el, work, opts = {}) {
  if (el && el.dataset && el.dataset.uiBusy === '1') return Promise.resolve(undefined);   // already running: ignore
  let p;
  try { p = typeof work === 'function' ? work() : work; } catch (e) { p = Promise.reject(e); }
  if (!p || typeof p.then !== 'function' || !el || !el.classList) return p;               // synchronous: nothing to track
  const isBtn = el.tagName === 'BUTTON' || el.classList.contains('ui-btn');
  const wasDisabled = !!el.disabled, html = el.innerHTML, startedAt = Date.now();
  el.dataset.uiBusy = '1';
  el.classList.add('ui-busy');
  el.setAttribute('aria-busy', 'true');
  if (isBtn) {
    el.disabled = true;
    const iconOnly = (el.textContent || '').trim().length <= 2;      // "↻", "×", "+": spinner only, keep the footprint
    el.innerHTML = `<span class="ui-spin ui-btn-spin" aria-hidden="true"></span>${iconOnly ? '' : `<span>${esc(opts.label || UI_BUSY_LABEL)}</span>`}`;
  }
  uiBtnError(el, null);
  const restore = () => {
    delete el.dataset.uiBusy;
    el.classList.remove('ui-busy');
    el.removeAttribute('aria-busy');
    if (isBtn) { el.innerHTML = html; el.disabled = wasDisabled; }
  };
  return p.then((v) => {
    restore();
    const errToast = _uiLastToast && _uiLastToast.type === 'error' && _uiLastToast.at >= startedAt ? _uiLastToast.msg : null;
    if (errToast) uiBtnError(el, errToast);
    else if (v !== false) uiFlash(el);
    return v;
  }, (err) => {
    restore();
    uiBtnError(el, (err && err.message) || 'Something went wrong');
    throw err;
  });
}
function uiBusyHandler(fn, opts) {
  return function (e) { return uiBusy((e && e.currentTarget) || this, () => fn.call(this, e), opts); };
}
function uiRun(el, fn, opts) { return uiBusy(el, fn, opts); }
function uiFlash(el, tone = 'ok') {
  if (!el || !el.isConnected) return;
  el.classList.add(`ui-flash-${tone}`);
  setTimeout(() => el.classList.remove(`ui-flash-${tone}`), UI_FLASH_MS);
}
/** Error text right after the control (cleared on the next run or after a while). */
function uiBtnError(el, msg) {
  if (!el || !el.parentNode) return;
  let n = el.nextElementSibling && el.nextElementSibling.classList && el.nextElementSibling.classList.contains('ui-btn-err') ? el.nextElementSibling : null;
  if (!msg) { if (n) n.remove(); return; }
  if (!n) { n = document.createElement('span'); n.className = 'ui-btn-err ui-err-text'; n.setAttribute('role', 'alert'); el.insertAdjacentElement('afterend', n); }
  n.textContent = msg;
  clearTimeout(n._t);
  n._t = setTimeout(() => n.remove(), 8000);
}

/* ---------------------------------------------------------------------------
 * MODAL MANAGER — for real forms (the prompt()-chain killer).
 *
 *   const m = uiModal({ title, body: '<html>', width: 560, actions: [
 *     { label:'Cancel' },
 *     { label:'Save', primary:true, onClick: async (m) => {...; return true|false } },
 *   ]});
 *   m.close();  m.el = the modal element (query your inputs from it).
 * An action returning false (or a rejected promise) keeps the modal open.
 * ------------------------------------------------------------------------- */
function uiModal({ title, body = '', actions = [], width = 520, onClose = null }) {
  const ov = document.createElement('div');
  ov.className = 'ui-overlay';
  ov.innerHTML = `
    <div class="ui-modal" role="dialog" aria-modal="true" style="max-width:${Number(width)}px;">
      <div class="ui-modal-head">
        <div class="ui-dialog-title">${esc(title || '')}</div>
        <button class="ui-modal-x" aria-label="Close">✕</button>
      </div>
      <div class="ui-modal-body">${body}</div>
      <div class="ui-dialog-actions"></div>
    </div>`;
  document.body.appendChild(ov);
  const api = {
    el: ov.querySelector('.ui-modal'),
    close() {
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
      if (onClose) onClose();
    },
  };
  const acts = ov.querySelector('.ui-dialog-actions');
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'ui-btn' + (a.primary ? ' ui-btn-primary' : '') + (a.danger ? ' ui-btn-danger' : '');
    b.textContent = a.label;
    b.addEventListener('click', uiBusyHandler(async () => {
      if (!a.onClick) return api.close();
      try {
        const keep = await a.onClick(api);
        if (keep !== false) api.close();
        return keep;                       // false = validation failed: no success flash
      } catch (e) {
        uiToast(e.message || 'Something went wrong', 'error');
        return false;
      }
    }));
    acts.appendChild(b);
  }
  ov.querySelector('.ui-modal-x').addEventListener('click', api.close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) api.close(); });
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); api.close(); } };
  document.addEventListener('keydown', onKey, true);
  return api;
}

/* ---------------------------------------------------------------------------
 * FORM KIT — composable field HTML for modal bodies. Query values off m.el.
 *
 *   uiField({ id:'fName', label:'Name', value, placeholder, hint })
 *   uiFieldSelect({ id, label, options:[{value,label}], value })
 *   uiFieldError(m.el, 'fName', 'Required')   // inline error under a field
 * ------------------------------------------------------------------------- */
function uiField({ id, label, value = '', placeholder = '', type = 'text', hint = '' }) {
  return `<div class="ui-field" data-field="${esc(id)}">
    ${label ? `<label class="ui-label" for="${esc(id)}">${esc(label)}</label>` : ''}
    <input class="ui-input" id="${esc(id)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}">
    ${hint ? `<div class="ui-hint">${esc(hint)}</div>` : ''}
    <div class="ui-field-err" style="display:none;"></div>
  </div>`;
}
function uiFieldSelect({ id, label, options = [], value = '', hint = '' }) {
  return `<div class="ui-field" data-field="${esc(id)}">
    ${label ? `<label class="ui-label" for="${esc(id)}">${esc(label)}</label>` : ''}
    <select class="ui-input" id="${esc(id)}">
      ${options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label ?? o.value)}</option>`).join('')}
    </select>
    ${hint ? `<div class="ui-hint">${esc(hint)}</div>` : ''}
    <div class="ui-field-err" style="display:none;"></div>
  </div>`;
}
function uiFieldError(scopeEl, id, msg) {
  const f = scopeEl.querySelector(`[data-field="${CSS.escape(id)}"] .ui-field-err`);
  if (!f) return;
  f.textContent = msg || '';
  f.style.display = msg ? '' : 'none';
}

/* ---------------------------------------------------------------------------
 * TABLE KIT — Terminal density, Ledger numerics, built-in states.
 *
 *   uiTable(el, {
 *     columns: [
 *       { key:'lp_number', label:'LP', mono:true },
 *       { key:'qty', label:'Qty', num:true },
 *       { key:'total', label:'Amount', money:true },
 *       { key:'status', label:'', render: r => uiChip(r.status) },
 *     ],
 *     rows, rowKey:'id', onRowClick(row), empty:'No charges.',
 *   });
 *   uiTableLoading(el, cols) / uiTableError(el, cols, msg, retryFn)
 * ------------------------------------------------------------------------- */
function _uiCell(col, row) {
  if (col.render) return col.render(row);
  const v = row[col.key];
  if (col.money) return uiMoney(v);
  if (col.num) return uiNum(v);
  if (col.mono) return uiId(v);
  return esc(v ?? '');
}

/* Sorting. A column sorts on col.sortValue(row) when given — needed for render-
 * only columns whose `key` isn't a real field (e.g. '_created' -> created_at).
 * Otherwise it sorts on row[col.key]. Blanks always sink to the bottom,
 * whichever direction you're sorting — an empty ship-date is not "earliest". */
function _uiSortVal(col, row) {
  return col.sortValue ? col.sortValue(row) : row[col.key];
}
function _uiCompare(a, b) {
  const blankA = a === null || a === undefined || a === '';
  const blankB = b === null || b === undefined || b === '';
  if (blankA && blankB) return 0;
  if (blankA) return 1;          // blanks sink
  if (blankB) return -1;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
    return na - nb;
  }
  const da = Date.parse(a), db = Date.parse(b);
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/* uiTable sorting has two modes:
 *   - LOCAL  (default): sorts the rows it was handed. Fine for a detail table
 *     that holds everything it will ever hold (order lines, invoice lines).
 *   - SERVER (pass onSort): the table renders the header state and calls
 *     onSort(key, dir) — the caller refetches. USE THIS FOR ANY PAGED LIST.
 *     Sorting a page client-side sorts the page, not the list, which is a lie.
 */
function uiTable(container, opts) {
  const { columns, rows, rowKey = 'id', onRowClick = null,
          empty = 'Nothing here yet.', sortable = false, onSort = null } = opts;
  const el = typeof container === 'string' ? document.getElementById(container) : container;

  // Server mode: the caller owns sort state. Local mode: it lives on the
  // element, so a re-render (refresh, filter change) keeps the user's choice.
  const state = onSort
    ? { key: opts.sortKey ?? null, dir: opts.sortDir ?? 'asc' }
    : (el._uiSort || (el._uiSort = { key: opts.sortKey ?? null, dir: opts.sortDir ?? 'asc' }));
  const canSort = (c) => sortable && c.sortable !== false && (c.sortValue || c.key);

  let view = rows || [];
  if (state.key && !onSort) {
    const col = columns.find(c => c.key === state.key);
    if (col) {
      const sign = state.dir === 'desc' ? -1 : 1;
      // Blanks sink in BOTH directions, so sort them outside the sign flip.
      view = [...view].sort((r1, r2) => {
        const a = _uiSortVal(col, r1), b = _uiSortVal(col, r2);
        const blankA = a === null || a === undefined || a === '';
        const blankB = b === null || b === undefined || b === '';
        if (blankA || blankB) return _uiCompare(a, b);
        return sign * _uiCompare(a, b);
      });
    }
  }

  const head = columns.map(c => {
    const cls = [c.money || c.num ? 'right' : '', canSort(c) ? 'ui-th-sort' : ''].filter(Boolean).join(' ');
    const active = state.key === c.key;
    const arrow = !canSort(c) ? ''
      : `<span class="ui-sort${active ? ' ui-sort-on' : ''}">${active && state.dir === 'desc' ? '▼' : '▲'}</span>`;
    return `<th class="${cls}"${canSort(c) ? ` data-sort="${esc(c.key)}"` : ''}>${esc(c.label ?? '')}${arrow}</th>`;
  }).join('');

  const wireSort = () => {
    if (!sortable) return;
    el.querySelectorAll('th[data-sort]').forEach(th =>
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        // Same column -> flip direction. New column -> start descending for
        // dates (newest first is what people mean), ascending otherwise.
        const col = columns.find(c => c.key === k);
        let dir;
        if (state.key === k) dir = state.dir === 'asc' ? 'desc' : 'asc';
        else dir = col?.sortDefault || 'asc';
        state.key = k; state.dir = dir;
        if (onSort) onSort(k, dir);
        else uiTable(el, opts);
      }));
  };

  if (!view.length) {
    el.innerHTML = `<table class="ui-table"><thead><tr>${head}</tr></thead>
      <tbody><tr><td colspan="${columns.length}"><div class="ui-empty">${esc(empty)}</div></td></tr></tbody></table>`;
    wireSort();
    return;
  }

  el.innerHTML = `<table class="ui-table"><thead><tr>${head}</tr></thead><tbody>
    ${view.map(r => `<tr${onRowClick ? ` class="ui-row-click" data-key="${esc(r[rowKey])}"` : ''}>
      ${columns.map(c => `<td class="${c.money || c.num ? 'right' : ''}">${_uiCell(c, r)}</td>`).join('')}
    </tr>`).join('')}
  </tbody></table>`;

  if (onRowClick) {
    const byKey = Object.fromEntries(view.map(r => [String(r[rowKey]), r]));
    el.querySelectorAll('.ui-row-click').forEach(tr =>
      tr.addEventListener('click', uiBusyHandler(() => onRowClick(byKey[tr.dataset.key]))));   // rows dim while an async open runs; re-clicks ignored
  }
  wireSort();
}
function uiTableLoading(container, columns) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  const head = columns.map(c => `<th>${esc(c.label ?? '')}</th>`).join('');
  el.innerHTML = `<table class="ui-table"><thead><tr>${head}</tr></thead><tbody>
    ${'<tr>' + columns.map(() => '<td><span class="ui-skel"></span></td>').join('') + '</tr>'.repeat(1)}
    <tr>${columns.map(() => '<td><span class="ui-skel"></span></td>').join('')}</tr>
    <tr>${columns.map(() => '<td><span class="ui-skel"></span></td>').join('')}</tr>
  </tbody></table>`;
}
function uiTableError(container, columns, msg, retryFn) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  const head = columns.map(c => `<th>${esc(c.label ?? '')}</th>`).join('');
  el.innerHTML = `<table class="ui-table"><thead><tr>${head}</tr></thead>
    <tbody><tr><td colspan="${columns.length}">
      <div class="ui-error">⚠ ${esc(msg || 'Failed to load')} ${retryFn ? '<button class="ui-btn" id="uiRetryBtn">Retry</button>' : ''}</div>
    </td></tr></tbody></table>`;
  if (retryFn) el.querySelector('#uiRetryBtn').addEventListener('click', retryFn);
}

/* ---------------------------------------------------------------------------
 * PAGER — for every server-paged list. Says how much there IS, not just what
 * fits on screen. A list that silently stops at its limit is a data-integrity
 * bug, not a layout choice.
 *
 *   uiPager('pagerEl', { total, limit, offset, onChange: (limit, offset) => …,
 *                        noun: 'orders' });
 * ------------------------------------------------------------------------- */
const UI_PAGE_SIZES = [50, 100, 250, 500];

function uiPager(container, { total = 0, limit = 50, offset = 0, onChange, noun = 'rows' }) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  if (!total) { el.innerHTML = ''; return; }

  const from = offset + 1;
  const to   = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  el.className = 'ui-pager';
  el.innerHTML = `
    <span class="ui-pager-count">
      ${esc(from.toLocaleString())}–${esc(to.toLocaleString())} of
      <strong>${esc(total.toLocaleString())}</strong> ${esc(noun)}
    </span>
    <span style="flex:1"></span>
    <label class="ui-pager-size">
      Show
      <select class="ui-input" id="uiPagerSize">
        ${UI_PAGE_SIZES.map(n => `<option value="${n}"${n === limit ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
    <button class="ui-btn" id="uiPagerFirst" ${offset === 0 ? 'disabled' : ''}>« First</button>
    <button class="ui-btn" id="uiPagerPrev"  ${offset === 0 ? 'disabled' : ''}>‹ Prev</button>
    <span class="ui-pager-page">Page ${esc(page)} of ${esc(pages)}</span>
    <button class="ui-btn" id="uiPagerNext"  ${to >= total ? 'disabled' : ''}>Next ›</button>
    <button class="ui-btn" id="uiPagerLast"  ${to >= total ? 'disabled' : ''}>Last »</button>`;

  el.querySelector('#uiPagerSize').addEventListener('change', (e) =>
    onChange(Number(e.target.value), 0));           // page size change -> back to page 1
  el.querySelector('#uiPagerFirst').addEventListener('click', () => onChange(limit, 0));
  el.querySelector('#uiPagerPrev').addEventListener('click', () =>
    onChange(limit, Math.max(0, offset - limit)));
  el.querySelector('#uiPagerNext').addEventListener('click', () => onChange(limit, offset + limit));
  el.querySelector('#uiPagerLast').addEventListener('click', () =>
    onChange(limit, (pages - 1) * limit));
}

/* ---------------------------------------------------------------------------
 * STAT TILES (Ledger hero element)
 *   uiTile({ label:'Total — period', value: 2900.5, money:true })
 *   uiTile({ label:'Charges', value: 22 })
 * Render a row of them inside a `.ui-tiles` container div.
 * ------------------------------------------------------------------------- */
/* Ledger display type (28px) is for MONEY AND COUNTS. An identifier — an LP, a
 * location, a lot, a status word — is Terminal type: monospace, 15px, allowed
 * to wrap. Putting "LP-2025-00001-C1" in a display tile wraps it over four
 * lines and clips it. Pass compact:true for those. */
function uiTile({ label, value, money = false, tone = null, sub = '', compact = false }) {
  const val = money ? uiMoney(value, { display: true })
    : compact ? `<span class="ui-tile-id">${esc(value ?? '—')}</span>`
    : `<span class="ui-num ui-tile-num">${esc(value ?? '—')}</span>`;
  return `<div class="ui-tile${compact ? ' ui-tile-compact' : ''}${tone ? ' ui-tile-' + esc(tone) : ''}">
    <div class="ui-tile-label">${esc(label)}</div>
    <div class="ui-tile-value">${val}</div>
    ${sub ? `<div class="ui-tile-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

/* ---------------------------------------------------------------------------
 * META GRID — key/value record metadata (invoice header, order header…).
 *   uiMeta([{ k:'Client', v: esc(name) }, { k:'Due', v: uiId(date) }])
 * `v` is HTML: pass it through esc()/uiId()/uiMoney() yourself.
 * ------------------------------------------------------------------------- */
function uiMeta(pairs) {
  return `<div class="ui-meta">${pairs.map(p => `<div>
    <span class="ui-meta-k">${esc(p.k)}</span>
    <span class="ui-meta-v">${p.v ?? '—'}</span>
  </div>`).join('')}</div>`;
}

/* ---------------------------------------------------------------------------
 * TABS — the one tab system (replaces .cli-tab, .bill-tab, .cmp-tab in the
 * screen batches).
 *   uiTabs('hostEl', [{id:'runs',label:'Accrual Runs'},...], { active:'runs',
 *     onChange: id => {...} });
 * ------------------------------------------------------------------------- */
function uiTabs(container, tabs, { active, onChange }) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  el.className = 'ui-tabs';
  el.innerHTML = tabs.map(t =>
    `<button class="ui-tab${t.id === active ? ' active' : ''}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('');
  el.querySelectorAll('.ui-tab').forEach(b =>
    b.addEventListener('click', () => {
      el.querySelectorAll('.ui-tab').forEach(x => x.classList.toggle('active', x === b));
      onChange(b.dataset.tab);
    }));
}

/* ---------------------------------------------------------------------------
 * STATE TRIAD — for non-table surfaces.
 * ------------------------------------------------------------------------- */
function uiEmpty(msg) { return `<div class="ui-empty">${esc(msg || 'Nothing here yet.')}</div>`; }
function uiSpinner(label) { return `<div class="ui-loading"><span class="ui-spin"></span>${esc(label || 'Loading…')}</div>`; }
function uiError(msg) { return `<div class="ui-error">⚠ ${esc(msg || 'Something went wrong')}</div>`; }
