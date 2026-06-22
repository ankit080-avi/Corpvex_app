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
const ALLOW_SELF_REGISTER = (Deno.env.get('ALLOW_SELF_REGISTER') ?? '0') === '1';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const p = await readParams(req);
  const action = (p.action || '').toLowerCase();
  const user = (p.user || '').trim();

  try {
    // ── register / pair an app user ──────────────────────────────────────────
    if (action === 'register') {
      if (!ALLOW_SELF_REGISTER) return json({ ok: false, error: 'registration disabled' }, 403);
      if (!user || !p.p) return json({ ok: false, error: 'user and p required' }, 400);
      const pollKey = crypto.randomUUID();
      const row = {
        id: user,
        name: p.name || user,
        mobile: p.mobile || null,
        pass_hash: await hashPass(p.p),
        poll_key: pollKey,
        is_active: true,
      };
      const { error } = await db.from('app_users').upsert(row, { onConflict: 'id' });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, name: row.name, pollKey });
    }

    // ── login (verify the app password, hand back the poll key) ──────────────
    if (action === 'login') {
      if (!user || !p.p) return json({ ok: false, error: 'user and p required' }, 400);
      const { data: u } = await db.from('app_users').select('*').eq('id', user).maybeSingle();
      if (!u || !u.is_active) return json({ ok: false, error: 'no such user' }, 404);
      if (u.pass_hash !== (await hashPass(p.p))) return json({ ok: false, error: 'wrong password' }, 401);
      return json({ ok: true, name: u.name, pollKey: u.poll_key });
    }

    // ── send: ERP relays an OTP it generated (+ stored in its own users table) ─
    if (action === 'send') {
      if (ERP_API_KEY && p.apikey !== ERP_API_KEY) return json({ ok: false, error: 'bad apikey' }, 401);
      if (!user || !p.code) return json({ ok: false, error: 'user and code required' }, 400);

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

    // ── current: the app polls for the live code to display ──────────────────
    if (action === 'current') {
      if (!user || !p.key) return json({ ok: false, error: 'user and key required' }, 400);
      const { data: u } = await db.from('app_users').select('poll_key,is_active').eq('id', user).maybeSingle();
      if (!u || !u.is_active) return json({ ok: false, error: 'unknown user' }, 404);
      if (u.poll_key !== p.key) return json({ ok: false, error: 'bad key' }, 401);

      const { data: c } = await db.from('otp_codes')
        .select('code,expires_at').eq('user_id', user).eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!c) return json({ ok: true, none: true });

      const remaining = Math.max(0, Math.floor((new Date(c.expires_at).getTime() - Date.now()) / 1000));
      return json({ ok: true, code: c.code, expiresAt: c.expires_at, remaining });
    }

    // ── paired: ERP asks whether a user has linked the app (drives 2FA gating) ─
    if (action === 'paired') {
      if (!user) return json({ ok: false, error: 'user required' }, 400);
      const { data: u } = await db.from('app_users').select('id,is_active').eq('id', user).maybeSingle();
      return json({ ok: true, paired: !!(u && u.is_active) });
    }

    return json({ ok: false, error: `unknown action '${action}'` }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
