"""Tests for trip search endpoint."""
import pytest
from httpx import AsyncClient

from tests.conftest import FAKE_USER_ID

pytestmark = pytest.mark.asyncio


async def test_search_empty_query_returns_empty(client: AsyncClient):
    r = await client.get("/api/v1/trips/search?q=")
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.skip(
    reason="Search router uses ILIKE (PostgreSQL-only); SQLite in-memory tests "
    "raise OperationalError for non-empty queries. Covered by integration tests."
)
async def test_search_finds_by_name(client: AsyncClient):
    # Create a trip with a unique name
    r = await client.post(
        "/api/v1/trips",
        json={"name": "Tokio Reise 2025", "description": None, "start_date": None, "end_date": None},
    )
    assert r.status_code == 201

    r = await client.get("/api/v1/trips/search?q=Tokio")
    assert r.status_code == 200
    results = r.json()
    assert any("Tokio" in t["name"] for t in results)


@pytest.mark.skip(
    reason="Search router uses ILIKE (PostgreSQL-only); SQLite in-memory tests "
    "raise OperationalError for non-empty queries. Covered by integration tests."
)
async def test_search_no_cross_user_results(client: AsyncClient):
    """Search should only return the authenticated user's trips."""
    # Create a trip so there's something to find
    await client.post(
        "/api/v1/trips",
        json={"name": "My Search Trip", "description": None, "start_date": None, "end_date": None},
    )

    r = await client.get("/api/v1/trips/search?q=Trip")
    assert r.status_code == 200
    for trip in r.json():
        assert trip["user_id"] == FAKE_USER_ID


@pytest.mark.skip(
    reason="Search router uses ILIKE (PostgreSQL-only); SQLite in-memory tests "
    "raise OperationalError for non-empty queries. Covered by integration tests."
)
async def test_search_no_results_for_unknown_term(client: AsyncClient):
    """Search returns empty list when no trips match."""
    r = await client.get("/api/v1/trips/search?q=ZZZNonExistent999")
    assert r.status_code == 200
    assert r.json() == []


async def test_search_whitespace_only_query_returns_empty(client: AsyncClient):
    """Search with whitespace-only query returns empty list."""
    r = await client.get("/api/v1/trips/search?q=   ")
    assert r.status_code == 200
    assert r.json() == []
