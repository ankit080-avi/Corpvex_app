/* ─────────────────────────────────────────────────────────────────────────────
   Corpvex Authenticator — phone app for ERP login OTPs.

   Flow: the user pairs once (User ID + password). When they sign in to the
   Corpvex ERP desktop, the ERP calls the otp-api `request` action; this app
   polls `current` and shows the live 6-digit code with a countdown. The user
   types it into the ERP, which calls `verify`.

   Backend: Supabase Edge Function `otp-api` (GET/POST). Optional FCM push just
   wakes/notifies the app — the code itself always arrives via the GET poll.
   ───────────────────────────────────────────────────────────────────────────── */

/* ═══ CONFIG — fill these after creating your Supabase project ═══════════════ */
const CONFIG = {
  // Project URL, e.g. https://abcdefgh.supabase.co
  SUPABASE_URL: 'https://dhqiwizjluiigztohghz.supabase.co',
  // Publishable / anon key (safe for the client; only used for device_tokens).
  SUPABASE_ANON_KEY: 'sb_publishable_gKT7nebaff4p880B6HFLGg_MLBovcJC',
  POLL_MS: 3000,          // how often to poll for a live OTP
  ALLOW_REGISTER: true,   // show the "Pair a device" tab (needs ALLOW_SELF_REGISTER=1 on the function)
};
const OTP_API = `${CONFIG.SUPABASE_URL}/functions/v1/otp-api`;
const BUILD = 1;

/* ═══ Tiny DOM helper ════════════════════════════════════════════════════════ */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return n;
}
const $view = () => document.getElementById('view');

/* ═══ Session (localStorage) ═════════════════════════════════════════════════ */
const SESSION_KEY = 'corpvex-session';
const loadSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
const saveSession = (s) => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
const clearSession = () => localStorage.removeItem(SESSION_KEY);
let session = loadSession();   // { id, name, pollKey }

/* ═══ Toast ══════════════════════════════════════════════════════════════════ */
function toast(msg, kind = 'info') {
  const host = document.getElementById('toastHost');
  const t = el('div', { class: `toast toast-${kind}` }, msg);
  host.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

/* ═══ API ════════════════════════════════════════════════════════════════════ */
async function api(action, params = {}, method = 'GET') {
  try {
    let res;
    if (method === 'POST') {
      res = await fetch(OTP_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...params }),
      });
    } else {
      const q = new URLSearchParams({ action, ...params });
      res = await fetch(`${OTP_API}?${q}`);
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    // NB: use httpStatus — some responses carry their own `status` (account state).
    return { httpStatus: res.status, ...data };
  } catch {
    return { httpStatus: 0, ok: false, error: 'Network error — check connection / config' };
  }
}

// Admin actions always carry the admin's pollKey as the bearer token.
const adminApi = (action, params = {}) => api(action, { adminKey: session.pollKey, ...params }, 'POST');

