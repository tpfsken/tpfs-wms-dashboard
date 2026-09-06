// =============================================================================
// PASSWORD — recovery, self-change, admin reset, forced change.
//
// Four entry points, three audiences:
//
//   pwOpenForgot()          login screen -> "Forgot password?" -> emailed link
//   pwOpenResetFromUrl(tok) the link lands back here as /?reset=<token>
//   pwOpenChange()          any signed-in user, from Settings
//   pwAdminReset(id, name)  ops resets a picker who has no email; a temp
//                           password is shown ONCE, read aloud, and must be
//                           changed at next login
//   pwForcedChange()        gate shown at boot when must_change_password is set
//
// Globals are prefixed pw* — there is no module system here, so every top-level
// name in this file is a global and a collision is a SyntaxError that takes the
// whole app down (see the INV_COLS outage).
// =============================================================================

const PW_MIN_LEN = 8;   // mirrors MIN_PASSWORD_LEN in the API. The SERVER decides;
                        // this is only here so the user gets told before a round-trip.

// Shared client-side check. Deliberately length-only — matches the server, and
// complexity rules just push warehouse staff to write passwords on the tablet.
function pwValidate(pw, confirmPw) {
  if (!pw || pw.length < PW_MIN_LEN) return `Password must be at least ${PW_MIN_LEN} characters`;
  if (confirmPw !== undefined && pw !== confirmPw) return 'The two passwords do not match';
  return null;
}

// =============================================================================
// FORGOT — from the login screen
// =============================================================================
function pwOpenForgot() {
  const prefill = (document.getElementById('loginEmail') || {}).value || '';
  const m = uiModal({
    title: 'Reset your password',
    width: 460,
    body: `
      <div class="ui-hint" style="margin-bottom:14px;">
        Enter your email. A link to set a new password is sent to that address.
        The link expires in 60 minutes.
      </div>
      ${uiField({ id: 'pwFgEmail', label: 'Email', value: prefill, type: 'email', placeholder: 'name@company.com' })}
      <div class="ui-hint" style="margin-top:12px;">
        No email on file? Ask a supervisor to reset your password from the Users screen.
      </div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Send reset link', primary: true, onClick: async (api) => {
        const email = api.el.querySelector('#pwFgEmail').value.trim();
        if (!email) { uiFieldError(api.el, 'pwFgEmail', 'Email required'); return false; }

        // No auth header — this runs pre-login.
        try {
          await fetch(`${API}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
        } catch (_) { /* fall through — see below */ }

        // Deliberately says the same thing whether or not the account exists.
        // The API is careful not to leak that; it would be pointless to leak it
        // here instead. Also shown on network error — better a user re-checks
        // their inbox than learns which addresses are real.
        uiAlert({
          title: 'Check your email',
          body: `If an account exists for <strong>${esc(email)}</strong>, a reset link is on its way.`
              + `<br><br>It expires in 60 minutes. Check spam if it hasn't arrived in a few minutes.`,
        });
        return true;
      } },
    ],
  });
  setTimeout(() => { const el = m.el.querySelector('#pwFgEmail'); if (el && !el.value) el.focus(); }, 50);
}

