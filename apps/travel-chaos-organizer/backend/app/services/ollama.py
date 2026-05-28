import base64
import json
import re
import httpx
from app.config import get_settings
from app.services.errors import ollama_unavailable, ollama_model_not_found
from app.services import cache as cache_svc

settings = get_settings()

PARSE_PROMPT = """You are a travel document parser. Extract structured travel information from the following content.

Return ONLY valid JSON matching this exact schema:
{
  "type": "flight|train|bus|hotel|rental_car|activity|transfer|document|other",
  "title": "short human-readable title",
  "booking_ref": "booking/confirmation number or null",
  "provider": "airline/hotel/company name or null",
  "event_at": "ISO 8601 datetime or null",
  "event_end_at": "ISO 8601 datetime or null",
  "origin": "departure city/airport or null",
  "destination": "arrival city/hotel address or null",
  "passengers": ["name1", "name2"] or null,
  "confirmation_number": "separate confirmation if different from booking_ref or null",
  "price": "total price with currency or null",
  "raw_summary": "one sentence summary of this travel item",
  "confidence": 0.0 to 1.0
}

Content to parse:
"""


async def parse_text(raw_text: str) -> tuple[dict, bool]:
    """Returns (parsed_dict, was_cached). Cachly cache hit skips Ollama entirely."""
    cached = await cache_svc.cache_get(raw_text)
    if cached is not None:
        return cached, True

    payload = {
        "model": settings.ollama_model,
        "prompt": PARSE_PROMPT + raw_text,
        "stream": False,
        "format": "json",
    }
    try:
        async with httpx.AsyncClient(timeout=settings.ollama_timeout) as client:
            resp = await client.post(f"{settings.ollama_url}/api/generate", json=payload)
            if resp.status_code == 404:
                raise ollama_model_not_found(settings.ollama_model)
            resp.raise_for_status()
            response_text = resp.json().get("response", "{}")
            result = _safe_parse(response_text)
            await cache_svc.cache_set(raw_text, result)
            return result, False
    except httpx.ConnectError:
        raise ollama_unavailable(settings.ollama_url)


async def parse_image(image_bytes: bytes, mime_type: str) -> tuple[dict, str, bool]:
    """Returns (parsed_dict, raw_text, was_cached)."""
    cached = await cache_svc.cache_get(image_bytes)
    if cached is not None:
        return cached, "", True

    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "model": settings.ollama_model,
        "prompt": PARSE_PROMPT + "Extract all visible travel information from this image.",
        "images": [b64],
        "stream": False,
        "format": "json",
    }
    try:
        async with httpx.AsyncClient(timeout=settings.ollama_timeout) as client:
            resp = await client.post(f"{settings.ollama_url}/api/generate", json=payload)
            if resp.status_code == 404:
                raise ollama_model_not_found(settings.ollama_model)
            resp.raise_for_status()
            response_text = resp.json().get("response", "{}")
            result = _safe_parse(response_text)
            await cache_svc.cache_set(image_bytes, result)
            # For images, Ollama returns structured JSON directly — there is no
            # separate OCR text output. Store the human-readable raw_summary
            # (from the parsed result) as raw_text instead of the JSON blob.
            return result, result.get("raw_summary") or None, False
    except httpx.ConnectError:
        raise ollama_unavailable(settings.ollama_url)


def _safe_parse(text: str) -> dict:
    try:
        cleaned = re.sub(r"```(?:json)?\s*|\s*```", "", text).strip()
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {
            "type": "other",
            "title": "Unrecognized document",
            "raw_summary": text[:300],
            "confidence": 0.0,
        }
