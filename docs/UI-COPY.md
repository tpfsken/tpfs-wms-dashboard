# UI copy guide — TPFS WMS dashboard

Adopted 2026-09-06 from the read-only audit in `docs/COPY-AUDIT.xlsx` (3,282
user-facing strings extracted from `index.html`, `js/*.js`, the API's error
messages and the password-reset email; 723 flagged). Nothing in the UI was
changed by the audit. This file is the standard new copy is written to and old
copy is corrected toward.

## 1. Terminology — one term per concept

Use the canonical term everywhere a person reads it: labels, buttons, table
headers, toasts, empty states, API error messages, emails. Database column
names and API field names are not copy and keep their own names.

| Concept | Canonical term | Replaces (count in the audit) | Notes |
| --- | --- | --- | --- |
| A thing the warehouse stores for a client | **item** | SKU (74), SKUs (11), product (7), part (1); "item" already 72 | "SKU code" stays as the name of the identifier field; the thing itself is an item. Plural "items". |
| The company the warehouse works for | **client** | account (18 / 5 — when it means the company), customer (30 / 1 — when it means the company) | "customer" is kept for the party an order ships **to** (`customer_name`, ship-to). "account" is kept for a login. Never "tenant" in copy. |
| Goods arriving | **receipt** | PO (31), POs (1), purchase order (2 / 1), ASN (4), inbound (3), receiving (11 — as a noun for the document) | The page that lists them is **Receiving** (verb form, a place); each document is a receipt. Use "supplier reference" for the client's PO number. |
| Goods leaving | **order** | fulfillment (1); shipment (19 / 9 — when it means the order) | An order has one or more **packages**. "Shipment" is reserved for the carrier's shipment / the label; do not use it for the order or for "shipped orders" — say "shipped orders". |
| A tracked container of stock | **license plate** (abbrev. **LP** in tables only) | LP (50), LPs (9), licence plate(s) (3), pallet (4 — when it means the LP) | US spelling "license". "Pallet" is a physical pallet or the PALLET pack level, not the LP. |
| Pack levels | **each / case / pallet** | eaches, inner pack | Match the `sku_type` values in lower case in prose, upper case only in code. |
| The person picking / packing | **picker / packer** | user, operator | Role names (Admin, Supervisor, Floor) are capitalised only when naming the role. |
| Barcodes | **barcode** | UPC / EAN / GTIN when generic | Use the specific name (UPC, EAN, GTIN-14) only when the format matters. |
| Legacy warehouse system | **the legacy system** | Excalibur (76 strings incl. API) | Vendor name belongs in a tooltip or the Migration page's own title, not in generic labels or toasts. |
| Order source / label system | **the shipping system** | ShipStation | Same rule. "Prints in ShipStation" becomes "prints in the shipping system" with the vendor in a tooltip. |
| Label provider | **the label provider** | EasyPost | Same rule. |
| Your company | **{warehouse name}** from tenant settings | TPFS, TPFS Warehouse, TPFS WMS (branding: 2 strings; internal-name: several) | The product name and the tenant's name come from configuration, never from a string literal. |

Words to avoid entirely in copy: tenant, payload, uuid, null, JSON, migration
NNN, endpoint, snake_case identifiers (`sku_code`, `client_id`, `tier_rules`),
status codes.

## 2. Tone

