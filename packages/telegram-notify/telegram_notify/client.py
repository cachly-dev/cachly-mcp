"""
telegram-notify — shared Telegram notification client.

Used by TCO backend (Python) and importable as a pip local package.
Single source of truth for: emoji map, message format, env var convention.

Interface: notify(app, event, payload)
          notify_user(db, user_id, message)   — direct DM via stored chat_id

Env vars:
  TELEGRAM_BOT_TOKEN            — bot token from @BotFather
  {APP_UPPER}_TELEGRAM_CHAT_ID  — app-specific channel (e.g. TCO_TELEGRAM_CHAT_ID)
  TELEGRAM_CHAT_ID              — fallback for all apps

No-op when unconfigured. Never throws.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_EMOJI: dict[str, str] = json.loads(
    (Path(__file__).parent / "emojis.json").read_text()
)


def _token() -> str:
    return os.getenv("TELEGRAM_BOT_TOKEN", "")


def _chat_id(app: str) -> str:
    key = f"{app.upper()}_TELEGRAM_CHAT_ID"
    return os.getenv(key) or os.getenv("TELEGRAM_CHAT_ID", "")


def format_message(app: str, event: str, payload: dict[str, Any]) -> str:
    icon = _EMOJI.get(event, _EMOJI["default"])
    lines = [f"{icon} *{app.upper()}* · `{event}`"]
    for k, v in payload.items():
        if v is not None and v != "":
            lines.append(f"  {k}: `{v}`")
    return "\n".join(lines)


async def notify(app: str, event: str, payload: dict[str, Any] | None = None) -> None:
    """Send event notification to the app's configured Telegram channel."""
    token = _token()
    chat_id = _chat_id(app)
    if not token or not chat_id:
        return
    try:
        import httpx
        text = format_message(app, event, payload or {})
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
            )
    except Exception:
        pass  # never raises


async def notify_user(db: Any, user_id: str, message: str) -> None:
    """Send a direct Telegram message to a user by their DB user_id.
    Looks up telegram_chat_id from the users table. No-op if not linked."""
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
        import httpx
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": row[0], "text": message, "parse_mode": "Markdown"},
            )
    except Exception:
        pass  # never raises
