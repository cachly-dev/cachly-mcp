import json
from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.db.database import get_db
from app.limiter import limiter
from app.models.schemas import TripItemCreate, TripItemOut, TripItemUpdate

router = APIRouter(prefix="/trips/{trip_id}/items", tags=["items"])


async def _assert_trip_owner(trip_id: str, uid: str, db: AsyncSession) -> None:
    result = await db.execute(
        text("SELECT id FROM trips WHERE id = :id AND user_id = :uid"),
        {"id": trip_id, "uid": uid},
    )
    if not result.fetchone():
        raise HTTPException(status_code=404, detail="Trip not found")


def _parse_item_row(row: dict) -> dict:
    """Deserialize parsed_data from JSON string (SQLite) or dict (PostgreSQL)."""
    if isinstance(row.get("parsed_data"), str):
        try:
            row["parsed_data"] = json.loads(row["parsed_data"])
        except (json.JSONDecodeError, TypeError):
            row["parsed_data"] = None
    return row


@router.get("", response_model=list[TripItemOut])
async def list_items(
    trip_id: UUID,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    tid = str(trip_id)
    await _assert_trip_owner(tid, uid, db)
    result = await db.execute(
        text("SELECT * FROM trip_items WHERE trip_id = :tid ORDER BY event_at ASC"),
        {"tid": tid},
    )
    return [_parse_item_row(dict(r._mapping)) for r in result.fetchall()]


@limiter.limit("30/minute")
@router.post("", response_model=TripItemOut, status_code=status.HTTP_201_CREATED)
async def create_item(
    request: Request,
    trip_id: UUID,
    body: TripItemCreate,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    tid = str(trip_id)
    await _assert_trip_owner(tid, uid, db)
    pd_json = json.dumps(body.parsed_data) if body.parsed_data else None
    result = await db.execute(
        text("""
            INSERT INTO trip_items
              (trip_id, user_id, type, title, raw_text, parsed_data,
               event_at, event_end_at, booking_ref, provider)
            VALUES
              (:trip_id, :uid, :type, :title, :raw_text, :parsed_data,
               :event_at, :event_end_at, :booking_ref, :provider)
            RETURNING *
        """),
        {
            "trip_id": tid, "uid": uid, "type": body.type, "title": body.title,
            "raw_text": body.raw_text, "parsed_data": pd_json,
            "event_at": body.event_at, "event_end_at": body.event_end_at,
            "booking_ref": body.booking_ref, "provider": body.provider,
        },
    )
    await db.commit()
    return _parse_item_row(dict(result.fetchone()._mapping))


@limiter.limit("30/minute")
@router.patch("/{item_id}", response_model=TripItemOut)
async def update_item(
    request: Request,
    trip_id: UUID,
    item_id: UUID,
    body: TripItemUpdate,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    tid, iid = str(trip_id), str(item_id)
    await _assert_trip_owner(tid, uid, db)
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if "parsed_data" in updates:
        updates["parsed_data"] = json.dumps(updates["parsed_data"])

    set_clauses = ", ".join(f"{k} = :{k}" for k in updates)
    updates.update({"item_id": iid, "trip_id": tid})
    result = await db.execute(
        text(f"UPDATE trip_items SET {set_clauses}, updated_at = CURRENT_TIMESTAMP WHERE id = :item_id AND trip_id = :trip_id RETURNING *"),
        updates,
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Item not found")
    await db.commit()
    return _parse_item_row(dict(row._mapping))


@limiter.limit("30/minute")
@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(
    request: Request,
    trip_id: UUID,
    item_id: UUID,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    tid, iid = str(trip_id), str(item_id)
    await _assert_trip_owner(tid, uid, db)
    result = await db.execute(
        text("DELETE FROM trip_items WHERE id = :item_id AND trip_id = :trip_id"),
        {"item_id": iid, "trip_id": tid},
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Item not found")
