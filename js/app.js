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
    boot();
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
};

// FIX: clients was missing from this map, so the Clients tab never auto-loaded.
const loaders = {
  dashboard: loadDashboard,
  inventory: loadInventory,
  orders:    loadOrders,
  inbound:   loadInbound,
  intake:    loadIntake,
  clients:   loadClients,
  billing:   loadBilling,
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
    boot();
  }
});
