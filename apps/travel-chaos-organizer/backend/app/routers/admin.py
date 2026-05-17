"""
Admin endpoints — Basic Auth protected, no JWT required.
Mount at /admin (no /api/v1 prefix).
"""
import os
import secrets
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.db.database import get_db
from app.config import get_settings

router = APIRouter(prefix="/admin", tags=["admin"])
security = HTTPBasic()


def _check_auth(credentials: Annotated[HTTPBasicCredentials, Depends(security)]) -> None:
    s = get_settings()
    ok_user = secrets.compare_digest(credentials.username.encode(), s.admin_user.encode())
    ok_pass = secrets.compare_digest(credentials.password.encode(), s.admin_password.encode())
    if not (ok_user and ok_pass):
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Basic"})


@router.get("/events/summary", dependencies=[Depends(_check_auth)])
async def events_summary(db: Annotated[AsyncSession, Depends(get_db)]):
    rows = await db.execute(text("""
        SELECT event_name, COUNT(*) as count,
               MAX(created_at) as last_seen
        FROM events
        GROUP BY event_name
        ORDER BY count DESC
        LIMIT 50
    """))
    return {"events": [dict(r._mapping) for r in rows.fetchall()]}


@router.get("/events/recent", dependencies=[Depends(_check_auth)])
async def events_recent(db: Annotated[AsyncSession, Depends(get_db)], limit: int = 50):
    rows = await db.execute(text("""
        SELECT id, user_id, event_name, properties, platform, app_version, created_at
        FROM events ORDER BY created_at DESC LIMIT :limit
    """), {"limit": min(limit, 200)})
    return {"events": [dict(r._mapping) for r in rows.fetchall()]}


@router.get("/waitlist", dependencies=[Depends(_check_auth)])
async def waitlist(db: Annotated[AsyncSession, Depends(get_db)]):
    rows = await db.execute(text(
        "SELECT id, email, source, created_at FROM waitlist ORDER BY created_at DESC"
    ))
    return {"signups": [dict(r._mapping) for r in rows.fetchall()]}


@router.get("/health", dependencies=[Depends(_check_auth)])
async def admin_health(db: Annotated[AsyncSession, Depends(get_db)]):
    event_count = await db.execute(text("SELECT COUNT(*) FROM events"))
    waitlist_count = await db.execute(text("SELECT COUNT(*) FROM waitlist"))
    user_count = await db.execute(text("SELECT COUNT(*) FROM users"))
    from datetime import datetime, timezone
    pro_count = await db.execute(
        text("SELECT COUNT(*) FROM users WHERE plan != 'free' AND (plan_expires_at IS NULL OR plan_expires_at > :now)"),
        {"now": datetime.now(timezone.utc)},
    )
    return {
        "events_total": event_count.scalar(),
        "waitlist_total": waitlist_count.scalar(),
        "users_total": user_count.scalar(),
        "pro_users": pro_count.scalar(),
    }


@router.get("/users", dependencies=[Depends(_check_auth)])
async def list_users(db: Annotated[AsyncSession, Depends(get_db)], limit: int = 100):
    rows = await db.execute(text("""
        SELECT u.id, u.email, u.plan, u.plan_expires_at, u.created_at,
               COUNT(e.id) AS event_count
        FROM users u
        LEFT JOIN events e ON e.user_id = u.id
        GROUP BY u.id, u.email, u.plan, u.plan_expires_at, u.created_at
        ORDER BY u.created_at DESC
        LIMIT :limit
    """), {"limit": min(limit, 500)})
    return {"users": [dict(r._mapping) for r in rows.fetchall()]}


@router.patch("/users/{uid}/plan", dependencies=[Depends(_check_auth)])
async def set_user_plan(
    uid: str,
    plan: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    expires_days: int | None = None,
):
    if plan not in ("free", "pro"):
        raise HTTPException(status_code=400, detail="plan must be 'free' or 'pro'")
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(days=expires_days)) if expires_days else None
    await db.execute(
        text("""
            INSERT INTO users (id, plan, plan_expires_at, updated_at)
            VALUES (:uid, :plan, :expires_at, :now)
            ON CONFLICT (id) DO UPDATE
              SET plan = EXCLUDED.plan,
                  plan_expires_at = EXCLUDED.plan_expires_at,
                  updated_at = EXCLUDED.updated_at
        """),
        {"uid": uid, "plan": plan, "expires_at": expires_at, "now": now},
    )
    await db.commit()
    return {"ok": True, "uid": uid, "plan": plan}
