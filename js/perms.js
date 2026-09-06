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
// null and can() returns true, exactly today's behaviour — the API still
// enforces once it is live.
//
// Portal users (Step B): /auth/me returns the portal.* keys they hold = their
// portal role AND what their company is entitled to (FEATURES). can() answers
// only portal.* keys for them — an ops key is always false, so nothing gated
// for ops ever shows in the portal.

let PERMS = null;          // Set of keys, or null = unknown (fail-open)
let FEATURES = null;       // portal: Set of entitled feature keys (null = unknown)
let ME = null;

function can(key){
  if(!U) return false;
  if(U.userType === 'client'){
    if(!String(key).startsWith('portal.')) return false;
    if(PERMS === null) return true;
    return PERMS.has(key);
  }
  if(String(key).startsWith('portal.')) return false;
  if(PERMS === null) return true;
  return PERMS.has(key);
}
/** Portal: is the feature switched on for this company (regardless of role)? */
function featureOn(key){
  if(!U || U.userType !== 'client') return false;
  if(FEATURES === null) return true;
  return FEATURES.has(key);
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
    FEATURES = ME.userType === 'client' ? new Set(ME.features || []) : null;
    if(U){
      U.role = ME.role;
      try { sessionStorage.setItem('tpfs_user', JSON.stringify(U)); } catch(_) {}
    }
    document.body.dataset.role = ME.role || '';
    if(typeof applyBrand === 'function') applyBrand(ME.tenantName);
    if(U) U.roleName = ME.roleName || ME.role;
    const line = document.getElementById('sideUserLine');
    if(line) line.textContent = `${U?.fullName || U?.email || ''} · ${ME.roleName || ME.role || ''}`;
    const roleEl = document.querySelector('.topbar-user-info .role');
    if(roleEl && ME.roleName){
      // Portal: keep the company name first, add the portal role after it.
      roleEl.textContent = (U && U.userType === 'client') ? `${U.clientName || U.clientCode || 'Customer'} · ${ME.roleName}` : ME.roleName;
    }
    applyPermGates(document);
    // Portal home cards are rendered before /auth/me answers — re-gate them.
    if(U && U.userType === 'client' && typeof loadPortalHome === 'function' && document.getElementById('page-portalHome')?.classList.contains('active')) loadPortalHome();
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
  if(body && body.reason === 'entitlement'){
    uiToast(`"${label}" isn't enabled for your company's portal. Ask your warehouse contact to switch it on.`, 'error', 6000);
  } else if(U && U.userType === 'client'){
    uiToast(`Your portal role doesn't include "${label}". A client admin at your company can change your role.`, 'error', 6000);
  } else {
    uiToast(`You don't have the "${label}" permission. Ask an admin to grant it under Settings → Roles & permissions.`, 'error', 6000);
  }
}
