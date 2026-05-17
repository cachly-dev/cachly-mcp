"""
Parse endpoint — accepts file upload or raw text, returns structured travel data.
Also handles Chaos Inbox ingestion.
"""
from typing import Annotated
from uuid import UUID
import aiofiles
import os
from pathlib import Path
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.config import get_settings
from app.db.database import get_db
from app.models.schemas import ParseResponse, ParsedTravelData
from app.services import ollama as ollama_svc
from app.services.parser import extract_text_from_pdf, is_image, is_pdf, is_text

router = APIRouter(prefix="/parse", tags=["parse"])
settings = get_settings()


async def _save_file(content: bytes, filename: str, uid: str) -> str:
    dest_dir = Path(settings.upload_dir) / uid
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    async with aiofiles.open(dest, "wb") as f:
        await f.write(content)
    return str(dest)


@router.post("/file", response_model=ParseResponse)
async def parse_file(
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
    file: UploadFile = File(...),
    trip_id: UUID | None = Form(None),
):
    content = await file.read()
    mime = file.content_type or "application/octet-stream"
    raw_text: str | None = None
    parsed_dict: dict = {}

    if is_pdf(mime):
        raw_text = extract_text_from_pdf(content)
        parsed_dict = await ollama_svc.parse_text(raw_text)
    elif is_image(mime):
        parsed_dict, raw_text = await ollama_svc.parse_image(content, mime)
    elif is_text(mime):
        raw_text = content.decode("utf-8", errors="replace")
        parsed_dict = await ollama_svc.parse_text(raw_text)
    else:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {mime}")

    file_path = await _save_file(content, file.filename or "upload", uid)
    parsed = ParsedTravelData(**{k: parsed_dict.get(k) for k in ParsedTravelData.model_fields})

    if trip_id:
        await _insert_item_from_parsed(uid, trip_id, parsed, raw_text, file_path, mime, file.filename, db)
    else:
        await _insert_inbox(uid, raw_text, parsed_dict, file_path, mime, file.filename, db)

    return ParseResponse(parsed=parsed, raw_text=raw_text, model_used=settings.ollama_model)


@router.post("/text", response_model=ParseResponse)
async def parse_text_endpoint(
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
    raw_text: str = Form(...),
    trip_id: UUID | None = Form(None),
):
    parsed_dict = await ollama_svc.parse_text(raw_text)
    parsed = ParsedTravelData(**{k: parsed_dict.get(k) for k in ParsedTravelData.model_fields})

    if trip_id:
        await _insert_item_from_parsed(uid, trip_id, parsed, raw_text, None, None, None, db)
    else:
        await _insert_inbox(uid, raw_text, parsed_dict, None, None, None, db)

    return ParseResponse(parsed=parsed, raw_text=raw_text, model_used=settings.ollama_model)


async def _insert_item_from_parsed(
    uid: str, trip_id: UUID, parsed: ParsedTravelData,
    raw_text: str | None, file_path: str | None,
    mime: str | None, filename: str | None,
    db: AsyncSession,
) -> None:
    import json
    result = await db.execute(
        text("""
            INSERT INTO trip_items
              (trip_id, user_id, type, title, raw_text, parsed_data,
               event_at, booking_ref, provider)
            VALUES (:trip_id, :uid, :type, :title, :raw_text, :pd::jsonb,
                    :event_at, :booking_ref, :provider)
            RETURNING id
        """),
        {
            "trip_id": trip_id, "uid": uid, "type": parsed.type, "title": parsed.title,
            "raw_text": raw_text, "pd": json.dumps(parsed.model_dump()),
            "event_at": parsed.event_at, "booking_ref": parsed.booking_ref, "provider": parsed.provider,
        },
    )
    item_id = result.fetchone()[0]

    if file_path:
        await db.execute(
            text("""
                INSERT INTO attachments (trip_item_id, user_id, file_path, file_name, mime_type)
                VALUES (:item_id, :uid, :fp, :fn, :mime)
            """),
            {"item_id": item_id, "uid": uid, "fp": file_path, "fn": filename, "mime": mime},
        )
    await db.commit()


async def _insert_inbox(
    uid: str, raw_text: str | None, parsed_dict: dict,
    file_path: str | None, mime: str | None, filename: str | None,
    db: AsyncSession,
) -> None:
    import json
    result = await db.execute(
        text("""
            INSERT INTO chaos_inbox (user_id, raw_content, parsed_data, source)
            VALUES (:uid, :raw, :pd::jsonb, :source)
            RETURNING id
        """),
        {"uid": uid, "raw": raw_text, "pd": json.dumps(parsed_dict), "source": filename or "text"},
    )
    inbox_id = result.fetchone()[0]

    if file_path:
        await db.execute(
            text("""
                INSERT INTO attachments (inbox_id, user_id, file_path, file_name, mime_type)
                VALUES (:inbox_id, :uid, :fp, :fn, :mime)
            """),
            {"inbox_id": inbox_id, "uid": uid, "fp": file_path, "fn": filename, "mime": mime},
        )
    await db.commit()
