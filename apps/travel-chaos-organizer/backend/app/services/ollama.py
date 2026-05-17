import base64
import json
import re
import httpx
from app.config import get_settings

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


async def parse_text(raw_text: str) -> dict:
    payload = {
        "model": settings.ollama_model,
        "prompt": PARSE_PROMPT + raw_text,
        "stream": False,
        "format": "json",
    }
    async with httpx.AsyncClient(timeout=settings.ollama_timeout) as client:
        resp = await client.post(f"{settings.ollama_url}/api/generate", json=payload)
        resp.raise_for_status()
        response_text = resp.json().get("response", "{}")
        return _safe_parse(response_text)


async def parse_image(image_bytes: bytes, mime_type: str) -> tuple[dict, str]:
    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "model": settings.ollama_model,
        "prompt": PARSE_PROMPT + "Extract all visible travel information from this image.",
        "images": [b64],
        "stream": False,
        "format": "json",
    }
    async with httpx.AsyncClient(timeout=settings.ollama_timeout) as client:
        resp = await client.post(f"{settings.ollama_url}/api/generate", json=payload)
        resp.raise_for_status()
        data = resp.json()
        response_text = data.get("response", "{}")
        # also return the OCR'd text if Ollama provides context
        return _safe_parse(response_text), response_text


def _safe_parse(text: str) -> dict:
    try:
        # strip markdown code fences if present
        cleaned = re.sub(r"```(?:json)?\s*|\s*```", "", text).strip()
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {
            "type": "other",
            "title": "Unrecognized document",
            "raw_summary": text[:300],
            "confidence": 0.0,
        }
