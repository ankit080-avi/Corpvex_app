# Corpvex Authenticator — project guide

Phone app that delivers **one-time login codes (OTP) for the Corpvex ERP**. When a
user signs in to the ERP desktop, an OTP is issued and shown on their phone; they
type it into the ERP; on success the app shows "Login successful" and stops the
timer. No email, no SMS gateway — the code travels over a small HTTPS API.

- **Repo:** https://github.com/ankit080-avi/Corpvex_app (branch `main`)
- **Live PWA:** https://ankit080-avi.github.io/Corpvex_app/ (GitHub Pages, root)
- **Android package:** `com.corpvex.app`
- **Git author for this repo:** `ankit788726@gmail.com` (local `user.email`)
- Built from the **dailywater** template (same stack), stripped to an authenticator.

> The ERP is a **separate project** (`D:\cl\fable5_v2.4`, PyQt6 + MSSQL). This repo is
> the phone app + the Supabase relay/API. They're linked only by the OTP API and a
> shared user id (the ERP username == the app `app_users.id`).

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla-JS SPA (`app.js`), no framework; tiny `el()` DOM helper |
| Styling | Plain CSS design tokens (`styles.css`); dark-first, indigo accent |
| PWA | `manifest.webmanifest` + `sw.js` (network-first; never caches `/functions/v1/`) |
| Backend | **Supabase** (Postgres + Edge Functions, Deno) |
| Auth | Custom user id + password (NOT Supabase Auth); sha-256(PEPPER:pw) |
| Android | Capacitor 8 wrapper → debug APK (`build.ps1`) |
| Push | Firebase FCM — **optional/stubbed**; the app works on polling |

---

## Live backend (Supabase)

- **Project ref:** `dhqiwizjluiigztohghz` (org `arwvvecsluzbbbohfmxd`, region `ap-south-1`).
- **URL:** `https://dhqiwizjluiigztohghz.supabase.co`
- **OTP API base:** `https://dhqiwizjluiigztohghz.supabase.co/functions/v1/otp-api`
- Managed with the Supabase CLI via `npx supabase` (the machine is logged in).
  - ⚠️ That CLI login does **not** see the old dailywater project `udclccwehhnhstngvgam`
    (different account) — Corpvex uses its own dedicated project above.
- **Function secrets:** `ADMIN_ID=88858141463`, `ERP_API_KEY=<secret>`, `OTP_PEPPER=<secret>`.
- `send-push` is **not deployed** (push optional; would need Firebase service account).

---

## The flows

### Provisioning (admin-gated lifecycle)
```
ERP create_user(user, password)   ─┐
app self-register (own password)  ─┴─→ app_users.status = 'pending'
Admin app → Approve / Reject          → status = 'active' | 'rejected'
```
Only `status='active'` users can sign in / receive an OTP. The admin id
(`ADMIN_ID`) bootstraps itself as an active admin on first register.

### Login OTP (active users only)
```
ERP login → request(user)
   ├─ active     → Supabase issues + stores a 6-digit OTP, returns it to the ERP
   └─ not active → error, no login
Phone app → current(user, pollKey)   → shows the live code + countdown
ERP verifies the typed code locally (against its own users.Otp)
ERP login success → consume(user)    → app shows "✓ Login successful", timer stops
```
`send` is an alternative where the ERP generates the code itself and relays it
(also status-checked). Either way the app reads the code via `current`.

---

## Data model (Supabase, `supabase/schema.sql`)

**`app_users`** — one row per user that can use the app. RLS: **anon revoked** (only
the edge function, via service role, touches it).
| col | meaning |
|---|---|
| `id` | the ERP login id (the `user` everything keys on) |
| `name`, `mobile` | display info |
| `pass_hash` | `sha256(OTP_PEPPER + ':' + password)` |
| `poll_key` | per-user secret; the app's read token AND the admin's bearer token |
| `role` | `admin` (id = `ADMIN_ID`) or `user` |
| `status` | `pending` \| `active` \| `rejected` |
| `otp_enabled` | admin switch; when false `paired` returns false → ERP skips app-OTP |

