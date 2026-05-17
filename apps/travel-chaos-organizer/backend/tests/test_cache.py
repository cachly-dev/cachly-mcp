"""
Tests for Cachly Redis cache layer (services/cache.py).
Uses unittest.mock — no real Redis required.
"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ── No-Redis path ─────────────────────────────────────────────────────────────

def test_cachly_configured_false_when_no_env(monkeypatch):
    monkeypatch.delenv("CACHLY_REDIS_URL", raising=False)
    from app.services import cache as c
    assert c.cachly_configured() is False


def test_cachly_configured_true_when_env_set(monkeypatch):
    monkeypatch.setenv("CACHLY_REDIS_URL", "redis://:pw@host:6380/0")
    from app.services import cache as c
    assert c.cachly_configured() is True


@pytest.mark.asyncio
async def test_cache_get_returns_none_when_no_redis(monkeypatch):
    monkeypatch.delenv("CACHLY_REDIS_URL", raising=False)
    import importlib
    from app.services import cache as c
    # Reset module-level state
    c._redis_client = None
    c._redis_available = False

    result = await c.cache_get("some content")
    assert result is None


@pytest.mark.asyncio
async def test_cache_set_no_ops_when_no_redis(monkeypatch):
    monkeypatch.delenv("CACHLY_REDIS_URL", raising=False)
    from app.services import cache as c
    c._redis_client = None
    c._redis_available = False

    # Should not raise
    await c.cache_set("some content", {"type": "flight"})


# ── With mocked Redis ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cache_get_returns_dict_on_hit():
    from app.services import cache as c

    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=json.dumps({"type": "flight", "title": "LH 400"}))

    c._redis_client = mock_redis
    c._redis_available = True

    result = await c.cache_get("flight booking text")
    assert result == {"type": "flight", "title": "LH 400"}


@pytest.mark.asyncio
async def test_cache_get_returns_none_on_miss():
    from app.services import cache as c

    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=None)

    c._redis_client = mock_redis
    c._redis_available = True

    result = await c.cache_get("unknown content")
    assert result is None


@pytest.mark.asyncio
async def test_cache_set_stores_json():
    from app.services import cache as c

    mock_redis = AsyncMock()
    mock_redis.set = AsyncMock()

    c._redis_client = mock_redis
    c._redis_available = True

    parsed = {"type": "hotel", "title": "Hilton Berlin"}
    await c.cache_set("hotel email text", parsed)

    mock_redis.set.assert_called_once()
    call_args = mock_redis.set.call_args
    assert call_args[1]["ex"] == c.CACHE_TTL
    stored = json.loads(call_args[0][1])
    assert stored["type"] == "hotel"


@pytest.mark.asyncio
async def test_cache_get_survives_redis_error():
    from app.services import cache as c

    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(side_effect=Exception("connection refused"))

    c._redis_client = mock_redis
    c._redis_available = True

    result = await c.cache_get("any content")
    assert result is None  # never raises


@pytest.mark.asyncio
async def test_cache_set_survives_redis_error():
    from app.services import cache as c

    mock_redis = AsyncMock()
    mock_redis.set = AsyncMock(side_effect=Exception("timeout"))

    c._redis_client = mock_redis
    c._redis_available = True

    await c.cache_set("any content", {"type": "other"})  # never raises


def test_cache_key_is_deterministic():
    from app.services import cache as c

    k1 = c._cache_key("same text")
    k2 = c._cache_key("same text")
    k3 = c._cache_key("different text")

    assert k1 == k2
    assert k1 != k3
    assert k1.startswith("tco:parse:")


def test_cache_key_works_for_bytes():
    from app.services import cache as c

    kb = c._cache_key(b"\x89PNG binary")
    assert kb.startswith("tco:parse:")
    assert len(kb) == len("tco:parse:") + 16
