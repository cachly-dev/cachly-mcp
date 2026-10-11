// Warten auf eine startende Instanz — Takt und EIN Aufbau je Instanz.
//
// ── Warum es das gibt (11.10.2026) ──────────────────────────────────────────
//
// Gemessen mit CACHLY_ZEITMESSUNG=1 an einem frisch angelegten Brain: von
// 10,4 s bis zur ersten Antwort gingen 9,2 s ins Warten auf `running`. Zwei
// Dinge daran lagen beim MCP-Server und nicht beim Cluster:
//
//   1. Der Takt war 3 s. Eine neue Instanz laeuft nach 6 bis 9 s; im Mittel
//      gingen 1,5 s, im schlimmsten Fall 3 s nur durch den Takt verloren.
//   2. Zwei Warteschleifen liefen nebeneinander (Werkzeugzaehlung und
//      smart_recall), fragten doppelt ab und bauten zwei Valkey-Verbindungen;
//      eine davon blieb ungenutzt offen.
//
// Der Server bietet kein Warten auf die Rueckmeldung an. Also oefter
// nachsehen (eine Abfrage kostet 40 bis 150 ms) — und nur in EINER Schleife je
// Instanz, damit es bei hoechstens einer Abfrage je Sekunde bleibt.

/** Takt, in dem nachgesehen wird, ob eine startende Instanz laeuft. */
export const PROVISION_TAKT_MS = 1000;

const schlafe = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fragt im Takt nach, solange die Instanz `provisioning` meldet und die Frist
 * laeuft. Gibt den letzten Stand zurueck — `running` oder was sonst kam.
 */
export async function warteAufLaufendeInstanz<T extends { status?: string }>(
  erste: T,
  abfragen: () => Promise<T>,
  opts: {
    fristMs: number;
    taktMs?: number;
    schlafen?: (ms: number) => Promise<void>;
    jetzt?: () => number;
    /** Jeder neue Stand, z. B. fuer die Zeitmessung. */
    melde?: (stand: T) => void;
  },
): Promise<T> {
  const jetzt = opts.jetzt ?? Date.now;
  const schlafen = opts.schlafen ?? schlafe;
  const takt = opts.taktMs ?? PROVISION_TAKT_MS;
  const frist = jetzt() + opts.fristMs;
  let stand = erste;
  while (stand.status === 'provisioning' && jetzt() < frist) {
    await schlafen(takt);
    stand = await abfragen();
    opts.melde?.(stand);
  }
  return stand;
}

/**
 * Ein Aufbau je Schluessel: wer kommt, waehrend einer laeuft, bekommt dasselbe
 * Versprechen. Ist es erledigt (gut oder schlecht), baut der naechste neu.
 */
export function gemeinsamerAufbau<T>(
  laufend: Map<string, Promise<T>>,
  schluessel: string,
  bauen: () => Promise<T>,
): Promise<T> {
  const da = laufend.get(schluessel);
  if (da) return da;
  const aufbau = bauen().finally(() => laufend.delete(schluessel));
  laufend.set(schluessel, aufbau);
  return aufbau;
}
