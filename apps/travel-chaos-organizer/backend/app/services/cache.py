"""
Cachly Redis cache for Ollama parse results.

When CACHLY_REDIS_URL is configured, parsed documents are stored by
content hash (SHA-256). Uploading the same PDF or text twice returns
the cached result instantly — no second AI call.

Hit/miss counters are stored in Redis (tco:stats:hits / tco:stats:misses)
so they survive restarts and are visible in the /api/v1/cache/stats endpoint.

Cache key format: tco:parse:{hex16}
Stats keys:       tco:stats:hits, tco:stats:misses
TTL: 7 days (parse results are deterministic for the same input)
"""
import hashlib
import json
from typing import Any

_redis_client: Any = None
_redis_available = False

CACHE_TTL = 7 * 24 * 3600  # 7 days


def _get_client():
    """Lazy-init Redis client. Returns None if Cachly is not configured."""
    global _redis_client, _redis_available
    if _redis_client is not None:
        return _redis_client if _redis_available else None

    import os
    redis_url = os.getenv("CACHLY_REDIS_URL", "")
    if not redis_url:
        _redis_available = False
        return None

    try:
        import redis.asyncio as aioredis
        _redis_client = aioredis.from_url(redis_url, decode_responses=True, socket_connect_timeout=3)
        _redis_available = True
        return _redis_client
    except Exception:
        _redis_available = False
        return None


def _cache_key(content: str | bytes) -> str:
    if isinstance(content, str):
        content = content.encode()
    digest = hashlib.sha256(content).hexdigest()[:16]
    return f"tco:parse:{digest}"


async def cache_get(content: str | bytes) -> dict | None:
    """Return cached parse result for this content, or None on miss/error.
    Increments tco:stats:hits on hit, tco:stats:misses on miss."""
    client = _get_client()
    if client is None:
        return None
    try:
        key = _cache_key(content)
        raw = await client.get(key)
        if raw is None:
            await client.incr("tco:stats:misses")
            return None
        await client.incr("tco:stats:hits")
        return json.loads(raw)
    except Exception:
        return None


async def cache_set(content: str | bytes, parsed: dict) -> None:
    """Store parse result. Fire-and-forget — never blocks or raises."""
    client = _get_client()
    if client is None:
        return
    try:
        key = _cache_key(content)
        await client.set(key, json.dumps(parsed), ex=CACHE_TTL)
    except Exception:
        pass


async def cache_stats() -> dict:
    """Return cache statistics. Returns zeros if Redis is not configured."""
    client = _get_client()
    configured = cachly_configured()
    if client is None:
        return {
            "configured": configured,
            "hits": 0,
            "misses": 0,
            "key_count": 0,
            "hit_rate": 0.0,
            "ttl_days": CACHE_TTL // 86400,
        }
    try:
        hits_raw, misses_raw = await client.mget("tco:stats:hits", "tco:stats:misses")
        hits = int(hits_raw or 0)
        misses = int(misses_raw or 0)
        total = hits + misses
        hit_rate = round(hits / total, 4) if total > 0 else 0.0

        # count tco:parse:* keys — SCAN is O(1) per call, safe on large keyspaces
        key_count = 0
        async for _ in client.scan_iter("tco:parse:*", count=100):
            key_count += 1

        return {
            "configured": True,
            "hits": hits,
            "misses": misses,
            "key_count": key_count,
            "hit_rate": hit_rate,
            "ttl_days": CACHE_TTL // 86400,
        }
    except Exception:
        return {
            "configured": configured,
            "hits": 0,
            "misses": 0,
            "key_count": 0,
            "hit_rate": 0.0,
            "ttl_days": CACHE_TTL // 86400,
        }


def cachly_configured() -> bool:
    """True if CACHLY_REDIS_URL is set."""
    import os
    return bool(os.getenv("CACHLY_REDIS_URL", ""))