/* ═══ Auth screens ═══════════════════════════════════════════════════════════ */
function viewAuth() {
  let mode = CONFIG.ALLOW_REGISTER ? 'login' : 'login'; // 'login' | 'register'

  function render() {
    const isReg = mode === 'register';
    const form = el('form', { class: 'card auth-card', onsubmit: submit },
      el('div', { class: 'brand' },
        el('div', { class: 'brand-mark' }, 'C'),
        el('div', {},
          el('div', { class: 'brand-name' }, 'Corpvex'),
          el('div', { class: 'brand-sub' }, 'Authenticator'),
        ),
      ),
      el('h1', { class: 'auth-title' }, isReg ? 'Create account' : 'Sign in'),
      el('p', { class: 'auth-lead' }, isReg
        ? 'Choose your own User ID + password. An admin approves the account before you can sign in.'
        : 'Sign in with your Corpvex app credentials to receive login OTPs here.'),

      el('label', { class: 'field' }, el('span', {}, 'User ID'),
        el('input', { class: 'input', id: 'f-user', autocomplete: 'username', placeholder: 'your ERP user id', value: session?.id || '', required: true })),

      isReg && el('label', { class: 'field' }, el('span', {}, 'Name'),
        el('input', { class: 'input', id: 'f-name', placeholder: 'display name' })),
      isReg && el('label', { class: 'field' }, el('span', {}, 'Mobile (optional)'),
        el('input', { class: 'input', id: 'f-mobile', inputmode: 'numeric', placeholder: '10-digit number' })),

      el('label', { class: 'field' }, el('span', {}, isReg ? 'Set a password' : 'Password'),
        el('input', { class: 'input', id: 'f-pass', type: 'password', autocomplete: isReg ? 'new-password' : 'current-password', placeholder: '••••••••', required: true })),

      el('button', { class: 'btn btn-primary', type: 'submit', id: 'f-submit' }, isReg ? 'Create account' : 'Sign in'),

      CONFIG.ALLOW_REGISTER && el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: () => { mode = isReg ? 'login' : 'register'; render(); } },
        isReg ? '← Back to sign in' : 'New user? Create account'),

      el('div', { class: 'build-tag' }, `Corpvex Authenticator · build ${BUILD}`),
    );
    $view().replaceChildren(el('div', { class: 'auth' }, form));
    document.getElementById('f-user').focus();
  }

  async function submit(e) {
    e.preventDefault();
    const btn = document.getElementById('f-submit');
    const user = document.getElementById('f-user').value.trim();
    const pass = document.getElementById('f-pass').value;
    if (!user || !pass) return toast('User ID and password are required', 'error');
    if (configMissing()) return;
    btn.disabled = true; btn.textContent = '…';
    try {
      if (mode === 'register') {
        const name = document.getElementById('f-name').value.trim();
        const mobile = document.getElementById('f-mobile').value.trim();
        const r = await api('register', { user, p: pass, name, mobile }, 'POST');
        if (!r.ok) throw new Error(r.error || 'Could not create account');
        if (r.status !== 'active') {
          // pending account — needs admin approval before it can sign in
          toast('Account created — waiting for admin approval', 'success');
          mode = 'login'; render();
          return;
        }
        session = { id: user, name: r.name || name || user, pollKey: r.pollKey, role: r.role || 'user' };
      } else {
        const r = await api('login', { user, p: pass }, 'POST');
        if (!r.ok) throw new Error(r.error || 'Sign in failed');
        session = { id: user, name: r.name || user, pollKey: r.pollKey, role: r.role || 'user' };
      }
      saveSession(session);
      toast(`Welcome, ${session.name}`, 'success');
      if (session.role !== 'admin') Push.register(session).catch(() => {});
      route();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = mode === 'register' ? 'Create account' : 'Sign in';
    }
  }

  render();
}

/* ═══ OTP home screen ════════════════════════════════════════════════════════ */
let pollTimer = null, tickTimer = null;

function viewHome() {
  stopPolling();

  const codeEl = el('div', { class: 'otp-code', id: 'otp-code' }, '— — —');
  const ringFill = el('div', { class: 'ring-fill', id: 'ring-fill' });
  const ring = el('div', { class: 'ring' }, ringFill, el('div', { class: 'ring-num', id: 'ring-num' }, ''));
  const statusEl = el('div', { class: 'otp-status', id: 'otp-status' }, 'Waiting for a login request…');
  const copyBtn = el('button', { class: 'btn btn-primary', id: 'copy-btn', disabled: true,
    onclick: copyCode }, 'Copy code');
  const fpBtn = el('button', { class: 'btn btn-ghost btn-sm', id: 'fp-btn', onclick: onFpClick }, '👆 Fingerprint');
  fpBtn.style.display = 'none';   // shown by refreshFpButton() when supported

  const screen = el('div', { class: 'otp-screen' },
    el('div', { class: 'topbar' },
      el('div', { class: 'topbar-id' },
        el('span', { class: 'dot' }),
        el('span', {}, session.name || session.id),
      ),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: logout }, 'Sign out'),
    ),
    el('div', { class: 'card otp-card' },
      el('div', { class: 'otp-label' }, 'Your login code'),
      codeEl,
      ring,
      statusEl,
      copyBtn,
      fpBtn,
    ),
    el('p', { class: 'otp-help' },
      'When you sign in to the Corpvex ERP, your one-time code shows up here. Type it into the ERP before it expires.'),
  );
  $view().replaceChildren(screen);
  startPolling();
  refreshFpButton();
}

let current = null;          // { code, expiresAt }
let successUntil = 0;        // show "Login successful" until this timestamp
let awaitingConsume = false; // a code was displayed; waiting for the ERP to consume it
let lastBiometricPromptCode = null;

