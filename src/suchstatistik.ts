/**
 * Die Suchstatistik, die das Dashboard anzeigt.
 *
 * Warum es diese Datei gibt (03.09.2026): Das Dashboard zeigte einem Konto
 * mit 3.467 Abrufen "0 Suchen, 0 ms Latenz, keine haeufigen Anfragen". Der
 * Grund waren ZWEI Suchwege und nur EIN Zaehler. Die Zahlen unter
 * `cachly:meta:brain:*` schrieb ausschliesslich `recordStats` im Go-Pfad
 * (`api/internal/brainsearch/bm25.go`), den der gRPC-Dienst benutzt. Der
 * Hauptweg unserer Nutzer laeuft durch den MCP-Server, und dort schrieb
 * niemand.
 *
 * Die Schluesselnamen und ihre Bedeutung sind Zeichen fuer Zeichen dieselben
 * wie dort. Zwei Schreiber auf einem Satz Zahlen sind vertretbar, zwei
 * Zaehlweisen waeren es nicht: **wer hier einen Schluessel aendert, aendert
 * `recordStats` mit.**
 *
 * Eigene Datei und nicht in brain.ts, damit die Tests die echte Rechnung
 * pruefen koennen statt einer Kopie davon.
 */

/** Ein Rohr (Pipeline), so viel davon wie diese Datei braucht. */
export interface StatistikRohr {
  incr(key: string): unknown;
  expire(key: string, seconds: number): unknown;
  lpush(key: string, value: string): unknown;
  ltrim(key: string, start: number, stop: number): unknown;
  zincrby(key: string, increment: number, member: string): unknown;
  exec(): Promise<unknown>;
}

export interface RohrQuelle {
  pipeline(): StatistikRohr;
}

/** Die Schluessel. Vertrag mit `recordStats` in bm25.go. */
export const SUCHSTATISTIK_SCHLUESSEL = {
  gesamt: "cachly:meta:brain:total_searches",
  jeTag: (tag: string) => `cachly:meta:brain:searches:${tag}`,
  latenz: "cachly:meta:brain:latency_ms",
  bestenliste: "cachly:meta:brain:top_queries",
} as const;

/** Wie lange die Tageszahlen leben. Der Go-Pfad setzt dieselbe Frist. */
export const TAGESZAHL_TTL_SEKUNDEN = 7 * 24 * 3600;

/** Wie viele Latenzwerte aufbewahrt werden (fuer Mittelwert und 95er-Wert). */
export const LATENZ_FENSTER = 200;

/**
 * Einen Suchlauf mitschreiben. Best-effort: eine Messzeile stoppt nie die
 * Antwort, fuer die sie erhoben wird.
 */
export async function merkeSuchlauf(
  redis: RohrQuelle,
  frage: string,
  dauerMs: number,
): Promise<void> {
  try {
    const tag = new Date().toISOString().slice(0, 10);
    const tagesSchluessel = SUCHSTATISTIK_SCHLUESSEL.jeTag(tag);
    const rohr = redis.pipeline();
    rohr.incr(SUCHSTATISTIK_SCHLUESSEL.gesamt);
    rohr.incr(tagesSchluessel);
    rohr.expire(tagesSchluessel, TAGESZAHL_TTL_SEKUNDEN);
    // Eine Uhr, die zuruecksprang, darf keine negative Latenz eintragen: der
    // Mittelwert im Dashboard waere danach dauerhaft falsch.
    rohr.lpush(SUCHSTATISTIK_SCHLUESSEL.latenz, String(Math.max(0, Math.round(dauerMs))));
    rohr.ltrim(SUCHSTATISTIK_SCHLUESSEL.latenz, 0, LATENZ_FENSTER - 1);
    // Nur kurze Fragen in die Bestenliste, und auf eine Zeile gebracht: die
    // Liste steht im Dashboard und soll dort lesbar sein. Ueber 200 Zeichen
    // ist es keine Frage mehr, sondern ein eingefuegter Text -- der wuerde
    // die Liste unlesbar machen und den Bestand des Kunden aufblaehen.
    const q = frage.trim().split(/\s+/).join(" ");
    if (q.length > 0 && q.length <= 200) {
      rohr.zincrby(
        SUCHSTATISTIK_SCHLUESSEL.bestenliste,
        1,
        q.length > 80 ? `${q.slice(0, 80)}…` : q,
      );
    }
    await rohr.exec();
  } catch {
    // Absichtlich stumm, wie bumpRecallQuota.
  }
}
