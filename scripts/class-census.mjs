// =============================================================================
// CLASS CENSUS — every CSS class referenced in js/*.js and index.html must be
// defined in app.css, or be on the allowlist below with a reason.
//
// Why this exists: FOUR shipped bugs of the same shape — .sev-chip, .btn-link,
// .ui-mono and .picker-ov-err — markup referencing a class nobody ever defined,
// silently unstyled in production (the hazmat severity badge was legible only
// because it carried an emoji). This check makes the fifth one impossible to
// ship quietly.
//
// Run: node scripts/class-census.mjs   (exit 1 on any unexplained miss)
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Referenced-but-undefined classes that are FINE, each with its reason.
// Adding to this list is a code-review decision, not a reflex.
const ALLOW = new Set([
  // printDocs.js opens a new window with its own embedded stylesheet
  // (<style>${DOC_CSS}</style>) — these are defined there, not in app.css.
  'center', 'doc-title', 'handling-note', 'hazmat-badge', 'hazmat-banner',
  'meta-block', 'meta-grid', 'mono', 'primary', 'row-meta', 'sig-line',
  'signature-row', 'small', 'toolbar',
  // billingEngine form-field hooks, read back via querySelector('.be-f-*');
  // visuals come from .ui-input on the same element.
  'be-f-aged', 'be-f-basis', 'be-f-cadence', 'be-f-code', 'be-f-free',
  'be-f-pro', 'be-f-rate', 'be-f-slot', 'be-f-tiers', 'be-f-unit',
  // Marker/hook classes whose styling is inline or on a parent:
  'cb-opt-custom',   // modifier on the styled .cb-opt ("+ Use ..." row)
  'cli-panel',       // client-detail tab pane; display toggled inline by JS
  'modal-overlay',   // legacy overlays; fully inline-styled
  'nav-badge',       // sidebar badge; fully inline-styled
  'ui-tile-value',   // structural wrapper; value styling is on the inner span
]);

const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
const defined = new Set([...css.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map(m => m[1]));

const used = new Map();
function add(cls, f) {
  cls = cls.trim();
  if (!cls || cls.includes('$') || cls.includes('{')) return;   // template fragment
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(cls)) return;
  if (cls.endsWith('-')) return;                                // dynamic prefix (e.g. cmp-band-)
  if (!used.has(cls)) used.set(cls, new Set());
  used.get(cls).add(f);
}
function scan(text, f) {
  for (const m of text.matchAll(/class=\\?"([^"\\]*)\\?"/g)) m[1].split(/\s+/).forEach(c => add(c, f));
  for (const m of text.matchAll(/class='([^']*)'/g)) m[1].split(/\s+/).forEach(c => add(c, f));
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) add(m[1], f);
  for (const m of text.matchAll(/className\s*=\s*'([^']*)'/g)) m[1].split(/\s+/).forEach(c => add(c, f));
}

for (const f of fs.readdirSync(path.join(root, 'js'))) {
  if (f.endsWith('.js')) scan(fs.readFileSync(path.join(root, 'js', f), 'utf8'), 'js/' + f);
}
scan(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), 'index.html');

const missing = [];
for (const [cls, files] of [...used.entries()].sort()) {
  if (defined.has(cls)) continue;
  if (cls.startsWith('js-')) continue;   // JS hooks by convention — no CSS intended
  if (ALLOW.has(cls)) continue;
  missing.push(cls.padEnd(30) + ' <- ' + [...files].join(', '));
}

// A stale allowlist is its own bug: an entry that became defined (or unused)
// means the list no longer describes reality.
const stale = [...ALLOW].filter(c => defined.has(c) || !used.has(c));

if (missing.length) {
  console.error('UNDEFINED CLASSES (markup references a class app.css never defines):');
  console.error(missing.join('\n'));
}
if (stale.length) console.error('STALE ALLOWLIST ENTRIES (now defined or no longer referenced): ' + stale.join(', '));
if (!missing.length && !stale.length) console.log(`CENSUS CLEAN — ${used.size} classes referenced, all accounted for.`);
process.exit(missing.length ? 1 : 0);