async function triggerBiometricApproval(code) {
  const cap = window.Capacitor;
  if (!cap) {
    console.info('[Biometrics] Not running inside Capacitor - skipping.');
    return;
  }
  const NativeBiometric = cap.Plugins?.NativeBiometric;
  if (!NativeBiometric) {
    console.warn('[Biometrics] NativeBiometric plugin not found.');
    return;
  }
  try {
    const result = await NativeBiometric.isAvailable();
    if (result.isAvailable) {
      await NativeBiometric.verifyIdentity({
        reason: "Confirm login request to Corpvex ERP",
        title: "Biometric Approval",
        subtitle: "Verify fingerprint to log in",
        description: "Scan your fingerprint to approve the login request on your PC.",
      });
      
      const r = await api('approve', { user: session.id, key: session.pollKey }, 'POST');
      if (r.ok) {
        toast('Login Approved!', 'success');
        current = null;
        successUntil = Date.now() + 6000;
        awaitingConsume = false;
        paintOtp();
      }
    }
  } catch (err) {
    console.warn('[Biometrics] Verification failed or canceled:', err);
  }
}

/* ═══ WebAuthn fingerprint (browser / PWA) ═══════════════════════════════════
   The installed Android app uses Capacitor NativeBiometric (auto-prompt above).
   In a plain browser there is no such plugin, so we use WebAuthn: the phone's
   built-in fingerprint/face gates the `approve` call. Same security model as the
   APK — biometric is a LOCAL gate; the `approve` API itself is authenticated by
   the per-user pollKey. (Hardening path: verify the WebAuthn assertion server-
   side in the Edge Function — not done here, to match the native flow.)
   Browsers require a user gesture to invoke WebAuthn, so this is button-driven. */
const FP_KEY = (id) => 'corpvex-fp-' + id;
let _fpSupported = null;
async function fpSupported() {
  if (_fpSupported !== null) return _fpSupported;
  try {
    _fpSupported = !!window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { _fpSupported = false; }
  return _fpSupported;
}
const fpRegistered = () => !!(session && localStorage.getItem(FP_KEY(session.id)));

function b64urlEncode(buf) {
  let s = ''; const bytes = new Uint8Array(buf);
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function fpRegister() {
  if (!session) return false;
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Corpvex', id: location.hostname },
      user: { id: new TextEncoder().encode(session.id), name: session.id,
              displayName: session.name || session.id },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000, attestation: 'none',
    }});
    localStorage.setItem(FP_KEY(session.id), b64urlEncode(cred.rawId));
    toast('Fingerprint enabled ✓', 'success');
    return true;
  } catch (err) {
    console.warn('[WebAuthn] register failed', err);
    toast('Could not enable fingerprint', 'error');
    return false;
  }
}

async function fpApprove() {
  const credId = session && localStorage.getItem(FP_KEY(session.id));
  if (!credId) return false;
  try {
    await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: b64urlDecode(credId) }],
      userVerification: 'required', timeout: 60000, rpId: location.hostname,
    }});
  } catch (err) {
    console.warn('[WebAuthn] verify canceled/failed', err);
    toast('Fingerprint not verified', 'error');
    return false;
  }
  const r = await api('approve', { user: session.id, key: session.pollKey }, 'POST');
  if (r.ok) {
    toast('Login approved ✓', 'success');
    current = null; successUntil = Date.now() + 6000; awaitingConsume = false;
    lastBiometricPromptCode = null;
    paintOtp(); refreshFpButton();
    return true;
  }
  toast('Approval failed', 'error');
  return false;
}

async function onFpClick() {
  if (!fpRegistered()) { if (await fpRegister()) refreshFpButton(); return; }
  await fpApprove();
}

async function refreshFpButton() {
  const btn = document.getElementById('fp-btn');
  if (!btn) return;
  if (window.Capacitor) { btn.style.display = 'none'; return; }  // native plugin handles it
  if (!await fpSupported()) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  if (!fpRegistered()) {
    btn.textContent = '👆 Enable fingerprint approval'; btn.disabled = false;
  } else if (current && awaitingConsume) {
    btn.textContent = '👆 Approve with fingerprint'; btn.disabled = false;
  } else {
    btn.textContent = '👆 Fingerprint enabled'; btn.disabled = true;
  }
}

