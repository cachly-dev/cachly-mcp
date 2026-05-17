"""
Parse endpoint — accepts file upload, raw text, or a public URL.
Returns structured travel data via Ollama AI.
Results are deduplicated via Cachly Redis when CACHLY_REDIS_URL is configured.
"""
from typing import Annotated
from uuid import UUID
import aiofiles
import os
from pathlib import Path
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth.keycloak import user_id
from app.config import get_settings
from app.db.database import get_db
from app.models.schemas import ParseResponse, ParsedTravelData
from app.services import ollama as ollama_svc
from app.services.parser import extract_text_from_pdf, is_image, is_pdf, is_text
from app.services.cache import cachly_configured

router = APIRouter(prefix="/parse", tags=["parse"])
settings = get_settings()

# ── helpers ────────────────────────────────────────────────────────────────────

async def _save_file(content: bytes, filename: str, uid: str) -> str:
    dest_dir = Path(settings.upload_dir) / uid
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    async with aiofiles.open(dest, "wb") as f:
        await f.write(content)
    return str(dest)


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
            VALUES (:trip_id, :uid, :type, :title, :raw_text, :pd,
                    :event_at, :booking_ref, :provider)
            RETURNING id
        """),
        {
            "trip_id": str(trip_id), "uid": uid, "type": parsed.type, "title": parsed.title,
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
) -> dict:
    import json
    result = await db.execute(
        text("""
            INSERT INTO chaos_inbox (user_id, raw_content, parsed_data, source)
            VALUES (:uid, :raw, :pd, :source)
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
    return {"inbox_id": str(inbox_id)}

# ── endpoints ──────────────────────────────────────────────────────────────────

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


class ParseUrlRequest(BaseModel):
    url: str
    trip_id: UUID | None = None


@router.post("/url")
async def parse_url(
    body: ParseUrlRequest,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """
    Fetch a public URL and parse its content with Ollama.
    Useful for online booking confirmation pages.
    Cached in Cachly Redis when CACHLY_REDIS_URL is configured.
    """
    import httpx as _httpx
    from html.parser import HTMLParser

    class _TextExtractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self._parts: list[str] = []
            self._skip = False
        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style", "nav", "footer"):
                self._skip = True
        def handle_endtag(self, tag):
            if tag in ("script", "style", "nav", "footer"):
                self._skip = False
        def handle_data(self, data):
            if not self._skip and data.strip():
                self._parts.append(data.strip())
        def text(self) -> str:
            return " ".join(self._parts)[:8000]

    try:
        async with _httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(body.url, headers={"User-Agent": "Mozilla/5.0 TCO/0.1"})
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not fetch URL: {e}")

    ct = resp.headers.get("content-type", "")
    if "html" in ct:
        extractor = _TextExtractor()
        extractor.feed(resp.text)
        raw_text = extractor.text()
    elif "pdf" in ct:
        raw_text = extract_text_from_pdf(resp.content)
    else:
        raw_text = resp.text[:8000]

    parsed_dict = await ollama_svc.parse_text(raw_text)
    parsed = ParsedTravelData(**{k: parsed_dict.get(k) for k in ParsedTravelData.model_fields})

    if body.trip_id:
        await _insert_item_from_parsed(uid, body.trip_id, parsed, raw_text, None, None, body.url, db)
        return ParseResponse(parsed=parsed, raw_text=raw_text, model_used=settings.ollama_model)
    else:
        result = await _insert_inbox(uid, raw_text, parsed_dict, None, None, body.url, db)
        return {**ParseResponse(parsed=parsed, raw_text=raw_text, model_used=settings.ollama_model).model_dump(), **result}
