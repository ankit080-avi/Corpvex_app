# Corpvex Authenticator

A phone app that displays **one-time login codes (OTP) for the Corpvex ERP**.

> **The ERP and this app are separate projects.** The **ERP** (a desktop app on
> MSSQL) *generates* the OTP, stores it in its own `users` table, and *verifies*
> it there. This project is the **relay + phone app**: an HTTPS GET API carries
> the ERP-issued code to the paired phone, which shows it with a countdown. The
> user types it back into the ERP. No email, no SMS gateway.

Built on the same stack as the `dailywater` template: **vanilla-JS PWA → Capacitor
Android APK**, **Supabase** (Postgres + Edge Functions), optional **Firebase Cloud
Messaging** push.

---

## How it works

**Provisioning (admin-gated lifecycle):**
```
ERP  → create_user(user, password)        → app_users.status = 'pending'
Admin app → Approve / Reject              → status = 'active' | 'rejected'
```

**Login OTP (only for active users):**
```
ERP login → request(user)
   ├─ status = active   → Supabase issues + stores a 6-digit OTP, returns it to the ERP
   └─ status ≠ active   → error, no login
Phone app → current(user, pollKey)        → shows the live code with a countdown
ERP → verifies the code the user typed (kept in its own users.Otp)
```
(`send` is an alternative where the ERP generates the code itself and relays it —
also status-checked. Either way the app reads the code via `current`.)

- The relay stores the code only briefly (`otp_codes`); the **source of truth is
  the ERP's `users` table**.
- `app_users` and `otp_codes` are **locked from the public/anon key** (RLS revoke).
  They are touched only by the `otp-api` Edge Function (service-role). The phone
  reads its code through `current`, gated by a per-user `pollKey`. The `send` action
  can be gated by an `ERP_API_KEY` secret so only the ERP can push codes.
- Push (FCM) is **optional**. The code always arrives via the GET poll; push just
  wakes/notifies the phone.

---

## Setup

### 1. Supabase
1. Create a project at <https://supabase.com>.
2. **SQL editor →** paste & run [`supabase/schema.sql`](supabase/schema.sql).
3. Deploy the functions (Supabase CLI):
   ```bash
   supabase functions deploy otp-api  --no-verify-jwt
   supabase functions deploy send-push --no-verify-jwt   # only if using push
   ```
   (`supabase/config.toml` already sets `verify_jwt = false` for both.)
4. Set function secrets:
   ```bash
   supabase secrets set OTP_PEPPER=<random-string>     # app password hashing salt
   supabase secrets set ERP_API_KEY=<random-string>    # the ERP must send this on `send`
   supabase secrets set ADMIN_ID=88858141463           # the software admin's id
   # ALLOW_SELF_REGISTER stays OFF — the admin creates all normal users.
   ```
   Put the same `ERP_API_KEY` into the ERP's `corpvex_otp.py` (`API_KEY`).

### Admin
A single **software admin** (id = `ADMIN_ID`, default `88858141463`) controls all
app logins. First-time setup: open the app → **"Admin first-time setup"** → enter
the admin id + a password (the matching id is auto-granted the admin role + active
status). The admin then signs in to a dashboard to:
- **Approve / Reject** users the ERP provisioned (they arrive as `pending`),
- **create** a user directly (id + password, created `active`),
- **disable OTP** for a user (their `paired` check returns false → ERP skips app-OTP),
- **disable** (→ rejected), **reset password**, or **delete** a user.

User lifecycle: `pending` → admin **Approve** → `active` (can log in / get OTP);
`pending`/`rejected` users are blocked. Normal users just **Sign in** with the
credentials they were given, once active.

### 2. The web app
Edit the `CONFIG` block at the top of [`app.js`](app.js):
```js
SUPABASE_URL:      'https://<your-project>.supabase.co',
SUPABASE_ANON_KEY: '<publishable anon key>',
```
That's all that's needed to run. Serve the folder (e.g. GitHub Pages on `main`,
or any static host) and open it on a phone.

### 3. (Optional) Push
Fill [`firebase-config.js`](firebase-config.js) with your Firebase web config +
VAPID public key, and set the `FIREBASE_SERVICE_ACCOUNT` secret on the
`send-push` function. See comments in those files.

### 4. (Optional) Android APK
```powershell
# Android SDK expected at D:\android-sdk (edit build.ps1 to change)
& .\capacitor-app\build.ps1      # → Corpvex.apk in the repo root
```

---

## ERP integration

The ERP generates + stores + verifies the OTP itself; it only calls **one** URL to
relay the code. The helper for that lives in the **ERP** project (separate repo),
at `corpvex_otp.py` — not in this repo. Usage:

```python
from corpvex_otp import create_user, request_otp

# Provisioning (your ERP "create user" action): user starts 'pending'; admin approves.
create_user("sagar", password="temp1234", name="Sagar", mobile="98765xxxxx")

# At login — Supabase issues the OTP only if the user is active:
r = request_otp("sagar")
if not r.get("ok"):
    deny(r.get("error"))            # e.g. 'awaiting admin approval' / 'access rejected'
else:
    code = r["code"]                # store in users.Otp; the phone app shows it via poll
    # ...user types it into the ERP; verify locally against users.Otp...
```
(`send_otp(user, code)` remains for the ERP-generates-the-code variant.)

Set `OTP_API_BASE` (and `API_KEY`, if you set the `ERP_API_KEY` secret) in that
module to your deployed function URL.

The ERP decides whether to require app-OTP by calling `is_paired(user)` →
`?action=paired&user=<id>` (true once the user has linked the app). Users without
Telegram get app-only 2FA once paired; Telegram users get both channels.

---

## Files

| Path | What |
|---|---|
| `index.html` / `app.js` / `styles.css` | the PWA (login + live OTP screen) |
| `sw.js` | service worker (offline shell; never caches the API) |
| `firebase-config.js` / `firebase-messaging-sw.js` | optional FCM push (stubbed until filled) |
| `manifest.webmanifest` / `icon-*.png` | PWA install metadata + icons |
| `supabase/schema.sql` | database schema |
| `supabase/functions/otp-api/` | API: create_user / request / send / current / paired / login / register + admin_* (list / set_status / upsert_user / set_flags / reset_password / delete_user) |
| `supabase/functions/send-push/` | optional FCM fan-out on `notifications` insert |
| `supabase/config.toml` | disables JWT enforcement on the functions |
| `capacitor-app/` | Android wrapper + `build.ps1` (android/ & www/ are gitignored, regenerated) |

> The ERP-side helper (`corpvex_otp.py`) lives in the **ERP** project, not here.

---

## Security notes (v1 → harden later)

- Passwords/codes flow over **HTTPS**; the ERP calls `send` via GET for simplicity.
  Set the `ERP_API_KEY` secret so only the ERP can relay codes. For extra safety
  prefer POST for anything carrying a secret (the function accepts both), since GET
  query strings can show up in proxy/server logs.
- `current` is gated by the per-user `pollKey`; rotate it on logout if needed.
- The icons are still the template's placeholders — replace `icon-*.png`.
