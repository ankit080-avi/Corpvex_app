"""
corpvex_otp — thin client for the Corpvex Authenticator OTP API.

Drop this into the Corpvex ERP (e.g. next to ui/login.py) and call it from the
login flow. No third-party deps — uses urllib from the stdlib.

    from corpvex_otp import request_otp, verify_otp

    # after the user enters their ERP id + password (your existing auth):
    request_otp(user_id)                     # OTP is pushed/shown on their phone
    code = ask_user_for_code()               # your dialog / input box
    if verify_otp(user_id, code):
        proceed_with_login()
    else:
        show_error("Invalid or expired code")

Set OTP_API_BASE below to your deployed Supabase function URL:
    https://<project>.supabase.co/functions/v1/otp-api
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

# ── CONFIG ───────────────────────────────────────────────────────────────────
OTP_API_BASE = "https://YOUR-PROJECT.supabase.co/functions/v1/otp-api"
TIMEOUT = 12  # seconds


def _get(action: str, **params) -> dict:
    """Call the OTP API with a GET request and return the parsed JSON (or {})."""
    params["action"] = action
    url = f"{OTP_API_BASE}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        # The function returns JSON bodies even on 4xx/5xx — surface them.
        try:
            return json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:  # network / timeout
        return {"ok": False, "error": str(e)}


def request_otp(user_id: str, ttl: int = 120) -> dict:
    """Ask the backend to issue a fresh OTP for `user_id` and push it to the phone.

    Returns the raw response dict, e.g. {'ok': True, 'ttl': 120, 'expiresAt': ...}.
    Does NOT return the code (the code only goes to the paired phone).
    """
    return _get("request", user=user_id, ttl=ttl)


def verify_otp(user_id: str, code: str) -> bool:
    """Return True iff `code` is the current valid OTP for `user_id`."""
    res = _get("verify", user=user_id, code=str(code).strip())
    return bool(res.get("ok") and res.get("verified"))


def verify_otp_detailed(user_id: str, code: str) -> dict:
    """Like verify_otp but returns the full response (attemptsLeft, locked, ...)."""
    return _get("verify", user=user_id, code=str(code).strip())


if __name__ == "__main__":
    # quick manual test:  python corpvex_otp.py <user>
    import sys
    u = sys.argv[1] if len(sys.argv) > 1 else "demo"
    print("request:", request_otp(u))
    c = input("Enter the code shown on the phone: ").strip()
    print("verify :", verify_otp_detailed(u, c))
