"""Tests for admin endpoints."""
import base64

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


def admin_headers(user: str = "admin", password: str = "changeme") -> dict:
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


async def test_admin_health_requires_auth(client: AsyncClient):
    r = await client.get("/admin/health")
    assert r.status_code == 401


async def test_admin_health_ok(client: AsyncClient):
    r = await client.get("/admin/health", headers=admin_headers())
    assert r.status_code == 200
    data = r.json()
    assert "events_total" in data
    assert "waitlist_total" in data


async def test_admin_dashboard_requires_auth(client: AsyncClient):
    r = await client.get("/admin")
    assert r.status_code == 401


async def test_admin_dashboard_returns_html(client: AsyncClient):
    r = await client.get("/admin", headers=admin_headers())
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "TCO Admin" in r.text


async def test_admin_wrong_password(client: AsyncClient):
    r = await client.get("/admin/health", headers=admin_headers(password="wrongpassword"))
    assert r.status_code == 401


async def test_admin_events_summary(client: AsyncClient):
    r = await client.get("/admin/events/summary", headers=admin_headers())
    assert r.status_code == 200
    assert "events" in r.json()


async def test_admin_waitlist(client: AsyncClient):
    r = await client.get("/admin/waitlist", headers=admin_headers())
    assert r.status_code == 200
    assert "signups" in r.json()


async def test_admin_set_user_plan(client: AsyncClient, db_session):
    from sqlalchemy import text

    # First create the user by calling /me
    await client.get("/api/v1/users/me")

    r = await client.patch(
        "/admin/users/user-test-123/plan?plan=pro", headers=admin_headers()
    )
    assert r.status_code == 200
    assert r.json()["plan"] == "pro"

    # Verify in DB
    row = await db_session.execute(
        text("SELECT plan FROM users WHERE id = 'user-test-123'")
    )
    assert row.fetchone()[0] == "pro"


async def test_admin_set_invalid_plan(client: AsyncClient):
    """Setting an invalid plan returns 400."""
    # Create user first
    await client.get("/api/v1/users/me")

    r = await client.patch(
        "/admin/users/user-test-123/plan?plan=enterprise", headers=admin_headers()
    )
    assert r.status_code == 400


async def test_admin_users_list(client: AsyncClient):
    r = await client.get("/admin/users", headers=admin_headers())
    assert r.status_code == 200
    assert "users" in r.json()


async def test_admin_health_counts(client: AsyncClient):
    """Health endpoint returns all expected count fields."""
    r = await client.get("/admin/health", headers=admin_headers())
    assert r.status_code == 200
    data = r.json()
    assert "users_total" in data
    assert "pro_users" in data
