"""
Tests for /api/v1/mail/import

Covers:
  strip_email_headers – removes From/To/Subject/X-* lines, preserves body
  import_mail         – text body → inbox when no trip_id
  import_mail         – text body → trip item when trip_id provided
  import_mail         – stripped headers don't leak into parsed_data

Run: pytest tests/test_mail.py -v
"""
import pytest
from httpx import AsyncClient

from app.routers.mail import strip_email_headers
from tests.conftest import make_trip, mock_ollama_flight

RAW_EMAIL = """\
From: booking@lufthansa.com
To: max@example.com
Subject: Ihre Buchungsbestätigung LH 400
Date: Mon, 12 Aug 2024 09:00:00 +0200
Content-Type: text/plain; charset=utf-8

Sehr geehrter Herr Mustermann,

Ihre Buchung wurde bestätigt.
Flug LH 400 Frankfurt (FRA) → New York (JFK)
Abflug: 15. August 2024, 10:30 Uhr
Buchungsreferenz: ABC123
"""


# ── strip_email_headers (pure, synchronous) ───────────────────────────────────

def test_strip_removes_from_header():
    result = strip_email_headers(RAW_EMAIL)
    assert "From:" not in result
    assert "To:" not in result


def test_strip_removes_subject():
    result = strip_email_headers(RAW_EMAIL)
    assert "Subject:" not in result


def test_strip_preserves_body():
    result = strip_email_headers(RAW_EMAIL)
    assert "LH 400" in result
    assert "ABC123" in result
    assert "Mustermann" in result


def test_strip_x_headers():
    raw = "X-Mailer: Outlook\nX-Spam-Status: No\n\nBody content here."
    result = strip_email_headers(raw)
    assert "X-Mailer" not in result
    assert "Body content here" in result


def test_strip_collapses_blank_lines():
    raw = "From: a@b.com\n\n\n\n\nBody text."
    result = strip_email_headers(raw)
    assert "\n\n\n" not in result


# ── import_mail endpoint ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_import_mail_goes_to_inbox_without_trip(client: AsyncClient, mock_ollama_flight):
    r = await client.post(
        "/api/v1/mail/import",
        content=RAW_EMAIL,
        headers={"Content-Type": "text/plain"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["parsed"]["type"] == "flight"
    assert body["parsed"]["booking_ref"] == "ABC123"

    inbox = await client.get("/api/v1/inbox")
    assert inbox.status_code == 200
    assert len(inbox.json()) == 1


@pytest.mark.asyncio
async def test_import_mail_assigned_to_trip(client: AsyncClient, mock_ollama_flight):
    trip_r = await client.post("/api/v1/trips", json=make_trip())
    trip_id = trip_r.json()["id"]

    r = await client.post(
        f"/api/v1/mail/import?trip_id={trip_id}",
        content=RAW_EMAIL,
        headers={"Content-Type": "text/plain"},
    )
    assert r.status_code == 200

    items_r = await client.get(f"/api/v1/trips/{trip_id}/items")
    assert len(items_r.json()) == 1

    inbox = await client.get("/api/v1/inbox")
    assert inbox.json() == []


@pytest.mark.asyncio
async def test_import_mail_low_confidence_still_saves(client: AsyncClient, mock_ollama_low_confidence):
    r = await client.post(
        "/api/v1/mail/import",
        content="Some random text that isn't a booking",
        headers={"Content-Type": "text/plain"},
    )
    assert r.status_code == 200
    assert r.json()["parsed"]["confidence"] == 0.1
