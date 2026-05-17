"""
Optional Cachly Redis cache for Ollama parse results.

When CACHLY_REDIS_URL is configured, parsed documents are stored by
content hash (SHA-256). Uploading the same PDF or text twice returns
the cached result instantly — no second AI call.

This is the core Cachly integration: TCO uses Cachly's Redis as its
AI result deduplication layer.

Cache key format: tco:parse:{hex16}
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
    """Return cached parse result for this content, or None on miss/error."""
    client = _get_client()
    if client is None:
        return None
    try:
        key = _cache_key(content)
        raw = await client.get(key)
        if raw is None:
            return None
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


def cachly_configured() -> bool:
    """True if CACHLY_REDIS_URL is set."""
    import os
    return bool(os.getenv("CACHLY_REDIS_URL", ""))
