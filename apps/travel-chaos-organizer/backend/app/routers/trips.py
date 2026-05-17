from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.db.database import get_db
from app.models.schemas import TripCreate, TripOut, TripUpdate
from app.services import quota

router = APIRouter(prefix="/trips", tags=["trips"])


@router.get("", response_model=list[TripOut])
async def list_trips(
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        text("SELECT * FROM trips WHERE user_id = :uid ORDER BY start_date ASC, created_at DESC"),
        {"uid": uid},
    )
    return [dict(r._mapping) for r in result.fetchall()]


# NOTE: ILIKE is PostgreSQL-specific. In tests (SQLite) it falls back to LIKE (case-insensitive in SQLite).
@router.get("/search", response_model=list[TripOut])
async def search_trips(
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
    q: str = "",
):
    if not q.strip():
        return []
    pattern = f"%{q.strip()}%"
    result = await db.execute(
        text("""
            SELECT DISTINCT t.* FROM trips t
            LEFT JOIN trip_items ti ON ti.trip_id = t.id
            WHERE t.user_id = :uid
              AND (
                t.name ILIKE :p OR t.description ILIKE :p
                OR ti.title ILIKE :p OR ti.provider ILIKE :p
                OR ti.booking_ref ILIKE :p
              )
            ORDER BY t.start_date ASC, t.created_at DESC
        """),
        {"uid": uid, "p": pattern},
    )
    return [dict(r._mapping) for r in result.fetchall()]


@router.post("", response_model=TripOut, status_code=status.HTTP_201_CREATED)
async def create_trip(
    body: TripCreate,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await quota.check_trips(db, uid)
    result = await db.execute(
        text("""
            INSERT INTO trips (user_id, name, description, start_date, end_date)
            VALUES (:uid, :name, :desc, :start_date, :end_date)
            RETURNING *
        """),
        {"uid": uid, "name": body.name, "desc": body.description,
         "start_date": body.start_date, "end_date": body.end_date},
    )
    await db.commit()
    return dict(result.fetchone()._mapping)


@router.get("/{trip_id}", response_model=TripOut)
async def get_trip(
    trip_id: UUID,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        text("SELECT * FROM trips WHERE id = :id AND user_id = :uid"),
        {"id": str(trip_id), "uid": uid},
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Trip not found")
    return dict(row._mapping)


@router.patch("/{trip_id}", response_model=TripOut)
async def update_trip(
    trip_id: UUID,
    body: TripUpdate,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")

    set_clauses = ", ".join(f"{k} = :{k}" for k in updates)
    updates.update({"id": str(trip_id), "uid": uid})
    result = await db.execute(
        text(f"UPDATE trips SET {set_clauses}, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND user_id = :uid RETURNING *"),
        updates,
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Trip not found")
    await db.commit()
    return dict(row._mapping)


@router.delete("/{trip_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_trip(
    trip_id: UUID,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        text("DELETE FROM trips WHERE id = :id AND user_id = :uid"),
        {"id": str(trip_id), "uid": uid},
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Trip not found")
