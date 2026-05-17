/**
 * Shared notifier — Telegram (+ extensible to Slack/webhook).
 * Interface: notify(app, event, payload)
 *
 * Configure via env:
 *   TELEGRAM_BOT_TOKEN        — from @BotFather
 *   CACHLY_TELEGRAM_CHAT_ID   — chat/channel for cachly-mcp events
 *   TELEGRAM_CHAT_ID          — fallback for any app
 *
 * No-op when unconfigured. Never throws.
 */

const EMOJI: Record<string, string> = {
  tool_call:    "🔧",
  tool_error:   "🔴",
  cache_hit:    "⚡",
  cache_miss:   "💭",
  auth_ok:      "🔑",
  auth_fail:    "🚫",
  startup:      "🚀",
  waitlist:     "📬",
  default:      "🔔",
};

function getToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

function getChatId(app: string): string {
  const key = `${app.toUpperCase()}_TELEGRAM_CHAT_ID`;
  return process.env[key] ?? process.env.TELEGRAM_CHAT_ID ?? "";
}

function formatMessage(app: string, event: string, payload: Record<string, unknown>): string {
  const icon = EMOJI[event] ?? EMOJI.default;
  const lines = [`${icon} *${app.toUpperCase()}* · \`${event}\``];
  for (const [k, v] of Object.entries(payload)) {
    if (v !== null && v !== undefined && v !== "") {
      lines.push(`  ${k}: \`${String(v)}\``);
    }
  }
  return lines.join("\n");
}

export async function notify(
  app: string,
  event: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const token = getToken();
  const chatId = getChatId(app);
  if (!token || !chatId) return;

  try {
    const text = formatMessage(app, event, payload);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // never throws
  }
}
