# TPFS WMS — Conventions

This is a static SPA deployed to Netlify. The backend is a Railway-hosted Node API at `https://tpfs-wms-api-production.up.railway.app/api`. Read the master build doc for product scope; this file is just rules for how the code in this folder is written.

## File layout

```
index.html          — HTML shell only. No <script> blocks, no <style>.
app.css             — All styles. Add new styles here, not inline (one-off
                      layout tweaks via inline style="" are fine).
js/util.js          — esc(), debounce(), fmt helpers, SM/WF status maps.
js/combo.js         — Combo-box engine. cbVal/cbSet/cbReset are the public API.
js/clients.js       — Clients page + clientsCache + loadCC().
js/dashboard.js     — Dashboard renders.
js/inventory.js     — Inventory page + Case Break modal.
js/orders.js        — Orders list/detail/allocation + New Order modal.
js/inbound.js       — Receiving + New PO modal.
js/intake.js        — AI intake pipeline (upload, review, approve).
js/billing.js       — Billing page: per-client meter, events drill-down,
                      rate card editor.
js/reports.js       — Reports page. Reports are DEFINITIONS in the API's
                      reportRegistry.js; this file is a generic runner driven
                      by /reports/catalog. Adding a report = adding a definition.
js/password.js      — Password recovery: forgot / reset / change / admin reset /
                      forced-change gate. Loads before app.js.
js/app.js           — API base, auth (T, U, apiGet, doLogin), navigation,
                      boot(), DOMContentLoaded wiring. Loads LAST.
```

Scripts are plain `<script>` tags loaded sequentially — no modules, no bundler. Functions and globals are shared across files. If you add a new module, add the `<script>` tag to `index.html` *before* `js/app.js`.

## The four ways this app has actually broken — read before editing

Every one of these shipped or nearly shipped. They are not hypotheticals.

**1. A duplicate global takes down LOGIN.** There is no module system, so every
top-level `const`/`let`/`function` in `js/*.js` is a global. A duplicate
declaration is a SyntaxError → the script dies → `app.js`'s `loaders` map throws
on the missing function → `DOMContentLoaded` never runs → the Sign In button is
never wired. The symptom is "nobody can log in", and the cause looks unrelated.
`js/inventory.js` declaring `INV_COLS`, already owned by `js/invoices.js`, did
exactly this. **Sweep for duplicate top-level names before every commit.**

**2. NEVER write to this repo from a sandbox/VM shell.** Doing so has now
truncated three files mid-token: `sw.js`, `js/picker.js`, and `index.html` (which
carried 32KB of NUL bytes in every deploy for weeks, and made `grep` treat the
file as binary — so repo-wide greps silently skipped it). Use the editor's file
tools, or Claude Code on the host. A sandbox mount's view of this repo is also
**stale and untrustworthy for reads** — it has served a 647-line `app.css` with
no design system in it. Verify on the host.

**3. Anything `position:fixed` must be able to SCROLL.** A fixed overlay with no
`overflow-y:auto` and no height cap clips its own action buttons off-screen on a
short viewport, unreachable — you cannot scroll a fixed element. The picker's
Confirm button was literally unreachable on a phone. Same class of bug: a dialog
whose `z-index` is below a full-screen shell renders *invisible* (`.ui-overlay`
was 1000; `#pickerShell` is 9999). Native `alert()` masked it, because browsers
float those above everything — so it only broke at the moment the code was
modernised. **Layer order is documented at the top of the design-system block in
`app.css`. Read it before touching any z-index.**

**4. Flex children shrink.** `.page` is a scrolling flex column, so any block on
an overflowing page gets squashed BELOW its natural height and `.card{overflow:hidden}`
clips the content off. Hence `.page > *{flex-shrink:0}`. If content mysteriously
vanishes, suspect this before suspecting the data.

## Emoji: no

This is an enterprise WMS. **No pictographs anywhere in the UI** — no parcel
(U+1F4E6), pin (U+1F4CD), camera (U+1F4F7), clipboard (U+1F4CB) and so on. They
render as toys, they don't print on a BOL, and iOS renders some *typographic* marks
as colour emoji anyway.

Typographic marks only: `✓ ⚠ ✕ ☐ ● ○ ± ↓ ↑ ›`. Status is carried by **colour and a
word**, never by an icon alone.

