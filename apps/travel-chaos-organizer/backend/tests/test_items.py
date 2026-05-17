"""
Tests for /api/v1/trips/{trip_id}/items

Covers:
  list_items   – empty, sorted by event_at, trip isolation
  create_item  – happy path, optional fields, missing title → 422
  update_item  – partial patch, type change, 404 for wrong trip
  delete_item  – removes item, 404 guard
  timeline order – items sorted chronologically regardless of insert order

Run: pytest tests/test_items.py -v
"""
import pytest
from httpx import AsyncClient
from tests.conftest import make_trip, make_item

pytestmark = pytest.mark.asyncio


async def _create_trip(client: AsyncClient) -> str:
    r = await client.post("/api/v1/trips", json=make_trip())
    assert r.status_code == 201
    return r.json()["id"]


async def _create_item(client: AsyncClient, trip_id: str, **kwargs) -> dict:
    r = await client.post(f"/api/v1/trips/{trip_id}/items", json=make_item(**kwargs))
    assert r.status_code == 201, r.text
    return r.json()


# ── list ──────────────────────────────────────────────────────────────────────

async def test_list_items_empty(client):
    trip_id = await _create_trip(client)
    r = await client.get(f"/api/v1/trips/{trip_id}/items")
    assert r.status_code == 200
    assert r.json() == []


async def test_list_items_wrong_trip_404(client):
    r = await client.get("/api/v1/trips/00000000-0000-0000-0000-000000000000/items")
    assert r.status_code == 404


async def test_timeline_sorted_by_event_at(client):
    trip_id = await _create_trip(client)
    await _create_item(client, trip_id, title="Late flight", event_at="2024-08-20T18:00:00")
    await _create_item(client, trip_id, title="Early flight", event_at="2024-08-15T06:00:00")
    await _create_item(client, trip_id, title="Mid hotel",   event_at="2024-08-17T14:00:00")

    r = await client.get(f"/api/v1/trips/{trip_id}/items")
    titles = [i["title"] for i in r.json()]
    assert titles == ["Early flight", "Mid hotel", "Late flight"]


# ── create ────────────────────────────────────────────────────────────────────

async def test_create_item_happy_path(client):
    trip_id = await _create_trip(client)
    r = await client.post(f"/api/v1/trips/{trip_id}/items", json=make_item(title="LH 400 FRA→JFK"))
    assert r.status_code == 201
    body = r.json()
    assert body["title"] == "LH 400 FRA→JFK"
    assert body["type"] == "flight"
    assert body["trip_id"] == trip_id


async def test_create_item_missing_title_rejected(client):
    trip_id = await _create_trip(client)
    r = await client.post(f"/api/v1/trips/{trip_id}/items", json={"type": "flight"})
    assert r.status_code == 422


async def test_create_item_optional_fields_nullable(client):
    trip_id = await _create_trip(client)
    r = await client.post(f"/api/v1/trips/{trip_id}/items",
                          json={"title": "Minimal item", "type": "other"})
    assert r.status_code == 201
    body = r.json()
    assert body["event_at"] is None
    assert body["booking_ref"] is None


async def test_create_item_with_parsed_data(client):
    trip_id = await _create_trip(client)
    parsed = {"origin": "FRA", "destination": "JFK", "confidence": 0.95}
    r = await client.post(f"/api/v1/trips/{trip_id}/items",
                          json={**make_item(), "parsed_data": parsed})
    assert r.status_code == 201
    assert r.json()["parsed_data"]["origin"] == "FRA"


# ── update ────────────────────────────────────────────────────────────────────

async def test_update_item_type(client):
    trip_id = await _create_trip(client)
    item = await _create_item(client, trip_id)
    r = await client.patch(f"/api/v1/trips/{trip_id}/items/{item['id']}",
                           json={"type": "hotel"})
    assert r.status_code == 200
    assert r.json()["type"] == "hotel"


async def test_update_item_not_found(client):
    trip_id = await _create_trip(client)
    r = await client.patch(
        f"/api/v1/trips/{trip_id}/items/00000000-0000-0000-0000-000000000000",
        json={"title": "Ghost"},
    )
    assert r.status_code == 404


async def test_update_item_empty_body_rejected(client):
    trip_id = await _create_trip(client)
    item = await _create_item(client, trip_id)
    r = await client.patch(f"/api/v1/trips/{trip_id}/items/{item['id']}", json={})
    assert r.status_code == 400


# ── delete ────────────────────────────────────────────────────────────────────

async def test_delete_item(client):
    trip_id = await _create_trip(client)
    item = await _create_item(client, trip_id)
    r = await client.delete(f"/api/v1/trips/{trip_id}/items/{item['id']}")
    assert r.status_code == 204

    items = await client.get(f"/api/v1/trips/{trip_id}/items")
    assert items.json() == []


async def test_delete_item_not_found(client):
    trip_id = await _create_trip(client)
    r = await client.delete(
        f"/api/v1/trips/{trip_id}/items/00000000-0000-0000-0000-000000000000"
    )
    assert r.status_code == 404
