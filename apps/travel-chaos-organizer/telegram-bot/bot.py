"""
TCO Telegram Bot
Commands: /start /link /unlink /trips /next /inbox /status /help
Forward any document/image/text → parsed via TCO AI
Inline keyboards for trip assignment
"""
import logging
import os
from dotenv import load_dotenv
import httpx
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
)
from telegram.ext import (
    Application, CallbackQueryHandler, CommandHandler,
    ContextTypes, MessageHandler, filters,
)

load_dotenv()
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
API_URL = os.environ.get("TCO_API_URL", "http://localhost:8000")
BOT_SECRET = os.environ.get("TCO_BOT_SECRET", TOKEN)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

_ICONS = {
    "flight": "✈️", "train": "🚂", "bus": "🚌", "hotel": "🏨",
    "rental_car": "🚗", "activity": "🎡", "transfer": "🚕",
    "document": "📄", "other": "📋",
}


# ── Auth helpers ────────────────────────────────────────────────────────────────

def _bot_headers(user_id: str | None = None) -> dict:
    h = {"X-Bot-Token": BOT_SECRET}
    if user_id:
        h["X-User-Id"] = user_id
    return h


async def get_linked_user(chat_id: str) -> dict | None:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(
            f"{API_URL}/api/v1/users/by-telegram/{chat_id}",
            headers=_bot_headers(),
        )
        if r.status_code == 200:
            return r.json()
    return None


async def _require_link(update: Update) -> dict | None:
    """Return linked user or send prompt and return None."""
    user = await get_linked_user(str(update.effective_chat.id))
    if not user:
        await update.message.reply_text(
            "🔗 Bitte zuerst Konto verknüpfen:\n\n"
            "1. TCO-App → Einstellungen → *Mit Telegram verknüpfen*\n"
            "2. Sende mir den PIN: `/link 123456`",
            parse_mode="Markdown",
        )
    return user


# ── Commands ────────────────────────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    user = await get_linked_user(chat_id)
    if user:
        await update.message.reply_text(
            f"👋 Willkommen zurück!\n\n"
            f"Plan: *{'✦ Pro' if user.get('plan') == 'pro' else 'Free'}*\n\n"
            f"/trips — Reisen anzeigen\n/next — Nächstes Event\n/inbox — Chaos Inbox",
            parse_mode="Markdown",
        )
    else:
        await update.message.reply_text(
            "✈️ *Travel Chaos Organizer Bot*\n\n"
            "Ich helfe dir, deine Reisedokumente zu verwalten.\n\n"
            "*Erste Schritte:*\n"
            "1. Öffne die TCO-App → Einstellungen → Telegram verknüpfen\n"
            "2. Du bekommst einen 6-stelligen PIN\n"
            "3. Schreib mir: `/link 123456`\n\n"
            "Danach kannst du mir Buchungsbestätigungen, Screenshots oder PDFs schicken!",
            parse_mode="Markdown",
        )


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "*TCO Bot — Befehle:*\n\n"
        "/trips — Deine Reisen\n"
        "/next — Nächstes Event\n"
        "/inbox — Chaos Inbox\n"
        "/status — Kontostatus\n"
        "/link \\<PIN\\> — Konto verknüpfen\n"
        "/unlink — Verknüpfung aufheben\n"
        "/help — Diese Hilfe\n\n"
        "*Dokumente senden:*\n"
        "Einfach Buchungsbestätigung, PDF oder Screenshot schicken — wird automatisch mit KI geparst ✨\n\n"
        "*Text senden:*\n"
        "Buchungsbestätigung als Text einfügen und senden.",
        parse_mode="Markdown",
    )


async def cmd_link(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Bitte PIN angeben: `/link 123456`", parse_mode="Markdown")
        return
    pin = ctx.args[0].strip()
    chat_id = str(update.effective_chat.id)
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"{API_URL}/api/v1/users/telegram-link",
            params={"pin": pin, "chat_id": chat_id},
        )
    if r.status_code == 200:
        await update.message.reply_text(
            "✅ *Konto erfolgreich verknüpft!*\n\n"
            "Du kannst jetzt:\n"
            "• Buchungsbestätigungen oder PDFs schicken → werden automatisch geparst\n"
            "• /trips — Reisen anzeigen\n"
            "• /inbox — Chaos Inbox verwalten\n"
            "• /next — Nächstes Event anzeigen",
            parse_mode="Markdown",
        )
    elif r.status_code == 410:
        await update.message.reply_text("⏰ PIN abgelaufen. Bitte neuen PIN in der App generieren.")
    elif r.status_code == 404:
        await update.message.reply_text("❌ PIN nicht gefunden. Bitte prüfe die Eingabe.")
    else:
        await update.message.reply_text("⚠️ Fehler beim Verknüpfen. Bitte versuche es erneut.")


