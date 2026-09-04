// =============================================================================
// UTIL — escape, format helpers, common state
// =============================================================================

// Escape ANY value before injecting into innerHTML. Always call this on
// untrusted/API data. For attribute values, this also handles ' and ".
function esc(s){
  return String(s??'').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Encode a value for embedding inside an HTML attribute value (defense-in-depth
// when building onclick="..." with JSON.stringify; prefer addEventListener).
function attrEsc(s){ return esc(s); }

function debounce(fn, ms){
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fmtBytes(b){
  if(!b) return '—';
  const u = ['B','KB','MB','GB'];
  let i = 0, v = b;
  while(v >= 1024 && i < u.length - 1){ v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
}

function fmtCost(c){
  if(c == null) return '—';
  return '$' + Number(c).toFixed(4);
}

// Integer cents → '$X.XX'. (legacy helper, kept for back-compat)
function fmtCents(cents){
  if(cents == null) return '—';
  const n = Number(cents);
  if(!Number.isFinite(n)) return '—';
  return '$' + (n / 100).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}

// Numeric dollars (e.g. 12.5) → '$12.50'. For billing display.
function fmtDollars(amount){
  if(amount == null) return '—';
  const n = Number(amount);
  if(!Number.isFinite(n)) return '—';
  return '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function fmtTimeShort(t){
  if(!t) return '—';
  const d = new Date(t);
  return d.toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
}

// ----- Status maps & workflow -----

// Status meta. Workflow rename (migration 020): PICKED collapsed into
// PACKING, PACKED renamed STAGED. PICKED + PACKED kept here as fallback
// labels in case any old data still surfaces — they shouldn't, but the
// chip won't crash if they do.
const SM = {
  NEW:        {c:'chip-new',     l:'New'},
  ALLOCATED:  {c:'chip-active',  l:'Allocated'},
  PICKING:    {c:'chip-active',  l:'Picking'},
  PACKING:    {c:'chip-active',  l:'Packing'},
  STAGED:     {c:'chip-warning', l:'Staged'},
  SHIPPED:    {c:'chip-success', l:'Shipped'},
  SHIPPED_EXTERNALLY: {c:'chip-success', l:'Shipped externally'},
  CANCELLED:  {c:'chip-danger',  l:'Cancelled'},
  BACKORDERED:{c:'chip-warning', l:'Backordered'},
  // Legacy fallbacks
  PICKED:     {c:'chip-active',  l:'Picked'},
  PACKED:     {c:'chip-warning', l:'Packed'},
};

const WF = ['NEW','ALLOCATED','PICKING','PACKING','STAGED','SHIPPED'];

// =============================================================================
// SEVERITY — at-a-glance product-handling tier. 4 levels:
//   critical  — high-stakes hazmat (PG I, explosives, toxic gas, radioactive,
//               toxic-by-inhalation, organic peroxide). Mandatory PPE,
//               cert-required, special procedure.
//   high      — any other hazmat (PG II/III, classes 2.1/2.2/3/4.x/5.1/8/9),
//               marine pollutants. Standard hazmat handling.
//   moderate  — non-hazmat with care: special handling text on file,
//               ground-only, temperature-sensitive.
//   standard  — normal product. No chip rendered by default unless
//               showStandard=true is passed to severityChip().
//
// The chips carry COLOUR AND A WORD, never an emoji — these are read on a
// warehouse tablet and printed onto BOLs, where colour emoji don't render and
// a hazard class is not a decoration.
//
// Computed on read from existing SKU attributes — no migration. If we
// ever need to filter by tier server-side ("all CRITICAL items"), we
// can add a denormalized severity_tier column later as a cache.
// =============================================================================

// NOTE: the tier emoji were removed — severity now reads as a coloured chip
// (see .sev-chip in app.css), which is legible on a warehouse tablet in a way a
// coloured circle glyph is not (it renders differently on every device, and at
// a glance orange and red dots are hard to tell apart). The TIER is what the
// picker acts on, so the tier is what the chip says.
function severityFor(sku){
  if(!sku) return { tier:'standard', label:'STANDARD', color:'#3a8a3a', reason:'' };

  const isHaz = !!(sku.is_hazmat ?? sku.is_hazardous);
  const cls   = String(sku.hazard_class || sku.transport_hazard_class || '').trim();
  const pg    = String(sku.packing_group || '').trim().toUpperCase();
  const sh    = String(sku.special_handling || sku.special_handling_instructions || '').trim();
  const grnd  = !!(sku.is_ground_only);
  const marin = !!(sku.marine_pollutant);

  // CRITICAL: explosives, toxic gas, toxic, radioactive, organic peroxide,
  // packing group I (most dangerous regardless of class)
  const criticalClasses = new Set(['1','1.1','1.2','1.3','1.4','1.5','1.6','2.3','5.2','6.1','7']);
  if(isHaz && (criticalClasses.has(cls) || pg === 'I')){
    const why = pg === 'I'
      ? `Packing Group I${cls ? ' (Class ' + cls + ')' : ''} — highest danger`
      : `Class ${cls} — high-stakes hazmat`;
    return { tier:'critical', label:'CRITICAL', color:'#cc1f1f', reason: why };
  }

  // HIGH: any other hazmat. Marine pollutants also high even if not
  // otherwise classified.
  if(isHaz){
    return {
      tier:'high', label:'HIGH', color:'#cc6600',
      reason: `Class ${cls || '—'}${pg ? ' PG ' + pg : ''}`,
    };
  }
  if(marin){
    return { tier:'high', label:'HIGH', color:'#cc6600', reason:'Marine pollutant' };
  }

  // MODERATE: non-hazmat that still needs care
  if(sh){
    return { tier:'moderate', label:'MODERATE', color:'#d6a700',
             reason:'Special handling required' };
  }
  if(grnd){
    return { tier:'moderate', label:'MODERATE', color:'#d6a700',
             reason:'Ground transport only' };
  }

  return { tier:'standard', label:'STANDARD', color:'#3a8a3a', reason:'' };
}

// Render a severity chip for a SKU. The colour carries the tier; the WORD
// carries it too, because colour alone fails for a colour-blind picker and in
// a black-and-white print.
//   size:         'sm' (default) | 'lg' (picker, prominent)
//   showStandard: default false — a normal item gets no chip, only exceptions
function severityChip(sku, opts){
  const o = opts || {};
  const s = severityFor(sku);
  if(s.tier === 'standard' && !o.showStandard) return '';
  const cls = `sev-chip sev-chip-${s.tier} sev-chip-${o.size || 'sm'}`;
  const title = `Severity: ${s.label}${s.reason ? ' — ' + s.reason : ''}`;
  return `<span class="${cls}" title="${esc(title)}">${esc(s.label)}</span>`;
}
