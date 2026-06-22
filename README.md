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
   supabase secrets set ALLOW_SELF_REGISTER=1          # lets the app pair new devices
   ```
   Put the same `ERP_API_KEY` into `erp_integration/corpvex_otp.py` (`API_KEY`).
   Turn `ALLOW_SELF_REGISTER` off (or unset) once your users are paired — after
   that, create users by inserting rows server-side instead.

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
relay the code (see [`erp_integration/corpvex_otp.py`](erp_integration/corpvex_otp.py)):

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

Point `OTP_API_BASE` (and `API_KEY`, if you set the `ERP_API_KEY` secret) in that
module at your deployed function URL. This helper file belongs in the **ERP**
project — it lives here only as reference.

---

## Files

| Path | What |
|---|---|
| `index.html` / `app.js` / `styles.css` | the PWA (login + live OTP screen) |
| `sw.js` | service worker (offline shell; never caches the API) |
| `firebase-config.js` / `firebase-messaging-sw.js` | optional FCM push (stubbed until filled) |
| `manifest.webmanifest` / `icon-*.png` | PWA install metadata + icons |
| `supabase/schema.sql` | database schema |
| `supabase/functions/otp-api/` | the relay API (send / current / login / register) |
| `supabase/functions/send-push/` | optional FCM fan-out on `notifications` insert |
| `supabase/config.toml` | disables JWT enforcement on the functions |
| `capacitor-app/` | Android wrapper + `build.ps1` (android/ & www/ are gitignored, regenerated) |
| `erp_integration/corpvex_otp.py` | drop-in Python helper for the ERP login |

---

## Security notes (v1 → harden later)

- Passwords/codes flow over **HTTPS**; the ERP calls `send` via GET for simplicity.
  Set the `ERP_API_KEY` secret so only the ERP can relay codes. For extra safety
  prefer POST for anything carrying a secret (the function accepts both), since GET
  query strings can show up in proxy/server logs.
- `current` is gated by the per-user `pollKey`; rotate it on logout if needed.
- The icons are still the template's placeholders — replace `icon-*.png`.
