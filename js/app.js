// =============================================================================
// APP — API base, auth, navigation, modals, boot
// =============================================================================

const API = 'https://tpfs-wms-api-production.up.railway.app/api';

// Session state — populated by login or restored from sessionStorage.
let T = sessionStorage.getItem('tpfs_token');
let U = JSON.parse(sessionStorage.getItem('tpfs_user') || 'null');

async function apiGet(p){
  try {
    const r = await fetch(`${API}${p}`, {headers:{'Authorization':`Bearer ${T}`}});
    if(r.status === 401){ sessionStorage.clear(); location.reload(); return null; }
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
  dashboard:'Dashboard', inventory:'Inventory', orders:'Orders',
  inbound:'Receiving', intake:'Intake', clients:'Clients',
  billing:'Billing', invoices:'Invoices', settings:'Settings', reports:'Reports', compliance:'Compliance', users:'Users & Certs',
  portalHome:'Customer Portal', portalNewOrder:'Place an Order', portalIntake:'Upload Documents',
  // Floor mode (phone-first ops shell)
  floorHome:'Warehouse Floor', floorPickList:'Orders to Pick',
  floorInbound:'Receive Inbound', floorMove:'Move Inventory', floorScanTest:'Scan test', floorPick:'Pick',
};

// FIX: clients was missing from this map, so the Clients tab never auto-loaded.
const loaders = {
  dashboard:      loadDashboard,
  inventory:      loadInventory,
  orders:         loadOrders,
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
      if(U?.userType === 'admin' || U?.isSupervisor){
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

  // Reveal admin/supervisor-only nav items
  const isAdmin = U?.userType === 'admin';
  const isSup   = !!U?.isSupervisor;
  if(isAdmin || isSup){
    const usersNav = document.getElementById('navUsersItem');
    if(usersNav) usersNav.style.display = '';
  }

  // Topbar 90-day cert expiry ribbon — fires once on boot, links to Users
  // page (admin/supervisor) or just informs the user otherwise.
  refreshCertExpiryRibbon();
  // Init page-level filter combos on boot so they exist when pages load
  initCombo('invStatusFilterWrap', [
    {value:'',label:'All statuses'},
    {value:'available',label:'Available'},
    {value:'allocated',label:'Allocated'},
    {value:'damaged',label:'Damaged'},
  ], {placeholder:'All statuses', onChange:() => loadInventory()});

  // Inventory Client filter — populates after clientsCache loads on first
  // visit to a client-aware page; load it now so the combo is ready.
  loadCC().then(() => {
    initCombo('invClientFilterWrap',
      [{value:'', label:'All clients'}].concat(
        clientsCache.map(c => ({value:String(c.id), label:`${c.code} — ${c.name}`}))
      ),
      {placeholder:'All clients', onChange:() => loadInventory()}
    );
  });

  initCombo('ordStatusFilterWrap', [
    {value:'',label:'All statuses'},
    {value:'NEW',label:'New'},{value:'ALLOCATED',label:'Allocated'},
    {value:'PICKING',label:'Picking'},{value:'PICKED',label:'Picked'},
    {value:'PACKING',label:'Packing'},{value:'PACKED',label:'Packed'},
    {value:'SHIPPED',label:'Shipped'},{value:'CANCELLED',label:'Cancelled'},
  ], {placeholder:'All statuses', onChange:() => loadOrders()});

  initCombo('intakeStatusFilterWrap', INTAKE_STATUSES,
    {placeholder:'All statuses', onChange:() => loadIntake()});

  setupIntakeDropzone();
  loadDashboard();
  setInterval(loadDashboard, 30000);
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

  // Login
  document.getElementById('loginBtn').addEventListener('click', doLogin);
  ['loginPassword','loginEmail'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if(e.key === 'Enter') doLogin();
    });
  });
  document.getElementById('loginForgotBtn')?.addEventListener('click', pwOpenForgot);

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

  // Search debounces
  document.getElementById('invSearch')?.addEventListener('input', debounce(loadInventory, 400));
  document.getElementById('ordSearch')?.addEventListener('input', debounce(loadOrders, 400));

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
  }

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
