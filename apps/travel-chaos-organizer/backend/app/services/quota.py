"""
Freemium quota enforcement.

Plans:
  free  — 50 AI parses / day, 3 active trips
  pro   — unlimited parses, unlimited trips

Usage:
    await quota.check_parse(db, uid)   # raises HTTP 429 if over limit
    await quota.check_trips(db, uid)   # raises HTTP 402 if over limit
    await quota.get_plan(db, uid)      # returns "free" | "pro"
"""
from datetime import datetime, timedelta, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from fastapi import HTTPException

FREE_DAILY_PARSES = 50
FREE_MAX_TRIPS = 3


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def get_plan(db: AsyncSession, uid: str) -> str:
    row = await db.execute(
        text("""
            SELECT plan FROM users
            WHERE id = :uid
              AND (plan_expires_at IS NULL OR plan_expires_at > :now)
        """),
        {"uid": uid, "now": _now()},
    )
    r = row.fetchone()
    return r[0] if r else "free"


async def _ensure_user(db: AsyncSession, uid: str) -> None:
    await db.execute(
        text("INSERT INTO users (id) VALUES (:uid) ON CONFLICT (id) DO NOTHING"),
        {"uid": uid},
    )


async def check_parse(db: AsyncSession, uid: str) -> None:
    await _ensure_user(db, uid)
    plan = await get_plan(db, uid)
    if plan != "free":
        return

    cutoff = _now() - timedelta(days=1)
    row = await db.execute(
        text("""
            SELECT COUNT(*) FROM events
            WHERE user_id = :uid
              AND event_name IN ('parse_file', 'parse_text', 'parse_url')
              AND created_at >= :cutoff
        """),
        {"uid": uid, "cutoff": cutoff},
    )
    count = row.scalar() or 0
    if count >= FREE_DAILY_PARSES:
        raise HTTPException(
            status_code=429,
            detail=f"Free plan: {FREE_DAILY_PARSES} AI parses per day. Upgrade to Pro for unlimited access.",
        )


async def check_trips(db: AsyncSession, uid: str) -> None:
    await _ensure_user(db, uid)
    plan = await get_plan(db, uid)
    if plan != "free":
        return

    row = await db.execute(
        text("SELECT COUNT(*) FROM trips WHERE user_id = :uid"),
        {"uid": uid},
    )
    count = row.scalar() or 0
    if count >= FREE_MAX_TRIPS:
        raise HTTPException(
            status_code=402,
            detail=f"Free plan: max {FREE_MAX_TRIPS} trips. Upgrade to Pro for unlimited trips.",
        )
