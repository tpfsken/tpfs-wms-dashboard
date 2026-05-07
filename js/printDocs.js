// =============================================================================
// PRINT DOCS — pick slip, packing slip, bill of lading
// =============================================================================
// Each function takes an order object (the shape returned by GET
// /orders/:id, including .lines, .allocations, .shipments, .client_full,
// .warehouse_full) and opens a printable HTML window. The browser's
// Print dialog handles PDF export — no server-side PDF generator
// required.
//
// All three docs share a small CSS stylesheet (DOC_CSS) tuned for
// 8.5×11 letter paper at 0.5" margins. The "@media print" rules hide
// the toolbar and force black-on-white for ink savings.
// =============================================================================

const DOC_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 32px 40px 32px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: #111;
    background: #fff;
    font-size: 12px;
    line-height: 1.4;
  }
  h1 { font-size: 20px; margin: 0 0 6px 0; letter-spacing: -0.01em; }
  h2 { font-size: 14px; margin: 0 0 4px 0; text-transform: uppercase; letter-spacing: 0.04em; color: #444; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
  th, td { border: 1px solid #555; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #eee; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
  .right { text-align: right; }
  .center { text-align: center; }
  .mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  .small { font-size: 10px; color: #555; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 12px 0; }
  .meta-block { border: 1px solid #555; padding: 10px 12px; }
  .meta-block h2 { margin-bottom: 6px; }
  .row-meta { display: flex; gap: 18px; flex-wrap: wrap; margin: 8px 0 14px 0; }
  .row-meta > div { font-size: 11px; }
  .row-meta strong { display: block; font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
  .hazmat-badge { display: inline-block; padding: 1px 6px; border: 1.5px solid #d22; color: #d22; font-weight: 700; font-size: 10px; border-radius: 3px; margin-right: 4px; }
  .hazmat-banner {
    background: #fff3cd; border-left: 4px solid #d22; padding: 8px 12px;
    margin: 8px 0; font-size: 11px; color: #6b3a05; font-weight: 600;
  }
  .handling-note {
    background: #fff3cd; padding: 4px 8px; font-size: 10px;
    color: #6b3a05; font-weight: 600; border-left: 3px solid #ec5; margin-top: 4px;
  }
  .signature-row {
    margin-top: 28px;
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 24px;
  }
  .sig-line {
    border-bottom: 1px solid #111;
    height: 28px;
    margin-bottom: 4px;
  }
  .toolbar {
    background: #222; color: #fff;
    padding: 10px 16px; display: flex; gap: 10px; align-items: center;
    margin: -24px -32px 24px -32px;
  }
  .toolbar button {
    background: #fff; color: #111; border: none; padding: 6px 14px;
    cursor: pointer; font-size: 13px; border-radius: 4px;
  }
  .toolbar button.primary { background: #2c7be5; color: #fff; }
  .doc-title { font-size: 22px; font-weight: 700; }
  @media print {
    .toolbar { display: none; }
    body { padding: 0.4in 0.4in 0.5in 0.4in; }
    @page { size: letter; margin: 0; }
    .hazmat-banner, .handling-note { background: #fff !important; }
  }
`;

function _printShell(title, bodyHtml) {
  // The "Print" button in the toolbar fires window.print(); the toolbar
  // itself is hidden in the print stylesheet so it never lands on paper.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${_esc(title)}</title>
  <style>${DOC_CSS}</style>
</head>
<body>
  <div class="toolbar">
    <span class="doc-title">${_esc(title)}</span>
    <div style="flex:1"></div>
    <button class="primary" onclick="window.print()">🖨️ Print</button>
    <button onclick="window.close()">Close</button>
  </div>
  ${bodyHtml}
</body>
</html>`;
}

// Local esc — printDocs runs inside a separate window so we can't rely
// on the main window's esc(). Mirrors the same minimal HTML escaping.
function _esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _fmtAddr(a) {
  // Accepts a flat object with line1/line2/city/state/postal/country or
  // ship-prefixed flavors. Returns multi-line HTML.
  const line1 = a.address_line1 || a.line1 || a.ship_to_line1 || '';
  const line2 = a.address_line2 || a.line2 || a.ship_to_line2 || '';
  const city  = a.city          || a.ship_to_city          || '';
  const state = a.state         || a.ship_to_state         || '';
  const zip   = a.postal        || a.postal_code           || a.ship_to_postal || '';
  const ctry  = a.country       || a.ship_to_country       || '';
  const csz = [city, state].filter(Boolean).join(', ') + (zip ? ' ' + zip : '');
  return [_esc(line1), line2 ? _esc(line2) : '', _esc(csz), _esc(ctry)]
    .filter(Boolean).join('<br>');
}

function _openDocWindow(html) {
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) {
    alert('Pop-up blocked. Allow pop-ups for this site to print docs.');
    return;
  }
  w.document.write(html);
  w.document.close();
}

// =============================================================================
// PICK SLIP — warehouse-facing. Per allocation: location, LP, lot, qty,
// hazmat chip, special handling banner. Picker sign-off at bottom.
// =============================================================================

function renderPickSlip(order) {
  const allocs = (order.allocations || []).filter(a => a.status !== 'CANCELLED');
  const totalUnits = allocs.reduce((s, a) => s + (Number(a.quantity) || 0), 0);

  const linesHtml = allocs.length
    ? `<table>
        <thead>
          <tr>
            <th style="width:30px;">✓</th>
            <th style="width:36px;">#</th>
            <th>Location</th>
            <th>License Plate</th>
            <th>SKU</th>
            <th>Description</th>
            <th>Lot</th>
            <th>Expiry</th>
            <th class="right">Qty</th>
            <th>UOM</th>
          </tr>
        </thead>
        <tbody>
          ${allocs.map((a, i) => {
            const hazBadge = a.is_hazmat
              ? `<span class="hazmat-badge">⚠ HAZMAT${a.un_number ? ' ' + _esc(a.un_number) : ''}</span> `
              : '';
            const handling = a.special_handling_instructions
              ? `<div class="handling-note">📋 ${_esc(a.special_handling_instructions)}</div>`
              : '';
            const exp = a.expiry_date
              ? new Date(a.expiry_date).toLocaleDateString()
              : '—';
            return `
              <tr>
                <td class="center">☐</td>
                <td class="center mono">${i + 1}</td>
                <td class="mono"><strong>${_esc(a.location_code || '—')}</strong></td>
                <td class="mono">${_esc(a.lp_number || '—')}</td>
                <td class="mono">${_esc(a.sku_code || '')}</td>
                <td>${hazBadge}${_esc(a.sku_name || '')}${handling}</td>
                <td class="mono">${_esc(a.lot_number || '—')}</td>
                <td>${_esc(exp)}</td>
                <td class="right mono"><strong>${_esc(a.quantity || 0)}</strong></td>
                <td>${_esc(a.uom || 'EA')}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`
    : '<p><em>No allocations on this order yet.</em></p>';

  const hazAny = allocs.some(a => a.is_hazmat);
  const hazBanner = hazAny
    ? `<div class="hazmat-banner">⚠ This order contains HAZARDOUS MATERIALS. Follow all special handling instructions below. Verify outer packaging meets DOT requirements before staging.</div>`
    : '';

  const body = `
    <h1>Pick Slip — ${_esc(order.order_number || '')}</h1>
    <div class="small">
      ${_esc(order.client_name || '')} ·
      Created ${_esc(new Date(order.created_at).toLocaleString())} ·
      Status <strong>${_esc(order.status || '')}</strong>
    </div>
    ${hazBanner}
    <div class="meta-grid">
      <div class="meta-block">
        <h2>Ship To</h2>
        <strong>${_esc(order.ship_to_name || order.customer_name || '—')}</strong><br>
        ${_fmtAddr(order)}
      </div>
      <div class="meta-block">
        <h2>Order Info</h2>
        <div><strong>Customer:</strong> ${_esc(order.customer_name || '—')}</div>
        <div><strong>Channel:</strong> ${_esc(order.channel || '—')}</div>
        <div><strong>Carrier:</strong> ${_esc(order.carrier_code || '—')} / ${_esc(order.ship_method || '—')}</div>
        <div><strong>Required Ship Date:</strong> ${order.required_ship_date ? _esc(new Date(order.required_ship_date).toLocaleDateString()) : '—'}</div>
        <div><strong>Total Units:</strong> ${_esc(totalUnits.toLocaleString())} across ${_esc(allocs.length)} pick${allocs.length === 1 ? '' : 's'}</div>
      </div>
    </div>
    ${linesHtml}
    <div class="signature-row">
      <div>
        <div class="sig-line"></div>
        <div class="small">Picker Signature / Date</div>
      </div>
      <div>
        <div class="sig-line"></div>
        <div class="small">Time Completed</div>
      </div>
    </div>
  `;

  _openDocWindow(_printShell(`Pick Slip ${order.order_number || ''}`, body));
}

// =============================================================================
// PACKING SLIP — customer-facing, goes IN the box. Order info, ship-to,
// items (no $$, no internal codes), notes.
// =============================================================================

function renderPackingSlip(order) {
  const lines = order.lines || [];
  const totalUnits = lines.reduce((s, l) => s + (Number(l.shipped_qty || l.allocated_qty || l.ordered_qty) || 0), 0);

  const linesHtml = lines.length
    ? `<table>
        <thead>
          <tr>
            <th style="width:50px;">Line</th>
            <th>SKU</th>
            <th>Description</th>
            <th class="right">Ordered</th>
            <th class="right">Shipped</th>
            <th>UOM</th>
          </tr>
        </thead>
        <tbody>
          ${lines.map(l => `
            <tr>
              <td class="center mono">${_esc(l.line_number || '')}</td>
              <td class="mono">${_esc(l.sku_code || '')}</td>
              <td>${_esc(l.sku_name || '')}</td>
              <td class="right mono">${_esc(l.ordered_qty || 0)}</td>
              <td class="right mono"><strong>${_esc(l.shipped_qty || l.allocated_qty || 0)}</strong></td>
              <td>${_esc(l.sku_uom || 'EA')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
    : '<p><em>No line items.</em></p>';

  const wh = order.warehouse_full || {};
  const ship = order.shipments && order.shipments[0];

  const body = `
    <h1>Packing Slip</h1>
    <div class="row-meta">
      <div><strong>Order Number</strong>${_esc(order.order_number || '')}</div>
      ${order.external_order_number ? `<div><strong>Customer PO</strong>${_esc(order.external_order_number)}</div>` : ''}
      <div><strong>Order Date</strong>${_esc(new Date(order.created_at).toLocaleDateString())}</div>
      <div><strong>Ship Date</strong>${order.shipped_at ? _esc(new Date(order.shipped_at).toLocaleDateString()) : '—'}</div>
      ${ship?.tracking_number ? `<div><strong>Tracking</strong>${_esc(ship.tracking_number)}</div>` : ''}
      ${order.carrier_code ? `<div><strong>Carrier</strong>${_esc(order.carrier_code)}</div>` : ''}
    </div>
    <div class="meta-grid">
      <div class="meta-block">
        <h2>Ship From</h2>
        <strong>${_esc(wh.name || order.warehouse_name || '')}</strong><br>
        ${_fmtAddr(wh)}
      </div>
      <div class="meta-block">
        <h2>Ship To</h2>
        <strong>${_esc(order.ship_to_name || order.customer_name || '—')}</strong><br>
        ${_fmtAddr(order)}
        ${order.customer_email ? `<div class="small" style="margin-top:6px;">${_esc(order.customer_email)}</div>` : ''}
      </div>
    </div>
    ${linesHtml}
    <div class="row-meta" style="margin-top:14px;">
      <div><strong>Total Units</strong>${_esc(totalUnits.toLocaleString())}</div>
      <div><strong>Total Lines</strong>${_esc(lines.length)}</div>
    </div>
    ${order.notes ? `<div style="margin-top:12px;border-top:1px solid #555;padding-top:10px;font-size:11px;"><strong>Notes:</strong> ${_esc(order.notes)}</div>` : ''}
    <div class="small" style="margin-top:24px;text-align:center;color:#444;">
      Thank you for your business.
    </div>
  `;

  _openDocWindow(_printShell(`Packing Slip ${order.order_number || ''}`, body));
}

// =============================================================================
// BILL OF LADING — driver-facing. Shipper / consignee, freight lines
// (pieces / weight / NMFC / class / HM), totals, hazmat emergency
// contact (DOT 49 CFR 172.604), signature blocks.
// =============================================================================

function renderBol(order) {
  const lines = (order.lines || []).filter(l => Number(l.allocated_qty || l.shipped_qty || l.ordered_qty) > 0);

  // Compute totals from line weight × qty. We use shipped_qty if present
  // (post-ship), else allocated, else ordered.
  let totalPieces = 0, totalWeight = 0;
  const rows = lines.map(l => {
    const pieces = Number(l.shipped_qty || l.allocated_qty || l.ordered_qty) || 0;
    const wt = (Number(l.weight_lbs) || 0) * pieces;
    totalPieces += pieces;
    totalWeight += wt;

    let descr;
    if (l.is_hazmat) {
      // DOT-required basic description: UN/NA #, Proper Shipping Name,
      // Hazard Class, Packing Group (when applicable). Class 2 has no PG.
      const parts = [
        l.un_number || '',
        (l.proper_shipping_name || l.sku_name || '').toUpperCase(),
        l.hazard_class ? `Class ${l.hazard_class}` : '',
        l.packing_group ? `PG ${l.packing_group}` : '',
        l.is_limited_qty ? '(Limited Quantity)' : '',
      ].filter(Boolean);
      descr = parts.join(', ');
    } else {
      descr = l.sku_name || l.sku_code || '';
    }

    return {
      pieces,
      isHazmat:    !!l.is_hazmat,
      description: descr,
      sku_code:    l.sku_code,
      weight:      wt,
      nmfc:        l.nmfc_code || '',
      cls:         l.freight_class || '',
    };
  });

  const linesHtml = rows.length
    ? `<table>
        <thead>
          <tr>
            <th class="right" style="width:60px;">Pieces</th>
            <th class="center" style="width:30px;">HM</th>
            <th>Description (kind of pkg, description, special marks)</th>
            <th class="right" style="width:80px;">Weight (lbs)</th>
            <th style="width:90px;">NMFC</th>
            <th class="right" style="width:60px;">Class</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="right mono"><strong>${_esc(r.pieces)}</strong></td>
              <td class="center"><strong style="color:${r.isHazmat ? '#d22' : '#555'};">${r.isHazmat ? 'X' : '—'}</strong></td>
              <td>
                <div class="mono small" style="color:#555;">${_esc(r.sku_code || '')}</div>
                <div>${_esc(r.description)}</div>
              </td>
              <td class="right mono">${r.weight ? _esc(r.weight.toFixed(1)) : '—'}</td>
              <td class="mono">${_esc(r.nmfc || '—')}</td>
              <td class="right mono"><strong>${_esc(r.cls || '—')}</strong></td>
            </tr>`).join('')}
          <tr style="background:#f4f4f4;">
            <td class="right mono"><strong>${_esc(totalPieces)}</strong></td>
            <td></td>
            <td><strong>TOTAL</strong></td>
            <td class="right mono"><strong>${_esc(totalWeight.toFixed(1))}</strong></td>
            <td colspan="2"></td>
          </tr>
        </tbody>
      </table>`
    : '<p><em>No allocated lines on this order.</em></p>';

  const wh = order.warehouse_full || {};
  const cli = order.client_full || {};
  const hazAny = rows.some(r => r.isHazmat);
  const emergency = (cli.hazmat_config && cli.hazmat_config.emergency_contact) || '';
  const ship = order.shipments && order.shipments[0];

  const hazBanner = hazAny
    ? `<div class="hazmat-banner">
        <strong>⚠ HAZARDOUS MATERIALS — Emergency Contact (24-hour):</strong>
        ${emergency ? _esc(emergency) : '<span style="color:#d22;">⚠ NOT ON FILE — required per 49 CFR 172.604</span>'}
      </div>`
    : '';

  const body = `
    <h1>Bill of Lading — ${_esc(order.order_number || '')}</h1>
    <div class="small">
      Date: ${_esc(new Date().toLocaleDateString())}
      ${order.shipped_at ? ` · Shipped: ${_esc(new Date(order.shipped_at).toLocaleDateString())}` : ''}
      ${ship?.shipment_number ? ` · Shipment: ${_esc(ship.shipment_number)}` : ''}
    </div>

    ${hazBanner}

    <div class="meta-grid">
      <div class="meta-block">
        <h2>Shipper (From)</h2>
        <strong>${_esc(wh.name || order.warehouse_name || '')}</strong><br>
        ${_fmtAddr(wh)}
        ${cli.name ? `<div class="small" style="margin-top:6px;">For account: ${_esc(cli.name)} (${_esc(cli.code || '')})</div>` : ''}
      </div>
      <div class="meta-block">
        <h2>Consignee (To)</h2>
        <strong>${_esc(order.ship_to_name || order.customer_name || '—')}</strong><br>
        ${_fmtAddr(order)}
        ${order.customer_email ? `<div class="small" style="margin-top:6px;">${_esc(order.customer_email)}</div>` : ''}
      </div>
    </div>

    <div class="row-meta">
      <div><strong>Carrier</strong>${_esc(order.carrier_code || '—')}</div>
      <div><strong>Service</strong>${_esc(order.ship_method || '—')}</div>
      ${ship?.tracking_number ? `<div><strong>PRO / Tracking #</strong>${_esc(ship.tracking_number)}</div>` : ''}
      ${order.external_order_number ? `<div><strong>Customer PO</strong>${_esc(order.external_order_number)}</div>` : ''}
    </div>

    ${linesHtml}

    <div style="margin-top:14px;border:1px solid #555;padding:10px;font-size:10px;line-height:1.5;">
      <strong>SHIPPER CERTIFICATION:</strong> This is to certify that the above named materials are properly classified, packaged, marked, and labeled, and are in proper condition for transportation according to the applicable regulations of the U.S. Department of Transportation.
    </div>

    <div class="signature-row" style="grid-template-columns:1fr 1fr;">
      <div>
        <div class="sig-line"></div>
        <div class="small">Shipper Signature / Date</div>
      </div>
      <div>
        <div class="sig-line"></div>
        <div class="small">Driver Signature / Date</div>
      </div>
    </div>
    <div class="signature-row" style="grid-template-columns:1fr 1fr;margin-top:14px;">
      <div>
        <div class="sig-line"></div>
        <div class="small">Consignee Signature / Date</div>
      </div>
      <div>
        <div class="sig-line"></div>
        <div class="small">Notes / Discrepancies</div>
      </div>
    </div>
  `;

  _openDocWindow(_printShell(`BOL ${order.order_number || ''}`, body));
}