async function poll() {
  if (!session) return;
  if (configMissing(true)) return;
  try {
    const r = await api('current', { user: session.id, key: session.pollKey });
    if (r.httpStatus === 401) { toast('Session expired - sign in again', 'error'); return logout(); }
    if (r.ok && r.code) {
      if (!current || current.code !== r.code) {
        current = { code: r.code, expiresAt: r.expiresAt };
        awaitingConsume = true; successUntil = 0;
        if (lastBiometricPromptCode !== r.code) {
          lastBiometricPromptCode = r.code;
          triggerBiometricApproval(r.code);
        }
      }
    } else {
      lastBiometricPromptCode = null;
      if (r.ok && r.consumed) {
        current = null;
        if (awaitingConsume) { successUntil = Date.now() + 6000; awaitingConsume = false; }
      } else if (r.ok && r.none) {
        current = null;
      }
    }
  } catch { /* network blip - keep last state */ }
  paintOtp();
  refreshFpButton();
}

function paintOtp() {
  const codeEl = document.getElementById('otp-code');
  const statusEl = document.getElementById('otp-status');
  const copyBtn = document.getElementById('copy-btn');
  const ringNum = document.getElementById('ring-num');
  const ringFill = document.getElementById('ring-fill');
  if (!codeEl) return;

  const inSuccess = successUntil && Date.now() < successUntil;

  if (current) {
    const remaining = Math.max(0, Math.floor((new Date(current.expiresAt).getTime() - Date.now()) / 1000));
    if (remaining <= 0) { current = null; return paintOtp(); }
    const c = String(current.code);
    codeEl.textContent = `${c.slice(0, 3)} ${c.slice(3)}`;
    codeEl.className = 'otp-code live';
    statusEl.textContent = 'Enter this in the ERP';
    statusEl.className = 'otp-status live';
    copyBtn.disabled = false;
    if (ringNum) ringNum.textContent = remaining;
    if (ringFill) {
      const pct = Math.min(100, Math.max(0, (remaining / 120) * 100));
      ringFill.style.setProperty('--pct', pct + '%');
      ringFill.className = 'ring-fill' + (remaining <= 15 ? ' low' : '');
    }
  } else if (inSuccess) {
    codeEl.textContent = '✓';
    codeEl.className = 'otp-code done';
    statusEl.textContent = 'Login successful';
    statusEl.className = 'otp-status ok';
    copyBtn.disabled = true;
    if (ringNum) ringNum.textContent = '✓';
    if (ringFill) { ringFill.style.setProperty('--pct', '100%'); ringFill.className = 'ring-fill done'; }
  } else {
    if (successUntil) successUntil = 0;
    codeEl.textContent = '— — —';
    codeEl.className = 'otp-code';
    statusEl.textContent = 'Waiting for a login request…';
    statusEl.className = 'otp-status';
    copyBtn.disabled = true;
    if (ringNum) ringNum.textContent = '';
    if (ringFill) { ringFill.style.setProperty('--pct', '0%'); ringFill.className = 'ring-fill'; }
  }
}

function copyCode() {
  if (!current) return;
  navigator.clipboard?.writeText(String(current.code))
    .then(() => toast('Code copied', 'success'))
    .catch(() => toast('Copy failed', 'error'));
}

function startPolling() {
  poll();
  pollTimer = setInterval(poll, CONFIG.POLL_MS);
  tickTimer = setInterval(paintOtp, 1000); // smooth countdown between polls
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  pollTimer = tickTimer = null;
}

function logout() {
  stopPolling();
  Push.unregister().catch(() => {});
  clearSession();
  session = null; current = null;
  route();
}

