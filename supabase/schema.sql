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
-- One row per Corpvex ERP user that can use the authenticator app.
--   id          = the Corpvex ERP login id (the `user` the ERP passes)
--   pass_hash   = sha-256 hex of the app password (computed in the edge function)
--   poll_key    = per-user secret the app stores after login; required to read OTPs
--                 (also doubles as the bearer token for admin actions)
--   role        = 'admin' (the software admin, id = ADMIN_ID secret) or 'user'
--   status      = 'pending' | 'active' | 'rejected'  (lifecycle)
--   otp_enabled = admin switch: when false, `paired` returns false so the ERP
--                 skips app-OTP for that user (i.e. "disable OTP for this user")
-- Provisioning lifecycle (see the flow diagram):
--   ERP calls create_user -> row created status='pending'
--   admin Approves -> status='active'  |  admin Rejects -> status='rejected'
--   only status='active' users can log in / receive an OTP.
-- (The admin bootstraps via register: the id matching ADMIN_ID is auto-granted
--  role='admin' and status='active'.)
create table if not exists public.app_users (
  id          text primary key,
  name        text,
  mobile      text,
  pass_hash   text,
  poll_key    text,
  role        text default 'user',
  status      text default 'pending',
  otp_enabled boolean default true,
  created_at  timestamptz default now()
);
-- (re-runnable) add the newer columns if an older app_users already exists
alter table public.app_users add column if not exists role        text default 'user';
alter table public.app_users add column if not exists status      text default 'pending';
alter table public.app_users add column if not exists otp_enabled boolean default true;
create index if not exists app_users_status_idx on public.app_users (status);
alter table public.app_users enable row level security;
-- No anon policy => the publishable key cannot read/write this table at all.
-- (The otp-api Edge Function uses the service-role key and bypasses RLS.)
revoke all on public.app_users from anon, authenticated;

-- ── otp_codes ────────────────────────────────────────────────────────────────
-- Relay copy of the ERP-issued OTP. The ERP pushes a code via `action=send`;
-- older unused codes for the user are superseded so only the newest is readable.
create table if not exists public.otp_codes (
  id          text primary key,
  user_id     text not null,
  code        text not null,
  used        boolean default false,
  created_at  timestamptz default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz   -- set when the ERP login succeeds (app shows "success")
);
alter table public.otp_codes add column if not exists consumed_at timestamptz;
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
