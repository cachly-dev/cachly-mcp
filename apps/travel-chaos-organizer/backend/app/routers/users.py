"""
User profile endpoint — returns current user's plan info and upserts user row.
"""
from typing import Annotated
from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.auth.keycloak import user_id
from app.db.database import get_db

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
