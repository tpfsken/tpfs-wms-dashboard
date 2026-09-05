'use strict';
// =============================================================================
// PERMISSIONS (client side) — mirrors GET /auth/me.
// =============================================================================
// The API is the boundary (requirePermission on every ops route). This module
// only keeps users from clicking things that would 403:
//
//   can('inventory.adjust')        -> boolean
//   applyPermGates(root)           -> hides every [data-perm="key|key2"] element
//                                     the user lacks (any listed key passes)
//   loadMe()                       -> fetch /auth/me, set U.role, PERMS, body[data-role]
//   permDeniedToast(body)          -> friendly toast for a PERMISSION_DENIED 403
//
// Fail-open when /auth/me is unavailable (API not yet deployed): PERMS stays
// null and can() returns true for ops users, exactly today's behaviour — the
// API still enforces once it is live. Portal users always get false.

let PERMS = null;          // Set of keys, or null = unknown (fail-open for ops)
let ME = null;

function can(key){
  if(!U || U.userType === 'client') return false;
  if(PERMS === null) return true;
  return PERMS.has(key);
}

function applyPermGates(root){
  const scope = root || document;
  scope.querySelectorAll('[data-perm]').forEach(el => {
    const keys = String(el.dataset.perm || '').split(/[\s,|]+/).filter(Boolean);
    const ok = !keys.length || keys.some(can);
    el.classList.toggle('perm-denied', !ok);
  });
}

async function loadMe(){
  try {
    const r = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${T}` } });
    if(r.status === 401){ sessionStorage.clear(); location.reload(); return null; }
    if(!r.ok){ applyPermGates(document); return null; }       // old API: stay open
    ME = await r.json();
    PERMS = new Set(ME.permissions || []);
    if(U){
      U.role = ME.role;
      try { sessionStorage.setItem('tpfs_user', JSON.stringify(U)); } catch(_) {}
    }
    document.body.dataset.role = ME.role || '';
    applyPermGates(document);
    return ME;
  } catch(_) {
    applyPermGates(document);
    return null;
  }
}

const _permToastAt = {};
function permDeniedToast(body){
  const key = (body && body.permission) || '_';
  const now = Date.now();
  if(_permToastAt[key] && now - _permToastAt[key] < 8000) return;   // one toast per key per 8s
  _permToastAt[key] = now;
  const label = body && body.label ? body.label : 'that action';
  uiToast(`You don't have the "${label}" permission. Ask an admin to grant it under Settings → Roles & permissions.`, 'error', 6000);
}
