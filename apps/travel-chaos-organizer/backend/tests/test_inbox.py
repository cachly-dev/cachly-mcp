"""
Tests for /api/v1/inbox

Covers:
  list_inbox   – empty, pending filter, other status filters
  assign       – moves item to trip, updates status to 'assigned', migrates attachments
  reject       – sets status to 'rejected', idempotent on 404

Run: pytest tests/test_inbox.py -v
"""

import pytest
from httpx import AsyncClient
from tests.conftest import make_trip

pytestmark = pytest.mark.asyncio


async def _create_trip(client: AsyncClient) -> str:
    r = await client.post("/api/v1/trips", json=make_trip())
    assert r.status_code == 201
    return r.json()["id"]


async def _seed_inbox(client: AsyncClient) -> str:
    """Parse some text so it lands in inbox (no trip_id → inbox)."""
    r = await client.post(
        "/api/v1/parse/text",
        data={"raw_text": "Flight LH 400 Frankfurt to New York on Aug 15"},
    )
    assert r.status_code == 200
    # fetch inbox to get the id
    inbox = await client.get("/api/v1/inbox")
    assert inbox.status_code == 200
    items = inbox.json()
    assert len(items) > 0
    return items[0]["id"]


# ── list ──────────────────────────────────────────────────────────────────────

async def test_inbox_empty(client):
    r = await client.get("/api/v1/inbox")
    assert r.status_code == 200
    assert r.json() == []


async def test_inbox_default_status_is_pending(client, mock_ollama_flight):
    await _seed_inbox(client)
    r = await client.get("/api/v1/inbox")
    assert r.status_code == 200
    items = r.json()
    assert all(i["status"] == "pending" for i in items)


async def test_inbox_filter_by_status(client, mock_ollama_flight):
    inbox_id = await _seed_inbox(client)
    await client.delete(f"/api/v1/inbox/{inbox_id}")

    r = await client.get("/api/v1/inbox?status_filter=rejected")
    assert r.status_code == 200
    assert any(i["id"] == inbox_id for i in r.json())


# ── assign ────────────────────────────────────────────────────────────────────

async def test_assign_creates_trip_item(client, mock_ollama_flight):
    trip_id = await _create_trip(client)
    inbox_id = await _seed_inbox(client)

    r = await client.post(
        f"/api/v1/inbox/{inbox_id}/assign",
        json={"trip_id": trip_id, "type": "flight"},
    )
    assert r.status_code == 200
    assert "trip_item_id" in r.json()


async def test_assign_marks_inbox_as_assigned(client, mock_ollama_flight):
    trip_id = await _create_trip(client)
    inbox_id = await _seed_inbox(client)
    await client.post(f"/api/v1/inbox/{inbox_id}/assign",
                      json={"trip_id": trip_id, "type": "flight"})

    r = await client.get("/api/v1/inbox?status_filter=assigned")
    assert any(i["id"] == inbox_id for i in r.json())


async def test_assign_not_found(client):
    r = await client.post(
        "/api/v1/inbox/00000000-0000-0000-0000-000000000000/assign",
        json={"trip_id": "00000000-0000-0000-0000-000000000001", "type": "other"},
    )
    assert r.status_code == 404


# ── reject ────────────────────────────────────────────────────────────────────

async def test_reject_inbox_item(client, mock_ollama_flight):
    inbox_id = await _seed_inbox(client)
    r = await client.delete(f"/api/v1/inbox/{inbox_id}")
    assert r.status_code == 204


async def test_reject_not_found(client):
    r = await client.delete("/api/v1/inbox/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404