/* ═══ Admin dashboard (role === 'admin') ═════════════════════════════════════ */
function viewAdmin() {
  stopPolling();
  const listHost = el('div', { class: 'admin-list', id: 'admin-list' }, el('div', { class: 'muted' }, 'Loading…'));

  const addForm = el('form', { class: 'card admin-add', onsubmit: onAdd },
    el('div', { class: 'admin-add-title' }, 'Add user'),
    el('div', { class: 'admin-add-grid' },
      el('input', { class: 'input', id: 'a-id', placeholder: 'User ID (ERP login)', autocomplete: 'off', required: true }),
      el('input', { class: 'input', id: 'a-name', placeholder: 'Name', autocomplete: 'off' }),
      el('input', { class: 'input', id: 'a-mobile', placeholder: 'Mobile (optional)', inputmode: 'numeric', autocomplete: 'off' }),
      el('input', { class: 'input', id: 'a-pass', type: 'password', placeholder: 'Password', autocomplete: 'new-password', required: true }),
    ),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create user'),
  );

  $view().replaceChildren(el('div', { class: 'otp-screen' },
    el('div', { class: 'topbar' },
      el('div', { class: 'topbar-id' }, el('span', { class: 'dot' }), el('span', {}, 'Admin · ' + (session.name || session.id))),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: logout }, 'Sign out'),
    ),
    addForm,
    el('div', { class: 'admin-head' },
      el('span', {}, 'Users'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: refresh }, '↻ Refresh')),
    listHost,
  ));
  refresh();

  function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

  async function refresh() {
    if (configMissing(true)) return listHost.replaceChildren(el('div', { class: 'muted' }, 'Set SUPABASE_URL / key in app.js first.'));
    listHost.replaceChildren(el('div', { class: 'muted' }, 'Loading…'));
    const r = await adminApi('admin_list');
    if (r.httpStatus === 401) { toast('Admin session expired', 'error'); return logout(); }
    if (!r.ok) return listHost.replaceChildren(el('div', { class: 'muted' }, r.error || 'Failed to load'));
    if (!r.users || !r.users.length) return listHost.replaceChildren(el('div', { class: 'muted' }, 'No users yet — add one above.'));
    const ord = { pending: 0, active: 1, rejected: 2 };
    const users = r.users.slice().sort((a, b) => (ord[a.status] ?? 9) - (ord[b.status] ?? 9) || String(a.id).localeCompare(String(b.id)));
    listHost.replaceChildren(...users.map((u) => userRow(u, r.adminId)));
  }

  function statusBadge(s) {
    const cls = s === 'active' ? 'badge-on' : s === 'pending' ? 'badge-pending' : 'badge-off';
    return el('span', { class: 'badge ' + cls }, s || 'pending');
  }

  function userRow(u, adminId) {
    const isAdmin = u.role === 'admin' || u.id === adminId;
    const sub = el('div', { class: 'urow-sub' },
      isAdmin ? el('span', { class: 'badge badge-admin' }, 'admin') : statusBadge(u.status),
      (!isAdmin && u.status === 'active')
        ? el('span', { class: u.otp_enabled ? 'badge badge-on' : 'badge badge-off' }, u.otp_enabled ? 'OTP on' : 'OTP off') : null,
      u.mobile ? el('span', { class: 'muted' }, u.mobile) : null,
    );
    let actions;
    if (isAdmin) {
      actions = el('div', { class: 'urow-actions' }, el('span', { class: 'muted' }, 'protected'));
    } else if (u.status === 'pending') {
      actions = el('div', { class: 'urow-actions' },
        el('button', { class: 'btn btn-mini btn-approve', onclick: () => setStatus(u, 'active') }, 'Approve'),
        el('button', { class: 'btn btn-mini btn-danger', onclick: () => setStatus(u, 'rejected') }, 'Reject'),
      );
    } else if (u.status === 'rejected') {
      actions = el('div', { class: 'urow-actions' },
        el('button', { class: 'btn btn-mini btn-approve', onclick: () => setStatus(u, 'active') }, 'Approve'),
        el('button', { class: 'btn btn-mini btn-danger', onclick: () => delUser(u) }, 'Delete'),
      );
    } else {
      actions = el('div', { class: 'urow-actions' },
        el('button', { class: 'btn btn-mini', onclick: () => setFlag(u, 'otp_enabled', !u.otp_enabled) }, u.otp_enabled ? 'Disable OTP' : 'Enable OTP'),
        el('button', { class: 'btn btn-mini', onclick: () => setStatus(u, 'rejected') }, 'Disable'),
        el('button', { class: 'btn btn-mini', onclick: () => resetPw(u) }, 'Reset pw'),
        el('button', { class: 'btn btn-mini btn-danger', onclick: () => delUser(u) }, 'Delete'),
      );
    }
    return el('div', { class: 'urow' },
      el('div', { class: 'urow-main' },
        el('div', { class: 'urow-id' }, u.name || u.id),
        el('div', { class: 'urow-name' }, u.id),
        sub),
      actions);
  }

  async function onAdd(e) {
    e.preventDefault();
    const id = val('a-id'), name = val('a-name'), mobile = val('a-mobile'), p = val('a-pass');
    if (!id || !p) return toast('User ID and password are required', 'error');
    if (configMissing()) return;
    const r = await adminApi('admin_upsert_user', { target: id, name, mobile, p });
    if (!r.ok) return toast(r.error || 'Failed', 'error');
    toast(r.created ? `Created ${id}` : `Updated ${id}`, 'success');
    ['a-id', 'a-name', 'a-mobile', 'a-pass'].forEach((i) => { const e2 = document.getElementById(i); if (e2) e2.value = ''; });
    refresh();
  }

  async function setFlag(u, field, value) {
    const r = await adminApi('admin_set_flags', { target: u.id, [field]: value });
    if (!r.ok) return toast(r.error || 'Failed', 'error');
    toast(value ? 'OTP enabled' : 'OTP disabled', 'success');
    refresh();
  }

  async function setStatus(u, status) {
    if (status === 'rejected' && !window.confirm(`${u.status === 'pending' ? 'Reject' : 'Disable'} ${u.id}?`)) return;
    const r = await adminApi('admin_set_status', { target: u.id, status });
    if (!r.ok) return toast(r.error || 'Failed', 'error');
    toast(status === 'active' ? `Approved ${u.id}` : `${u.id} ${status}`, 'success');
    refresh();
  }

  async function resetPw(u) {
    const np = window.prompt(`New password for ${u.id}:`);
    if (!np) return;
    const r = await adminApi('admin_reset_password', { target: u.id, p: np });
    if (!r.ok) return toast(r.error || 'Failed', 'error');
    toast(`Password reset for ${u.id}`, 'success');
  }

  async function delUser(u) {
    if (!window.confirm(`Delete ${u.id}? This removes their app login.`)) return;
    const r = await adminApi('admin_delete_user', { target: u.id });
    if (!r.ok) return toast(r.error || 'Failed', 'error');
    toast(`Deleted ${u.id}`, 'success');
    refresh();
  }
}

