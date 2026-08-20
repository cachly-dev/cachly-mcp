/**
 * Bedeutungsabgleich: die Frage findet die Lektion auch ohne gemeinsame Wörter.
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Gemessen am 19.08.2026 an 499 echten Lektionen mit 100 Fragen in Alltags-
 * sprache:
 *
 *   Verfahren            Platz 1   Top 3   MRR
 *   Wörter (bisher)        21 %    33 %   29,3 %
 *   Bedeutung (bge-m3)     40 %    60 %   51,4 %
 *
 * Der Wortabgleich war ausgereizt: nach drei Reparaturen brachten weitere
 * Eingriffe je eine Frage. Der Grund liegt in der Aufgabe, nicht in der
 * Umsetzung. Eine Frage beschreibt ein SYMPTOM, die Lektion eine URSACHE.
 * "Der Deploy hängt beim Bauen" und "No space left on device" teilen kein Wort
 * und meinen dasselbe. Kein Wörterbuch schließt diese Lücke.
 *
 * ── Und es ist SCHNELLER, nicht langsamer ───────────────────────────────────
 *
 * Das war die Überraschung. Am selben Tag gemessen:
 *
 *   Wortabgleich (heute, 499 Lektionen)   788 ms   (Mitte)
 *   Einbettung der Frage (Netzaufruf)     282 ms
 *   Vergleich gegen 494 Vektoren            0 ms   (14 ms im schlechtesten Fall)
 *
 * Der Wortabgleich baut seinen Index bei JEDER Frage neu: alle Datensätze
 * holen, zerlegen, Worthäufigkeiten und Bigramme rechnen. Das wächst linear
 * mit dem Bestand — gemessen 1,6 ms je Lektion und Frage:
 *
 *   Lektionen     50    100    250    499    998   1996
 *   Wartezeit   75ms  156ms  408ms  792ms 1601ms 3185ms
 *
 * Bei 2000 Lektionen sind das 3,2 Sekunden. Die automatische Einblendung hat
 * ein 3-Sekunden-Budget — das erklärt, warum sie nichts liefert
 * (cachly:ambient-recall-blendet-nichts-ein).
 *
 * Der Bedeutungsabgleich kostet dagegen konstant einen Netzaufruf. Er wird
 * nicht langsamer, wenn der Bestand wächst.
 *
 * ── Was das Modul NICHT tut ─────────────────────────────────────────────────
 *
 * Es ersetzt den Wortabgleich nicht. Zwei Gründe:
 *
 *   1. Ohne Netz gibt es keine Einbettung. Der Wortabgleich läuft immer.
 *   2. Gemischt sind die ersten zehn Treffer besser als bei beiden einzeln
 *      (71 % gegen 68 und 47). Wörter finden das wörtlich Genannte, Bedeutung
 *      das sinngemäß Gemeinte.
 */

import type { Redis } from 'ioredis';

/** Wo ein Lektionsvektor liegt. Ein Schlüssel je Lektion, neben der Lektion. */
export const VEKTOR_PRAEFIX = 'cachly:lesson:vec:';

/**
 * Wo der Vektor des THEMENNAMENS liegt.
 *
 * Warum getrennt vom Volltextvektor: der Name ist kurz und frageähnlich, der
 * Volltext ist 1376 Zeichen lang. Eine 60-Zeichen-Frage gegen 60 Zeichen zu
 * halten ist symmetrisch, gegen 1376 nicht — der Sortierer bewertet beide
 * deshalb als eigene Merkmale (`naeheText` 1,0 und `naeheThema` 0,6).
 *
 * Gemessen am 19.08.2026: der Name allein findet nur 26 %, im Verbund trägt er
 * verlässlich. Bis zum 20.08. gab es diese Vektoren nur im Messstand
 * (korpus-gross.sicht-c.json), im Produkt nicht — der Sortierer aus
 * rangfolge.ts war deshalb auch gar nicht verdrahtet.
 */
export const NAME_VEKTOR_PRAEFIX = 'cachly:lesson:vecname:';

