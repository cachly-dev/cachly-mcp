/**
 * Resonanz — eine Lektion wird durch die Fragen adressiert, die zu ihr fuehrten.
 *
 * ── Das Vorbild ─────────────────────────────────────────────────────────────
 *
 * Das Hologramm speichert nicht das Bild, sondern das Interferenzmuster des
 * Lichts, das es beleuchtet hat. Beleuchtet man es spaeter wieder, entsteht
 * das Bild aus dem Muster — und jeder Splitter traegt das Ganze, nur unschaerfer.
 *
 * ── Das Problem, gegen das es antritt ───────────────────────────────────────
 *
 * Jeder Index in diesem Haus beschreibt, was eine Lektion SAGT: ihr Volltext,
 * ihr Themenname. Gesucht wird aber mit dem, was jemand FRAGT — und die beiden
 * Sprachen fallen auseinander. Gemessen am 21.08.2026: von 100 Fragen liegen
 * 11 auf Platz 100+ der Bedeutungsrangfolge. Fuer die ist die richtige Lektion
 * semantisch nicht "in der Naehe" — keine Vektorrechnung ueber ihren Text holt
 * sie naeher heran.
 *
 * Diese Datei fuehrt deshalb eine dritte Sicht: je Lektion die laufende
 * Ueberlagerung aller Fragevektoren, die nachweislich zu ihr gefuehrt haben.
 * Der Vergleich laeuft dann Frage-gegen-Frage statt Frage-gegen-Text.
 *
 * ── Warum wir das koennen und andere nicht ──────────────────────────────────
 *
 * Es braucht die geschlossene Schleife: von der Frage ueber den Treffer bis zu
 * der Bestaetigung, dass der Treffer richtig war. Ein Suchindex, der nur
 * Dokumente kennt, hat diese Daten nicht.
 *
 * ── Die ehrliche Grenze ─────────────────────────────────────────────────────
 *
 * Der Index ist am Anfang leer. Eine Lektion, die noch nie gefunden wurde, hat
 * keine Resonanz — und ausgerechnet die braeuchte sie am dringendsten. Das ist
 * kein Fehler der Idee, sondern ihre Bauart: sie wird mit der Zeit besser und
 * am ersten Tag gar nicht. Deshalb ist sie ein ZUSATZ und ersetzt keine Sicht.
 */

import type { Redis } from 'ioredis';
import { packe, entpacke, kosinus } from './bedeutung.js';

/** Schluessel-Vorsatz der Resonanzvektoren. */
export const RESONANZ_PRAEFIX = 'cachly:lesson:res:';

/**
 * Fuegt einen Fragevektor zur Resonanz einer Lektion.
 *
 * Die Ueberlagerung ist eine gleitende Summe mit Normierung: der neue Vektor
 * zieht die Resonanz um `anteil` in seine Richtung. Ohne Normierung waeren
 * haeufig gefundene Lektionen einfach laenger und wuerden jeden Kosinus
 * gewinnen — die Naehe misst dann Beliebtheit statt Passung.
 *
 * `anteil` bewusst klein: eine einzelne Frage darf die Adresse einer Lektion
 * nicht umschreiben. Zehn aehnliche Fragen sollen sie praegen, eine schraege
 * nicht.
 *
 * @param bisher die bisherige Resonanz oder null
 * @param frage der Fragevektor, der zu einem bestaetigten Treffer fuehrte
 * @param anteil wie stark die neue Frage zieht
 */
export function ueberlagere(bisher: number[] | null, frage: number[], anteil = 0.3): number[] {
  if (!bisher || bisher.length !== frage.length) return normiere(frage);
  const neu = bisher.map((x, i) => (1 - anteil) * x + anteil * frage[i]);
  return normiere(neu);
}

/** Auf Laenge 1. Ein Nullvektor bleibt ein Nullvektor. */
export function normiere(v: number[]): number[] {
  let q = 0;
  for (const x of v) q += x * x;
  const l = Math.sqrt(q);
  return l > 0 ? v.map((x) => x / l) : v;
}

/**
 * Der Resonanzbestand — dieselbe Mechanik wie Vektorbestand, andere Sicht.
 *
 * Bewusst eine eigene kleine Klasse statt eines vierten Vektorbestand-Praefix:
 * dieser Bestand wird auch GESCHRIEBEN (im Recall-Pfad, nach einem Treffer),
 * und Schreiben gehoert nicht in eine Klasse, die sonst nur laedt.
 */
export class Resonanzbestand {
  private vektoren = new Map<string, number[]>();
  private geladen = 0;

  constructor(private readonly frischeMs = 60_000) {}

  /** Die Naehe einer Frage zur Resonanz EINER Lektion. -2, wenn keine da ist. */
  naehe(frage: number[], topic: string): number {
    const v = this.vektoren.get(topic);
    return v ? kosinus(frage, v) : -2;
  }

  get groesse(): number { return this.vektoren.size; }

  /** Nur fuer Messungen: Resonanz ohne Speicher setzen. */
  setzeDirekt(topic: string, v: number[]): void {
    this.vektoren.set(topic, v);
  }

  /** Laedt fehlende Resonanzvektoren nach. */
  async aktualisiere(redis: Redis, jetzt = Date.now()): Promise<void> {
    if (this.vektoren.size > 0 && jetzt - this.geladen < this.frischeMs) return;
    const schluessel: string[] = [];
    let cursor = '0';
    do {
      const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${RESONANZ_PRAEFIX}*`, 'COUNT', 500);
      cursor = next;
      schluessel.push(...gefunden);
    } while (cursor !== '0');

    if (schluessel.length === 0) { this.geladen = jetzt; return; }
    const werte = await redis.mget(...schluessel);
    const frisch = new Map<string, number[]>();
    for (const [i, s] of schluessel.entries()) {
      const roh = werte[i];
      if (!roh) continue;
      const v = entpacke(roh);
      if (v) frisch.set(s.slice(RESONANZ_PRAEFIX.length), v);
    }
    this.vektoren = frisch;
    this.geladen = jetzt;
  }

  /**
   * Schreibt die neue Resonanz einer Lektion.
   *
   * Faengt jeden Fehler ab: eine Suche darf nie daran scheitern, dass sie sich
   * nicht merken konnte, was sie gefunden hat. Der Aufrufer bekommt `false`
   * und kann es melden.
   */
  async schreibe(redis: Redis, topic: string, frage: number[], anteil = 0.3): Promise<boolean> {
    try {
      const neu = ueberlagere(this.vektoren.get(topic) ?? null, frage, anteil);
      this.vektoren.set(topic, neu);
      await redis.set(`${RESONANZ_PRAEFIX}${topic}`, packe(neu));
      return true;
    } catch {
      return false;
    }
  }
}
