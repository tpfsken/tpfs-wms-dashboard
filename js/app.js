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
    // Phase 3: client portal users get the portal shell; ops/admin get the
    // full ops dashboard. Switch is purely on the JWT's userType claim.
    if(U && U.userType === 'client') bootPortal(); else boot();
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
  billing:'Billing', reports:'Reports',
  portalHome:'Customer Portal', portalNewOrder:'Place an Order', portalIntake:'Upload Documents',
};

// FIX: clients was missing from this map, so the Clients tab never auto-loaded.
const loaders = {
  dashboard:      loadDashboard,
  inventory:      loadInventory,
  orders:         loadOrders,
  inbound:        loadInbound,
  intake:         loadIntake,
  clients:        loadClients,
  billing:        loadBilling,
  reports:        loadReports,
  portalHome:     loadPortalHome,
  portalNewOrder: loadPortalNewOrder,
  portalIntake:   loadPortalIntake,
};

function navigateTo(p){
  document.querySelector(`.nav-item[data-page="${p}"]`)?.click();
}

function tick(){
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:true});
}

// ----- Boot -----

function boot(){
  if(U){
    document.getElementById('userAvatar').textContent =
      (U.fullName || U.email || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('userName').textContent = U.fullName || U.email;
  }
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

  // Intake upload + case-break LP search
  document.getElementById('intakeUploadInput')?.addEventListener('change', onIntakeFilesPicked);
  document.getElementById('cbLpSearch')?.addEventListener('input', searchCBLps);
  document.getElementById('cbQty')?.addEventListener('input', updateCBPreview);

  // SKU search inputs (new-order + new-PO)
  document.getElementById('noSkuSearch')?.addEventListener('input', searchOrderSkus);
  document.getElementById('noSkuSearch')?.addEventListener('focus', searchOrderSkus);
  document.getElementById('npSkuSearch')?.addEventListener('input', searchPoSkus);
  document.getElementById('npSkuSearch')?.addEventListener('focus', searchPoSkus);

  // Clock
  tick();
  setInterval(tick, 1000);

  // If we already have a token, skip login overlay and boot.
  if(T && U){
    document.getElementById('loginOverlay').style.display = 'none';
    // Phase 3: dispatch on JWT userType — clients land in the portal shell,
    // ops/admin keep the existing dashboard boot.
    if(U.userType === 'client') bootPortal(); else boot();
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
// PWA INSTALL — explicit "📱 Install App" button in the topbar that fires
// the deferred beforeinstallprompt event. iOS Safari doesn't fire this
// event so we show a helper banner instead with the Add-to-Home-Screen
// instructions.
// =============================================================================

let _pwaInstallEvent = null;

function setupPwaInstall(){
  // Already installed? hide everything.
  const standalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;
  if(standalone) return;

  // Chromium fires this when PWA criteria are met. We stash the event
  // and show our install button.
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _pwaInstallEvent = e;
    const btn = document.getElementById('installAppBtn');
    if(btn) btn.style.display = '';
  });

  // Hide once installed
  window.addEventListener('appinstalled', () => {
    const btn = document.getElementById('installAppBtn');
    if(btn) btn.style.display = 'none';
    _pwaInstallEvent = null;
  });

  // iOS Safari doesn't fire beforeinstallprompt — show the banner with
  // visual instructions instead. Detection: iOS user agent + Safari
  // (not Chrome/Firefox on iOS, those use the same WebKit but can't
  // install PWAs).
  const ua = navigator.userAgent;
  const isIos    = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = isIos && !/CriOS|FxiOS|OPiOS|EdgiOS/i.test(ua);
  if(isIos && isSafari && !sessionStorage.getItem('iosInstallHintDismissed')){
    setTimeout(() => {
      const hint = document.getElementById('iosInstallHint');
      if(hint) hint.style.display = '';
    }, 2000);
  }
}

async function installPwaApp(){
  if(!_pwaInstallEvent){
    alert('Install option not available yet — try a hard refresh (pull down on the page) and tap this button again. On iOS, use Safari\'s Share button → Add to Home Screen.');
    return;
  }
  _pwaInstallEvent.prompt();
  const choice = await _pwaInstallEvent.userChoice;
  if(choice && choice.outcome === 'accepted'){
    document.getElementById('installAppBtn').style.display = 'none';
  }
  _pwaInstallEvent = null;
}

function dismissIosHint(){
  const hint = document.getElementById('iosInstallHint');
  if(hint) hint.style.display = 'none';
  sessionStorage.setItem('iosInstallHintDismissed', '1');
}
