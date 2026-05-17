from typing import Annotated
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.db.database import get_db
from app.services import telemetry

router = APIRouter(prefix="/events", tags=["events"])


class EventBody(BaseModel):
    event_name: str
    properties: dict | None = None
    platform: str | None = None
    app_version: str | None = None


@router.post("")
async def log_event(
    body: EventBody,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await telemetry.track(db, uid, body.event_name, body.properties, body.platform, body.app_version)
    return {"ok": True}
