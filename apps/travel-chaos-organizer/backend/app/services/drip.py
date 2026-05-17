"""
Email drip sequence for waitlist signups.
Triggered manually via admin endpoint or a cron job.

Sequence:
  Day 0  — welcome email (sent at signup, already handled in waitlist.py)
  Day 3  — "Import your first document" nudge
  Day 7  — "Upgrade to Pro" offer
  Day 14 — "What are you organising?" feedback request
"""
from datetime import datetime, timedelta, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.services import email as email_svc


SEQUENCE = [
    (3,  "day3_nudge"),
    (7,  "day7_upgrade"),
    (14, "day14_feedback"),
]

SUBJECTS = {
    "day3_nudge":      "Hast du schon dein erstes Dokument importiert? ✈️",
    "day7_upgrade":    "Unbegrenzte Trips mit TCO Pro 🚀",
    "day14_feedback":  "Was organisierst du mit TCO? Wir wollen's wissen 💬",
}

BODIES = {
    "day3_nudge": """
<p>Hey,</p>
<p>du hast dich vor 3 Tagen für Travel Chaos Organizer angemeldet – super!</p>
<p>Hast du schon versucht, ein Buchungsbestätigungs-PDF oder Screenshot zu importieren?
Einfach in der App auf <strong>„Dokument importieren"</strong> tippen –
unsere KI erkennt Flüge, Hotels und Mietwagen automatisch.</p>
<p>Viel Spaß beim Aufräumen des Reisechaos 🗂️</p>
""",
    "day7_upgrade": """
<p>Hey,</p>
<p>nach einer Woche mit TCO: wie läuft's?</p>
<p>Mit dem <strong>kostenlosen Plan</strong> hast du 3 Trips und 50 KI-Parses pro Tag.
Für Vielreisende gibt's <strong>TCO Pro</strong>: unbegrenzte Trips, unbegrenzte Parses.</p>
<p><a href="https://tco.app/upgrade" style="background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Jetzt upgraden →</a></p>
""",
    "day14_feedback": """
<p>Hey,</p>
<p>du nutzt TCO jetzt seit 2 Wochen – wir würden gerne wissen, was du organisierst
und was wir verbessern können.</p>
<p>Einfach auf diese Mail antworten – jede Rückmeldung hilft uns sehr!</p>
""",
}


async def run_drip(db: AsyncSession, dry_run: bool = False) -> dict:
    """
    Check all waitlist signups and send due emails.
    Tracks sent emails in the events table to avoid duplicates.
    Returns a dict with counts.
    """
    sent = 0
    skipped = 0
    now = datetime.now(timezone.utc)

    rows = await db.execute(text("SELECT id, email, created_at FROM waitlist ORDER BY created_at ASC"))
    signups = rows.fetchall()

    for signup in signups:
        signup_id, email, created_at = signup
        if isinstance(created_at, str):
            from datetime import datetime as _dt
            try:
                created_at = _dt.fromisoformat(created_at.replace("Z", "+00:00"))
            except ValueError:
                continue
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)

        days_since = (now - created_at).days

        for day, event_name in SEQUENCE:
            if days_since < day:
                continue

            # Check if already sent
            already = await db.execute(
                text("""
                    SELECT 1 FROM events
                    WHERE user_id IS NULL
                      AND event_name = :name
                      AND properties::text LIKE :email_pat
                    LIMIT 1
                """),
                {"name": f"drip_{event_name}", "email_pat": f'%{email}%'},
            )
            if already.fetchone():
                skipped += 1
                continue

            if not dry_run:
                subject = SUBJECTS[event_name]
                body = BODIES[event_name]
                html = f"""
                <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
                <img src="https://tco.app/logo.png" height="32" style="margin-bottom:24px">
                {body}
                <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
                <p style="color:#999;font-size:12px">Travel Chaos Organizer · <a href="https://tco.app">tco.app</a></p>
                </div>"""
                await email_svc._send(email, subject, html)

                # Track as sent
                import json
                await db.execute(
                    text("""
                        INSERT INTO events (user_id, event_name, properties)
                        VALUES (NULL, :name, :props)
                    """),
                    {"name": f"drip_{event_name}", "props": json.dumps({"email": email, "signup_id": str(signup_id)})},
                )
                await db.commit()
            sent += 1

    return {"sent": sent, "skipped": skipped, "dry_run": dry_run}
