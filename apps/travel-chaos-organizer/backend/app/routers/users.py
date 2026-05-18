"""
User profile endpoint — returns current user's plan info and upserts user row.
"""
import secrets
from typing import Annotated
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.auth.keycloak import user_id
from app.db.database import get_db

# In-process PIN store (sufficient for single-process; use Redis for multi-replica)
_pending_links: dict[str, tuple[str, datetime]] = {}  # pin -> (uid, expires_at)

router = APIRouter(prefix="/users", tags=["users"])

@router.get("/me")
async def me(
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    # Upsert user row (first login creates it)
    await db.execute(
        text("""
            INSERT INTO users (id) VALUES (:uid)
            ON CONFLICT (id) DO NOTHING
        """),
        {"uid": uid},
    )
    await db.commit()

    row_check = await db.execute(text("SELECT created_at, updated_at FROM users WHERE id = :uid"), {"uid": uid})
    user_row = row_check.fetchone()
    # Track first login (created_at == updated_at means fresh insert)
    if user_row and str(user_row[0])[:19] == str(user_row[1])[:19]:
        from app.services import telemetry, notifier
        await telemetry.track(db, uid, "user_first_login", {"uid": uid})
        await notifier.notify("tco", "new_user", {"uid": uid[:8] + "..."})

    row = await db.execute(
        text("""
            SELECT id, email, plan, plan_expires_at, created_at
            FROM users WHERE id = :uid
        """),
        {"uid": uid},
    )
    r = row.fetchone()
    now = datetime.now(timezone.utc)
    plan = r[2] if r else "free"
    plan_expires_at = r[3] if r else None
    # plan is only active if not expired
    if plan != "free" and plan_expires_at is not None:
        # compare: plan_expires_at may be a string (SQLite) or datetime (PG)
        if isinstance(plan_expires_at, str):
            from datetime import datetime as _dt
            try:
                plan_expires_at_dt = _dt.fromisoformat(plan_expires_at.replace("Z", "+00:00"))
            except ValueError:
                plan_expires_at_dt = None
        else:
            plan_expires_at_dt = plan_expires_at
        if plan_expires_at_dt and plan_expires_at_dt < now:
            plan = "free"

    return {
        "id": uid,
        "plan": plan,
        "plan_expires_at": plan_expires_at,
        "free_daily_parses": 50,
        "free_max_trips": 3,
        "is_pro": plan != "free",
    }


@router.post("/telegram-pin")
async def generate_telegram_pin(
    uid: Annotated[str, Depends(user_id)],
):
    """Generate a 6-digit PIN valid 10 min to link Telegram account."""
    pin = str(secrets.randbelow(900000) + 100000)  # 100000-999999
    expires = datetime.now(timezone.utc) + timedelta(minutes=10)
    _pending_links[pin] = (uid, expires)
    return {"pin": pin, "expires_in_seconds": 600}


@router.post("/telegram-link")
async def confirm_telegram_link(
    pin: str,
    chat_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Called by the bot: validates PIN and stores chat_id. No JWT needed — bot uses service token."""
    entry = _pending_links.get(pin)
    if not entry:
        raise HTTPException(status_code=404, detail="PIN not found or expired")
    uid, expires = entry
    if datetime.now(timezone.utc) > expires:
        del _pending_links[pin]
        raise HTTPException(status_code=410, detail="PIN expired")
    del _pending_links[pin]
    await db.execute(
        text("UPDATE users SET telegram_chat_id = :cid WHERE id = :uid"),
        {"cid": chat_id, "uid": uid},
    )
    await db.commit()
    return {"ok": True, "uid": uid}


@router.get("/by-telegram/{chat_id}")
async def get_user_by_telegram(
    chat_id: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Bot-internal: get user's trips by telegram chat_id. Authenticated by bot token header."""
    from app.config import get_settings
    s = get_settings()
    bot_token = request.headers.get("X-Bot-Token", "")
    if not s.telegram_bot_token or bot_token != s.telegram_bot_token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    result = await db.execute(
        text("SELECT id, email, plan FROM users WHERE telegram_chat_id = :cid"),
        {"cid": chat_id},
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not linked")
    return {"id": row[0], "email": row[1], "plan": row[2]}