async def cmd_unlink(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = await _require_link(update)
    if not user:
        return
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ Ja, trennen", callback_data="unlink:confirm"),
        InlineKeyboardButton("❌ Abbrechen", callback_data="unlink:cancel"),
    ]])
    await update.message.reply_text(
        "⚠️ Telegram-Verknüpfung aufheben?\n\nDu erhältst dann keine Bot-Nachrichten mehr.",
        reply_markup=keyboard,
    )


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    user = await get_linked_user(chat_id)
    if not user:
        await update.message.reply_text(
            "🔴 Konto *nicht verknüpft*\n\nNutze `/link <PIN>` zum Verbinden.",
            parse_mode="Markdown",
        )
        return
    plan = user.get("plan", "free")
    plan_label = "✦ Pro" if plan == "pro" else "Free"
    await update.message.reply_text(
        f"✅ *Konto verknüpft*\n\nPlan: *{plan_label}*\n\nTelegramm-Chat-ID: `{chat_id}`",
        parse_mode="Markdown",
    )


async def cmd_trips(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = await _require_link(update)
    if not user:
        return
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{API_URL}/api/v1/trips", headers=_bot_headers(user["id"]))
    if r.status_code != 200:
        await update.message.reply_text("⚠️ Fehler beim Laden der Trips.")
        return
    trips = r.json()
    if not trips:
        await update.message.reply_text("📭 Noch keine Trips. Erstelle deinen ersten Trip in der TCO-App!")
        return
    # Build inline keyboard — each trip is a button to view its timeline
    buttons = [
        [InlineKeyboardButton(
            f"{'✈️ ' if t.get('start_date') else '📋 '}{t['name']}",
            callback_data=f"trip:{t['id']}:{t['name'][:20]}",
        )]
        for t in trips[:8]
    ]
    await update.message.reply_text(
        f"🗺️ *Deine Trips ({len(trips)}):*",
        reply_markup=InlineKeyboardMarkup(buttons),
        parse_mode="Markdown",
    )


async def cmd_next(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = await _require_link(update)
    if not user:
        return
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{API_URL}/api/v1/trips", headers=_bot_headers(user["id"]))
    if r.status_code != 200 or not r.json():
        await update.message.reply_text("Keine Trips gefunden.")
        return
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).date().isoformat()
    upcoming = [t for t in r.json() if t.get("start_date") and t["start_date"] >= today]
    if not upcoming:
        await update.message.reply_text("📭 Kein bevorstehender Trip gefunden.")
        return
    t = upcoming[0]
    start = t.get("start_date", "?")[:10]
    end = t.get("end_date", "?")[:10] if t.get("end_date") else "?"
    days = ""
    try:
        from datetime import date
        d = (date.fromisoformat(start) - date.today()).days
        days = f" (in {d} {'Tag' if d == 1 else 'Tagen'})"
    except Exception:
        pass
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton("📅 Timeline anzeigen", callback_data=f"trip:{t['id']}:{t['name'][:20]}"),
    ]])
    await update.message.reply_text(
        f"🗓️ *Nächster Trip:*\n\n*{t['name']}*\nStart: {start}{days}\nEnde: {end}",
        reply_markup=keyboard,
        parse_mode="Markdown",
    )


async def cmd_inbox(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = await _require_link(update)
    if not user:
        return
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(
            f"{API_URL}/api/v1/inbox?status_filter=pending",
            headers=_bot_headers(user["id"]),
        )
    if r.status_code != 200:
        await update.message.reply_text("⚠️ Fehler beim Laden des Inbox.")
        return
    items = r.json()
    if not items:
        await update.message.reply_text("🎉 Chaos Inbox ist leer!")
        return
    # Show first 5 items with assign/reject buttons
    for item in items[:5]:
        pd = item.get("parsed_data") or {}
        title = pd.get("title") or "(kein Titel)"
        itype = pd.get("type") or "other"
        icon = _ICONS.get(itype, "📋")
        provider = pd.get("provider") or ""
        ref = pd.get("booking_ref") or ""
        lines = [f"{icon} *{title}*"]
        if provider:
            lines.append(f"Anbieter: {provider}")
        if ref:
            lines.append(f"Ref: `{ref}`")
        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton("✈️ Trip zuweisen", callback_data=f"assign:{item['id']}:pick"),
            InlineKeyboardButton("🗑️ Löschen", callback_data=f"reject:{item['id']}"),
        ]])
        await update.message.reply_text(
            "\n".join(lines),
            reply_markup=keyboard,
            parse_mode="Markdown",
        )
    if len(items) > 5:
        await update.message.reply_text(f"… und {len(items) - 5} weitere. Öffne die App für die vollständige Ansicht.")


