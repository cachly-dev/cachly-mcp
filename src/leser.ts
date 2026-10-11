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
 * Leser weiter. Damit nicht jede Anfrage einen vergeblichen Umweg macht,
 * steht die Leser-Sicherung davor (leser-sicherung.ts): nach 3 Ausfaellen in
 * Folge — oder sofort bei 503 — wird der Leser 10 Minuten nicht gefragt.
 * Dieser Prozess lebt lange, die Sicherung bleibt im Speicher, eine je Instanz.
 *
 * Zahlen und Begruendung: rangfolge-stellschrauben.ts (LESER_*),
 * leser-sicherung.ts (LESER_SICHERUNG_*).
 */

import { embedConfig } from './embeddings.js';
import { LESER_GEWICHT, LESER_ZEITLIMIT_MS } from './rangfolge-stellschrauben.js';
import { LeserSicherung, frageLeser, speicherImProzess } from './leser-sicherung.js';

/** Eine Sicherung je Instanz: die API waehlt je Instanz einen anderen Leser. */
const sicherungen = new Map<string, LeserSicherung>();

function sicherungFuer(instanceId?: string): LeserSicherung {
  const schluessel = instanceId ?? '';
  let s = sicherungen.get(schluessel);
  if (!s) {
    s = new LeserSicherung(speicherImProzess());
    sicherungen.set(schluessel, s);
  }
  return s;
}

/** Ist der Leser ueberhaupt im Spiel? (Gewicht, Umgebung, Schluessel, Sicherung) */
export function leserAktiv(instanceId?: string): boolean {
  if (LESER_GEWICHT <= 0) return false;
  if ((process.env.CACHLY_LESER ?? '').toLowerCase() in { '0': 1, 'off': 1, 'aus': 1, 'false': 1 }) return false;
  if (!embedConfig.jwt) return false;
  // Nur nachsehen, nicht spannen: den einen Versuch nach der Pause gibt
  // leserPunkte frei (darfFragen), sonst ginge er hier verloren.
  return !sicherungFuer(instanceId).offen();
}

/** Nur fuer Tests: alle Sicherungen zuruecksetzen. */
export function leserSperreLoeschen(): void { sicherungen.clear(); }

/**
 * Punkte je Text (gleiche Reihenfolge wie `texte`), hoeher = passender —
 * oder `null`, wenn der Leser nicht antwortet. Wirft nie.
 */
export async function leserPunkte(
  frage: string,
  texte: string[],
  opts?: { zeitlimitMs?: number; fetchFn?: typeof fetch; instanceId?: string; zusatzKopf?: Record<string, string> },
): Promise<number[] | null> {
  if (!leserAktiv(opts?.instanceId) || texte.length === 0) return null;
  // instance_id: die API entscheidet damit, WELCHER Leser lesen darf —
  // der eigene Dienst im Haus, oder (nur fuer freigegebene Instanzen) Jev.
  // zusatzKopf: nur fuer Messlaeufe (X-Admin-Key). /rerank teilt den
  // Embed-Limiter (60 je Minute je Nutzer); ein Messlauf mit 2,7 Aufrufen
  // je Sekunde verlor am 07.10.2026 706 von 3.003 Leseraufrufen an HTTP 429.
  const antwort = await frageLeser({
    url: `${embedConfig.apiUrl}/api/v1/rerank`,
    jwt: embedConfig.jwt,
    frage,
    texte,
    instanceId: opts?.instanceId,
    zeitlimitMs: opts?.zeitlimitMs ?? LESER_ZEITLIMIT_MS,
    fetchFn: opts?.fetchFn,
    zusatzKopf: opts?.zusatzKopf,
  }, sicherungFuer(opts?.instanceId));
  return antwort.art === 'punkte' ? antwort.scores : null;
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
