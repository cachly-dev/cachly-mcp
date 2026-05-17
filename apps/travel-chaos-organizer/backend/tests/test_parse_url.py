"""
Tests for POST /parse/url endpoint.
httpx is mocked — no real network calls.
"""
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock


FAKE_HTML = """
<html><head><title>Booking Confirmation</title></head>
<body>
<h1>Booking Confirmed</h1>
<p>Flight LH 400 Frankfurt to New York</p>
<p>Booking Reference: XYZ789</p>
<p>Date: 2025-08-15</p>
</body></html>
"""


@pytest.fixture
def mock_ollama_parse():
    with patch("app.services.ollama.parse_text", new_callable=AsyncMock) as m:
        m.return_value = {
            "type": "flight",
            "title": "LH 400 Frankfurt → New York",
            "booking_ref": "XYZ789",
            "provider": "Lufthansa",
            "event_at": "2025-08-15T10:30:00",
            "confidence": 0.88,
        }
        yield m


@pytest.fixture
def mock_http_response():
    mock_resp = MagicMock()
    mock_resp.headers = {"content-type": "text/html; charset=utf-8"}
    mock_resp.text = FAKE_HTML
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


@pytest.mark.asyncio
async def test_parse_url_to_inbox(client, mock_ollama_parse, mock_http_response):
    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client_instance = AsyncMock()
        mock_client_instance.get = AsyncMock(return_value=mock_http_response)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        resp = await client.post("/api/v1/parse/url", json={"url": "https://example.com/booking"})

    assert resp.status_code == 200
    data = resp.json()
    assert data["parsed"]["type"] == "flight"
    assert data["parsed"]["booking_ref"] == "XYZ789"


@pytest.mark.asyncio
async def test_parse_url_to_trip(client, mock_ollama_parse, mock_http_response):
    # Create a trip first
    trip_resp = await client.post("/api/v1/trips", json={"name": "Test Trip"})
    assert trip_resp.status_code == 201
    trip_id = trip_resp.json()["id"]

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client_instance = AsyncMock()
        mock_client_instance.get = AsyncMock(return_value=mock_http_response)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        resp = await client.post(
            "/api/v1/parse/url",
            json={"url": "https://example.com/booking", "trip_id": trip_id},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["parsed"]["type"] == "flight"


@pytest.mark.asyncio
async def test_parse_url_unreachable_returns_422(client):
    import httpx
    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client_instance = AsyncMock()
        mock_client_instance.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        resp = await client.post("/api/v1/parse/url", json={"url": "https://unreachable.invalid"})

    assert resp.status_code == 422
    assert "Could not fetch URL" in resp.json()["detail"]
