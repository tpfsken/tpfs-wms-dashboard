// =============================================================================
// APP — API base, auth, navigation, modals, boot
// =============================================================================

const API = 'https://tpfs-wms-api-production.up.railway.app/api';

// "View portal as client" (js/portalAccess.js) opens this page in a new tab
// with ?portalPreview=1 and leaves the preview token in a one-shot
// localStorage handoff. Install it as THIS tab's session before the restore
// below; the opener's ops session (copied by the browser into a
// script-opened tab) is dropped so the tab is the client's portal only.
(function installPortalPreview(){
  try {
    if(new URLSearchParams(location.search).get('portalPreview') !== '1') return;
    const raw = localStorage.getItem('tpfs_preview_handoff');
    localStorage.removeItem('tpfs_preview_handoff');
    sessionStorage.clear();
    if(raw){
      const h = JSON.parse(raw);
      if(h && h.token && h.user){ sessionStorage.setItem('tpfs_token', h.token); sessionStorage.setItem('tpfs_user', JSON.stringify(h.user)); }
    }
    history.replaceState(null, '', location.pathname);
  } catch(_) {}
})();

// Session state — populated by login or restored from sessionStorage.
let T = sessionStorage.getItem('tpfs_token');
let U = JSON.parse(sessionStorage.getItem('tpfs_user') || 'null');

async function apiGet(p){
  try {
    const r = await fetch(`${API}${p}`, {headers:{'Authorization':`Bearer ${T}`}});
    if(r.status === 401){
      // A revoked / expired portal preview says so on the login screen.
      const body = await r.json().catch(() => null);
      sessionStorage.clear();
      if(body && body.code === 'PREVIEW_ENDED'){ try { sessionStorage.setItem('tpfs_login_notice', 'This portal preview has ended — you can close this tab.'); } catch(_) {} }
      location.reload(); return null;
    }
    if(r.status === 403){
      // A permission denial names the missing ability — say so instead of a
      // generic "could not load" (js/perms.js). Other 403s stay silent.
      const body = await r.json().catch(() => null);
      if(body && body.code === 'PERMISSION_DENIED' && typeof permDeniedToast === 'function') permDeniedToast(body);
      // The company's portal access was switched off under a live session:
      // back to the login screen, which shows why (audit H-3).
      if(body && body.code === 'CLIENT_INACTIVE'){
        try { sessionStorage.clear(); sessionStorage.setItem('tpfs_login_notice', body.error || 'Portal access is inactive'); } catch(_) {}
        location.reload();
      }
      return null;
    }
    if(!r.ok) return null;
    return r.json();
  } catch(e){
    return null;
  }
}

async function doLogin(){
  const e = document.getElementById('loginEmail').value.trim();
  const p = document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError');
  err.textContent = '';
  if(!e || !p){ err.textContent = 'Email and password required'; return; }
  try {
    const r = await fetch(`${API}/auth/login`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({email: e, password: p}),
    });
    const d = await r.json();
    if(!r.ok){ err.textContent = d.error || 'Login failed'; return; }
    T = d.token; U = d.user;
    sessionStorage.setItem('tpfs_token', T);
    sessionStorage.setItem('tpfs_user', JSON.stringify(U));
    document.getElementById('loginOverlay').style.display = 'none';

    // Temp password (admin reset, or a new account). The API 403s every other
    // route until this is cleared, so booting the app first would just render a
    // dashboard where nothing loads and nothing explains why.
    if(d.mustChangePassword){ pwForcedChange(); return; }

    // Phase 3: client portal users get the portal shell; ops/admin get the
    // full ops dashboard. Switch is purely on the JWT's userType claim.
    if(U && U.userType === 'client') bootPortal();
    else if(typeof shouldUseFloorMode === 'function' && shouldUseFloorMode()) bootFloor();
    else boot();
    // Role + effective permissions (js/perms.js): hides what this user may not do.
    if(typeof loadMe === 'function') loadMe();
  } catch(x){
    err.textContent = 'Network error';
  }
}

// ----- Modals -----

function closeModal(id){
  document.getElementById(id).style.display = 'none';
}

// ----- Navigation -----

const titles = {
  dashboard:'Dashboard', inventory:'Inventory', orders:'Orders', waves:'Waves',
  inbound:'Receiving', intake:'Intake', clients:'Clients',
  billing:'Billing', invoices:'Invoices', settings:'Settings', reports:'Reports', compliance:'Compliance', users:'Users', portalUsers:'Users',
  portalHome:'Customer Portal', portalNewOrder:'Place an Order', portalIntake:'Upload Documents',
  // Floor mode (phone-first ops shell)
  floorHome:'Warehouse Floor', floorPickList:'Orders to Pick',
  floorInbound:'Receive Inbound', floorMove:'Move Inventory', floorScanTest:'Scan test', floorPick:'Pick', floorShip:'Pack & Ship',
};

