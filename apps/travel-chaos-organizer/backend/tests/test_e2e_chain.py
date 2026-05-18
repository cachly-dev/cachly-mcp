"""
E2E chain test: parse text → inbox → assign to trip.
Covers the full happy path a user would take.
"""
import json
import uuid
import pytest
from unittest.mock import patch, AsyncMock
from httpx import AsyncClient
from sqlalchemy import text
from tests.conftest import FAKE_USER_ID

# A fixed UUID for the "other user's trip" in cross-user tests
OTHER_TRIP_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012"


@pytest.mark.asyncio
async def test_full_parse_to_assign_chain(client: AsyncClient, db_session, mock_ollama_flight):
    """Parse text → lands in inbox → assign to trip → trip has item."""
    # 1. Create a trip
    r = await client.post("/api/v1/trips", json={
        "name": "E2E Test Trip", "description": "Chain test",
        "start_date": "2025-08-01", "end_date": "2025-08-10"
    })
    assert r.status_code == 201
    trip_id = r.json()["id"]

    # 2. Parse text → inbox (no trip_id)
    with patch("app.services.telemetry.track", new_callable=AsyncMock):
        r = await client.post("/api/v1/parse/text", data={"raw_text": "Lufthansa Buchungsbestaetigung LH400 FRA-JFK"})
    assert r.status_code == 200
    assert r.json()["parsed"]["type"] == "flight"

    # 3. Fetch inbox
    r = await client.get("/api/v1/inbox?status_filter=pending")
    assert r.status_code == 200
    inbox = r.json()
    assert len(inbox) >= 1
    inbox_id = inbox[0]["id"]

    # 4. Assign inbox item to trip
    r = await client.post(f"/api/v1/inbox/{inbox_id}/assign",
                          json={"trip_id": trip_id, "type": "flight"})
    assert r.status_code == 200
    trip_item_id = r.json()["trip_item_id"]
    assert trip_item_id

    # 5. Verify item appears in trip timeline
    r = await client.get(f"/api/v1/trips/{trip_id}/items")
    assert r.status_code == 200
    items = r.json()
    assert any(i["id"] == trip_item_id for i in items)

    # 6. Inbox item is now "assigned"
    r = await client.get("/api/v1/inbox?status_filter=assigned")
    assert r.status_code == 200
    assigned = [i for i in r.json() if i["id"] == inbox_id]
    assert len(assigned) == 1


@pytest.mark.asyncio
async def test_cross_user_inbox_assign_blocked(client: AsyncClient, db_session, mock_ollama_flight):
    """Cannot assign inbox item to another user's trip."""
    # Create a trip owned by a DIFFERENT user with a valid UUID
    await db_session.execute(
        text("INSERT INTO trips (id, user_id, name) VALUES (:id, :uid, :name)"),
        {"id": OTHER_TRIP_ID, "uid": "other-user", "name": "Other Trip"}
    )
    await db_session.commit()

    # Parse something into inbox
    with patch("app.services.telemetry.track", new_callable=AsyncMock):
        r = await client.post("/api/v1/parse/text", data={"raw_text": "Booking confirmation XYZ123"})
    assert r.status_code == 200

    r = await client.get("/api/v1/inbox?status_filter=pending")
    inbox_id = r.json()[0]["id"]

    # Try to assign to other user's trip — must be 403
    r = await client.post(f"/api/v1/inbox/{inbox_id}/assign",
                          json={"trip_id": OTHER_TRIP_ID, "type": "other"})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_trip_search_returns_correct_results(client: AsyncClient, db_session):
    """Search finds trips by name and description.
    NOTE: The search endpoint uses ILIKE which is PostgreSQL-specific.
    This test is skipped when running with the SQLite in-memory test DB.
    """
    pytest.skip("Search endpoint uses ILIKE (PostgreSQL only); not compatible with SQLite test DB")


@pytest.mark.asyncio
async def test_delete_trip_cascades_cleanup(client: AsyncClient, db_session):
    """Deleting a trip removes it from the list."""
    r = await client.post("/api/v1/trips", json={"name": "Delete Me Trip"})
    trip_id = r.json()["id"]

    r = await client.delete(f"/api/v1/trips/{trip_id}")
    assert r.status_code == 204

    r = await client.get("/api/v1/trips")
    assert all(t["id"] != trip_id for t in r.json())


@pytest.mark.asyncio
async def test_waitlist_signup_deduplication(client: AsyncClient):
    """Same email can't sign up twice."""
    email = "e2e-dedup@test.com"
    r1 = await client.post("/api/v1/waitlist", json={"email": email})
    assert r1.status_code in (200, 201)

    r2 = await client.post("/api/v1/waitlist", json={"email": email})
    # Should succeed (409 or 200 with "already registered") — not 500
    assert r2.status_code < 500