/* ═══ Optional FCM push (wakes/notifies; code still arrives via poll) ═════════ */
const Push = {
  _sb: null,
  sb() {
    if (!this._sb && window.supabase && !configMissing(true)) {
      this._sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    }
    return this._sb;
  },
  enabled() {
    return !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.vapidKey);
  },
  async register(user) {
    if (!this.enabled()) { console.info('[Push] firebase-config not filled — skipping (poll still works).'); return; }
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
    try {
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
      }
      await navigator.serviceWorker.register('firebase-messaging-sw.js');
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js');
      const { getMessaging, getToken, onMessage } =
        await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js');
      const app = initializeApp(window.FIREBASE_CONFIG);
      const messaging = getMessaging(app);
      const token = await getToken(messaging, { vapidKey: window.FIREBASE_CONFIG.vapidKey });
      if (!token) return;
      const sb = this.sb();
      if (sb) {
        await sb.from('device_tokens').upsert(
          { id: 'web_' + token.slice(-12), userId: user.id, token, platform: 'web', updated_at: new Date().toISOString() },
          { onConflict: 'userId,token' });
        localStorage.setItem('corpvex-fcm', JSON.stringify({ userId: user.id, token }));
      }
      onMessage(messaging, () => { poll(); }); // foreground push -> refresh now
    } catch (err) { console.warn('[Push] register failed', err); }
  },
  async unregister() {
    try {
      const raw = localStorage.getItem('corpvex-fcm');
      if (raw) {
        const { token } = JSON.parse(raw);
        const sb = this.sb();
        if (sb && token) await sb.from('device_tokens').delete().eq('token', token);
      }
      localStorage.removeItem('corpvex-fcm');
    } catch { /* ignore */ }
  },
};

/* ═══ Helpers / router / boot ════════════════════════════════════════════════ */
function configMissing(silent) {
  const bad = CONFIG.SUPABASE_URL.includes('YOUR-PROJECT') || CONFIG.SUPABASE_ANON_KEY.includes('YOUR_');
  if (bad && !silent) toast('Set SUPABASE_URL / key in app.js first', 'error');
  return bad;
}

function route() {
  session = session || loadSession();
  if (session && session.pollKey) {
    if (session.role === 'admin') viewAdmin();
    else viewHome();
  } else viewAuth();
}

// Re-poll immediately when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) poll(); });

window.addEventListener('DOMContentLoaded', route);