// FIX: clients was missing from this map, so the Clients tab never auto-loaded.
const loaders = {
  dashboard:      loadDashboard,
  inventory:      loadInventory,
  orders:         loadOrders,
  waves:          loadWaves,
  quotes:         loadQuotes,
  inbound:        loadInbound,
  intake:         loadIntake,
  clients:        loadClients,
  billing:        loadBillingSection,
  settings:       loadSettingsPage,
  invoices:       loadInvoices,
  reports:        loadReports,
  compliance:     loadCompliance,
  users:          loadUsers,
  portalUsers:    loadPortalUsers,
  portalHome:     loadPortalHome,
  portalNewOrder: loadPortalNewOrder,
  portalIntake:   loadPortalIntake,
  // Floor mode
  floorHome:      loadFloorHomeCounts,
  floorPickList:  loadFloorPickList,
  floorInbound:   loadFloorInbound,
  floorMove:      loadFloorMove,
  floorScanTest:  loadFloorScanTest,
  floorPick:      loadFloorPick,
  floorShip:      loadFloorShip,
};

function navigateTo(p){
  // Pages with a sidebar nav-item: simulate the click so the active
  // highlight + page swap + loader call all fire through that handler.
  const navItem = document.querySelector(`.nav-item[data-page="${p}"]`);
  if(navItem){ navItem.click(); return; }
  // Pages without a sidebar entry (floor mode, etc.): swap the .active
  // page directly and call the loader if there is one.
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.getElementById('page-' + p)?.classList.add('active');
  const titleEl = document.getElementById('pageTitle');
  if(titleEl) titleEl.textContent = titles[p] || p;
  if(loaders[p]) loaders[p]();
}

function tick(){
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:true});
}

// =============================================================================
// CERT EXPIRY RIBBON — auto-fires on boot if any of the user's hazmat
// certs expire in the next 90 days. Click → /me/certs (or Users page if
// they're admin/supervisor). Hidden if no certs are within the window.
// =============================================================================
async function refreshCertExpiryRibbon(){
  const ribbon = document.getElementById('certExpiryRibbon');
  if(!ribbon) return;
  try {
    const r = await apiGet('/me/certs');
    const expiring = r?.expiring || [];
    if(!expiring.length){
      ribbon.style.display = 'none';
      return;
    }
    // Show the soonest-expiring cert + a count if multiple
    const soonest = expiring[0];
    const days = Number(soonest.days_until_expiry);
    const label = expiring.length === 1
      ? `⏰ ${soonest.cert_type_display} expires in ${days} day${days === 1 ? '' : 's'}`
      : `⏰ ${expiring.length} certs expiring soon (next: ${soonest.cert_type_display}, ${days}d)`;
    ribbon.textContent = label;
    ribbon.style.display = '';
    ribbon.onclick = () => {
      // Admin/supervisor can act on it — take them to the page where they can.
      if(can('users.manage') || can('users.onboard')){
        navigateTo('users');
        return;
      }
      // Everyone else can only be told. Say what's expiring and when, and who
      // to go to — an alert() listing certs told them nothing actionable.
      uiAlert({
        title: 'Your certifications are expiring',
        body: expiring.map(c => `
          <div style="margin-bottom:8px;">
            <strong>${esc(c.cert_type_display)}</strong>
            ${c.cert_number ? `<span class="ui-muted"> · ${esc(c.cert_number)}</span>` : ''}
            <div class="ui-hint">Expires ${esc(new Date(c.expires_at).toLocaleDateString())} — in ${esc(c.days_until_expiry)} day(s)</div>
          </div>`).join('') +
          '<div class="ui-hint">Ask a supervisor to record the renewal once you have it. Work needing this certification stops when it lapses.</div>',
      });
    };
  } catch(_) {
    ribbon.style.display = 'none';
  }
}

// ----- Boot -----

