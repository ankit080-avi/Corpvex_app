# Corpvex Authenticator

A phone app that delivers **one-time login codes (OTP) for the Corpvex ERP**.
When a user signs in to the ERP desktop app, the ERP asks the backend to issue an
OTP; this app shows the live 6-digit code with a countdown; the user types it into
the ERP, which verifies it. No email, no SMS gateway — the code travels over a
simple HTTPS GET API.

Built on the same stack as the `dailywater` template: **vanilla-JS PWA → Capacitor
Android APK**, **Supabase** (Postgres + Edge Functions), optional **Firebase Cloud
Messaging** push.

---

## How it works

```
ERP desktop login
  └─ GET  /functions/v1/otp-api?action=request&user=<id>      → issue + (optionally) push an OTP
Phone app (this repo)
  └─ GET  /functions/v1/otp-api?action=current&user=<id>&key=<pollKey>   → show the live code
ERP desktop (user typed the code)
  └─ GET  /functions/v1/otp-api?action=verify&user=<id>&code=<n>         → {ok:true}
```

- The **OTP code is never returned to the ERP** — only `request` (issue) and
  `verify` (check). The code is shown only on the paired phone.
- `app_users` and `otp_codes` are **locked from the public/anon key** (RLS revoke).
  They are touched only by the `otp-api` Edge Function (service-role). The phone
  reads its code through `current`, gated by a per-user `pollKey`.
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
4. To allow the app's "Pair this device" screen, set a function secret:
   ```bash
   supabase secrets set ALLOW_SELF_REGISTER=1
   supabase secrets set OTP_PEPPER=<some-random-string>
   ```
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

The ERP only needs to call two URLs (see [`erp_integration/corpvex_otp.py`](erp_integration/corpvex_otp.py)):

```python
from corpvex_otp import request_otp, verify_otp

request_otp("ankit")                 # at login → code goes to the user's phone
ok = verify_otp("ankit", code_typed) # check what they entered
```

Point `OTP_API_BASE` in that module at your deployed function URL.

---

## Files

| Path | What |
|---|---|
| `index.html` / `app.js` / `styles.css` | the PWA (login + live OTP screen) |
| `sw.js` | service worker (offline shell; never caches the API) |
| `firebase-config.js` / `firebase-messaging-sw.js` | optional FCM push (stubbed until filled) |
| `manifest.webmanifest` / `icon-*.png` | PWA install metadata + icons |
| `supabase/schema.sql` | database schema |
| `supabase/functions/otp-api/` | the OTP API (request / current / verify / login / register) |
| `supabase/functions/send-push/` | optional FCM fan-out on `notifications` insert |
| `supabase/config.toml` | disables JWT enforcement on the functions |
| `capacitor-app/` | Android wrapper + `build.ps1` (android/ & www/ are gitignored, regenerated) |
| `erp_integration/corpvex_otp.py` | drop-in Python helper for the ERP login |

---

## Security notes (v1 → harden later)

- Passwords/codes flow over **HTTPS**; the ERP calls `request`/`verify` via GET for
  simplicity. For production, prefer POST for anything carrying a secret and add a
  shared API key/HMAC the ERP sends so only the ERP can call `request`/`verify`.
- `current` is gated by the per-user `pollKey`; rotate it on logout if needed.
- The icons are still the template's placeholders — replace `icon-*.png`.
