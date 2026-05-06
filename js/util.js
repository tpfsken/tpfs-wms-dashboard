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

function fmtTimeShort(t){
  if(!t) return '—';
  const d = new Date(t);
  return d.toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
}

// ----- Status maps & workflow -----

const SM = {
  NEW:        {c:'chip-new',     l:'New'},
  ALLOCATED:  {c:'chip-active',  l:'Allocated'},
  PICKING:    {c:'chip-active',  l:'Picking'},
  PICKED:     {c:'chip-active',  l:'Picked'},
  PACKING:    {c:'chip-active',  l:'Packing'},
  PACKED:     {c:'chip-active',  l:'Packed'},
  SHIPPED:    {c:'chip-success', l:'Shipped'},
  CANCELLED:  {c:'chip-danger',  l:'Cancelled'},
  BACKORDERED:{c:'chip-warning', l:'Backordered'},
};

const WF = ['NEW','ALLOCATED','PICKING','PICKED','PACKING','PACKED','SHIPPED'];
