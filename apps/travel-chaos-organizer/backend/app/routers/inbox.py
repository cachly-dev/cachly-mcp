from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.db.database import get_db
from app.models.schemas import InboxItemOut, InboxAssign

router = APIRouter(prefix="/inbox", tags=["inbox"])


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
    return [dict(r._mapping) for r in result.fetchall()]


@router.post("/{inbox_id}/assign", response_model=dict)
async def assign_to_trip(
    inbox_id: UUID,
    body: InboxAssign,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    row = await db.execute(
        text("SELECT * FROM chaos_inbox WHERE id = :id AND user_id = :uid"),
        {"id": inbox_id, "uid": uid},
    )
    inbox_item = row.fetchone()
    if not inbox_item:
        raise HTTPException(status_code=404, detail="Inbox item not found")

    item = dict(inbox_item._mapping)
    import json
    parsed = item.get("parsed_data") or {}
    title = parsed.get("title", "Imported item") if isinstance(parsed, dict) else "Imported item"

    result = await db.execute(
        text("""
            INSERT INTO trip_items (trip_id, user_id, type, title, raw_text, parsed_data)
            VALUES (:trip_id, :uid, :type, :title, :raw, :pd::jsonb)
            RETURNING id
        """),
        {
            "trip_id": body.trip_id, "uid": uid, "type": body.type, "title": title,
            "raw": item.get("raw_content"), "pd": json.dumps(parsed),
        },
    )
    trip_item_id = result.fetchone()[0]

    await db.execute(
        text("UPDATE chaos_inbox SET status = 'assigned', updated_at = now() WHERE id = :id"),
        {"id": inbox_id},
    )
    await db.execute(
        text("UPDATE attachments SET trip_item_id = :tid, inbox_id = NULL WHERE inbox_id = :iid"),
        {"tid": trip_item_id, "iid": inbox_id},
    )
    await db.commit()
    return {"trip_item_id": str(trip_item_id)}


@router.delete("/{inbox_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reject_inbox_item(
    inbox_id: UUID,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        text("UPDATE chaos_inbox SET status = 'rejected', updated_at = now() WHERE id = :id AND user_id = :uid"),
        {"id": inbox_id, "uid": uid},
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Inbox item not found")
