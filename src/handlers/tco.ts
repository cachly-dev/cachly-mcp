/**
 * Travel Chaos Organizer — MCP bridge.
 *
 * Exposes the TCO REST API as MCP tools so any Claude instance with cachly-mcp
 * configured can manage travel plans through natural language.
 *
 * Auth: TCO and Cachly share the same Keycloak realm, so the Cachly JWT
 * (CACHLY_JWT env var) is forwarded as-is to the TCO backend — no extra
 * credentials needed.
 *
 * Config:
 *   TCO_API_URL   — base URL of the TCO FastAPI backend (e.g. http://localhost:8000)
 *                   If not set, all tools return a configuration error.
 */

const TCO_URL = process.env.TCO_API_URL ?? '';

export const TCO_TOOL_NAMES = new Set([
  'tco_list_trips',
  'tco_create_trip',
  'tco_get_timeline',
  'tco_delete_trip',
  'tco_inbox_list',
  'tco_inbox_assign',
  'tco_inbox_reject',
  'tco_parse_url',
  'tco_import_email',
  'tco_parse_text',
  'tco_cache_stats',
  'tco_provision_cache',
]);

type TcoFetch = (path: string, jwt: string, init?: RequestInit) => Promise<unknown>;

async function tcoFetch(path: string, jwt: string, init: RequestInit = {}): Promise<unknown> {
  if (!TCO_URL) {
    throw new Error(
      'TCO_API_URL is not configured. Add `TCO_API_URL=http://<your-tco-host>:8000` to your environment.'
    );
  }
  const res = await fetch(`${TCO_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TCO API ${res.status}: ${text}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (res.status === 204 || !ct.includes('application/json')) return null;
  return res.json();
}

function noConfig(): string {
  return (
    '⚙️  **TCO not configured.**\n\n' +
    'Set `TCO_API_URL=http://<host>:8000` in your environment and restart cachly-mcp.\n' +
    'See `apps/travel-chaos-organizer/README.md` for setup instructions.'
  );
}

