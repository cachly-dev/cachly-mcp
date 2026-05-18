"""
Unit tests for the Ollama service layer.

Covers:
  parse_text    – valid JSON response, malformed JSON fallback, empty response
  parse_image   – base64 encoding, correct payload shape
  _safe_parse   – markdown fence stripping, JSON decode errors → fallback dict
  confidence    – low-confidence items still return a dict (never raise)

Run: pytest tests/test_ollama.py -v
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.ollama import _safe_parse, parse_image, parse_text

# ── _safe_parse (pure, synchronous) ──────────────────────────────────────────

def test_safe_parse_valid_json():
    raw = '{"type": "flight", "title": "LH 400", "confidence": 0.9}'
    result = _safe_parse(raw)
    assert result["type"] == "flight"
    assert result["confidence"] == 0.9


def test_safe_parse_strips_markdown_fences():
    raw = "```json\n{\"type\": \"hotel\", \"title\": \"Marriott\"}\n```"
    result = _safe_parse(raw)
    assert result["type"] == "hotel"


def test_safe_parse_strips_plain_fences():
    raw = "```\n{\"type\": \"train\"}\n```"
    assert _safe_parse(raw)["type"] == "train"


def test_safe_parse_malformed_returns_fallback():
    result = _safe_parse("this is not json at all")
    assert result["type"] == "other"
    assert result["confidence"] == 0.0
    assert "Unrecognized" in result["title"]


def test_safe_parse_empty_string_returns_fallback():
    result = _safe_parse("")
    assert result["type"] == "other"


def test_safe_parse_truncates_long_summary():
    long_text = "x" * 1000
    result = _safe_parse(long_text)
    assert len(result.get("raw_summary", "")) <= 300


# ── parse_text ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_parse_text_happy_path():
    expected = {"type": "flight", "title": "LH 400 FRA→JFK", "confidence": 0.9}
    mock_response = MagicMock()
    mock_response.json.return_value = {"response": json.dumps(expected)}

    with patch("httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_cls.return_value = mock_client

        result = await parse_text("Flight LH 400 from Frankfurt to New York")

    assert result["type"] == "flight"
    assert result["confidence"] == 0.9


@pytest.mark.asyncio
async def test_parse_text_ollama_returns_garbage():
    mock_response = MagicMock()
    mock_response.json.return_value = {"response": "I cannot parse this."}

    with patch("httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_cls.return_value = mock_client

        result = await parse_text("some text")

    assert result["type"] == "other"
    assert result["confidence"] == 0.0


@pytest.mark.asyncio
async def test_parse_text_ollama_empty_response():
    mock_response = MagicMock()
    mock_response.json.return_value = {}

    with patch("httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_cls.return_value = mock_client

        result = await parse_text("anything")

    assert isinstance(result, dict)


# ── parse_image ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_parse_image_sends_base64():
    payload_sent = {}
    expected = {"type": "hotel", "title": "Marriott Berlin", "confidence": 0.85}

    async def fake_post(url, json=None, **kwargs):
        payload_sent.update(json or {})
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"response": json_str(expected)}
        return mock_resp

    def json_str(d): return __import__("json").dumps(d)

    with patch("httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(side_effect=fake_post)
        mock_cls.return_value = mock_client

        result, raw = await parse_image(b"\xff\xd8\xff", "image/jpeg")

    assert "images" in payload_sent
    assert len(payload_sent["images"]) == 1
    assert isinstance(payload_sent["images"][0], str)
    assert result["type"] == "hotel"
