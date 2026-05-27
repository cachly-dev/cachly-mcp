from typing import Annotated
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.db.database import get_db
from app.services import telemetry
from app.limiter import limiter

router = APIRouter(prefix="/events", tags=["events"])


class EventBody(BaseModel):
    event_name: str
    properties: dict | None = None
    platform: str | None = None
    app_version: str | None = None


@limiter.limit("30/minute")
@router.post("")
async def log_event(
    request: Request,
    body: EventBody,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await telemetry.track(db, uid, body.event_name, body.properties, body.platform, body.app_version)
    return {"ok": True}
