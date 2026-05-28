"""
Mail import endpoint — paste raw email text or forward as plain text.
Gmail / Outlook share-to-app flows send the body as plain text;
we strip headers and run it through the same Ollama parsing pipeline.
Results are Cachly-cached by content hash when CACHLY_REDIS_URL is configured.
"""
import json
import re
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.keycloak import user_id
from app.config import get_settings
from app.db.database import get_db
from app.models.schemas import ParseResponse, ParsedTravelData
from app.services import ollama as ollama_svc

router = APIRouter(prefix="/mail", tags=["mail"])
settings = get_settings()

_HEADER_RE = re.compile(
    r"^(From|To|Cc|Bcc|Subject|Date|Message-ID|MIME-Version|Content-Type"
    r"|Content-Transfer-Encoding|Delivered-To|Received|Return-Path|X-[^:]+)"
    r":\s.*$",
    re.MULTILINE | re.IGNORECASE,
)
_BLANK_LINES_RE = re.compile(r"\n{3,}")


def _safe_dt(val: str | None) -> str | None:
    """Sanitise an Ollama-produced datetime string to strict ISO-8601 so that
    asyncpg can cast it to TIMESTAMPTZ without raising a DataError."""
    if val is None:
        return None
    try:
        dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).isoformat()
    except (ValueError, AttributeError):
        return None


def _build_parsed(parsed_dict: dict) -> ParsedTravelData:
    """Build a ParsedTravelData, falling back to type='other' on ValidationError."""
    try:
        return ParsedTravelData(**{k: parsed_dict.get(k) for k in ParsedTravelData.model_fields})
    except ValidationError:
        safe = {k: parsed_dict.get(k) for k in ParsedTravelData.model_fields}
        safe["type"] = "other"
        return ParsedTravelData(**safe)


def strip_email_headers(raw: str) -> str:
    cleaned = _HEADER_RE.sub("", raw)
    cleaned = _BLANK_LINES_RE.sub("\n\n", cleaned)
    return cleaned.strip()


@router.post("/import", response_model=ParseResponse)
async def import_mail(
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
    raw_email: str = Body(..., media_type="text/plain", description="Raw email body (paste or share)"),
    trip_id: UUID | None = Query(None, description="Assign directly to this trip (optional)"),
):
    body_text = strip_email_headers(raw_email)
    parsed_dict, _was_cached = await ollama_svc.parse_text(body_text)
    parsed = _build_parsed(parsed_dict)

    if trip_id:
        await db.execute(
            text("""
                INSERT INTO trip_items
                  (trip_id, user_id, type, title, raw_text, parsed_data,
                   event_at, event_end_at, booking_ref, provider)
                VALUES (:trip_id, :uid, :type, :title, :raw, :pd,
                        :event_at, :event_end_at, :booking_ref, :provider)
            """),
            {
                "trip_id": str(trip_id), "uid": uid, "type": parsed.type, "title": parsed.title,
                "raw": body_text, "pd": json.dumps(parsed.model_dump()),
                "event_at": _safe_dt(parsed.event_at),
                "event_end_at": _safe_dt(parsed.event_end_at),
                "booking_ref": parsed.booking_ref, "provider": parsed.provider,
            },
        )
    else:
        await db.execute(
            text("""
                INSERT INTO chaos_inbox (user_id, raw_content, parsed_data, source)
                VALUES (:uid, :raw, :pd, 'mail')
            """),
            {"uid": uid, "raw": body_text, "pd": json.dumps(parsed.model_dump())},
        )
    await db.commit()

    return ParseResponse(parsed=parsed, raw_text=body_text, model_used=settings.ollama_model)
