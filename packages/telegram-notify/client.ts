/**
 * telegram-notify — shared Telegram notification client.
 *
 * Used by cachly-mcp (TypeScript) and TCO backend (Python via client.py).
 * Single source of truth for: emoji map, message format, env var convention.
 *
 * Interface: notify(app, event, payload)
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN          — bot token from @BotFather
 *   {APP_UPPER}_TELEGRAM_CHAT_ID — app-specific channel (e.g. CACHLY_TELEGRAM_CHAT_ID)
 *   TELEGRAM_CHAT_ID             — fallback for all apps
 *
 * No-op when unconfigured. Never throws.
 *
 * Note: emoji map is kept in sync with emojis.json (Python reads the JSON file at runtime).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: { env: Record<string, string | undefined> };

const EMOJI: Record<string, string> = {
  tool_call:          '🔧',
  tool_error:         '🔴',
  cache_hit:          '⚡',
  cache_miss:         '💭',
  auth_ok:            '🔑',
  auth_fail:          '🚫',
  startup:            '🚀',
  waitlist_signup:    '📬',
  parse_file:         '📄',
  parse_text:         '📝',
  parse_url:          '🔗',
  trip_created:       '🗺️',
  trip_deleted:       '🗑️',
  error:              '🔴',
  stripe_payment:     '💳',
  stripe_checkout:    '🛒',
  new_user:           '🆕',
  pdf_export:         '📑',
  trip_search:        '🔍',
  default:            '🔔',
};

function getToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? '';
}

function getChatId(app: string): string {
  const key = `${app.toUpperCase()}_TELEGRAM_CHAT_ID`;
  return process.env[key] ?? process.env.TELEGRAM_CHAT_ID ?? '';
}

export function formatMessage(
  app: string,
  event: string,
  payload: Record<string, unknown>,
): string {
  const icon = EMOJI[event] ?? EMOJI['default'];
  const lines = [`${icon} *${app.toUpperCase()}* · \`${event}\``];
  for (const [k, v] of Object.entries(payload)) {
    if (v !== null && v !== undefined && v !== '') {
      lines.push(`  ${k}: \`${String(v)}\``);
    }
  }
  return lines.join('\n');
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // never throws
  }
}
