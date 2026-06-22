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

```
ERP (separate project, MSSQL)
  ├─ generate OTP, store in its own users table (otp + otp_expiry)
  └─ GET  /functions/v1/otp-api?action=send&user=<id>&code=<otp>   → relay it
Phone app (this repo)
  └─ GET  /functions/v1/otp-api?action=current&user=<id>&key=<pollKey>  → show the live code
ERP (user typed the code)
  └─ verify LOCALLY against its own users table  (not via this API)
```

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
Accounts are provisioned by a single **software admin** (id = `ADMIN_ID`, default
`88858141463`). First-time setup: open the app → **"Admin first-time setup"** →
enter the admin id + a password (the matching id is auto-granted the admin role).
After that the admin signs in to a dashboard to:
- **create** app-login users (id + password they hand out),
- **enable/disable** an account, **reset** a password, **delete** a user,
- **disable OTP for a particular user** — that user's `paired` check returns false,
  so the ERP stops requiring app-OTP for them.

Normal users just **Sign in** with the credentials the admin gives them.

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
from corpvex_otp import generate_otp, send_otp

code = generate_otp()                       # 6-digit string
# 1) store in the ERP users table:
#    UPDATE users SET otp = ?, otp_expiry = DATEADD(second, 120, GETDATE())
#     WHERE login_id = ?
send_otp("ankit", code)                     # 2) relay to the phone app

# 3) user types the code into the ERP -> verify LOCALLY:
#    SELECT otp, otp_expiry FROM users WHERE login_id = ?  (compare + check expiry)
```

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
| `supabase/functions/otp-api/` | relay API: send / current / paired / login / register + admin_* (list/upsert_user/set_flags/reset_password/delete_user) |
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
