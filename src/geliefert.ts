import { estimateTokens } from './ambient-recall.js';

/**
 * Wie viel Text kam aus dem Gedaechtnis statt aus dem Modell?
 *
 * ANLASS 19.08.2026, Heinrich: "Bei der Schaetzung der Tokenersparnis sollten
 * wir schauen, dass wir nicht nur schaetzen, denn das nervt Leute sehr stark.
 * Vielleicht machen wir eine weitere Metrik rein? Sowas wie Token, die bei den
 * Calls aus dem Brain rausgenommen wurden und nicht aus der AI vom Vendor
 * kamen?"
 *
 * ── Warum das die bessere Zahl ist ──────────────────────────────────────────
 *
 * Die bisherige Zahl "583k Token gespart" ist eine RECHNUNG: 1.200 Token je
 * wiederverwendeter Lektion mal 486 Abrufe. Der Faktor 1.200 ist geraten, und
 * jeder darf ihn bestreiten. Die Zahl hier ist eine SUMME: die Laenge der
 * Antworten, die das Brain wirklich zurueckgegeben hat. Da gibt es nichts zu
 * bestreiten — hoechstens die Frage, was sie bedeutet.
 *
 * ── Was sie NICHT sagt ──────────────────────────────────────────────────────
 *
 * Sie ist KEIN Beweis, dass das Modell diese Token sonst selbst erzeugt haette.
 * Vielleicht haette es die Antwort gar nicht gefunden, vielleicht kuerzer
 * geantwortet. Sie sagt genau eines, und das laesst sich nachrechnen: so viel
 * Text kam als Antwort aus dem Gedaechtnis. Wer mehr behauptet, schaetzt
 * wieder.
 *
 * Deshalb steht die Schaetzung weiter daneben — aber klein, mit ihrer Annahme
 * im selben Satz, und neben einer Zahl, die keine braucht.
 */

/**
 * Nur ABRUFE zaehlen, nicht jede Antwort.
 *
 * `learn_from_attempts` gibt eine Bestaetigung zurueck, `create_instance` eine
 * Kennung — das ist kein geliefertes Wissen. Gezaehlt wird, was Gespeichertes
 * herausgibt. Steht ein Werkzeug nicht auf dieser Liste, zaehlt es nicht mit;
 * die Zahl ist dadurch eher zu klein als zu gross, und das ist die richtige
 * Richtung fuer eine Zahl, mit der man wirbt.
 */
export const LIEFERNDE_WERKZEUGE = new Set([
  'smart_recall',
  'recall_best_solution',
  'recall_context',
  'recall_at',
  'causal_trace',
  'semantic_search',
  'brain_search',
  'team_recall',
  'global_recall',
  'session_start',
  'session_start_summary',
  'brain_briefing',
  'compact_recover',
  'session_handoff',
  'crystal_view',
  'brain_graph',
  'trace_dependency',
  'brain_who_knows',
  'fedbrain_search',
  'syndicate_search',
]);

export function istLieferung(werkzeugName: string): boolean {
  return LIEFERNDE_WERKZEUGE.has(werkzeugName);
}

/** Redis-Schluessel je Brain: Summe der gelieferten Token. */
export function lieferSchluessel(instanceId: string): string {
  return `cachly:stats:delivered_tokens:${instanceId}`;
}

/** Redis-Schluessel je Brain: Abrufe gesamt und davon mit Treffer. */
export function trefferSchluessel(instanceId: string): string {
  return `cachly:stats:recall_hits:${instanceId}`;
}

/**
 * Hatte dieser Abruf einen Treffer?
 *
 * Erkannt an dem, was die Antwort SAGT, nicht an ihrer Laenge: eine hoefliche
 * Absage ("keine passende Lektion gefunden") ist laenger als mancher Treffer.
 * Die Muster stammen aus den Antworttexten der Abruf-Werkzeuge selbst.
 */
const LEERE_ANTWORT =
  /(no (relevant |matching |cached )?(lessons?|results?|context|memory|match)|keine? (passende|relevante)|nothing (found|cached)|0 results|Results \(0\b|empty)/i;

export function hatTreffer(antwort: string): boolean {
  if (!antwort || antwort.trim().length === 0) return false;
  return !LEERE_ANTWORT.test(antwort);
}

/** Die Token dieser Antwort — dieselbe Schaetzfunktion wie beim Einblende-Budget. */
export function tokenDerAntwort(antwort: string): number {
  return estimateTokens(antwort);
}

export interface LieferBild {
  /** Summe der gelieferten Token. */
  token: number;
  /** Abrufe insgesamt. */
  abrufe: number;
  /** Davon mit mindestens einem Treffer. */
  treffer: number;
  /** treffer/abrufe, 0..1. Bei 0 Abrufen: 0. */
  quote: number;
}

export function lieferBild(roh: {
  token?: string | number | null;
  abrufe?: string | number | null;
  treffer?: string | number | null;
}): LieferBild {
  const zahl = (v: string | number | null | undefined): number => {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const token = zahl(roh.token);
  const abrufe = zahl(roh.abrufe);
  const treffer = Math.min(zahl(roh.treffer), abrufe);
  return { token, abrufe, treffer, quote: abrufe > 0 ? treffer / abrufe : 0 };
}

/** Grosse Zahlen so, wie ein Mensch sie liest. */
export function inWorten(bild: LieferBild): string {
  if (bild.abrufe === 0) {
    return 'Aus dem Brain geliefert: noch nichts — es gab bisher keinen Abruf.';
  }
  const t =
    bild.token >= 1_000_000
      ? `${(bild.token / 1_000_000).toFixed(2)} Mio.`
      : bild.token >= 1_000
        ? `${Math.round(bild.token / 1_000)}k`
        : `${bild.token}`;
  const prozent = Math.round(bild.quote * 100);
  return (
    `Aus dem Brain geliefert: ${t} Token in ${bild.abrufe} Abrufen. ` +
    `${bild.treffer} davon fanden etwas (${prozent} %). ` +
    `Gemessen, nicht gerechnet — es ist die Summe der Antwortlaengen, keine Annahme.`
  );
}