# ── Callback query handlers ─────────────────────────────────────────────────────

async def handle_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data or ""
    chat_id = str(update.effective_chat.id)
    user = await get_linked_user(chat_id)
    if not user:
        await query.edit_message_text("⚠️ Konto nicht verknüpft. Nutze /link.")
        return

    # ── unlink confirm/cancel ──────────────────────────────────────────────
    if data == "unlink:confirm":
        async with httpx.AsyncClient(timeout=10) as c:
            await c.delete(
                f"{API_URL}/api/v1/users/telegram-unlink",
                headers={"Authorization": f"X-User-Id {user['id']}", **_bot_headers(user["id"])},
            )
        await query.edit_message_text("✅ Verknüpfung aufgehoben. Auf Wiedersehen!")
        return
    if data == "unlink:cancel":
        await query.edit_message_text("❌ Abgebrochen. Verknüpfung bleibt bestehen.")
        return

    # ── show trip timeline ─────────────────────────────────────────────────
    if data.startswith("trip:"):
        parts = data.split(":", 2)
        trip_id = parts[1]
        trip_name = parts[2] if len(parts) > 2 else "Trip"
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{API_URL}/api/v1/trips/{trip_id}/items", headers=_bot_headers(user["id"]))
        if r.status_code != 200 or not r.json():
            await query.edit_message_text(f"📂 *{trip_name}* hat noch keine Einträge.", parse_mode="Markdown")
            return
        items = r.json()
        lines = [f"📅 *{trip_name}* — {len(items)} Einträge\n"]
        for i in items[:10]:
            icon = _ICONS.get(i.get("type", "other"), "📋")
            time = i.get("event_at", "")[:16].replace("T", " ") if i.get("event_at") else ""
            lines.append(f"{icon} *{i['title']}*{(' · ' + time) if time else ''}")
        if len(items) > 10:
            lines.append(f"… +{len(items) - 10} weitere")
        await query.edit_message_text("\n".join(lines), parse_mode="Markdown")
        return

    # ── assign inbox item — pick trip ──────────────────────────────────────
    if data.startswith("assign:") and data.endswith(":pick"):
        inbox_id = data.split(":")[1]
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{API_URL}/api/v1/trips", headers=_bot_headers(user["id"]))
        trips = r.json() if r.status_code == 200 else []
        if not trips:
            await query.edit_message_text("📭 Keine Trips vorhanden. Erstelle zuerst einen Trip in der App.")
            return
        buttons = [
            [InlineKeyboardButton(t["name"], callback_data=f"assign:{inbox_id}:{t['id']}")]
            for t in trips[:8]
        ]
        buttons.append([InlineKeyboardButton("❌ Abbrechen", callback_data=f"assign:{inbox_id}:cancel")])
        await query.edit_message_reply_markup(InlineKeyboardMarkup(buttons))
        return

    if data.startswith("assign:") and data.endswith(":cancel"):
        await query.edit_message_reply_markup(None)
        return

    # ── assign inbox item to specific trip ─────────────────────────────────
    if data.startswith("assign:"):
        parts = data.split(":", 2)
        inbox_id, trip_id = parts[1], parts[2]
        if trip_id in ("pick", "cancel"):
            return
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{API_URL}/api/v1/inbox/{inbox_id}/assign",
                json={"trip_id": trip_id, "type": "other"},
                headers=_bot_headers(user["id"]),
            )
        if r.status_code == 200:
            await query.edit_message_text("✅ Dem Trip zugewiesen!", parse_mode="Markdown")
        else:
            await query.edit_message_text(f"⚠️ Fehler beim Zuweisen ({r.status_code}).")
        return

    # ── reject inbox item ──────────────────────────────────────────────────
    if data.startswith("reject:"):
        inbox_id = data.split(":")[1]
        async with httpx.AsyncClient(timeout=10) as c:
            await c.delete(f"{API_URL}/api/v1/inbox/{inbox_id}", headers=_bot_headers(user["id"]))
        await query.edit_message_text("🗑️ Gelöscht.")
        return


# ── Message handlers ────────────────────────────────────────────────────────────

