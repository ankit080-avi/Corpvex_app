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
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  // Publishable / anon key (safe for the client; only used for device_tokens).
  SUPABASE_ANON_KEY: 'YOUR_PUBLISHABLE_ANON_KEY',
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
  return { status: res.status, ...data };
}

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
      el('h1', { class: 'auth-title' }, isReg ? 'Pair this device' : 'Sign in'),
      el('p', { class: 'auth-lead' }, isReg
        ? 'Link your phone to your Corpvex ERP login so you can receive OTPs here.'
        : 'Enter your Corpvex ERP login to start receiving OTPs on this device.'),

      el('label', { class: 'field' }, el('span', {}, 'User ID'),
        el('input', { class: 'input', id: 'f-user', autocomplete: 'username', placeholder: 'your ERP user id', value: session?.id || '', required: true })),

      isReg && el('label', { class: 'field' }, el('span', {}, 'Name'),
        el('input', { class: 'input', id: 'f-name', placeholder: 'display name' })),
      isReg && el('label', { class: 'field' }, el('span', {}, 'Mobile (optional)'),
        el('input', { class: 'input', id: 'f-mobile', inputmode: 'numeric', placeholder: '10-digit number' })),

      el('label', { class: 'field' }, el('span', {}, isReg ? 'Set a password' : 'Password'),
        el('input', { class: 'input', id: 'f-pass', type: 'password', autocomplete: isReg ? 'new-password' : 'current-password', placeholder: '••••••••', required: true })),

      el('button', { class: 'btn btn-primary', type: 'submit', id: 'f-submit' }, isReg ? 'Pair device' : 'Sign in'),

      CONFIG.ALLOW_REGISTER && el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: () => { mode = isReg ? 'login' : 'register'; render(); } },
        isReg ? '← Back to sign in' : 'First time? Pair this device'),

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
        if (!r.ok) throw new Error(r.error || 'Could not pair');
        session = { id: user, name: r.name || name || user, pollKey: r.pollKey };
      } else {
        const r = await api('login', { user, p: pass }, 'POST');
        if (!r.ok) throw new Error(r.error || 'Sign in failed');
        session = { id: user, name: r.name || user, pollKey: r.pollKey };
      }
      saveSession(session);
      toast(`Welcome, ${session.name}`, 'success');
      Push.register(session).catch(() => {});
      route();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = mode === 'register' ? 'Pair device' : 'Sign in';
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
    ),
    el('p', { class: 'otp-help' },
      'When you sign in to the Corpvex ERP, your one-time code shows up here. Type it into the ERP before it expires.'),
  );
  $view().replaceChildren(screen);
  startPolling();
}

let current = null; // { code, expiresAt }

async function poll() {
  if (!session) return;
  if (configMissing(true)) return;
  try {
    const r = await api('current', { user: session.id, key: session.pollKey });
    if (r.status === 401) { toast('Session expired — sign in again', 'error'); return logout(); }
    if (r.ok && r.code) {
      if (!current || current.code !== r.code) current = { code: r.code, expiresAt: r.expiresAt };
    } else if (r.ok && r.none) {
      current = null;
    }
  } catch { /* network blip — keep last state */ }
  paintOtp();
}

function paintOtp() {
  const codeEl = document.getElementById('otp-code');
  const statusEl = document.getElementById('otp-status');
  const copyBtn = document.getElementById('copy-btn');
  const ringNum = document.getElementById('ring-num');
  const ringFill = document.getElementById('ring-fill');
  if (!codeEl) return;

  if (current) {
    const remaining = Math.max(0, Math.floor((new Date(current.expiresAt).getTime() - Date.now()) / 1000));
    if (remaining <= 0) { current = null; return paintOtp(); }
    const c = String(current.code);
    codeEl.textContent = `${c.slice(0, 3)} ${c.slice(3)}`;
    codeEl.classList.add('live');
    statusEl.textContent = 'Enter this in the ERP';
    statusEl.className = 'otp-status live';
    copyBtn.disabled = false;
    if (ringNum) ringNum.textContent = remaining;
    if (ringFill) {
      const pct = Math.min(100, Math.max(0, (remaining / 120) * 100));
      ringFill.style.setProperty('--pct', pct + '%');
      ringFill.classList.toggle('low', remaining <= 15);
    }
  } else {
    codeEl.textContent = '— — —';
    codeEl.classList.remove('live');
    statusEl.textContent = 'Waiting for a login request…';
    statusEl.className = 'otp-status';
    copyBtn.disabled = true;
    if (ringNum) ringNum.textContent = '';
    if (ringFill) { ringFill.style.setProperty('--pct', '0%'); ringFill.classList.remove('low'); }
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
  if (session && session.pollKey) viewHome();
  else viewAuth();
}

// Re-poll immediately when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) poll(); });

window.addEventListener('DOMContentLoaded', route);
