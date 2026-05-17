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

      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ TCO error: ${msg}`;
  }
}
