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
  SHIPPED: 'ok', CANCELLED: 'neutral', BACKORDERED: 'danger',
  // billing runs / charges / invoices
  DRAFT: 'warn', POSTED: 'ok', DISCARDED: 'neutral', FAILED: 'danger', RUNNING: 'info',
  APPROVED: 'ok', SENT: 'info', PAID: 'ok', VOID: 'neutral',
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
    b.addEventListener('click', async () => {
      if (!a.onClick) return api.close();
      b.disabled = true;
      try {
        const keep = await a.onClick(api);
        if (keep !== false) api.close();
      } catch (e) {
        uiToast(e.message || 'Something went wrong', 'error');
      } finally { b.disabled = false; }
    });
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
function uiTable(container, { columns, rows, rowKey = 'id', onRowClick = null, empty = 'Nothing here yet.' }) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  const head = columns.map(c =>
    `<th class="${c.money || c.num ? 'right' : ''}">${esc(c.label ?? '')}</th>`).join('');
  if (!rows || !rows.length) {
    el.innerHTML = `<table class="ui-table"><thead><tr>${head}</tr></thead>
      <tbody><tr><td colspan="${columns.length}"><div class="ui-empty">${esc(empty)}</div></td></tr></tbody></table>`;
    return;
  }
  el.innerHTML = `<table class="ui-table"><thead><tr>${head}</tr></thead><tbody>
    ${rows.map(r => `<tr${onRowClick ? ` class="ui-row-click" data-key="${esc(r[rowKey])}"` : ''}>
      ${columns.map(c => `<td class="${c.money || c.num ? 'right' : ''}">${_uiCell(c, r)}</td>`).join('')}
    </tr>`).join('')}
  </tbody></table>`;
  if (onRowClick) {
    const byKey = Object.fromEntries(rows.map(r => [String(r[rowKey]), r]));
    el.querySelectorAll('.ui-row-click').forEach(tr =>
      tr.addEventListener('click', () => onRowClick(byKey[tr.dataset.key])));
  }
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
 * STAT TILES (Ledger hero element)
 *   uiTile({ label:'Total — period', value: 2900.5, money:true })
 *   uiTile({ label:'Charges', value: 22 })
 * Render a row of them inside a `.ui-tiles` container div.
 * ------------------------------------------------------------------------- */
function uiTile({ label, value, money = false, tone = null, sub = '' }) {
  const val = money ? uiMoney(value, { display: true })
    : `<span class="ui-num ui-tile-num">${esc(value ?? '—')}</span>`;
  return `<div class="ui-tile${tone ? ' ui-tile-' + esc(tone) : ''}">
    <div class="ui-tile-label">${esc(label)}</div>
    <div class="ui-tile-value">${val}</div>
    ${sub ? `<div class="ui-tile-sub">${esc(sub)}</div>` : ''}
  </div>`;
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
