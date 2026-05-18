"""
Re-exports from the shared telegram-notify package.
Canonical implementation: packages/telegram-notify/telegram_notify/client.py

Install locally: pip install -e ../../../../packages/telegram-notify
Docker build: COPY packages/telegram-notify /tmp/telegram-notify && pip install /tmp/telegram-notify
"""
from telegram_notify import notify, notify_user, format_message

__all__ = ["notify", "notify_user", "format_message"]
