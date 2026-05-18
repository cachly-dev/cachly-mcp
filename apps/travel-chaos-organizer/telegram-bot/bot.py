"""
TCO Telegram Bot
Commands: /start /link /trips /next /help
Forward any document/image/text → parsed via TCO AI
"""
import logging
import os
import tempfile
from dotenv import load_dotenv
import httpx
from telegram import Update, Document, PhotoSize
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    ContextTypes, filters,
)

load_dotenv()
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
API_URL = os.environ.get("TCO_API_URL", "http://localhost:8000")
BOT_SECRET = os.environ.get("TCO_BOT_SECRET", TOKEN)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


def api_headers() -> dict:
    return {"X-Bot-Token": BOT_SECRET}


async def get_linked_user(chat_id: str) -> dict | None:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{API_URL}/api/v1/users/by-telegram/{chat_id}", headers=api_headers())
        if r.status_code == 200:
            return r.json()
    return None


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "✈️ *Travel Chaos Organizer Bot*\n\n"
        "Ich helfe dir, deine Reisedokumente zu verwalten.\n\n"
        "*Erste Schritte:*\n"
        "1. Öffne die TCO-App → Einstellungen → Telegram verknüpfen\n"
        "2. Du bekommst einen 6-stelligen PIN\n"
        "3. Schreib mir: `/link 123456`\n\n"
        "Danach kannst du mir Buchungsbestätigungen, Screenshots oder PDFs schicken — ich parse sie automatisch!",
        parse_mode="Markdown"
    )


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "*TCO Bot — Befehle:*\n\n"
        "/trips — Deine Reisen anzeigen\n"
        "/next — Nächstes Event\n"
        "/link <PIN> — Konto verknüpfen\n"
        "/help — Diese Hilfe\n\n"
        "*Dokumente senden:*\n"
        "Einfach Buchungsbestätigung, PDF oder Screenshot schicken — wird automatisch geparst ✨",
        parse_mode="Markdown"
    )


