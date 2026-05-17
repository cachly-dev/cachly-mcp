"""Tests for /api/v1/users/me endpoint."""
import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_me_returns_plan(client: AsyncClient):
    r = await client.get("/api/v1/users/me")
    assert r.status_code == 200
    data = r.json()
    assert data["plan"] in ("free", "pro")
    assert data["is_pro"] is False  # default free
    assert data["free_daily_parses"] == 50
    assert data["free_max_trips"] == 3


async def test_me_upserts_user_on_first_call(client: AsyncClient, db_session):
    from sqlalchemy import text

    # Call /me which should create the user row
    r = await client.get("/api/v1/users/me")
    assert r.status_code == 200

    # Verify user row exists
    row = await db_session.execute(text("SELECT id FROM users WHERE id = 'user-test-123'"))
    assert row.fetchone() is not None


async def test_me_requires_auth(client: AsyncClient):
    """Without auth override, endpoint should reject unauthenticated requests."""
    from app.auth.keycloak import get_current_user
    from app.main import app
    from fastapi import HTTPException

    # Remove the auth override to simulate a real unauthenticated request
    original_overrides = dict(app.dependency_overrides)
    if get_current_user in app.dependency_overrides:
        del app.dependency_overrides[get_current_user]

    try:
        r = await client.get("/api/v1/users/me")
        assert r.status_code in (401, 403, 422)
    finally:
        app.dependency_overrides.update(original_overrides)


async def test_me_returns_user_id(client: AsyncClient):
    """The /me endpoint returns the authenticated user's ID."""
    r = await client.get("/api/v1/users/me")
    assert r.status_code == 200
    assert r.json()["id"] == "user-test-123"
