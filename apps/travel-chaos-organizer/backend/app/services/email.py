"""
Transactional email via Resend API.
No-op when RESEND_API_KEY is not set.
"""
import os
from typing import Any
from app.config import get_settings


def _configured() -> bool:
    return bool(os.getenv("RESEND_API_KEY", ""))


async def send_waitlist_welcome(to_email: str) -> None:
    """Send welcome email after waitlist signup."""
    if not _configured():
        return
    try:
        import httpx
        api_key = os.getenv("RESEND_API_KEY", "")
        from_addr = os.getenv("RESEND_FROM", "noreply@tco.app")
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "from": from_addr,
                    "to": [to_email],
                    "subject": "Du bist auf der Liste 🗺️",
                    "html": _welcome_html(to_email),
                },
            )
    except Exception:
        pass


async def _send(to: str, subject: str, html: str) -> None:
    """Generic send — used by drip and other services."""
    s = get_settings()
    if not s.resend_api_key:
        return
    import httpx
    async with httpx.AsyncClient() as client:
        await client.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {s.resend_api_key}", "Content-Type": "application/json"},
            json={"from": s.resend_from, "to": [to], "subject": subject, "html": html},
            timeout=10,
        )


def _welcome_html(email: str) -> str:
    return f"""
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#0f0f1a;color:#e2e8f0;padding:40px;max-width:560px;margin:0 auto">
  <h1 style="color:#a5b4fc;font-size:24px;margin-bottom:8px">🗺️ Du bist auf der Liste.</h1>
  <p style="color:#6666aa;margin-bottom:24px">Wir melden uns, sobald Travel Chaos Organizer bereit ist.</p>
  <p style="font-size:14px;color:#3a3a5e">Registriert mit: {email}</p>
</body>
</html>"""