Note the codepoints above are spelled out rather than shown: this rule must not
trip the very sweep it mandates. The sweep should return **zero** hits — a rule with
a permanent known false positive is a rule people learn to skip. Sweep with:

```
grep -P '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}]' -rn .
```

Grep **every file type**, not just `.js` — the emoji that survived the last sweep
were in `index.html`, which everyone had stopped looking at.

**5. A CSS class nobody defined styles NOTHING — silently.** Four shipped bugs of
the same shape: `.sev-chip`, `.btn-link`, `.ui-mono`, `.picker-ov-err` — markup
referencing a class `app.css` never defines. The element renders, unstyled, and
nobody notices until a hazmat badge turns out to be legible only because of an
emoji. **Run `node scripts/class-census.mjs` before every commit** — it checks
every class referenced in `js/*.js` + `index.html` against `app.css`, carries an
allowlist for the known-benign cases (printDocs' own stylesheet, JS hooks), and
must exit 0. Adding to its allowlist is a review decision, not a reflex.

**6. A second click fires a second request.** Every async click handler goes
through `uiBusy` (`js/ui.js`): `el.addEventListener('click', uiBusyHandler(async (e) => …))`,
inline `onclick="uiRun(this, () => loadOrders())"`, modal actions and
`uiTable` rows are wired already. While the promise runs the control is
disabled, shows a spinner + "Working…" (icon buttons: spinner only), further
clicks are ignored; on completion a brief success flash, or the error text
beside the control (a handler that reported `uiToast(…, 'error')` counts as a
failure). Pressed state is CSS `:active` via `--press-scale` / `--press-opacity`;
floor mode adds a vibration on press. **Run `node scripts/busy-census.mjs`
before every commit** — it flags any async click handler that is not wrapped
and must exit 0.

## XSS / HTML interpolation — NON-NEGOTIABLE

Every value coming from the API, the user, or any other untrusted source MUST go through `esc()` before being placed in `innerHTML` or an HTML attribute. No exceptions. `esc(undefined)` and `esc(null)` are safe; they return `''`.

```js
// GOOD
el.innerHTML = `<td>${esc(row.sku_code)}</td>`;
el.innerHTML = `<input value="${esc(row.name)}">`;

// BAD — never do this
el.innerHTML = `<td>${row.sku_code}</td>`;
```

For event handlers, NEVER inline-interpolate untrusted data into `onclick="..."`. Instead, use `data-*` attributes + `addEventListener` after render:

```js
// GOOD
el.innerHTML = `<button class="js-edit" data-id="${esc(row.id)}">Edit</button>`;
el.querySelectorAll('.js-edit').forEach(b =>
  b.addEventListener('click', () => editRow(b.dataset.id))
);

// BAD — JS injection waiting to happen
el.innerHTML = `<button onclick="editRow('${row.id}')">Edit</button>`;
```

For complex objects in onclick payloads, use `data-payload='${esc(JSON.stringify(obj))}'` and `JSON.parse(el.dataset.payload)` in the handler.

Inline `onclick="loadInventory()"` (literal call, no data) is acceptable but discouraged for new code — prefer wiring in `app.js` DOMContentLoaded.

## Combo boxes

Pages have wrapper divs like `<div class="cb-wrap" id="someWrap"></div>`. To use them:

```js
initCombo('someWrap', [{value:'A', label:'Option A'}, ...], {
  placeholder: 'Select...',
  value: 'A',                    // optional initial value
  onChange: (v, label) => { ... },
  allowCustom: true,             // user-typed values become options
});

cbVal('someWrap');                 // → 'A' or ''
cbSet('someWrap', 'B', 'Option B');
cbReset('someWrap');
```

Page-level filter combos are initialized once in `boot()` (see `app.js`). Modal combos are initialized in the `show*Modal()` function each open.

## API responses

Endpoints return either bare arrays OR `{rows: [...]}` OR `{data: [...]}` depending on which list endpoint. Always handle both:

```js
const list = d?.rows || d?.data || d || [];
```

Auth: every fetch needs `Authorization: Bearer ${T}`. Use `apiGet(path)` for GETs (it handles 401 → reload). For mutations, use raw `fetch` with the auth header.

## State

Globals live at the top of their module file (e.g. `COI`, `COD`, `AIC`, `orderLines` in `orders.js`). Don't add new top-level globals without a reason — prefer module-scoped variables. There is no module system, so `let foo = …;` at the top of `orders.js` is still global.

Session token + user are in `sessionStorage` as `tpfs_token` / `tpfs_user`, mirrored to `T` and `U` in `app.js`.

## Status / chip mapping

Order/workflow statuses: use the `SM` map and `WF` array from `util.js`. Don't redefine these. Add new statuses to `SM` if needed.

Inventory status colors: `available` → success, `allocated` → active, `damaged` → danger, anything else → warning. Keep this consistent.

## Bug fixes / things NOT to do again

- **Don't use `(v||'').toString()`** to render numeric values — `0` becomes `''`. Use `(v??'').toString()` or `esc(v ?? '')`.
- **Don't fabricate synthetic IDs** (`'inv_'+sku_code` style). If the data doesn't have a real ID, drop the row. The API rejects synthetic IDs.
- **Don't reference removed elements** — when a `<select>` becomes a combo, also update every `getElementById('xId').value` to `cbSet/cbVal('xWrap')`.
- **Don't add a new page without adding it to `loaders` in `app.js`** — otherwise the nav-click won't auto-load it.

## Adding a new page

1. Add the `<div class="page" id="page-foo">…</div>` block in `index.html`.
2. Add a `.nav-item` with `data-page="foo"` in the sidebar.
3. Add `foo: 'Foo'` to the `titles` map in `app.js`.
4. Add `foo: loadFoo` to the `loaders` map in `app.js`.
5. Create `js/foo.js` with `loadFoo()` and any modal logic.
6. Add `<script src="js/foo.js"></script>` to `index.html` before `app.js`.

## Hard rules

- Never write secrets, tokens, or API keys into source files.
- Never call `innerHTML = ` with untrusted data unless every interpolated value is wrapped in `esc()`.
- Never bypass auth — every API call goes through `apiGet` or includes the `Authorization` header manually.
- Don't introduce build tools, bundlers, frameworks, or TypeScript without explicit user request. The simplicity is intentional.


## Design system — TERMINAL LEDGER (NON-NEGOTIABLE for new/updated screens)

Direction: **Terminal** (Linear density) governs tables, chrome, chips, and
identifiers; **Ledger** (Stripe/Mercury) governs money and display figures.
Components live in `js/ui.js`; tokens + `ui-*` classes at the bottom of
`app.css`. Legacy classes remain until each screen's migration batch (D1-D7);
printed documents (printDocs.js) are EXCLUDED until their own batch.

Rules:

1. **No native dialogs.** `alert()`/`confirm()`/`prompt()` are banned in new
   or modified code. Use `await uiConfirm({...})`, `await uiPrompt({...})`,
   `uiAlert({...})`. They are Promise-based — the containing function must be
   `async`, and remember a pending dialog does NOT block other events the way
   native dialogs did.
2. **No new inline `style=""`** beyond trivial one-off layout (flex:1, a
   width). Spacing/typography/color always via tokens and `ui-*` classes.
3. **Every mutation reports via `uiToast(msg, 'success'|'error')`.** Silent
   success is a bug; `alert()`-as-error is a bug.
4. **Tables** through `uiTable()` (or `.ui-table` markup): 32px rows, sticky
   header, numerics right-aligned via `num:true`/`money:true`, identifiers
   (LP/SKU/order numbers) via `mono:true`.
5. **Money** renders through `uiMoney()` — never hand-format dollars. Stat
   tiles through `uiTile()` inside `.ui-tiles`.
6. **Statuses** render through `uiChip(status)`. The taxonomy has exactly
   five tones (ok/info/warn/danger/neutral) — map new statuses in
   `UI_STATUS_MAP`, never invent a new chip color.
7. **Tabs** through `uiTabs()` — do not build another tab system.
8. **Forms in modals** through `uiModal()` + `uiField()`/`uiFieldSelect()`
   with `uiFieldError()` for validation — never a `prompt()` chain.
9. `esc()` discipline is unchanged and applies inside anything you pass to
   these components as HTML.