function boot(){
  if(U){
    document.getElementById('userAvatar').textContent =
      (U.fullName || U.email || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('userName').textContent = U.fullName || U.email;
  }

  // Users nav is [data-perm="users.manage|users.onboard"] — gated by loadMe().

  // Topbar 90-day cert expiry ribbon — fires once on boot, links to Users
  // page (admin/supervisor) or just informs the user otherwise.
  refreshCertExpiryRibbon();

  // Client options for the shared filter bars (Inventory / Orders / Receiving).
  // The bars themselves are built at DOM-ready; only ops may call /clients.
  loadCC().then(() => uiFilterBarClientOptions(null, clientsCache));

  initCombo('intakeStatusFilterWrap', INTAKE_STATUSES,
    {placeholder:'All statuses', onChange:() => loadIntake()});

  setupIntakeDropzone();
  loadDashboard();
  // Seamless 30s refresh (js/dashboard.js): skips hidden tabs and other pages,
  // catches up once when the tab is visible again.
  setInterval(dashTick, 30000);
  document.addEventListener('visibilitychange', dashOnVisibility);
}

// ----- DOM-ready wiring -----

document.addEventListener('DOMContentLoaded', () => {
  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(n => {
    n.addEventListener('click', () => {
      const p = n.dataset.page;
      document.querySelectorAll('.nav-item[data-page]').forEach(x => x.classList.remove('active'));
      n.classList.add('active');
      document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
      document.getElementById('page-' + p)?.classList.add('active');
      document.getElementById('pageTitle').textContent = titles[p] || p;
      if(loaders[p]) loaders[p]();
    });
  });

  // List-page headers — one shared filter bar (js/ui.js uiFilterBar). Built
  // before either boot path so portal users get them too; the Client combo is
  // ops-only and gets its options in boot().
  initInventoryFilterBar();
  initOrdersFilterBar();
  initInboundFilterBar();

  // Login
  document.getElementById('loginBtn').addEventListener('click', uiBusyHandler(doLogin));
  ['loginPassword','loginEmail'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if(e.key === 'Enter') doLogin();
    });
  });
  document.getElementById('loginForgotBtn')?.addEventListener('click', pwOpenForgot);
  // Left over by apiGet when the API refused a live session (client inactive / offboarded).
  try {
    const _notice = sessionStorage.getItem('tpfs_login_notice');
    if(_notice){ document.getElementById('loginError').textContent = _notice; sessionStorage.removeItem('tpfs_login_notice'); }
  } catch(_) {}

  // A reset link from the email lands here as /?reset=<token>. Handle it BEFORE
  // any session restore — someone resetting their password may well already have
  // a stale session in this tab, and the reset must still work.
  const _resetTok = new URLSearchParams(location.search).get('reset');
  if(_resetTok) pwOpenResetFromUrl(_resetTok);

  // Sign out (sidebar + topbar)
  document.querySelectorAll('.js-signout').forEach(el => {
    el.addEventListener('click', () => { sessionStorage.clear(); location.reload(); });
  });

  // Sidebar collapse
  document.querySelector('.collapse-btn')?.addEventListener('click', () =>
    document.getElementById('shell').classList.toggle('collapsed'));

  // (Inventory / Orders / Receiving search debounces are wired by uiFilterBar.)

  // Topbar global search was removed — each page has its own scoped search
  // (Inventory: SKU/lot, Orders: order #, Reports: SKU/lot/LP).

  // Intake upload. (Case-break's LP search + qty inputs are wired inside its
  // uiModal — D4b — so they don't exist at DOM-ready.)
  document.getElementById('intakeUploadInput')?.addEventListener('change', onIntakeFilesPicked);

  // SKU search input (new-PO). The new-order one is wired inside its uiModal
  // (D3e) — that input no longer exists at DOM-ready.
  document.getElementById('npSkuSearch')?.addEventListener('input', searchPoSkus);
  document.getElementById('npSkuSearch')?.addEventListener('focus', searchPoSkus);

  // Clock
  tick();
  setInterval(tick, 1000);

  // If we already have a token, skip login overlay and boot.
  if(T && U){
    document.getElementById('loginOverlay').style.display = 'none';
    // Boot dispatch:
    //   - client users → always portal mode
    //   - ops users on phones → floor mode (stripped 3-card shell)
    //   - ops users elsewhere → full desktop dashboard
    if(U.userType === 'client') bootPortal();
    else if(typeof shouldUseFloorMode === 'function' && shouldUseFloorMode()) bootFloor();
    else boot();
    if(typeof loadMe === 'function') loadMe();
  }

  // Own-password change lives in the sidebar footer so floor users, who do
  // not see Settings, still have it.
  document.querySelectorAll('.js-change-pw').forEach(el =>
    el.addEventListener('click', uiBusyHandler(() => pwOpenChange())));

  // PWA: register the service worker so the app is installable to the
  // tablet's home screen and the static shell loads instantly even on
  // flaky warehouse WiFi. The browser only allows SW registration over
  // https or localhost — Netlify is https so this just works.
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }
  setupPwaInstall();
});

// =============================================================================
// PWA INSTALL — was an "Install App" button in the topbar; removed for
// less clutter. Browsers expose their own install UX (Chrome/Edge address-
// bar icon, Safari Share menu → Add to Home Screen). manifest.json + service
// worker stay registered so install still works via those native controls.
// =============================================================================

function setupPwaInstall(){
  // No-op — install handled by native browser UX. Kept as a stub so the
  // call site in boot() doesn't have to be edited.
}
