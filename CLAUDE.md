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
js/reports.js       — Reports page: Lot Recall (9.16) + future reports.
js/app.js           — API base, auth (T, U, apiGet, doLogin), navigation,
                      boot(), DOMContentLoaded wiring. Loads LAST.
```

Scripts are plain `<script>` tags loaded sequentially — no modules, no bundler. Functions and globals are shared across files. If you add a new module, add the `<script>` tag to `index.html` *before* `js/app.js`.

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