function fmt(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export async function handleTcoTool(
  name: string,
  args: Record<string, unknown>,
  jwt: string,
): Promise<string | null> {
  if (!TCO_TOOL_NAMES.has(name)) return null;
  if (!TCO_URL) return noConfig();

  try {
    switch (name) {

      // ── List all trips ───────────────────────────────────────────────────
      case 'tco_list_trips': {
        const trips = await tcoFetch('/api/v1/trips', jwt);
        const list = trips as Array<Record<string, unknown>>;
        if (!list.length) return '📭 No trips yet. Use `tco_create_trip` to get started.';
        const rows = list.map((t) => {
          const dates = t.start_date
            ? `${t.start_date}${t.end_date ? ` → ${t.end_date}` : ''}`
            : 'no dates';
          return `• **${t.name}** \`${t.id}\` — ${dates}`;
        });
        return `🗺️  **Your trips (${list.length}):**\n\n${rows.join('\n')}`;
      }

      // ── Create a trip ────────────────────────────────────────────────────
      case 'tco_create_trip': {
        const { name: tripName, description = null, start_date = null, end_date = null } = args as {
          name: string; description?: string | null; start_date?: string | null; end_date?: string | null;
        };
        const trip = await tcoFetch('/api/v1/trips', jwt, {
          method: 'POST',
          body: JSON.stringify({ name: tripName, description, start_date, end_date }),
        });
        const t = trip as Record<string, unknown>;
        return `✅ Trip **${t.name}** created (id: \`${t.id}\`)`;
      }

      // ── Get timeline for a trip ──────────────────────────────────────────
      case 'tco_get_timeline': {
        const { trip_id } = args as { trip_id: string };
        const items = await tcoFetch(`/api/v1/trips/${trip_id}/items`, jwt);
        const list = items as Array<Record<string, unknown>>;
        if (!list.length) return `📂 Trip \`${trip_id}\` has no timeline items yet. Upload a document to get started.`;

        const TYPE_ICONS: Record<string, string> = {
          flight: '✈️', train: '🚂', bus: '🚌', hotel: '🏨',
          rental_car: '🚗', activity: '🎡', transfer: '🚕', document: '📄', other: '📋',
        };
        const rows = list.map((i) => {
          const icon = TYPE_ICONS[i.type as string] ?? '📋';
          const time = i.event_at ? ` · ${(i.event_at as string).slice(0, 16).replace('T', ' ')}` : '';
          const ref = i.booking_ref ? ` · #${i.booking_ref}` : '';
          const provider = i.provider ? ` · ${i.provider}` : '';
          return `${icon} **${i.title}**${time}${provider}${ref}`;
        });
        return `📅 **Timeline (${list.length} items):**\n\n${rows.join('\n')}`;
      }

      // ── Delete a trip ────────────────────────────────────────────────────
      case 'tco_delete_trip': {
        const { trip_id } = args as { trip_id: string };
        await tcoFetch(`/api/v1/trips/${trip_id}`, jwt, { method: 'DELETE' });
        return `🗑️ Trip \`${trip_id}\` deleted.`;
      }

      // ── Inbox: list pending items ────────────────────────────────────────
      case 'tco_inbox_list': {
        const status = (args.status as string | undefined) ?? 'pending';
        const items = await tcoFetch(`/api/v1/inbox?status_filter=${status}`, jwt);
        const list = items as Array<Record<string, unknown>>;
        if (!list.length) return `🎉 Chaos inbox is empty (status: ${status}).`;
        const rows = list.map((i) => {
          const pd = i.parsed_data as Record<string, unknown> | null;
          const title = (pd?.title as string | undefined) ?? '(no title)';
          const src = (i.source as string | undefined) ?? 'unknown source';
          return `• **${title}** \`${i.id}\` — from ${src}`;
        });
        return `📥 **Inbox (${list.length} ${status}):**\n\n${rows.join('\n')}\n\nUse \`tco_inbox_assign\` to move to a trip.`;
      }

      // ── Inbox: assign item to trip ───────────────────────────────────────
      case 'tco_inbox_assign': {
        const { inbox_id, trip_id, type = 'other' } = args as {
          inbox_id: string; trip_id: string; type?: string;
        };
        const result = await tcoFetch(`/api/v1/inbox/${inbox_id}/assign`, jwt, {
          method: 'POST',
          body: JSON.stringify({ trip_id, type }),
        });
        const r = result as Record<string, unknown>;
        return `✅ Inbox item assigned to trip. New timeline item id: \`${r.trip_item_id}\``;
      }

      // ── Inbox: reject / delete item ──────────────────────────────────────
      case 'tco_inbox_reject': {
        const { inbox_id } = args as { inbox_id: string };
        await tcoFetch(`/api/v1/inbox/${inbox_id}`, jwt, { method: 'DELETE' });
        return `🗑️ Inbox item \`${inbox_id}\` rejected and removed.`;
      }

      // ── Parse a public URL into a trip ───────────────────────────────────
      case 'tco_parse_url': {
        const { url, trip_id } = args as { url: string; trip_id?: string };
        const body: Record<string, string> = { url };
        if (trip_id) body.trip_id = trip_id;
        const result = await tcoFetch('/api/v1/parse/url', jwt, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const r = result as Record<string, unknown>;
        const confidence = typeof r.confidence === 'number' ? ` (confidence: ${Math.round(r.confidence * 100)}%)` : '';
        const dest = trip_id ? `trip \`${trip_id}\`` : 'chaos inbox';
        return `✅ URL parsed and saved to ${dest}${confidence}.\n\nParsed: ${fmt(r.parsed_data ?? r)}`;
      }

      // ── Import email text into inbox or trip ─────────────────────────────
      case 'tco_import_email': {
        const { raw_email, trip_id } = args as { raw_email: string; trip_id?: string };
        const body: Record<string, string> = { raw_email };
        if (trip_id) body.trip_id = trip_id;
        const result = await tcoFetch('/api/v1/mail/import', jwt, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const r = result as Record<string, unknown>;
        const dest = trip_id ? `trip \`${trip_id}\`` : 'chaos inbox';
        return `✅ Email imported to ${dest}. Inbox id: \`${r.inbox_id ?? '?'}\``;
      }

      // ── Parse raw text via Ollama (Cachly-cached) ────────────────────────
      case 'tco_parse_text': {
        const { text, trip_id } = args as { text: string; trip_id?: string };
        const params = new URLSearchParams();
        params.set('raw_text', text);
        if (trip_id) params.set('trip_id', trip_id);
        const result = await tcoFetch('/api/v1/parse/text', jwt, {
          method: 'POST',
          body: params.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const r = result as Record<string, unknown>;
        const parsed = r.parsed as Record<string, unknown> | undefined;
        const cached = (r as Record<string, unknown>).cached;
        const dest = trip_id ? `trip \`${trip_id}\`` : 'Chaos Inbox';
        const cacheNote = cached ? ' ⚡ **(Cache Hit — kein AI-Call)**' : '';
        const confidence = typeof parsed?.confidence === 'number'
          ? ` (confidence: ${Math.round((parsed.confidence as number) * 100)}%)`
          : '';
        return `✅ Text geparst und in ${dest} gespeichert${confidence}${cacheNote}.\n\nParsed: ${fmt(parsed ?? r)}`;
      }

      // ── Cachly Redis cache stats ─────────────────────────────────────────
      case 'tco_cache_stats': {
        const stats = await tcoFetch('/api/v1/cache/stats', jwt) as Record<string, unknown>;
        if (!stats.configured) {
          return (
            '📭 **Cachly Redis ist nicht verbunden.**\n\n' +
            'Setze `CACHLY_REDIS_URL=redis://<host>:6379/0` in der TCO `.env` und deploye neu.\n' +
            'Nutze `tco_provision_cache` um eine kostenlose Cachly-Instanz zu erstellen.'
          );
        }
        const hits = stats.hits as number;
        const misses = stats.misses as number;
        const total = hits + misses;
        const hitPct = total > 0 ? Math.round((hits / total) * 100) : 0;
        const saved = hits > 0
          ? `\n\n💡 **~${hits} AI-Calls eingespart** (jeder Cache Hit = kein Ollama-Aufruf).`
          : '';
        return (
          `✅ **Cachly Redis — aktiv**\n\n` +
          `| Metric | Wert |\n|--------|------|\n` +
          `| Cache Hits | **${hits}** |\n` +
          `| Cache Misses | ${misses} |\n` +
          `| Hit Rate | **${hitPct}%** |\n` +
          `| Gecachte Dokumente | ${stats.key_count} |\n` +
          `| TTL | ${stats.ttl_days} Tage |` +
          saved
        );
      }

      // ── Provision a Cachly free instance for TCO ─────────────────────────
      case 'tco_provision_cache': {
        const CACHLY_API = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
        const res = await fetch(`${CACHLY_API}/instances`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'tco-cache', tier: 'free' }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          // Instance may already exist — try to fetch it
          if (res.status === 409 || txt.includes('already')) {
            const listRes = await fetch(`${CACHLY_API}/instances`, {
              headers: { Authorization: `Bearer ${jwt}` },
            });
            if (listRes.ok) {
              const list = await listRes.json() as Array<Record<string, unknown>>;
              const existing = list.find((i) => i.name === 'tco-cache');
              if (existing) {
                return (
                  `ℹ️ **Instanz "tco-cache" existiert bereits.**\n\n` +
                  `Redis URL: \`${existing.redis_url ?? existing.connection_string ?? '(siehe Cachly Dashboard)'}\`\n\n` +
                  `Setze in der TCO \`.env\`:\n\`\`\`\nCACHLY_REDIS_URL=${existing.redis_url ?? existing.connection_string}\n\`\`\`\n` +
                  `Dann: \`bash scripts/deploy.sh\``
                );
              }
            }
          }
          throw new Error(`Cachly API ${res.status}: ${txt}`);
        }

        const instance = await res.json() as Record<string, unknown>;
        const redisUrl = instance.redis_url ?? instance.connection_string ?? '';
        return (
          `🎉 **Cachly Redis Instanz erstellt!**\n\n` +
          `Name: \`tco-cache\` (Free Tier, 25 MB)\n` +
          `Redis URL: \`${redisUrl}\`\n\n` +
          `**Setup (2 Schritte):**\n` +
          `1. Füge zur TCO \`.env\` hinzu:\n\`\`\`\nCACHLY_REDIS_URL=${redisUrl}\n\`\`\`\n` +
          `2. Neu deployen:\n\`\`\`bash\nbash scripts/deploy.sh\n\`\`\`\n\n` +
          `Ab sofort werden alle Ollama Parse-Ergebnisse gecacht — kein zweiter AI-Call für dasselbe Dokument.`
        );
      }

      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ TCO error: ${msg}`;
  }
}
