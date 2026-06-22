// ─────────────────────────────────────────────────────────────────────────────
// otp-api — Corpvex Authenticator relay (Supabase Edge Function)
//
// IMPORTANT: this is only a RELAY. The Corpvex ERP (a separate project, on MSSQL)
// GENERATES the OTP and stores it in its own `users` table, and VERIFIES it there.
// This function just carries the ERP-issued code to the paired phone app.
//
// Params may come from the query string (GET) or a JSON body (POST).
//
//   GET  ?action=send&user=<id>&code=<otp>[&ttl=120][&apikey=<k>]  (ERP)
//        -> store the ERP-issued code so the app can read it; optional push
//   GET  ?action=current&user=<id>&key=<pollKey>                   (app)
//        -> return the live code to display
//   POST  {action:'login',    user, p}            (app) -> {ok, name, pollKey}
//   POST  {action:'register', user, p, name, mobile}    -> create/pair an app user
//
// Deploy without JWT enforcement (see supabase/config.toml):
//   supabase functions deploy otp-api --no-verify-jwt
//
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional secrets:
//   ERP_API_KEY         -> if set, the `send` action requires &apikey=<this>
//   OTP_PEPPER          -> salt for app password hashing
//   ALLOW_SELF_REGISTER -> '1' to permit the register action
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PEPPER = Deno.env.get('OTP_PEPPER') ?? 'corpvex';
const ERP_API_KEY = Deno.env.get('ERP_API_KEY') ?? '';
// The software admin's id (full control over app-login users). Defaults to the
// number you gave; override with the ADMIN_ID secret.
const ADMIN_ID = (Deno.env.get('ADMIN_ID') ?? '88858141463').trim();

const DEFAULT_TTL = 120; // seconds the relayed code stays readable by the app

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const hashPass = (p: string) => sha256hex(`${PEPPER}:${p}`);
const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const genCode = () => String(Math.floor(100000 + Math.random() * 900000)); // 6 digits

// Merge query-string params with JSON body params (body wins if both present).
async function readParams(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const url = new URL(req.url);
  for (const [k, v] of url.searchParams) out[k.toLowerCase()] = v;
  if (req.method === 'POST') {
    try {
      const b = await req.json();
      if (b && typeof b === 'object') {
        for (const [k, v] of Object.entries(b)) out[k.toLowerCase()] = String(v ?? '');
      }
    } catch { /* no/invalid body — query params only */ }
  }
  return out;
}

