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
    return {
        "events_total": event_count.scalar(),
        "waitlist_total": waitlist_count.scalar(),
    }