// =============================================================================
// RESET — the emailed link lands on /?reset=<token>
// =============================================================================
// Shown over the login overlay, before any session exists.
function pwOpenResetFromUrl(token) {
  const m = uiModal({
    title: 'Set a new password',
    width: 460,
    onClose: () => pwStripResetParam(),   // don't leave a dead token in the URL bar
    body: `
      <div class="ui-hint" style="margin-bottom:14px;">
        Choose a new password. Minimum ${PW_MIN_LEN} characters.
      </div>
      ${uiField({ id: 'pwRsNew',  label: 'New password',     type: 'password' })}
      ${uiField({ id: 'pwRsConf', label: 'Confirm password', type: 'password' })}`,
    actions: [
      { label: 'Cancel' },
      { label: 'Set password', primary: true, onClick: async (api) => {
        const pw   = api.el.querySelector('#pwRsNew').value;
        const conf = api.el.querySelector('#pwRsConf').value;
        const bad  = pwValidate(pw, conf);
        if (bad) { uiFieldError(api.el, 'pwRsNew', bad); return false; }

        const r = await fetch(`${API}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password: pw }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          // Expired / already used / bogus all come back identical by design.
          uiFieldError(api.el, 'pwRsNew', d.error || 'This reset link is invalid or has expired');
          return false;
        }

        pwStripResetParam();
        uiToast('Password set — sign in with your new password', 'success');
        return true;
      } },
    ],
  });
  setTimeout(() => { const el = m.el.querySelector('#pwRsNew'); if (el) el.focus(); }, 50);
}

// A used token in the address bar is a footgun: the user reloads, the token is
// now spent, and they get "invalid link" on a password they just set fine.
function pwStripResetParam() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('reset')) {
      u.searchParams.delete('reset');
      history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch (_) { /* non-fatal */ }
}

// =============================================================================
// CHANGE — a signed-in user changing their own password (Settings)
// =============================================================================
function pwOpenChange() {
  const m = uiModal({
    title: 'Change password',
    width: 460,
    body: `
      ${uiField({ id: 'pwChCur',  label: 'Current password', type: 'password' })}
      ${uiField({ id: 'pwChNew',  label: 'New password',     type: 'password', hint: `At least ${PW_MIN_LEN} characters` })}
      ${uiField({ id: 'pwChConf', label: 'Confirm new password', type: 'password' })}
      <label class="ui-check"><input type="checkbox" id="pwChOthers" checked> Sign out my other devices</label>
      <div class="ui-hint">Every other tablet, phone or browser signed in as you is signed out at once. This one stays signed in.</div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Change password', primary: true, onClick: (api) => pwSubmitChange(api, false) },
    ],
  });
  setTimeout(() => { const el = m.el.querySelector('#pwChCur'); if (el) el.focus(); }, 50);
}

// =============================================================================
// FORCED CHANGE — must_change_password is set (admin reset, or a new account)
// =============================================================================
// No Cancel, no close button that leads anywhere useful: the API 403s every
// other route until this is done, so letting them dismiss it would just produce
// an app where nothing works and no explanation is given.
function pwForcedChange() {
  // uiModal's close() ALWAYS fires onClose — including the close we trigger
  // ourselves on success. Without disarming it first, a successful change would
  // save the new token and then immediately have it wiped by the abandon-path
  // cleanup below, dumping the user back to login for no visible reason.
  // So: success disarms, then closes.
  let done = false;

  const m = uiModal({
    title: 'Set your own password',
    width: 460,
    onClose: () => {
      if (done) return;   // success path — the app is booting, leave the session alone
      // Abandoned (X, Esc, click-away). Drop them to a clean login rather than a
      // booted shell where every API call 403s with PASSWORD_CHANGE_REQUIRED.
      sessionStorage.clear();
      location.reload();
    },
    body: `
      <div class="ui-banner ui-banner-warn" style="margin-bottom:14px;">
        You're signed in with a temporary password. Set your own to continue.
      </div>
      ${uiField({ id: 'pwChCur',  label: 'Temporary password', type: 'password', hint: 'The one you were just given' })}
      ${uiField({ id: 'pwChNew',  label: 'New password',       type: 'password', hint: `At least ${PW_MIN_LEN} characters` })}
      ${uiField({ id: 'pwChConf', label: 'Confirm new password', type: 'password' })}`,
    actions: [
      { label: 'Set password and continue', primary: true,
        // The disarm callback is what makes success different from abandonment.
        onClick: (api) => pwSubmitChange(api, () => { done = true; }) },
    ],
  });
  setTimeout(() => { const el = m.el.querySelector('#pwChCur'); if (el) el.focus(); }, 50);
}

// Shared submit for both change flows.
//   onForcedSuccess — null for a normal Settings change; for the forced gate it
//   disarms that modal's clear-session-and-reload onClose before we close it.
async function pwSubmitChange(api, onForcedSuccess) {
  const cur  = api.el.querySelector('#pwChCur').value;
  const pw   = api.el.querySelector('#pwChNew').value;
  const conf = api.el.querySelector('#pwChConf').value;

  uiFieldError(api.el, 'pwChCur', '');
  uiFieldError(api.el, 'pwChNew', '');

  if (!cur) { uiFieldError(api.el, 'pwChCur', 'Required'); return false; }
  const bad = pwValidate(pw, conf);
  if (bad)  { uiFieldError(api.el, 'pwChNew', bad); return false; }
  if (cur === pw) {
    uiFieldError(api.el, 'pwChNew', 'New password must be different from the current one');
    return false;
  }

  const r = await fetch(`${API}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${T}` },
    body: JSON.stringify({ currentPassword: cur, newPassword: pw, signOutOthers: api.el.querySelector('#pwChOthers') ? api.el.querySelector('#pwChOthers').checked : true }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d.error || 'Could not change password';
    uiFieldError(api.el, /current/i.test(msg) ? 'pwChCur' : 'pwChNew', msg);
    return false;
  }

  // The API re-mints the token with must_change_password cleared. Without
  // swapping it in, the user would change their password and STILL be locked out
  // by the stale flag in their old JWT — every route would keep 403ing.
  if (d.token) {
    T = d.token;
    sessionStorage.setItem('tpfs_token', T);
    if (U) { U.mustChangePassword = false; sessionStorage.setItem('tpfs_user', JSON.stringify(U)); }
  }

  uiToast('Password changed', 'success');

  if (onForcedSuccess) {
    // Disarm BEFORE closing — api.close() fires the modal's onClose, which would
    // otherwise clear the session we just re-authenticated.
    onForcedSuccess();
    api.close();
    pwBootAfterLogin();   // gate cleared; start the app for real
    return false;         // already closed
  }
  return true;
}

// Mirrors the post-login branch in app.js's doLogin().
function pwBootAfterLogin() {
  if (U && U.userType === 'client') bootPortal();
  else if (typeof shouldUseFloorMode === 'function' && shouldUseFloorMode()) bootFloor();
  else boot();
}

// =============================================================================
// ADMIN RESET — ops resets a user who has no email (pickers)
// =============================================================================
async function pwAdminReset(userId, fullName) {
  const ok = await uiConfirm({
    title: `Reset password for ${fullName || 'this user'}?`,
    body: 'They will be signed out of nothing immediately, but their current password stops working. '
        + 'You will get a temporary password to give them, and they must set their own at next login.',
    confirmText: 'Reset password',
    tone: 'warn',
  });
  if (!ok) return;

  const r = await fetch(`${API}/users/${userId}/reset-password`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${T}` },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return uiToast(d.error || 'Could not reset password', 'error');

  return pwShowTempPassword(d.user?.fullName || fullName, d.tempPassword);
}

/** The one-time temp-password dialog — used by admin reset and by Add user. */
function pwShowTempPassword(fullName, tempPassword) {
  // Shown ONCE. It is not stored in plaintext anywhere and cannot be retrieved
  // again — a second reset issues a different one. Say so plainly, or someone
  // will close this and come back looking for it.
  const m = uiModal({
    title: 'Temporary password',
    width: 460,
    body: `
      <div class="ui-hint" style="margin-bottom:12px;">
        Give this to <strong>${esc(fullName || 'the user')}</strong>.
        They must set their own password when they sign in.
      </div>
      <div id="pwTempBox" style="font-family:ui-monospace,Menlo,monospace;font-size:22px;letter-spacing:.12em;
           text-align:center;padding:16px;background:var(--hover);border:1px solid var(--border-h);
           border-radius:10px;user-select:all;">${esc(tempPassword)}</div>
      <div class="ui-banner ui-banner-warn" style="margin-top:12px;">
        This is shown once. It cannot be looked up again — if it's lost, just reset again.
      </div>`,
    actions: [
      { label: 'Copy', onClick: async (api) => {
        try { await navigator.clipboard.writeText(tempPassword); uiToast('Copied', 'success'); }
        catch (_) { uiToast('Select the text and copy it manually', 'error'); }
        return false;   // keep the dialog open — closing it loses the password
      } },
      { label: 'Done', primary: true },
    ],
  });
  return m;
}