/** Der Text, aus dem der Namensvektor gebildet wird: Trennzeichen zu Wörtern. */
export function textFuerNamensVektor(topic: string): string {
  return topic.replace(/[:_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Vektoren werden als base64 gespeichert, nicht als JSON-Zahlenliste.
 *
 * 1024 Zahlen als JSON sind rund 20 KB je Lektion, als Float32 sind es 4 KB.
 * Bei 500 Lektionen ist das der Unterschied zwischen 10 MB und 2 MB, die bei
 * jedem kalten Start über die Leitung gehen.
 */
export function packe(vektor: number[]): string {
  const f = new Float32Array(vektor);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

export function entpacke(s: string): number[] | null {
  try {
    const b = Buffer.from(s, 'base64');
    if (b.byteLength === 0 || b.byteLength % 4 !== 0) return null;
    const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    return Array.from(f);
  } catch {
    return null;
  }
}

/**
 * Kosinus-Ähnlichkeit zweier Vektoren.
 *
 * Die Länge wird bei JEDEM Aufruf neu gerechnet statt einmal vorher. Das ist
 * absichtlich: gemessen liegt der gesamte Vergleich gegen 494 Vektoren bei
 * 0 ms. Eine Vorberechnung wäre eine zweite Wahrheit über denselben Vektor —
 * und der Gewinn wäre nicht messbar.
 */
export function kosinus(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let p = 0; let qa = 0; let qb = 0;
  for (let i = 0; i < a.length; i++) { p += a[i] * b[i]; qa += a[i] * a[i]; qb += b[i] * b[i]; }
  return qa && qb ? p / Math.sqrt(qa * qb) : 0;
}

/**
 * Der Text, aus dem der Vektor einer Lektion gebildet wird.
 *
 * Bewusst NICHT das rohe JSON: Feldnamen, Zeitstempel und Prüfspuren tragen
 * keine Bedeutung, verbrauchen aber vom Fenster des Einbettungsmodells. Der
 * Dienst kürzt bei rund 2000 Zeichen — gemessen liefern 2000, 4000 und 6000
 * Zeichen denselben Vektor. Was hinten steht, existiert für ihn nicht.
 */
export function textFuerVektor(lektion: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return [s(lektion.topic), s(lektion.what_worked), s(lektion.what_failed)]
    .filter(Boolean).join('\n').slice(0, 2000);
}

/**
 * Ein Vektorbestand, der im Arbeitsspeicher bleibt.
 *
 * Warum: 494 Vektoren sind rund 2 MB. Die bei jeder Frage aus dem Speicher zu
 * holen wäre langsamer als der Wortabgleich, den wir gerade ersetzen — der
 * Gewinn wäre weg, bevor er anfängt.
 *
 * Der MCP-Server läuft lange, also wird einmal geladen und danach nur
 * nachgetragen. Die Prüfung "hat sich etwas geändert" läuft über die ANZAHL
 * der Schlüssel, nicht über ihren Inhalt: eine geänderte Lektion bekommt beim
 * Lernen sofort ihren neuen Vektor geschrieben, und dieser Bestand holt ihn
 * beim nächsten Nachladen.
 */
export class Vektorbestand {
  private vektoren = new Map<string, number[]>();
  private geladen = 0;

  /**
   * @param frischeMs wie lange ein geladener Bestand als frisch gilt
   * @param praefix   welche Sicht — Volltext (Standard) oder Themenname
   *
   * Der Präfix ist ein Parameter und keine zweite Klasse: die Mechanik ist
   * identisch (scannen, in Blöcken holen, entpacken, Gelöschtes vergessen).
   * Zwei Klassen dafür wären zwei Orte, an denen dieselbe Änderung nachgezogen
   * werden müsste.
   */
  constructor(
    private readonly frischeMs = 60_000,
    private readonly praefix: string = VEKTOR_PRAEFIX,
  ) {}

  /** Die Nähe einer Frage zu EINER Lektion. -2, wenn sie keinen Vektor hat. */
  naehe(frage: number[], topic: string): number {
    const v = this.vektoren.get(`${this.praefix}${topic}`);
    return v ? kosinus(frage, v) : -2;
  }

  /**
   * Der Vektor selbst — für die Rückkopplung, die aus den besten Treffern
   * einen angereicherten Fragevektor baut (`reichereAn`). `null`, wenn die
   * Lektion keinen hat; der Aufrufer filtert das weg.
   */
  rohvektor(topic: string): number[] | null {
    return this.vektoren.get(`${this.praefix}${topic}`) ?? null;
  }

  get groesse(): number { return this.vektoren.size; }

  /** Lädt fehlende Vektoren nach. Tut nichts, wenn kürzlich geladen wurde. */
  async aktualisiere(redis: Redis, jetzt = Date.now()): Promise<void> {
    if (this.vektoren.size > 0 && jetzt - this.geladen < this.frischeMs) return;

    const schluessel: string[] = [];
    let cursor = '0';
    do {
      const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${this.praefix}*`, 'COUNT', 500);
      cursor = next;
      schluessel.push(...gefunden);
    } while (cursor !== '0');

    const fehlend = schluessel.filter((k) => !this.vektoren.has(k));
    for (let i = 0; i < fehlend.length; i += 100) {
      const block = fehlend.slice(i, i + 100);
      const werte = await redis.mget(...block);
      for (const [j, roh] of werte.entries()) {
        if (!roh) continue;
        const v = entpacke(roh);
        if (v) this.vektoren.set(block[j], v);
      }
    }

    // Gelöschte Lektionen wieder loswerden.
    if (schluessel.length < this.vektoren.size) {
      const da = new Set(schluessel);
      for (const k of [...this.vektoren.keys()]) if (!da.has(k)) this.vektoren.delete(k);
    }
    this.geladen = jetzt;
  }

  /**
   * Die ähnlichsten Lektionen zu einem Fragevektor.
   *
   * Zurück kommen die THEMEN, nicht die Schlüssel — der Aufrufer arbeitet mit
   * Themen und soll das Schlüsselformat nicht kennen müssen.
   */
  aehnlichste(frage: number[], anzahl: number): Array<{ topic: string; naehe: number }> {
    const aus: Array<{ topic: string; naehe: number }> = [];
    for (const [k, v] of this.vektoren) {
      aus.push({ topic: k.slice(this.praefix.length), naehe: kosinus(frage, v) });
    }
    aus.sort((a, b) => b.naehe - a.naehe);
    return aus.slice(0, anzahl);
  }
}

/**
 * Mischt zwei Rangfolgen über die PLATZIERUNG, nicht über die Punktzahl.
 *
 * Punktzahlen aus BM25 und aus einem Kosinus sind nicht vergleichbar: die eine
 * ist nach oben offen, die andere liegt zwischen -1 und 1. Wer sie addiert oder
 * skaliert, wählt unbeabsichtigt einen Gewinner und merkt es nie.
 *
 * Reciprocal Rank Fusion braucht keine gemeinsame Einheit.
 *
 * ── Wie viel Wortabgleich? ──────────────────────────────────────────────────
 *
 * Gemessen am 19.08.2026 an 499 Lektionen mit 100 Fragen:
 *
 *   Wortgewicht   Platz 1   Top 3   Top 10   MRR
 *   0,0 (nur Sinn)   40 %    60 %     68 %   51,4 %
 *   0,1              41 %    63 %     71 %   53,5 %
 *   0,2              42 %    57 %     70 %   52,0 %
 *   0,3              39 %    55 %     71 %   49,0 %
 *   0,4              38 %    51 %     69 %   47,7 %
 *   1,0 (nur Wörter) 21 %    33 %     47 %   29,3 %
 *
 * 0,1 ist auf drei von vier Maßen vorn und überall besser als reine Bedeutung.
 * Wenig Wortabgleich hilft, viel schadet: die Wörter fangen den Fall, in dem
 * jemand eine Fehlermeldung wörtlich einfügt, und stören sonst.
 *
 * Zu 0,2 ist der Abstand bei Platz 1 EINE Frage. Das ist kein Beleg, sondern
 * eine Richtung — wer hier dreht, misst nach.
 */
export const WORT_GEWICHT = 0.1;

export function mischeRangfolgen(
  woerter: string[],
  bedeutung: string[],
  wortGewicht = WORT_GEWICHT,
  k = 60,
): string[] {
  const punkte = new Map<string, number>();
  woerter.forEach((t, i) => punkte.set(t, (punkte.get(t) ?? 0) + wortGewicht / (k + i + 1)));
  bedeutung.forEach((t, i) => punkte.set(t, (punkte.get(t) ?? 0) + (1 - wortGewicht) / (k + i + 1)));
  return [...punkte.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}
