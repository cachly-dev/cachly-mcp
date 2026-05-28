import json
from datetime import datetime
from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.db.database import get_db
from app.models.schemas import InboxItemOut, InboxAssign


def _safe_dt(val: str | None) -> datetime | None:
    """Convert an ISO 8601 string to datetime, returning None on failure."""
    if not val or not isinstance(val, str):
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00"))
    except ValueError:
        return None

router = APIRouter(prefix="/inbox", tags=["inbox"])


def _parse_inbox_row(row: dict) -> dict:
    if isinstance(row.get("parsed_data"), str):
        try:
            row["parsed_data"] = json.loads(row["parsed_data"])
        except (json.JSONDecodeError, TypeError):
            row["parsed_data"] = None
    return row


@router.get("", response_model=list[InboxItemOut])
async def list_inbox(
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
    status_filter: str = "pending",
):
    result = await db.execute(
        text("SELECT * FROM chaos_inbox WHERE user_id = :uid AND status = :status ORDER BY created_at DESC"),
        {"uid": uid, "status": status_filter},
    )
    return [_parse_inbox_row(dict(r._mapping)) for r in result.fetchall()]


@router.post("/{inbox_id}/assign", response_model=dict)
async def assign_to_trip(
    inbox_id: UUID,
    body: InboxAssign,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    iid = str(inbox_id)
    row = await db.execute(
        text("SELECT * FROM chaos_inbox WHERE id = :id AND user_id = :uid"),
        {"id": iid, "uid": uid},
    )
    inbox_item = row.fetchone()
    if not inbox_item:
        raise HTTPException(status_code=404, detail="Inbox item not found")

    # Verify the target trip belongs to this user (prevents assigning to other users' trips)
    trip_check = await db.execute(
        text("SELECT id FROM trips WHERE id = :tid AND user_id = :uid"),
        {"tid": str(body.trip_id), "uid": uid},
    )
    if not trip_check.fetchone():
        raise HTTPException(status_code=403, detail="Trip not found or access denied")

    item = dict(inbox_item._mapping)
    raw_pd = item.get("parsed_data") or {}
    parsed = json.loads(raw_pd) if isinstance(raw_pd, str) else raw_pd
    title = parsed.get("title", "Imported item") if isinstance(parsed, dict) else "Imported item"

    result = await db.execute(
        text("""
            INSERT INTO trip_items (trip_id, user_id, type, title, raw_text, parsed_data,
                                    event_at, event_end_at, booking_ref, provider)
            VALUES (:trip_id, :uid, :type, :title, :raw, :pd,
                    :event_at, :event_end_at, :booking_ref, :provider)
            RETURNING id, title, event_at
        """),
        {
            "trip_id": str(body.trip_id), "uid": uid, "type": body.type, "title": title,
            "raw": item.get("raw_content"), "pd": json.dumps(parsed),
            "event_at": _safe_dt(parsed.get("event_at") if isinstance(parsed, dict) else None),
            "event_end_at": _safe_dt(parsed.get("event_end_at") if isinstance(parsed, dict) else None),
            "booking_ref": parsed.get("booking_ref") if isinstance(parsed, dict) else None,
            "provider": parsed.get("provider") if isinstance(parsed, dict) else None,
        },
    )
    row = result.fetchone()
    trip_item_id = row[0]
    item_title = row[1]
    event_at = row[2].isoformat() if row[2] else None

    await db.execute(
        text("UPDATE chaos_inbox SET status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = :id"),
        {"id": iid},
    )
    await db.execute(
        text("UPDATE attachments SET trip_item_id = :tid, inbox_id = NULL WHERE inbox_id = :iid"),
        {"tid": trip_item_id, "iid": iid},
    )
    await db.commit()
    return {"trip_item_id": str(trip_item_id), "title": item_title, "event_at": event_at}


@router.delete("/{inbox_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reject_inbox_item(
    inbox_id: UUID,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        text("UPDATE chaos_inbox SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = :id AND user_id = :uid"),
        {"id": str(inbox_id), "uid": uid},
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Inbox item not found")
