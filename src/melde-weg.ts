// Kopf und Rumpf fuer den Melde-Weg POST /api/v1/telemetry/mcp.
//
// Der Schluessel reist nur im Kopf `Authorization`, wie bei jedem anderen
// Aufruf an die API. Bis 0.10.235 stand er im Rumpf (Felder `jwt` und
// `api_key`). Die API prueft ihn seit 09.11.2026, bevor sie ein Ereignis einem
// Konto zuschreibt (api/cmd/server/telemetrie_ausweis.go); vorher las sie den
// Inhaber eines Tokens ungeprueft.
//
// Eigenes Modul statt index.ts, weil index.ts beim Laden den Server startet
// und sich so nicht pruefen laesst.

import type { DashboardMetrics } from './telemetry-types.js';

/** Felder, die nie im Rumpf landen duerfen — auch nicht, wenn ein Aufrufer sie mitgibt. */
const SCHLUESSEL_FELDER = new Set(['api_key', 'jwt', 'apiKey', 'token', 'authorization']);

/** Kopfzeilen: Authorization nur, wenn ein Schluessel da ist. */
export function meldeKopf(schluessel: string | undefined): Record<string, string> {
  const s = (schluessel ?? '').trim();
  return { 'Content-Type': 'application/json', ...(s ? { Authorization: `Bearer ${s}` } : {}) };
}

/** Rumpf: Grundfelder, Kennzahlen, Zusatzfelder — ohne jedes Schluesselfeld. */
export function meldeRumpf(
  grund: Record<string, unknown>,
  extra?: Record<string, unknown>,
  metrics?: DashboardMetrics,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!SCHLUESSEL_FELDER.has(k)) rest[k] = v;
  }
  return { ...grund, ...(metrics ? { metrics } : {}), ...rest };
}
