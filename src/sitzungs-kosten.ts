/**
 * Sitzungs-Kosten des Gedaechtnisses (Karte eutmy0ly93ch, 02.09.2026).
 *
 * Am Ende einer Sitzung wusste niemand, wie oft das Brain befragt wurde und
 * was das gekostet hat. Eine erfolgreiche Sitzung kann trotzdem einen
 * ungesunden Pfad gehabt haben — die teuerste Form im Bench-Mitschnitt war
 * die Umformulierungs-Schleife: derselbe Abruf mit anderen Woertern, kein
 * Fehler dazwischen, jede Runde sendet den ganzen Kontext neu.
 *
 * Gezaehlt wird im Prozess (kein Redis-Schreiben je Aufruf), je Instanz:
 * Recall-Aufrufe, davon Wiederholungen (fast gleiche Anfrage) und die
 * Zeichen der Werkzeugantworten. session_end liest und loescht.
 */

export interface SitzungsKosten {
  recalls: number;
  wiederholungen: number;
  antwortZeichen: number;
}

interface Zustand extends SitzungsKosten {
  anfragen: Set<string>[];
}

const zustand = new Map<string, Zustand>();

/** Wortmenge einer Anfrage: Kleinbuchstaben, nur Woerter ab 3 Zeichen. */
export function wortmenge(text: string): Set<string> {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_:-]+/u)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Zwei Anfragen gelten als Wiederholung, wenn ihre Wortmengen zu mindestens
 * 60 % uebereinstimmen (Jaccard) — "deploy timeout netz" und "timeout beim
 * deploy im netz" sind dieselbe Frage, "redis eviction policy" nicht.
 */
export function istWiederholung(a: Set<string>, b: Set<string>): boolean {
  if (a.size < 2 || b.size < 2) return false;
  let schnitt = 0;
  for (const w of a) if (b.has(w)) schnitt++;
  const vereinigung = a.size + b.size - schnitt;
  return vereinigung > 0 && schnitt / vereinigung >= 0.6;
}

export function merkeRecall(instanceId: string, anfrage: string, antwortZeichen: number): void {
  const z = zustand.get(instanceId) ?? { recalls: 0, wiederholungen: 0, antwortZeichen: 0, anfragen: [] };
  const menge = wortmenge(anfrage);
  z.recalls += 1;
  z.antwortZeichen += Math.max(0, antwortZeichen | 0);
  if (z.anfragen.some((fruehere) => istWiederholung(fruehere, menge))) z.wiederholungen += 1;
  z.anfragen.push(menge);
  if (z.anfragen.length > 200) z.anfragen.shift();
  zustand.set(instanceId, z);
}

export function sitzungsKosten(instanceId: string): SitzungsKosten {
  const z = zustand.get(instanceId);
  return z
    ? { recalls: z.recalls, wiederholungen: z.wiederholungen, antwortZeichen: z.antwortZeichen }
    : { recalls: 0, wiederholungen: 0, antwortZeichen: 0 };
}

export function vergissSitzungsKosten(instanceId: string): void {
  zustand.delete(instanceId);
}

/** Grobe Token-Schaetzung: vier Zeichen je Token. */
export function geschaetzteToken(zeichen: number): number {
  return Math.round(zeichen / 4);
}

/** Die Zeilen fuer session_end; leer, wenn nichts abgerufen wurde. */
export function kostenZeilen(k: SitzungsKosten): string[] {
  if (k.recalls === 0) return [];
  const zeilen = [
    `🧾 **Gedächtnis-Kosten:** ${k.recalls} Recall${k.recalls === 1 ? '' : 's'}, davon ${k.wiederholungen} Wiederholung${k.wiederholungen === 1 ? '' : 'en'} (fast gleiche Anfrage), ~${geschaetzteToken(k.antwortZeichen)} Token Werkzeugantworten.`,
  ];
  if (k.wiederholungen >= 2) {
    zeilen.push('   ↪ Einmal abrufen, dann handeln — Umformulierungen liefern dieselben Treffer und kosten jede Runde den ganzen Kontext.');
  }
  return zeilen;
}
