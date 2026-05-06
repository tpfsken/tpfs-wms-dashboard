// =============================================================================
// COMBO BOX ENGINE
// =============================================================================
// Usage: initCombo(containerId, options, {placeholder, value, onChange, allowCustom})
// options: [{value, label, sub}] or array of strings
// Read selection: cbVal(id) → string
// Set selection:  cbSet(id, value, label?)
// Reset:          cbReset(id)
// =============================================================================

const _cbState = {};

function initCombo(id, options, cfg = {}){
  const wrap = document.getElementById(id);
  if(!wrap) return;
  const placeholder = cfg.placeholder || 'Select...';
  const current = cfg.value || '';
  const opts = options.map(o => typeof o === 'string' ? {value:o, label:o} : o);

  _cbState[id] = {
    opts, cfg,
    selected: current ? (opts.find(o => o.value === current) || {value:current, label:current}) : null,
  };

  const initialLabel = current
    ? (opts.find(o => o.value === current)?.label || current)
    : placeholder;

  wrap.innerHTML = `<button type="button" class="cb-input" id="${esc(id)}_btn">${esc(initialLabel)}</button><span class="cb-arrow">▼</span>`;
  document.getElementById(id + '_btn').addEventListener('click', () => _cbToggle(id));
}

function _cbToggle(id){
  // Close any other open combos
  document.querySelectorAll('.cb-drop').forEach(d => {
    if(d.dataset.id !== id){
      d.remove();
      document.getElementById(d.dataset.id + '_btn')?.classList.remove('open');
    }
  });

  const existing = document.getElementById(id + '_drop');
  if(existing){
    existing.remove();
    document.getElementById(id + '_btn')?.classList.remove('open');
    return;
  }

  const wrap = document.getElementById(id);
  const btn = document.getElementById(id + '_btn');
  const state = _cbState[id];
  if(!state || !wrap) return;

  btn.classList.add('open');
  const drop = document.createElement('div');
  drop.className = 'cb-drop';
  drop.id = id + '_drop';
  drop.dataset.id = id;
  drop.innerHTML = `<div class="cb-search"><input id="${esc(id)}_search" placeholder="Type to filter..." autocomplete="off"></div><div class="cb-list" id="${esc(id)}_list"></div>`;
  wrap.appendChild(drop);

  // Delegate option clicks via the list container so we don't have to escape
  // values into inline onclick handlers.
  document.getElementById(id + '_list').addEventListener('click', e => {
    const opt = e.target.closest('.cb-opt');
    if(!opt || !opt.dataset.value && !opt.classList.contains('cb-opt-custom')) return;
    if(opt.classList.contains('cb-opt-empty')) return;
    _cbSelect(id, opt.dataset.value || '', opt.dataset.label || '');
  });

  _cbRender(id, '');

  const si = document.getElementById(id + '_search');
  si.focus();
  si.addEventListener('input', () => _cbRender(id, si.value));
  si.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown'){ e.preventDefault(); _cbFocusNext(id, 1); }
    if(e.key === 'ArrowUp'){   e.preventDefault(); _cbFocusNext(id, -1); }
    if(e.key === 'Enter'){     e.preventDefault(); _cbSelectFocused(id); }
    if(e.key === 'Escape'){    _cbClose(id); }
  });

  // Close on outside click
  setTimeout(() => document.addEventListener('click', function handler(e){
    if(!wrap.contains(e.target)){ _cbClose(id); document.removeEventListener('click', handler); }
  }), 50);
}

function _cbRender(id, filter){
  const state = _cbState[id];
  const list = document.getElementById(id + '_list');
  if(!state || !list) return;
  const q = filter.toLowerCase();
  const filtered = state.opts.filter(o =>
    !q ||
    o.label.toLowerCase().includes(q) ||
    (o.sub || '').toLowerCase().includes(q) ||
    o.value.toLowerCase().includes(q)
  );

  if(!filtered.length && state.cfg.allowCustom && filter){
    list.innerHTML = `<div class="cb-opt cb-opt-custom" data-value="${esc(filter)}" data-label="${esc(filter)}">+ Use "${esc(filter)}"</div>`;
    return;
  }
  if(!filtered.length){
    list.innerHTML = '<div class="cb-opt-empty">No options found</div>';
    return;
  }

  list.innerHTML = filtered.map((o,i) => `
    <div class="cb-opt${state.selected?.value === o.value ? ' selected' : ''}"
         data-idx="${i}"
         data-value="${esc(o.value)}"
         data-label="${esc(o.label)}">
      ${esc(o.label)}${o.sub ? `<span style="margin-left:auto;font-size:11px;color:var(--muted)">${esc(o.sub)}</span>` : ''}
    </div>
  `).join('');
}

function _cbFocusNext(id, dir){
  const list = document.getElementById(id + '_list');
  if(!list) return;
  const items = list.querySelectorAll('.cb-opt');
  const focused = list.querySelector('.cb-opt.focused');
  let idx = focused ? parseInt(focused.dataset.idx || 0) + dir : (dir > 0 ? 0 : items.length - 1);
  idx = Math.max(0, Math.min(items.length - 1, idx));
  items.forEach(el => el.classList.remove('focused'));
  if(items[idx]){
    items[idx].classList.add('focused');
    items[idx].scrollIntoView({block:'nearest'});
  }
}

function _cbSelectFocused(id){
  const list = document.getElementById(id + '_list');
  const focused = list?.querySelector('.cb-opt.focused, .cb-opt.selected');
  if(focused) focused.click();
}

function _cbSelect(id, value, label){
  const state = _cbState[id];
  const btn = document.getElementById(id + '_btn');
  if(!state || !btn) return;
  state.selected = {value, label};
  btn.textContent = label || value;
  _cbClose(id);
  if(state.cfg.onChange) state.cfg.onChange(value, label);
}

function _cbClose(id){
  document.getElementById(id + '_drop')?.remove();
  document.getElementById(id + '_btn')?.classList.remove('open');
}

function cbVal(id){
  return _cbState[id]?.selected?.value || '';
}

function cbSet(id, value, label){
  const state = _cbState[id];
  const btn = document.getElementById(id + '_btn');
  if(!state || !btn) return;
  state.selected = value ? {value, label: label || value} : null;
  btn.textContent = value ? (label || value) : (state.cfg.placeholder || 'Select...');
}

function cbReset(id){
  const state = _cbState[id];
  const btn = document.getElementById(id + '_btn');
  if(!state || !btn) return;
  state.selected = null;
  btn.textContent = state.cfg.placeholder || 'Select...';
}
