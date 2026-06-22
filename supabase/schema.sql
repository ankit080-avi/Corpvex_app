-- ============================================================================
-- Corpvex Authenticator — Supabase schema
-- Paste into your project's  Dashboard -> SQL Editor -> Run.
--
-- Design notes
--  * The ERP and the app are SEPARATE projects. The ERP (MSSQL) generates the
--    OTP, stores it in its OWN `users` table, and verifies it there. This DB is
--    only a RELAY: the ERP pushes the code (GET .../otp-api?action=send&user=<id>
--    &code=<otp>); the phone app polls (action=current&user=<id>&key=<pollKey>)
--    and shows it. So otp_codes below is a short-lived relay copy, NOT the source
--    of truth (that's the ERP's users table).
--  * Text ids (the app / edge function supply their own), matching the template.
--  * SECURITY BOUNDARY: app_users and otp_codes have RLS that DENIES the anon
--    (publishable) key. They are touched ONLY by the otp-api Edge Function, which
--    runs with the service-role key. So OTP codes and password hashes are never
--    reachable over the public REST API — only through the gated function.
--  * device_tokens / notifications stay anon-writable so the app can register its
--    push token and the send-push function (shared with the template) can fan out.
-- ============================================================================

-- ── app_users ───────────────────────────────────────────────────────────────
-- One row per Corpvex ERP user that has paired the authenticator app.
--   id        = the Corpvex ERP login id (the `user` the ERP passes)
--   pass_hash = sha-256 hex of the app password (computed in the edge function)
--   poll_key  = per-user secret the app stores after login; required to read OTPs
create table if not exists public.app_users (
  id         text primary key,
  name       text,
  mobile     text,
  pass_hash  text,
  poll_key   text,
  is_active  boolean default true,
  created_at timestamptz default now()
);
alter table public.app_users enable row level security;
-- No anon policy => the publishable key cannot read/write this table at all.
-- (The otp-api Edge Function uses the service-role key and bypasses RLS.)
revoke all on public.app_users from anon, authenticated;

-- ── otp_codes ────────────────────────────────────────────────────────────────
-- Relay copy of the ERP-issued OTP. The ERP pushes a code via `action=send`;
-- older unused codes for the user are superseded so only the newest is readable.
create table if not exists public.otp_codes (
  id         text primary key,
  user_id    text not null,
  code       text not null,
  used       boolean default false,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);
alter table public.otp_codes enable row level security;
revoke all on public.otp_codes from anon, authenticated;
create index if not exists otp_codes_user_idx    on public.otp_codes (user_id);
create index if not exists otp_codes_expires_idx on public.otp_codes (expires_at);

-- ── device_tokens ────────────────────────────────────────────────────────────
-- FCM tokens for optional push (shared shape with the template's send-push fn).
create table if not exists public.device_tokens (
  id         text primary key,
  "userId"   text,
  token      text,
  platform   text,
  updated_at timestamptz default now(),
  constraint device_tokens_user_token_uniq unique ("userId", token)
);
alter table public.device_tokens enable row level security;
drop policy if exists "device_tokens anon full access" on public.device_tokens;
create policy "device_tokens anon full access" on public.device_tokens
  for all to anon, authenticated using (true) with check (true);
create index if not exists device_tokens_userid_idx on public.device_tokens ("userId");

-- ── notifications ────────────────────────────────────────────────────────────
-- Insert here to fan a push out via the send-push Edge Function (DB webhook).
create table if not exists public.notifications (
  id       text primary key,
  "userId" text,
  type     text,
  title    text,
  body     text,
  date     timestamptz default now(),
  read     boolean default false
);
alter table public.notifications enable row level security;
drop policy if exists "notifications anon full access" on public.notifications;
create policy "notifications anon full access" on public.notifications
  for all to anon, authenticated using (true) with check (true);
create index if not exists notifications_userid_idx on public.notifications ("userId");
