// =============================================================================
// CLIENTS
// =============================================================================

let clientsCache = [];

async function loadCC(){
  if(clientsCache.length) return;
  const d = await apiGet('/clients');
  if(d) clientsCache = d;
}

async function loadClients(){
  const d = await apiGet('/clients');
  if(!d) return;
  document.getElementById('clientBody').innerHTML = d.length
    ? d.map(c => {
        const stChip = c.is_active ? 'chip-success' : 'chip-danger';
        return `
          <tr>
            <td style="font-weight:600;color:var(--blue);">${esc(c.code || '')}</td>
            <td style="font-weight:600;">${esc(c.name || '')}</td>
            <td style="color:var(--text2);">${esc(c.contact_email || '')}</td>
            <td><span class="chip chip-new">${esc(c.client_type || '')}</span></td>
            <td>${esc(c.onboarded_at ? new Date(c.onboarded_at).toLocaleDateString() : '—')}</td>
            <td><span class="chip ${stChip}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
          </tr>`;
      }).join('')
    : '<tr><td colspan="6" class="empty-state">No clients</td></tr>';
}
