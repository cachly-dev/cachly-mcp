"""
Fire-and-forget event tracking.
Never raises — telemetry must never break the request.
"""
import json
from typing import Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text


async def track(
    db: AsyncSession,
    user_id: str | None,
    event_name: str,
    properties: dict[str, Any] | None = None,
    platform: str | None = None,
    app_version: str | None = None,
) -> None:
    try:
        await db.execute(
            text("""
                INSERT INTO events (user_id, event_name, properties, platform, app_version)
                VALUES (:uid, :name, :props, :platform, :version)
            """),
            {
                "uid": user_id,
                "name": event_name,
                "props": json.dumps(properties or {}),
                "platform": platform,
                "version": app_version,
            },
        )
        await db.commit()
    except Exception:
        pass