async def handle_document(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = await _require_link(update)
    if not user:
        return
    msg = await update.message.reply_text("⏳ Analysiere Dokument…")
    doc = update.message.document
    photo = update.message.photo
    try:
        if photo:
            file = await ctx.bot.get_file(photo[-1].file_id)
            mime, fname = "image/jpeg", "photo.jpg"
        elif doc:
            file = await ctx.bot.get_file(doc.file_id)
            mime = doc.mime_type or "application/octet-stream"
            fname = doc.file_name or "document"
        else:
            await msg.edit_text("⚠️ Kein Dokument erkannt.")
            return
        file_bytes = await file.download_as_bytearray()
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                f"{API_URL}/api/v1/parse/file",
                files={"file": (fname, bytes(file_bytes), mime)},
                headers=_bot_headers(user["id"]),
            )
        if r.status_code == 200:
            parsed = r.json().get("parsed", {})
            title = parsed.get("title") or "Dokument"
            itype = parsed.get("type") or "other"
            icon = _ICONS.get(itype, "📋")
            ref = parsed.get("booking_ref") or ""
            provider = parsed.get("provider") or ""
            event_at = parsed.get("event_at") or ""
            lines = [f"{icon} *{title}*", f"Typ: {itype}"]
            if provider:
                lines.append(f"Anbieter: {provider}")
            if ref:
                lines.append(f"Ref: `{ref}`")
            if event_at:
                lines.append(f"Datum: {event_at[:16].replace('T', ' ')}")
            lines.append("\n📥 Im Chaos Inbox")
            # Fetch trips for inline assignment
            async with httpx.AsyncClient(timeout=10) as c2:
                trips_r = await c2.get(f"{API_URL}/api/v1/trips", headers=_bot_headers(user["id"]))
            inbox_id = r.json().get("inbox_id")
            keyboard = None
            if inbox_id and trips_r.status_code == 200 and trips_r.json():
                trips = trips_r.json()[:6]
                buttons = [
                    [InlineKeyboardButton(f"➡️ {t['name']}", callback_data=f"assign:{inbox_id}:{t['id']}")]
                    for t in trips
                ]
                buttons.append([InlineKeyboardButton("🗑️ Ablehnen", callback_data=f"reject:{inbox_id}")])
                keyboard = InlineKeyboardMarkup(buttons)
            await msg.edit_text(
                "\n".join(lines),
                reply_markup=keyboard,
                parse_mode="Markdown",
            )
        elif r.status_code == 429:
            await msg.edit_text("⚠️ Tageslimit erreicht. Morgen wieder verfügbar (oder auf Pro upgraden).")
        else:
            await msg.edit_text(f"⚠️ Fehler beim Parsen ({r.status_code}). Prüfe Ollama.")
    except Exception:
        log.exception("handle_document error")
        await msg.edit_text("⚠️ Technischer Fehler. Bitte versuche es erneut.")


async def handle_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.message.text or ""
    if text.startswith("/"):
        return
    user = await _require_link(update)
    if not user:
        return
    if len(text) < 20:
        await update.message.reply_text("Text zu kurz zum Parsen. Bitte Buchungsbestätigung oder E-Mail einfügen.")
        return
    msg = await update.message.reply_text("⏳ Analysiere Text…")
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"{API_URL}/api/v1/parse/text",
            data={"raw_text": text},
            headers=_bot_headers(user["id"]),
        )
    if r.status_code == 200:
        parsed = r.json().get("parsed", {})
        title = parsed.get("title") or "Text"
        itype = parsed.get("type") or "other"
        icon = _ICONS.get(itype, "📋")
        inbox_id = r.json().get("inbox_id")
        # Build inline keyboard for assignment
        keyboard = None
        if inbox_id:
            async with httpx.AsyncClient(timeout=10) as c2:
                trips_r = await c2.get(f"{API_URL}/api/v1/trips", headers=_bot_headers(user["id"]))
            if trips_r.status_code == 200 and trips_r.json():
                trips = trips_r.json()[:6]
                buttons = [
                    [InlineKeyboardButton(f"➡️ {t['name']}", callback_data=f"assign:{inbox_id}:{t['id']}")]
                    for t in trips
                ]
                buttons.append([InlineKeyboardButton("🗑️ Ablehnen", callback_data=f"reject:{inbox_id}")])
                keyboard = InlineKeyboardMarkup(buttons)
        await msg.edit_text(
            f"{icon} *{title}* erkannt und im Inbox gespeichert.",
            reply_markup=keyboard,
            parse_mode="Markdown",
        )
    elif r.status_code == 429:
        await msg.edit_text("⚠️ Tageslimit erreicht.")
    else:
        await msg.edit_text("⚠️ Konnte Text nicht parsen.")


def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("link", cmd_link))
    app.add_handler(CommandHandler("unlink", cmd_unlink))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("trips", cmd_trips))
    app.add_handler(CommandHandler("next", cmd_next))
    app.add_handler(CommandHandler("inbox", cmd_inbox))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.Document.ALL | filters.PHOTO, handle_document))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    log.info("TCO Bot starting…")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
