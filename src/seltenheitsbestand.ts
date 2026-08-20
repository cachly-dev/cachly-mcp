/**
 * Die Seltenheit der Wörter im Bestand — einmal gelesen, dann stehend.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * `bewerteTopf` (src/rangfolge.ts) gewichtet die Seltenheits-Deckung mit 1,3 —
 * dem höchsten Gewicht von allen. Sie zu rechnen verlangt die Wortstatistik
 * über den GANZEN Bestand, nicht nur über die Kandidaten.
 *
 * Diese Statistik bei jeder Frage neu aufzubauen wäre genau der Fehler, den
 * der Wortabgleich heute macht: gemessen am 19.08.2026 baut er seinen Index
 * bei JEDER Frage neu, 1,6 ms je Lektion — bei 2000 Lektionen 3,2 Sekunden,
 * womit das 3-Sekunden-Budget der automatischen Einblendung reißt.
 *
 * Also dasselbe Muster wie `Vektorbestand`: einmal laden, eine Minute lang
 * gültig, danach nachladen. Ein voller Lesevorgang je Minute statt einer je
 * Frage.
 *
 * ── Was hier NICHT passiert ─────────────────────────────────────────────────
 *
 * Es wird keine zweite Zerlegung gebaut. `inhaltsWoerter` und `grobStamm`
 * kommen aus rangfolge.ts — dieselben Funktionen, die auch der Sortierer
 * benutzt. Zwei Zerlegungen desselben Textes wären zwei Wahrheiten, und die
 * Deckung würde gegen eine Statistik gerechnet, die anders zählt als sie.
 */

import type { Redis } from 'ioredis';
import { Seltenheit } from './rangfolge.js';

const LEKTION_PRAEFIX = 'cachly:lesson:best:';

/** Der Text einer Lektion, so wie ihn auch der Messstand bildet. */
export function lektionsText(l: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  return [s(l.topic), s(l.what_worked), s(l.what_failed)].filter(Boolean).join(' ');
}

export class Seltenheitsbestand {
  private seltenheit: Seltenheit | null = null;
  private texte = new Map<string, string>();
  private geladen = 0;

  constructor(private readonly frischeMs = 60_000) {}

  get groesse(): number { return this.texte.size; }

  /** Der Wortschatz einer Lektion, oder ein leerer Text, wenn sie fehlt. */
  textVon(topic: string): string { return this.texte.get(topic) ?? ''; }

  /**
   * Alle Themen des Bestands.
   *
   * Wird für die Vorauswahl gebraucht: sie muss über ALLE Lektionen laufen,
   * nicht nur über die, die zufällig einen bestimmten Vektor haben. Genau
   * daran ist der erste Verdrahtungsversuch am 20.08.2026 gescheitert — die
   * Vorauswahl lief nur über die 399 Lektionen mit Fehlertext, und die
   * restlichen 108 konnten nicht mehr gefunden werden (Trefferlage 90 % auf
   * 70 % gefallen).
   */
  themen(): IterableIterator<string> { return this.texte.keys(); }

  /** Die Statistik selbst. `null`, solange nie geladen wurde. */
  get statistik(): Seltenheit | null { return this.seltenheit; }

  async aktualisiere(redis: Redis, jetzt = Date.now()): Promise<void> {
    if (this.seltenheit && jetzt - this.geladen < this.frischeMs) return;

    const schluessel: string[] = [];
    let cursor = '0';
    do {
      const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${LEKTION_PRAEFIX}*`, 'COUNT', 500);
      cursor = next;
      schluessel.push(...gefunden);
    } while (cursor !== '0');

    if (schluessel.length === 0) return; // Lieber die alte Statistik als gar keine.

    const texte = new Map<string, string>();
    for (let i = 0; i < schluessel.length; i += 100) {
      const block = schluessel.slice(i, i + 100);
      const werte = await redis.mget(...block);
      for (const [j, roh] of werte.entries()) {
        if (!roh) continue;
        try {
          const o = JSON.parse(roh) as Record<string, unknown>;
          const topic = typeof o.topic === 'string' && o.topic
            ? o.topic
            : block[j].slice(LEKTION_PRAEFIX.length);
          if (topic) texte.set(topic, lektionsText(o));
        } catch { /* eine kaputte Zeile ist ein Thema fuer doctor, nicht fuer den Recall */ }
      }
    }

    this.texte = texte;
    this.seltenheit = new Seltenheit([...texte.values()]);
    this.geladen = jetzt;
  }
}
