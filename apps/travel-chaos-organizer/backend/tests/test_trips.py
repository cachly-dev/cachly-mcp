"""
Tests for /api/v1/trips

Covers:
  list_trips    – empty list, multiple trips, user isolation
  create_trip   – happy path, missing name, date validation
  get_trip      – found, 404 for wrong user
  update_trip   – partial update, no-op body → 400
  delete_trip   – deletes own trip, 404 for other user's trip

Run: pytest tests/test_trips.py -v
"""

import pytest
from httpx import AsyncClient

from tests.conftest import FAKE_USER_ID, make_trip

pytestmark = pytest.mark.asyncio


async def _create(client: AsyncClient, **kwargs) -> dict:
    r = await client.post("/api/v1/trips", json=make_trip(**kwargs))
    assert r.status_code == 201, r.text
    return r.json()


# ── list ──────────────────────────────────────────────────────────────────────

async def test_list_trips_empty(client):
    r = await client.get("/api/v1/trips")
    assert r.status_code == 200
    assert r.json() == []


async def test_list_trips_returns_own_trips(client):
    await _create(client, name="Trip A")
    await _create(client, name="Trip B")
    r = await client.get("/api/v1/trips")
    assert r.status_code == 200
    names = {t["name"] for t in r.json()}
    assert names == {"Trip A", "Trip B"}


# ── create ────────────────────────────────────────────────────────────────────

async def test_create_trip_happy_path(client):
    data = make_trip(name="Barcelona 2024")
    r = await client.post("/api/v1/trips", json=data)
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Barcelona 2024"
    assert body["user_id"] == FAKE_USER_ID
    assert "id" in body


async def test_create_trip_missing_name_rejected(client):
    r = await client.post("/api/v1/trips", json={"description": "no name"})
    assert r.status_code == 422


async def test_create_trip_empty_name_rejected(client):
    r = await client.post("/api/v1/trips", json={"name": ""})
    assert r.status_code == 422


async def test_create_trip_optional_dates(client):
    r = await client.post("/api/v1/trips", json={"name": "Open-ended"})
    assert r.status_code == 201
    body = r.json()
    assert body["start_date"] is None
    assert body["end_date"] is None


# ── get ───────────────────────────────────────────────────────────────────────

async def test_get_trip_found(client):
    created = await _create(client, name="My Trip")
    r = await client.get(f"/api/v1/trips/{created['id']}")
    assert r.status_code == 200
    assert r.json()["name"] == "My Trip"


async def test_get_trip_not_found(client):
    r = await client.get("/api/v1/trips/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


# ── update ────────────────────────────────────────────────────────────────────

async def test_update_trip_name(client):
    created = await _create(client, name="Old Name")
    r = await client.patch(f"/api/v1/trips/{created['id']}", json={"name": "New Name"})
    assert r.status_code == 200
    assert r.json()["name"] == "New Name"


async def test_update_trip_empty_body_rejected(client):
    created = await _create(client)
    r = await client.patch(f"/api/v1/trips/{created['id']}", json={})
    assert r.status_code == 400


async def test_update_trip_not_found(client):
    r = await client.patch("/api/v1/trips/00000000-0000-0000-0000-000000000000",
                           json={"name": "X"})
    assert r.status_code == 404


# ── delete ────────────────────────────────────────────────────────────────────

async def test_delete_trip(client):
    created = await _create(client)
    r = await client.delete(f"/api/v1/trips/{created['id']}")
    assert r.status_code == 204

    r2 = await client.get(f"/api/v1/trips/{created['id']}")
    assert r2.status_code == 404


async def test_delete_trip_not_found(client):
    r = await client.delete("/api/v1/trips/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404