// Resolve an admin from their poll_key (which doubles as the admin bearer token).
async function requireAdmin(adminKey: string) {
  if (!adminKey) return null;
  const { data } = await db.from('app_users')
    .select('id,role,status').eq('poll_key', adminKey).maybeSingle();
  return data && data.role === 'admin' && data.status === 'active' ? data : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const p = await readParams(req);
  const action = (p.action || '').toLowerCase();
  const user = (p.user || '').trim();

  try {
    // ── register: self sign-up. Anyone can create an account with their OWN
    //    password; it starts 'pending' until the admin approves it. The admin id
    //    bootstraps itself as an active admin. Never overwrites an existing user.
    if (action === 'register') {
      if (!user || !p.p) return json({ ok: false, error: 'user and p required' }, 400);
      const isAdminId = user === ADMIN_ID;
      const { data: existing } = await db.from('app_users').select('id,role').eq('id', user).maybeSingle();
      if (existing) {
        return json({ ok: false, error: (isAdminId && existing.role === 'admin')
          ? 'admin already set up — sign in instead'
          : 'this user already exists — sign in instead' }, 409);
      }
      const row = {
        id: user,
        name: p.name || user,
        mobile: p.mobile || null,
        pass_hash: await hashPass(p.p),
        poll_key: crypto.randomUUID(),
        role: isAdminId ? 'admin' : 'user',
        status: isAdminId ? 'active' : 'pending',
        otp_enabled: true,
      };
      const { error } = await db.from('app_users').insert(row);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, name: row.name, pollKey: row.poll_key, role: row.role, status: row.status });
    }

    // ── login (verify the app password, hand back the poll key + role) ───────
    if (action === 'login') {
      if (!user || !p.p) return json({ ok: false, error: 'user and p required' }, 400);
      const { data: u } = await db.from('app_users').select('*').eq('id', user).maybeSingle();
      if (!u) return json({ ok: false, error: 'no such user' }, 404);
      if (u.pass_hash !== (await hashPass(p.p))) return json({ ok: false, error: 'wrong password' }, 401);
      if (u.status === 'pending') return json({ ok: false, error: 'awaiting admin approval', status: 'pending' }, 403);
      if (u.status === 'rejected') return json({ ok: false, error: 'access rejected — contact the admin', status: 'rejected' }, 403);
      if (u.status !== 'active') return json({ ok: false, error: 'account not active', status: u.status }, 403);
      return json({ ok: true, name: u.name, pollKey: u.poll_key, role: u.role || 'user', otpEnabled: u.otp_enabled !== false });
    }

    // ── request: ERP asks Supabase to ISSUE an OTP (status-checked) ──────────
    // Supabase generates + stores the code and returns it to the ERP. The app
    // shows it via `current`; the ERP keeps the returned code for local verify.
    if (action === 'request') {
      if (ERP_API_KEY && p.apikey !== ERP_API_KEY) return json({ ok: false, error: 'bad apikey' }, 401);
      if (!user) return json({ ok: false, error: 'user required' }, 400);
      const { data: u } = await db.from('app_users').select('status,otp_enabled').eq('id', user).maybeSingle();
      if (!u) return json({ ok: false, error: 'no app user', status: 'none' }, 404);
      if (u.status !== 'active') return json({ ok: false, error: `user not active (${u.status})`, status: u.status }, 403);
      if (u.otp_enabled === false) return json({ ok: false, error: 'otp disabled for this user', status: u.status }, 403);

      const ttl = Math.max(30, Math.min(600, parseInt(p.ttl || '', 10) || DEFAULT_TTL));
      const code = genCode();
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      await db.from('otp_codes').update({ used: true }).eq('user_id', user).eq('used', false);
      const { error } = await db.from('otp_codes').insert({
        id: genId(), user_id: user, code, used: false, expires_at: expiresAt,
      });
      if (error) return json({ ok: false, error: error.message }, 500);
      await db.from('notifications').insert({
        id: genId(), userId: user, type: 'otp', title: 'Corpvex login code',
        body: `Your login OTP is ${code}. Valid ${ttl}s.`, date: new Date().toISOString(),
      });
      return json({ ok: true, code, ttl, expiresAt });
    }

    // ── create_user: ERP provisions a new app user as 'pending' (admin approves) ─
    if (action === 'create_user') {
      if (ERP_API_KEY && p.apikey !== ERP_API_KEY) return json({ ok: false, error: 'bad apikey' }, 401);
      if (!user || !p.p) return json({ ok: false, error: 'user and p (password) required' }, 400);
      const { data: existing } = await db.from('app_users').select('id,status').eq('id', user).maybeSingle();
      if (existing) return json({ ok: true, created: false, status: existing.status });
      const { error } = await db.from('app_users').insert({
        id: user, name: p.name || user, mobile: p.mobile || null,
        pass_hash: await hashPass(p.p), poll_key: crypto.randomUUID(),
        role: 'user', status: 'pending', otp_enabled: true,
      });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, created: true, status: 'pending' });
    }

    // ── send: ERP relays an OTP it generated itself (status-checked) ─────────
    if (action === 'send') {
      if (ERP_API_KEY && p.apikey !== ERP_API_KEY) return json({ ok: false, error: 'bad apikey' }, 401);
      if (!user || !p.code) return json({ ok: false, error: 'user and code required' }, 400);
      const { data: su } = await db.from('app_users').select('status').eq('id', user).maybeSingle();
      if (!su || su.status !== 'active') return json({ ok: false, error: 'user not active', status: su?.status || 'none' }, 403);

      const ttl = Math.max(30, Math.min(600, parseInt(p.ttl || '', 10) || DEFAULT_TTL));
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

      // supersede any still-live relayed code, then store the new one
      await db.from('otp_codes').update({ used: true }).eq('user_id', user).eq('used', false);
      const { error } = await db.from('otp_codes').insert({
        id: genId(), user_id: user, code: String(p.code), used: false, expires_at: expiresAt,
      });
      if (error) return json({ ok: false, error: error.message }, 500);

      // optional push (works only if device_tokens + send-push are configured)
      await db.from('notifications').insert({
        id: genId(), userId: user, type: 'otp',
        title: 'Corpvex login code',
        body: `Your login OTP is ${p.code}. Valid ${ttl}s. Ignore if this wasn't you.`,
        date: new Date().toISOString(),
      });

      return json({ ok: true, ttl, expiresAt });
    }

    // ── consume: ERP marks the OTP used after a successful login (stops the app timer) ─
    if (action === 'consume') {
      if (ERP_API_KEY && p.apikey !== ERP_API_KEY) return json({ ok: false, error: 'bad apikey' }, 401);
      if (!user) return json({ ok: false, error: 'user required' }, 400);
      const { data, error } = await db.from('otp_codes')
        .update({ used: true, consumed_at: new Date().toISOString() })
        .eq('user_id', user).eq('used', false).select('id');
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, consumed: (data?.length || 0) > 0 });
    }

    // ── current: the app polls for the live code to display ──────────────────
    if (action === 'current') {
      if (!user || !p.key) return json({ ok: false, error: 'user and key required' }, 400);
      const { data: u } = await db.from('app_users').select('poll_key,status').eq('id', user).maybeSingle();
      if (!u || u.status !== 'active') return json({ ok: false, error: 'unknown or inactive user' }, 404);
      if (u.poll_key !== p.key) return json({ ok: false, error: 'bad key' }, 401);

      const { data: c } = await db.from('otp_codes')
        .select('code,expires_at').eq('user_id', user).eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (c) {
        const remaining = Math.max(0, Math.floor((new Date(c.expires_at).getTime() - Date.now()) / 1000));
        return json({ ok: true, code: c.code, expiresAt: c.expires_at, remaining });
      }
      // No active code — was one just consumed by a successful ERP login? (show success)
      const { data: last } = await db.from('otp_codes')
        .select('consumed_at').eq('user_id', user).not('consumed_at', 'is', null)
        .order('consumed_at', { ascending: false }).limit(1).maybeSingle();
      if (last?.consumed_at && (Date.now() - new Date(last.consumed_at).getTime()) < 30000) {
        return json({ ok: true, consumed: true });
      }
      return json({ ok: true, none: true });
    }

    // ── paired: ERP asks whether to require app-OTP for this user ────────────
    // True only if the account is active AND the admin hasn't disabled OTP for it.
    if (action === 'paired') {
      if (!user) return json({ ok: false, error: 'user required' }, 400);
      const { data: u } = await db.from('app_users').select('id,status,otp_enabled').eq('id', user).maybeSingle();
      return json({ ok: true, paired: !!(u && u.status === 'active' && u.otp_enabled !== false) });
    }

    // ── admin: full control over app-login users (gated by an admin poll_key) ─
    if (action.startsWith('admin_')) {
      const admin = await requireAdmin(p.adminkey || '');
      if (!admin) return json({ ok: false, error: 'admin auth required' }, 401);
      const target = (p.target || '').trim();

      if (action === 'admin_list') {
        const { data } = await db.from('app_users')
          .select('id,name,mobile,role,status,otp_enabled,created_at')
          .order('status', { ascending: true }).order('id', { ascending: true });
        return json({ ok: true, users: data || [], adminId: ADMIN_ID });
      }

      if (action === 'admin_upsert_user') {
        if (!target) return json({ ok: false, error: 'target user required' }, 400);
        const { data: existing } = await db.from('app_users').select('id').eq('id', target).maybeSingle();
        const row: Record<string, unknown> = { id: target, name: p.name || target, mobile: p.mobile || null };
        if (!existing) { row.poll_key = crypto.randomUUID(); row.role = 'user'; row.status = 'active'; row.otp_enabled = true; }
        if (p.p) row.pass_hash = await hashPass(p.p);
        if (!existing && !p.p) return json({ ok: false, error: 'a password is required for a new user' }, 400);
        const { error } = await db.from('app_users').upsert(row, { onConflict: 'id' });
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true, created: !existing });
      }

      // approve / reject / re-pending
      if (action === 'admin_set_status') {
        if (!target) return json({ ok: false, error: 'target user required' }, 400);
        if (target === ADMIN_ID) return json({ ok: false, error: 'cannot change the admin account' }, 400);
        const st = (p.status || '').toLowerCase();
        if (!['active', 'rejected', 'pending'].includes(st)) {
          return json({ ok: false, error: 'status must be active|rejected|pending' }, 400);
        }
        const { error } = await db.from('app_users').update({ status: st }).eq('id', target);
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true, status: st });
      }

      // toggle OTP for a user
      if (action === 'admin_set_flags') {
        if (!target) return json({ ok: false, error: 'target user required' }, 400);
        if (target === ADMIN_ID) return json({ ok: false, error: 'cannot change the admin account' }, 400);
        if (p.otp_enabled === undefined) return json({ ok: false, error: 'nothing to update' }, 400);
        const { error } = await db.from('app_users')
          .update({ otp_enabled: ['true', '1'].includes(String(p.otp_enabled)) }).eq('id', target);
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true });
      }

      if (action === 'admin_reset_password') {
        if (!target || !p.p) return json({ ok: false, error: 'target and p required' }, 400);
        const { error } = await db.from('app_users')
          .update({ pass_hash: await hashPass(p.p), poll_key: crypto.randomUUID() }).eq('id', target);
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true });
      }

      if (action === 'admin_delete_user') {
        if (!target) return json({ ok: false, error: 'target required' }, 400);
        if (target === ADMIN_ID) return json({ ok: false, error: 'cannot delete the admin' }, 400);
        await db.from('app_users').delete().eq('id', target);
        await db.from('otp_codes').delete().eq('user_id', target);
        return json({ ok: true });
      }

      return json({ ok: false, error: `unknown admin action '${action}'` }, 400);
    }

    return json({ ok: false, error: `unknown action '${action}'` }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
