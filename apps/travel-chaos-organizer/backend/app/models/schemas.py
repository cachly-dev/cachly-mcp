from __future__ import annotations
from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID
from pydantic import BaseModel, Field


ItemType = Literal[
    "flight", "train", "bus", "hotel", "rental_car",
    "activity", "transfer", "document", "other"
]

InboxStatus = Literal["pending", "processed", "rejected", "assigned"]


# ── Trips ──────────────────────────────────────────────────────────────────

class TripCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    start_date: date | None = None
    end_date: date | None = None


class TripUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None
    start_date: date | None = None
    end_date: date | None = None


class TripOut(BaseModel):
    id: UUID
    user_id: str
    name: str
    description: str | None
    start_date: date | None
    end_date: date | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Trip Items ─────────────────────────────────────────────────────────────

class TripItemCreate(BaseModel):
    type: ItemType = "other"
    title: str = Field(..., min_length=1, max_length=300)
    raw_text: str | None = None
    parsed_data: dict[str, Any] | None = None
    event_at: datetime | None = None
    event_end_at: datetime | None = None
    booking_ref: str | None = None
    provider: str | None = None


class TripItemUpdate(BaseModel):
    type: ItemType | None = None
    title: str | None = Field(None, min_length=1, max_length=300)
    raw_text: str | None = None
    parsed_data: dict[str, Any] | None = None
    event_at: datetime | None = None
    event_end_at: datetime | None = None
    booking_ref: str | None = None
    provider: str | None = None


class TripItemOut(BaseModel):
    id: UUID
    trip_id: UUID
    user_id: str
    type: str
    title: str
    raw_text: str | None
    parsed_data: dict[str, Any] | None
    event_at: datetime | None
    event_end_at: datetime | None
    booking_ref: str | None
    provider: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Attachments ────────────────────────────────────────────────────────────

class AttachmentOut(BaseModel):
    id: UUID
    trip_item_id: UUID | None
    inbox_id: UUID | None
    file_name: str
    mime_type: str
    size_bytes: int | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Chaos Inbox ────────────────────────────────────────────────────────────

class InboxItemOut(BaseModel):
    id: UUID
    user_id: str
    raw_content: str | None
    source: str | None
    status: str
    parsed_data: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class InboxAssign(BaseModel):
    trip_id: UUID
    type: ItemType = "other"


# ── Parsing ────────────────────────────────────────────────────────────────

class ParsedTravelData(BaseModel):
    type: ItemType = "other"
    title: str = "Unnamed Item"
    booking_ref: str | None = None
    provider: str | None = None
    event_at: str | None = None
    event_end_at: str | None = None
    origin: str | None = None
    destination: str | None = None
    passengers: list[str] | None = None
    confirmation_number: str | None = None
    price: str | None = None
    raw_summary: str | None = None
    confidence: float = 0.0


class ParseResponse(BaseModel):
    parsed: ParsedTravelData
    raw_text: str | None = None
    model_used: str
