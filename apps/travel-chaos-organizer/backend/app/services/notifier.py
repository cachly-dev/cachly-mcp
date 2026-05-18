"""
Telegram notifier — fire-and-forget, never raises.
Interface: notify(app, event, payload)

Used by TCO backend. Same conceptual interface as src/notifier.ts in cachly-mcp.
Configure via env:
  TELEGRAM_BOT_TOKEN   — bot token from @BotFather
  TCO_TELEGRAM_CHAT_ID — chat/channel ID for TCO events (fallback: TELEGRAM_CHAT_ID)

No-op when not configured.
"""
import json
import os
from typing import Any


def _token() -> str:
    return os.getenv("TELEGRAM_BOT_TOKEN", "")


def _chat_id() -> str:
    return os.getenv("TCO_TELEGRAM_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID", "")


_EMOJI = {
    "waitlist_signup":  "📬",
    "parse_file":       "📄",
    "parse_text":       "📝",
    "parse_url":        "🔗",
    "trip_created":     "🗺️",
    "trip_deleted":     "🗑️",
    "cache_hit":        "⚡",
    "error":            "🔴",
    "stripe_payment":   "💳",
    "new_user":         "🆕",
    "pdf_export":       "📑",
    "trip_search":      "🔍",
    "stripe_checkout":  "🛒",
    "default":          "🔔",
}


def _format(app: str, event: str, payload: dict[str, Any]) -> str:
    icon = _EMOJI.get(event, _EMOJI["default"])
    lines = [f"{icon} *{app.upper()}* · `{event}`"]
    for k, v in payload.items():
        if v is not None:
            lines.append(f"  {k}: `{v}`")
    return "\n".join(lines)


async def notify(app: str, event: str, payload: dict[str, Any] | None = None) -> None:
    """Send event to admin Telegram chat. No-op if not configured."""
    token = _token()
    chat_id = _chat_id()
    if not token or not chat_id:
        return
    try:
        import httpx
        msg = _format(app, event, payload or {})
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": msg, "parse_mode": "Markdown"},
            )
    except Exception:
        pass  # never raises


async def notify_user(db: Any, user_id: str, message: str) -> None:
    """Send a direct Telegram message to a specific user (by their user_id).
    Looks up telegram_chat_id from DB. No-op if user has not linked Telegram."""
    token = _token()
    if not token:
        return
    try:
        from sqlalchemy import text as sql_text
        result = await db.execute(
            sql_text("SELECT telegram_chat_id FROM users WHERE id = :uid"),
            {"uid": user_id},
        )
        row = result.fetchone()
        if not row or not row[0]:
            return
        chat_id = row[0]
        import httpx
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": message, "parse_mode": "Markdown"},
            )
    except Exception:
        pass  # never raises
