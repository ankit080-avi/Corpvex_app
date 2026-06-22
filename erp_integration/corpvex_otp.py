"""
corpvex_otp — thin client the Corpvex ERP uses to relay a login OTP to the app.

ARCHITECTURE (the ERP and the app are SEPARATE projects):
  * The ERP generates the OTP and stores it in its OWN `users` table (MSSQL),
    and verifies it there. This module does NOT generate or verify — it only
    pushes the ERP-issued code to the relay API so the paired phone app can show
    it.

Typical ERP login flow (e.g. inside ui/login.py):

    from corpvex_otp import generate_otp, send_otp

    code = generate_otp()                       # 6-digit string
    # 1) store it in the ERP users table (your DB layer), e.g.:
    #    UPDATE users
    #       SET otp = ?, otp_expiry = DATEADD(second, 120, GETDATE())
    #     WHERE login_id = ?
    db.execute_update(...)                       # <- your existing DB call

    # 2) relay it to the phone app:
    send_otp(user_login_id, code)

    # 3) user reads it on the phone, types it into the ERP; verify LOCALLY:
    #    SELECT otp, otp_expiry FROM users WHERE login_id = ?
    #    -> compare to what they typed and check otp_expiry > GETDATE()

Set OTP_API_BASE to your deployed Supabase function URL and (if you set the
ERP_API_KEY secret on the function) set API_KEY to match.
No third-party deps — stdlib urllib only.
"""

from __future__ import annotations

import json
import random
import urllib.error
import urllib.parse
import urllib.request

# ── CONFIG ───────────────────────────────────────────────────────────────────
OTP_API_BASE = "https://YOUR-PROJECT.supabase.co/functions/v1/otp-api"
API_KEY = ""        # must match the ERP_API_KEY function secret (leave "" if unset)
DEFAULT_TTL = 120   # seconds the code stays valid (match your users.otp_expiry window)
TIMEOUT = 12        # seconds


def generate_otp(digits: int = 6) -> str:
    """Return a random numeric OTP (default 6 digits). Store this in users table."""
    return "".join(str(random.randint(0, 9)) for _ in range(digits))


def _get(action: str, **params) -> dict:
    """Call the relay API with a GET request; return parsed JSON (or an error dict)."""
    params = {k: v for k, v in params.items() if v not in ("", None)}
    params["action"] = action
    url = f"{OTP_API_BASE}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:  # network / timeout
        return {"ok": False, "error": str(e)}


def send_otp(user_id: str, code: str, ttl: int = DEFAULT_TTL) -> dict:
    """Relay an ERP-generated `code` for `user_id` to the paired phone app.

    Returns the raw response, e.g. {'ok': True, 'ttl': 120, 'expiresAt': ...}.
    Does not store or verify — that stays in the ERP's users table.
    """
    return _get("send", user=user_id, code=str(code), ttl=ttl, apikey=API_KEY)


if __name__ == "__main__":
    # quick manual test:  python corpvex_otp.py <user>
    import sys
    u = sys.argv[1] if len(sys.argv) > 1 else "demo"
    c = generate_otp()
    print("generated:", c)
    print("send     :", send_otp(u, c))
