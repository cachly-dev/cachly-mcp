/**
 * ══ Der Leser: Frage und Lektion gemeinsam lesen ══════════════════════════
 *
 * Ein Cross-Encoder sieht Frage und Lektionstext als EIN Eingabepaar und sagt,
 * wie gut sie zusammenpassen — anders als der Bedeutungsabgleich, der zwei
 * getrennt berechnete Vektoren vergleicht. Das Modell ist am Hausbestand
 * gelernt (bench/leser/leser-trainieren.py) und laeuft als Dienst hinter
 * POST /api/v1/rerank; dieser Baustein ist nur der Anruf dorthin.
 *
 * Verhalten im Fehlerfall ist Absicht: jede Stoerung (kein Dienst, 503,
 * Zeitlimit, kaputte Antwort) liefert `null`, und der Aufrufer sortiert ohne
 * Leser weiter. Ein 503 ("nicht konfiguriert") wird zehn Minuten gemerkt,
 * damit nicht jede Anfrage einen vergeblichen Umweg macht.
 *
 * Zahlen und Begruendung: rangfolge-stellschrauben.ts (LESER_*).
 */

import { embedConfig } from './embeddings.js';
import { LESER_GEWICHT, LESER_ZEITLIMIT_MS } from './rangfolge-stellschrauben.js';

const SPERRE_MS = 10 * 60_000;
let gesperrtBis = 0;

/** Ist der Leser ueberhaupt im Spiel? (Gewicht, Umgebung, Schluessel, Sperre) */
export function leserAktiv(): boolean {
  if (LESER_GEWICHT <= 0) return false;
  if ((process.env.CACHLY_LESER ?? '').toLowerCase() in { '0': 1, 'off': 1, 'aus': 1, 'false': 1 }) return false;
  if (!embedConfig.jwt) return false;
  return Date.now() >= gesperrtBis;
}

/** Nur fuer Tests: die Sperre zuruecksetzen. */
export function leserSperreLoeschen(): void { gesperrtBis = 0; }

/**
 * Punkte je Text (gleiche Reihenfolge wie `texte`), hoeher = passender —
 * oder `null`, wenn der Leser nicht antwortet. Wirft nie.
 */
export async function leserPunkte(
  frage: string,
  texte: string[],
  opts?: { zeitlimitMs?: number; fetchFn?: typeof fetch },
): Promise<number[] | null> {
  if (!leserAktiv() || texte.length === 0) return null;
  const zeitlimit = opts?.zeitlimitMs ?? LESER_ZEITLIMIT_MS;
  const f = opts?.fetchFn ?? fetch;
  try {
    const res = await f(`${embedConfig.apiUrl}/api/v1/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${embedConfig.jwt}`,
      },
      body: JSON.stringify({ query: frage, texts: texte }),
      signal: AbortSignal.timeout(zeitlimit),
    });
    if (res.status === 503) {
      // Kein Dienst dahinter (oder Sicherung offen): zehn Minuten nicht fragen.
      gesperrtBis = Date.now() + SPERRE_MS;
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json() as { scores?: unknown };
    const scores = Array.isArray(j.scores) ? j.scores : null;
    if (!scores || scores.length !== texte.length || !scores.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return null;
    }
    return scores as number[];
  } catch {
    return null;
  }
}

/**
 * Die Mischung, die gemessen wurde (Arm L4): Hauspunkt und Leserpunkt je im
 * Topf gespreizt (0..1) und 1:1 addiert. Liefert die neue Reihenfolge der
 * Indizes 0..n-1. Reine Rechnung, ohne Netz — damit der Messstand und der
 * Auslieferpfad dieselbe Mischung benutzen.
 */
export function mischeMitLeser(haus: number[], leser: number[], gewicht = LESER_GEWICHT): number[] {
  const spreiz = (w: number[]): number[] => {
    const lo = Math.min(...w);
    const hi = Math.max(...w);
    return hi > lo ? w.map((x) => (x - lo) / (hi - lo)) : w.map(() => 0);
  };
  const h = spreiz(haus);
  const l = spreiz(leser);
  return haus
    .map((_, i) => ({ i, p: h[i] + gewicht * l[i] }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x) => x.i);
}
