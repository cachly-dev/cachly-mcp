"""Tests for freemium quota enforcement."""
import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_free_trip_limit_enforced(client: AsyncClient):
    """Free plan blocks trip creation after 3 trips."""
    # Create 3 trips (should succeed)
    for i in range(3):
        r = await client.post(
            "/api/v1/trips",
            json={"name": f"Trip {i}", "description": None, "start_date": None, "end_date": None},
        )
        assert r.status_code == 201, f"Trip {i} creation failed: {r.text}"

    # 4th trip should be blocked (402)
    r = await client.post(
        "/api/v1/trips",
        json={"name": "Trip 4", "description": None, "start_date": None, "end_date": None},
    )
    assert r.status_code == 402
    assert "Free plan" in r.json()["detail"]


async def test_pro_plan_bypasses_trip_limit(client: AsyncClient, db_session):
    """Pro users can create more than 3 trips."""
    from sqlalchemy import text

    # Upgrade user to pro
    await db_session.execute(
        text(
            "INSERT INTO users (id, plan) VALUES (:uid, 'pro')"
            " ON CONFLICT (id) DO UPDATE SET plan='pro'"
        ),
        {"uid": "user-test-123"},
    )
    await db_session.commit()

    for i in range(5):
        r = await client.post(
            "/api/v1/trips",
            json={"name": f"Pro Trip {i}", "description": None, "start_date": None, "end_date": None},
        )
        assert r.status_code == 201