**`otp_codes`** — relay copy of the issued OTP. RLS: **anon revoked**.
`id, user_id, code, used, created_at, expires_at, consumed_at`.
`consumed_at` is stamped by `consume` on a successful login (drives the app's success state).

**`device_tokens`, `notifications`** — anon-writable; only used by optional FCM push.

---

## API — `otp-api` Edge Function (`supabase/functions/otp-api/index.ts`)

One function; routes on `action`. Params from query string (GET) **or** JSON body
(POST). Deployed with `--no-verify-jwt` (also set in `supabase/config.toml`) so the
ERP can call bare URLs. CORS `*`.

| action | caller (gate) | does |
|---|---|---|
| `register` | anyone | self sign-up → `pending` (admin id → active admin); INSERT, never overwrites an existing user |
| `login` | app (POST) | verify password (before status); returns `role`, `otpEnabled`, `pollKey`; blocks non-active |
| `request` | ERP (`apikey`) | status-check → issue + store OTP → return `{code, ttl, expiresAt}` |
| `send` | ERP (`apikey`) | relay an ERP-generated code (status-checked) |
| `current` | app (`pollKey`) | `{code, expiresAt, remaining}` \| `{consumed:true}` (used <30s ago) \| `{none:true}` |
| `consume` | ERP (`apikey`) | mark active OTP `used` + stamp `consumed_at` (login success) |
| `paired` | ERP | `{paired:true}` iff `status=active` AND `otp_enabled` |
| `admin_list` | admin (`adminKey`) | list all users |
| `admin_set_status` | admin | approve/reject/pending (not the admin row) |
| `admin_upsert_user` | admin | create (→active) / edit a user |
| `admin_set_flags` | admin | toggle `otp_enabled` |
| `admin_reset_password` | admin | set a user's password (rotates their poll_key) |
| `admin_delete_user` | admin | delete a user (+ their otp_codes) |

`adminKey` = the admin's `poll_key` (returned at admin login). `apikey` must equal the
`ERP_API_KEY` secret.

---

## Admin

- Id = `ADMIN_ID` secret (default **`88858141463`**). **Default password set: `Corpvex@123`**
  (change recommended — there's no in-app self-change for the admin yet).
- First-time: open the app → **Create account** → id `88858141463` + a password → auto
  admin + active. Afterwards **Sign in**.
- Dashboard (role `admin`): Add user; per-user **Approve/Reject** (pending),
  **Approve/Delete** (rejected), **Disable OTP / Disable / Reset pw / Delete** (active).
  The admin's own row is "protected".

---

## App screens (`app.js`)

- **Auth:** Sign in / "New user? Create account" (own password → pending). `CONFIG`
  block at the top holds `SUPABASE_URL` + `SUPABASE_ANON_KEY` (publishable; safe to ship).
- **Home (user):** polls `current` every 3 s; shows the live code + countdown ring;
  on consume → green "✓ Login successful" (timer stopped) → idle after ~6 s.
- **Admin dashboard:** user list with status badges + management actions.
- `api()` returns `httpStatus` (not `status`, which collides with the account status field).

---

## Build & deploy

### Web / PWA (GitHub Pages)
Pages serves `main`/root. Push → redeploys in ~1–2 min.
```
git add -A && git commit -m "..." && git push origin main
```
**On each web release bump the cache-busters** so browsers/PWA refetch: `?v=N` on
`app.js`/`styles.css`/`firebase-config.js` in `index.html` **and** `VERSION` in `sw.js`.

### Edge function + schema (Supabase CLI via npx)
```powershell
npx supabase functions deploy otp-api --project-ref dhqiwizjluiigztohghz --no-verify-jwt
# schema changes: add a file under supabase/migrations/ then:
$env:SUPABASE_DB_PASSWORD = '<db password>'
npx supabase db push --yes
# secrets:
npx supabase secrets set --project-ref dhqiwizjluiigztohghz ADMIN_ID=88858141463 ERP_API_KEY=<...> OTP_PEPPER=<...>
```
(Function deploy uploads via API — Docker not required. The "Docker not running" line is harmless.)

### Android APK
```powershell
& .\capacitor-app\build.ps1      # → Corpvex.apk in repo root
```
Needs Android SDK at `D:\android-sdk` (edit `build.ps1` to change) + a JDK (uses 21).
`build.ps1` copies the root web assets into `capacitor-app/www/`, runs `cap sync`, and
`gradle assembleDebug`. **The APK bundles `app.js` at build time** — it is immune to the
web cache issue, but must be rebuilt + reinstalled to pick up config/code changes.

---

## ERP integration (separate project `D:\cl\fable5_v2.4`)

- **`corpvex_otp.py`** (at the ERP root — NOT in this repo): the ERP's client.
  Functions: `create_user`, `request_otp`, `send_otp`, `is_paired`, `consume`,
  `generate_otp`. Config: `OTP_API_BASE` + `API_KEY` (= `ERP_API_KEY`). `is_configured()`
  no-ops everything until the URL is set.
- **`ui/login.py`** changes:
  - detection worker also calls `is_paired(user)` (background, fail-closed).
  - OTP mode gating: `LoginMode > 1 AND (has Telegram OR app-paired)`.
  - **App is the preferred OTP channel** when paired — `request_otp` issues the code via
    Supabase (works even without a Telegram bot token); Telegram is an optional extra.
  - `_notify_app_login_success(user)` → `consume(user)` at the login-success point
    (both `_do_login` and `_login_without_password`), so the app stops its timer.
  - Backups left as `ui/login.py.pre_*.bak`.
- The ERP stores its own OTP in **`users.Otp`** (int — `zfill(6)` on verify to keep
  leading zeros) and verifies locally. ERP DB = **`new2`** on `DESKTOP-T7SV8S3\SSMS`
  (creds in `config1.ini`).
- **No hot reload** — restart the ERP after any `login.py` / `corpvex_otp.py` change.

---

## File map

| Path | What |
|---|---|
| `index.html` / `app.js` / `styles.css` | the PWA (auth + OTP screen + admin dashboard) |
| `sw.js` | service worker (offline shell; skips the API) |
| `firebase-config.js` / `firebase-messaging-sw.js` | optional FCM push (stubbed) |
| `manifest.webmanifest` / `icon-*.png` | PWA metadata + icons (still template placeholders) |
| `supabase/schema.sql` | full schema (human reference) |
| `supabase/migrations/` | applied migrations (`db push`) |
| `supabase/functions/otp-api/` | the API (all actions above) |
| `supabase/functions/send-push/` | optional FCM fan-out (not deployed) |
| `supabase/config.toml` | `verify_jwt = false` for the functions |
| `capacitor-app/` | Android wrapper + `build.ps1` (`android/` & `www/` gitignored, regenerated) |
| `README.md` | setup-oriented doc; `i.md` (this) is the full project guide |

---

## Open items / notes

- **Icons** are still the dailywater placeholders — replace `icon-192/512/maskable-512.png`.
- **Admin self-password-change** isn't in the UI yet (the admin row is "protected"). Change
  the default `Corpvex@123` via `admin_reset_password` (API) or add a UI affordance.
- **Push (FCM)** is optional and not deployed; the app works fully on polling. To enable:
  fill `firebase-config.js`, deploy `send-push`, set `FIREBASE_SERVICE_ACCOUNT` secret.
- **Repo is public:** the `SUPABASE_ANON_KEY` (publishable) in `app.js` is safe to expose;
  RLS locks `app_users`/`otp_codes` from anon. The real secrets live only in Supabase
  function secrets + the ERP's `corpvex_otp.py`.
- **Wire `create_user`** into the ERP's user-creation screen so new users land as `pending`.

---

_Status (2026-06-22): live end-to-end. Verified register→approve, request→app shows code,
ERP login→consume→"Login successful". APK built (`Corpvex.apk`, 3.97 MB)._