async def cmd_link(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Bitte PIN angeben: `/link 123456`", parse_mode="Markdown")
        return
    pin = ctx.args[0].strip()
    chat_id = str(update.effective_chat.id)
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(f"{API_URL}/api/v1/users/telegram-link", params={"pin": pin, "chat_id": chat_id})
    if r.status_code == 200:
        await update.message.reply_text("✅ Konto erfolgreich verknüpft! Schick mir jetzt eine Buchungsbestätigung.")
    elif r.status_code == 410:
        await update.message.reply_text("⏰ PIN abgelaufen. Bitte neuen PIN in der App generieren.")
    elif r.status_code == 404:
        await update.message.reply_text("❌ PIN nicht gefunden. Bitte prüfe die Eingabe.")
    else:
        await update.message.reply_text("⚠️ Fehler beim Verknüpfen. Bitte versuche es erneut.")


async def cmd_trips(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    user = await get_linked_user(chat_id)
    if not user:
        await update.message.reply_text("Bitte zuerst Konto verknüpfen: `/link <PIN>`", parse_mode="Markdown")
        return
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{API_URL}/api/v1/trips", headers={**api_headers(), "X-User-Id": user["id"]})
    if r.status_code != 200:
        await update.message.reply_text("⚠️ Fehler beim Laden der Trips.")
        return
    trips = r.json()
    if not trips:
        await update.message.reply_text("Noch keine Trips. Erstelle deinen ersten Trip in der TCO-App!")
        return
    lines = ["✈️ *Deine Trips:*\n"]
    for t in trips[:8]:
        start = t.get("start_date", "?")[:10] if t.get("start_date") else "?"
        end = t.get("end_date", "?")[:10] if t.get("end_date") else "?"
        lines.append(f"• *{t['name']}* — {start} → {end}")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def cmd_next(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    user = await get_linked_user(chat_id)
    if not user:
        await update.message.reply_text("Bitte zuerst Konto verknüpfen: `/link <PIN>`", parse_mode="Markdown")
        return
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{API_URL}/api/v1/trips", headers={**api_headers(), "X-User-Id": user["id"]})
    if r.status_code != 200 or not r.json():
        await update.message.reply_text("Keine Trips gefunden.")
        return
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    upcoming = [t for t in r.json() if t.get("start_date") and t["start_date"] >= now[:10]]
    if not upcoming:
        await update.message.reply_text("Kein nächster Trip gefunden.")
        return
    t = upcoming[0]
    await update.message.reply_text(
        f"🗓️ *Nächster Trip:*\n\n"
        f"*{t['name']}*\n"
        f"Start: {t.get('start_date', '?')[:10]}\n"
        f"Ende: {t.get('end_date', '?')[:10]}",
        parse_mode="Markdown"
    )


async def handle_document(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    user = await get_linked_user(chat_id)
    if not user:
        await update.message.reply_text("Bitte zuerst Konto verknüpfen: `/link <PIN>`", parse_mode="Markdown")
        return
    msg = await update.message.reply_text("⏳ Analysiere Dokument…")
    doc = update.message.document
    photo = update.message.photo
    caption = update.message.caption or ""
    try:
        if photo:
            file = await ctx.bot.get_file(photo[-1].file_id)
            mime = "image/jpeg"
            fname = "photo.jpg"
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
                headers={**api_headers(), "X-User-Id": user["id"]},
            )
        if r.status_code == 200:
            parsed = r.json().get("parsed", {})
            title = parsed.get("title") or "Dokument"
            ptype = parsed.get("type") or "other"
            ref = parsed.get("booking_ref") or ""
            provider = parsed.get("provider") or ""
            event_at = parsed.get("event_at") or ""
            lines = [f"✅ *{title}*", f"Typ: {ptype}"]
            if provider: lines.append(f"Anbieter: {provider}")
            if ref: lines.append(f"Ref: `{ref}`")
            if event_at: lines.append(f"Datum: {event_at[:16].replace('T', ' ')}")
            lines.append("\n📥 Im Chaos Inbox gespeichert. Öffne die App zum Zuweisen.")
            await msg.edit_text("\n".join(lines), parse_mode="Markdown")
        elif r.status_code == 429:
            await msg.edit_text("⚠️ Tageslimit erreicht. Morgen wieder verfügbar (oder auf Pro upgraden).")
        else:
            await msg.edit_text(f"⚠️ Fehler beim Parsen ({r.status_code}). Prüfe Ollama.")
    except Exception as e:
        log.exception("handle_document error")
        await msg.edit_text("⚠️ Technischer Fehler. Bitte versuche es erneut.")


async def handle_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.message.text or ""
    if text.startswith("/"):
        return  # unknown command — ignore
    chat_id = str(update.effective_chat.id)
    user = await get_linked_user(chat_id)
    if not user:
        await update.message.reply_text("Bitte zuerst Konto verknüpfen: `/link <PIN>`", parse_mode="Markdown")
        return
    if len(text) < 20:
        await update.message.reply_text("Text zu kurz zum Parsen. Bitte Buchungsbestätigung oder E-Mail einfügen.")
        return
    msg = await update.message.reply_text("⏳ Analysiere Text…")
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"{API_URL}/api/v1/parse/text",
            data={"raw_text": text},
            headers={**api_headers(), "X-User-Id": user["id"]},
        )
    if r.status_code == 200:
        parsed = r.json().get("parsed", {})
        title = parsed.get("title") or "Text"
        await msg.edit_text(f"✅ *{title}* erkannt und im Inbox gespeichert.", parse_mode="Markdown")
    elif r.status_code == 429:
        await msg.edit_text("⚠️ Tageslimit erreicht.")
    else:
        await msg.edit_text("⚠️ Konnte Text nicht parsen.")


def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("link", cmd_link))
    app.add_handler(CommandHandler("trips", cmd_trips))
    app.add_handler(CommandHandler("next", cmd_next))
    app.add_handler(MessageHandler(filters.Document.ALL | filters.PHOTO, handle_document))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    log.info("TCO Bot starting…")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