- Plain, direct, second person. "You" for the reader, never "I" or "we" ("we'll
  send you a link" → "A link is sent to your email").
- Neutral and enterprise: no exclamation marks, no "oops", "sorry", "yay",
  no emoji (the class-census gate already forbids emoji glyphs).
- Say what happened and what to do next; do not explain the internals ("cache
  invalidated", "session cache") unless the reader can act on it.
- Numbers, names and codes the reader typed back go in the sentence as data,
  not as blame: "Barcode 036000291453 has a bad check digit (should end in 2)."
- Confirmations name the object and the consequence: "Deactivate Maria Lopez?
  She is signed out within a minute and cannot sign in until reactivated."
- Empty states say what the reader can do: "No items yet — use Add item."
- Hints are one sentence, no trailing period when they are fragments.

## 3. Casing

- **Sentence case everywhere**: page titles, card titles, buttons, tabs, table
  headers, menu items, chips ("Add item", "Item master", "Portal access",
  "Order queue", "Pick waves", "Dock schedule", "Sign out"). Today 76 buttons
  are sentence case and 4 are Title Case; nav items and print documents are
  the main Title Case holdouts (71 strings flagged).
- Proper nouns and role names keep their capitals: Admin, Supervisor, Floor,
  Client admin, Client viewer, Bill of Lading (document name), UPC, EAN, GTIN,
  SDS, COA, PO (only when quoting a supplier's document).
- Status chips are upper case by design (ACTIVE, SHIPPED) — they are values,
  not sentences.
- Never start a visible sentence or label in lower case ("case code", "not
  imported" as a select option is fine; as a label it is not).
- Units: "lb" / "lbs" after a number, "in" for inches, "×" between
  quantities in tables, "·" as the separator in meta lines.

## 4. Error messages

Pattern, in this order: **what is wrong** (naming the field or object in the
reader's words) → **why, if it helps** → **what to do**.

| Instead of | Write |
| --- | --- |
| `rule_label required` | Enter a rule label. |
| `tier_rules must be a non-empty array` | Add at least one tier rule. |
| `{id} must be a uuid` | That record could not be found. |
| `Invalid or expired token` | Your session has expired. Sign in again. |
| `Internal server error` | Something went wrong on our side. Try again, and contact support if it keeps happening. |
| `hazardClass required when isHazmat is true` | Enter a hazard class for a hazmat item. |
| `role "csr" does not exist for this tenant` | The role "csr" does not exist. Pick one from the list. |
| `Label not found in ShipStation` | The shipping system has no label for this package. Create the label there, then try again. |

Rules:

- One sentence for the problem, an optional second for the action. Full stops.
- Field names in plain words, matching the label on screen, never the API key.
- Never reveal which of several failure modes happened when that helps an
  attacker (login, password reset keep their single message).
- Codes the UI branches on (`PERMISSION_DENIED`, `CLIENT_INACTIVE`,
  `TOKEN_REVOKED`, `VIEW_ONLY`) stay in the JSON `code` field; the `error`
  text is what people read.
- Permission denials name the ability, not the key: "You need the "Adjust
  inventory quantities" permission for this."
- Deploy-order messages ("needs migration 097 applied") are for the
  administrator; phrase them as "This feature is not available yet — the
  database update has not been applied." and keep the migration number in a
  `detail` field.

## 5. Where the vendor detail goes

When the vendor or system name carries information the reader needs (where a
label is printed, where an order came from), keep it out of the label and put
it in a tooltip (`title` attribute) or a hint line. The audit workbook's
**tooltip** column holds the proposed tooltip text for every string where a
vendor name was removed from the visible copy.

## 6. Audit summary (2026-09-06)

| Category | Count | What it means |
| --- | --- | --- |
| error-pattern | 190 | error text that does not follow §4 (mostly API `required` / `must be` messages with raw field names) |
| terminology | 176 | a synonym where the canonical term applies (SKU, PO, LP, product…) |
| developer-term | 136 | identifiers, codes or internals visible to people (`sku_code`, `payload`, migration numbers, uuid) |
| internal-name | 76 | Excalibur / ShipStation / EasyPost / TPFS in generic UI |
| capitalization | 71 | Title Case labels, lower-case sentence starts |
| terminology-review | 70 | customer / shipment / account / inbound — correct in some places, review the meaning |
| branding | 2 | hardcoded product name |
| tone | 2 | first-person copy |
| **Total flagged** | **723** | of 3,282 strings extracted |

The full list with file, location, current text, problem, proposed text and
tooltip is in `docs/COPY-AUDIT.xlsx` (sheets: Flagged, All strings,
Terminology census, Summary). The extractor that produced it is not part of the
repo; re-running the audit means re-running that script against the current
tree.
