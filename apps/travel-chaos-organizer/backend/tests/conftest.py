"""
Shared fixtures for Travel Chaos Organizer backend tests.

Patterns from cachly-mcp:
- In-memory mocks instead of real services (no Docker required for unit tests)
- Deterministic fake data via factory helpers
- Auth always injectable / bypassable in unit scope
"""

import json
import uuid
from collections.abc import AsyncGenerator
from datetime import date
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.database import Base, get_db
from app.main import app
from app.models.schemas import ParsedTravelData

# ── In-memory SQLite DB (mirrors cachly MockRedis pattern) ────────────────────

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture(scope="function")
async def db_engine():
    import sqlalchemy
    engine = create_async_engine(TEST_DB_URL, echo=False)
    async with engine.begin() as conn:
        # Execute each DDL statement separately — SQLite doesn't support
        # multi-statement execute() calls.
        for stmt in SQLITE_SCHEMA.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                await conn.execute(sqlalchemy.text(stmt))
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine) -> AsyncGenerator[AsyncSession, None]:
    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as session:
        yield session
        await session.rollback()


# ── Auth bypass (like cachly's checkJwt mock) ─────────────────────────────────

FAKE_USER_ID = "user-test-123"
FAKE_USER_PAYLOAD = {"sub": FAKE_USER_ID, "email": "test@example.com"}


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client with auth bypassed and real in-memory DB."""
    from app.auth.keycloak import get_current_user
    from app.db.database import get_db

    async def override_auth():
        return FAKE_USER_PAYLOAD

    async def override_db():
        yield db_session

    app.dependency_overrides[get_current_user] = override_auth
    app.dependency_overrides[get_db] = override_db

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c

    app.dependency_overrides.clear()


# ── Ollama mock (no real LLM needed) ──────────────────────────────────────────

PARSED_FLIGHT = ParsedTravelData(
    type="flight",
    title="LH 400 Frankfurt → New York",
    booking_ref="ABC123",
    provider="Lufthansa",
    event_at="2024-08-15T10:30:00",
    origin="FRA",
    destination="JFK",
    passengers=["Max Mustermann"],
    price="€ 850",
    confidence=0.92,
)


@pytest.fixture
def mock_ollama_flight():
    with patch("app.services.ollama.parse_text", new_callable=AsyncMock) as m:
        m.return_value = PARSED_FLIGHT.model_dump()
        yield m


@pytest.fixture
def mock_ollama_low_confidence():
    with patch("app.services.ollama.parse_text", new_callable=AsyncMock) as m:
        m.return_value = {
            "type": "other",
            "title": "Unrecognized document",
            "confidence": 0.1,
        }
        yield m


# ── Factory helpers ────────────────────────────────────────────────────────────

def make_trip(name: str = "Sommerurlaub 2024", **kwargs) -> dict[str, Any]:
    return {"name": name, "description": "Test trip", "start_date": "2024-08-01",
            "end_date": "2024-08-15", **kwargs}


def make_item(**kwargs) -> dict[str, Any]:
    return {"type": "flight", "title": "LH 400 FRA→JFK", "event_at": "2024-08-15T10:30:00",
            "booking_ref": "ABC123", "provider": "Lufthansa", **kwargs}


# ── SQLite-compatible schema (no PostgreSQL ENUMs / pgcrypto) ─────────────────

def _uuid_default() -> str:
    """SQLite UUID expression: generates xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx format."""
    return (
        "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || "
        "lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || "
        "lower(hex(randomblob(6)))"
    )

_UD = _uuid_default()

SQLITE_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS trips (
    id          TEXT PRIMARY KEY DEFAULT ({_UD}),
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    start_date  TEXT,
    end_date    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trip_items (
    id            TEXT PRIMARY KEY DEFAULT ({_UD}),
    trip_id       TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'other',
    title         TEXT NOT NULL,
    raw_text      TEXT,
    parsed_data   TEXT,
    event_at      TEXT,
    event_end_at  TEXT,
    booking_ref   TEXT,
    provider      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
    id            TEXT PRIMARY KEY DEFAULT ({_UD}),
    trip_item_id  TEXT,
    inbox_id      TEXT,
    user_id       TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chaos_inbox (
    id           TEXT PRIMARY KEY DEFAULT ({_UD}),
    user_id      TEXT NOT NULL,
    raw_content  TEXT,
    source       TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    parsed_data  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT,
    plan            TEXT NOT NULL DEFAULT 'free',
    plan_expires_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY DEFAULT ({_UD}),
    user_id     TEXT,
    event_name  TEXT NOT NULL,
    properties  TEXT,
    platform    TEXT,
    app_version TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS waitlist (
    id         TEXT PRIMARY KEY DEFAULT ({_UD}),
    email      TEXT NOT NULL UNIQUE,
    source     TEXT DEFAULT 'landing',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""
