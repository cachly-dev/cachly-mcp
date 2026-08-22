/**
 * Eingänge: die zweite Tür zu einer Lektion.
 *
 * ── Was gemessen wurde, und was daraus folgt ────────────────────────────────
 *
 * Am 20.08.2026 an 499 echten Lektionen mit zwei unabhängigen 100-Fragen-Sätzen
 * (`.agent/cachly/tor0-tor1-ergebnis.md`):
 *
 *   Findequote@3, frischer Prüfsatz
 *     heute, nur Volltextvektor                              52 %
 *     Eingänge in der Vorauswahl                             56 %
 *     dazu das Merkmal "bester Eingang" im Sortierer         58 %
 *     alle Eingänge AUSSER den Fehlertexten                  52 %   ← null Gewinn
 *
 * Die letzte Zeile ist die wichtigste: von fünf ausprobierten Türarten trägt
 * GENAU EINE. Der erste Satz von what_worked bringt nichts, die Übersetzung
 * bringt nichts, der Themenname steckt längst im Sortierer. Deshalb baut
 * dieses Modul nur die Fehlertexte — alles andere wäre Speicher ohne Wirkung.
 *
 * ── Warum ausgerechnet der Fehlertext ───────────────────────────────────────
 *
 * Er ist ein scharfer Schlüssel. Nutzer fügen Meldungen wörtlich ein; passt der
 * Schlüssel, zieht er die Lektion nach ganz vorn. Der Preis steht in derselben
 * Messung und wird hier offen genannt: dieselben Eingänge SENKEN die Decke von
 * 89 auf 86 % — sie ziehen auch falsche Lektionen in die Vorauswahl. Für den
 * Nutzer zählt trotzdem die Findequote: er sieht drei Lektionen, nicht 25.
 *
 * ── Eine Wahrheit ──────────────────────────────────────────────────────────
 *
 * Die Extraktion stand zuerst im Messwerkzeug (src/bench/eingaenge-b.ts). Sie
 * steht jetzt HIER, und der Bench importiert sie. Zwei Fassungen desselben
 * regulären Ausdrucks wären die Fehlerklasse, die dieses Haus am häufigsten
 * trifft — und die Messung würde etwas anderes prüfen als das Produkt.
 */

import type { Redis } from 'ioredis';
import { kosinus, packe, entpacke } from './bedeutung.js';

/** Wo die Eingänge einer Lektion liegen: EIN Hash je Lektion, neben ihr. */
export const EINGANG_PRAEFIX = 'cachly:lesson:eing:';

/** Höchstens so viele Eingänge je Lektion. Mehr Türen kosten Decke. */
export const EINGAENGE_JE_LEKTION = 3;

/**
 * Die Feld-Markierungen, die im Bestand IM Text stehen.
 *
 * Gemessen: `what_worked` enthält bei vielen Lektionen wörtlich
 * `</what_worked>\n<what_failed>`. Wer das nicht wegnimmt, bettet Feldnamen ein
 * und wundert sich über die Nähe zwischen zwei völlig fremden Lektionen.
 */
export function ohneMarkierungen(text: string): string {
  return text.replace(/<\/?(what_worked|what_failed|context|topic)>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Wörtliche Fehlertexte, Codes und Kernsätze aus einer Lektion.
 *
 * Fünf Muster, alle an echten Lektionen belegt:
 *   1. der GROSSGESCHRIEBENE Kernsatz am Anfang (Schreibregel des Hauses)
 *   2. alles in Anführungszeichen oder Rückwärts-Haken
 *   3. Fehlerklassen und Meldungen samt Umfeld (Error, panic, FATAL, HTTP 5xx)
 *   4. Systemfehler-Kürzel MIT Umfeld — "EACCES" allein ist als Vektor blind
 *   5. englische Meldungssätze mitten im deutschen Text
 */
export function fehlertexteAus(text: string, hoechstens = EINGAENGE_JE_LEKTION): string[] {
  const t = ohneMarkierungen(text);
  const aus: string[] = [];
  const nimm = (s: string | undefined): void => {
    if (!s) return;
    const k = s.replace(/\s+/g, ' ').trim().replace(/^["'`„“]|["'`„“]$/g, '').trim();
    if (k.length < 8 || k.length > 160) return;
    if (aus.some((x) => x.toLowerCase() === k.toLowerCase())) return;
    aus.push(k);
  };

  const gross = /^[^a-zäöüß]{15,200}?(?=[.:]|\s[a-zäöüß])/.exec(t);
  if (gross && /[A-ZÄÖÜ]{3,}/.test(gross[0])) nimm(gross[0]);

  for (const m of t.matchAll(/[„"'`]([^„"'`\n]{8,160})[“"'`]/g)) nimm(m[1]);

  for (const m of t.matchAll(
    /\b((?:[A-Z][a-zA-Z]*(?:Error|Exception)|panic:|FATAL|ERROR|Traceback|exit(?:ed with)? (?:code )?\d+|HTTP [45]\d{2}|status [45]\d{2})[^.\n]{0,90})/g,
  )) nimm(m[1]);

  for (const m of t.matchAll(/\b(E[A-Z]{3,10}\b[^.\n]{0,60})/g)) nimm(m[1]);

  for (const m of t.matchAll(
    /\b((?:no such|not found|permission denied|connection refused|no space left|too many|already exists|cannot|failed to|unable to)[^.,;\n]{0,70})/gi,
  )) nimm(m[1]);

  return aus.slice(0, hoechstens);
}

/** Der Text einer Lektion, aus dem Eingänge gezogen werden. */
export function eingangsText(lektion: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  return `${s(lektion.what_worked)}\n${s(lektion.what_failed)}`;
}

/**
 * Schreibt die Eingänge einer Lektion — als EIN Hash, nicht als n Schlüssel.
 *
 * Warum ein Hash: die Eingänge gehören zusammen und werden zusammen gelesen.
 * Drei Schlüssel je Lektion wären bei 2000 Lektionen 6000 Schlüssel im SCAN.
 *
 * Der Hash wird zuerst gelöscht: hat sich der Text der Lektion geändert, sind
 * die alten Fehlertexte falsch. Eine Lektion neu zu lernen darf keine Reste
 * hinterlassen — das wäre eine zweite Wahrheit über denselben Text.
 *
 * Gibt zurück, wie viele Eingänge geschrieben wurden.
 */
export async function schreibeEingaenge(
  redis: Redis,
  topic: string,
  lektion: Record<string, unknown>,
  einbetten: (text: string) => Promise<number[] | null>,
): Promise<number> {
  const texte = fehlertexteAus(eingangsText(lektion));
  const schluessel = `${EINGANG_PRAEFIX}${topic}`;

  if (texte.length === 0) {
    // Kein Fehlertext in dieser Lektion — dann bekommt sie keinen Eingang.
    // Eine leere Tür ist besser als eine erfundene.
    await redis.del(schluessel);
    return 0;
  }

  const felder: string[] = [];
  for (const text of texte) {
    const v = await einbetten(text);
    if (v?.length) felder.push(text.slice(0, 200), packe(v));
  }
  if (felder.length === 0) return 0;

  await redis.del(schluessel);
  await redis.hset(schluessel, ...felder);
  return felder.length / 2;
}

/**
 * Die Eingänge aller Lektionen im Arbeitsspeicher.
 *
 * Baugleich zu `Vektorbestand` in bedeutung.ts und aus demselben Grund: bei
 * jeder Frage aus dem Speicher zu holen wäre langsamer als der Wortabgleich,
 * den wir gerade ersetzen. Der MCP-Server läuft lange, also wird einmal geladen
 * und danach nur nachgetragen.
 */
export class Eingangsbestand {
  private eingaenge = new Map<string, number[][]>();
  private geladen = 0;

  constructor(private readonly frischeMs = 60_000) {}

  get groesse(): number { return this.eingaenge.size; }

  get anzahlEingaenge(): number {
    let n = 0;
    for (const vs of this.eingaenge.values()) n += vs.length;
    return n;
  }

  /**
   * @param praefixe welche Hashes zum Bestand gehoeren
   *
   * Zwei statt einem: die aus dem Text gezogenen Fehlertexte
   * (`cachly:lesson:eing:`) und die aus der Nutzung gelernten Fragen
   * (`cachly:lesson:pfad:`). Sie liegen getrennt, weil `schreibeEingaenge`
   * seinen Hash vor jedem Schreiben loescht — laegen die gelernten Fragen
   * dort, wuerde jedes erneute Lernen die gesammelte Erfahrung wegwerfen.
   * Fuer die SUCHE sind sie dasselbe: Tueren zu derselben Lektion.
   */
  async aktualisiere(
    redis: Redis,
    jetzt = Date.now(),
    praefixe: readonly string[] = [EINGANG_PRAEFIX, 'cachly:lesson:pfad:'],
  ): Promise<void> {
    if (this.eingaenge.size > 0 && jetzt - this.geladen < this.frischeMs) return;

    const frisch = new Map<string, number[][]>();
    for (const praefix of praefixe) {
      const schluessel: string[] = [];
      let cursor = '0';
      do {
        const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${praefix}*`, 'COUNT', 500);
        cursor = next;
        schluessel.push(...gefunden);
      } while (cursor !== '0');

      for (const k of schluessel) {
        const hash = await redis.hgetall(k);
        const topic = k.slice(praefix.length);
        const vs = frisch.get(topic) ?? [];
        for (const roh of Object.values(hash)) {
          const v = entpacke(roh);
          if (v) vs.push(v);
        }
        if (vs.length) frisch.set(topic, vs);
      }
    }
    this.eingaenge = frisch;
    this.geladen = jetzt;
  }

  /**
   * Die Nähe zum BESTEN Eingang einer Lektion. -2, wenn sie keinen hat.
   *
   * Maximum, nicht Mittelwert: eine Lektion wird über ihre passendste Tür
   * gefunden, und die anderen dürfen schlecht passen. Der Mittelwert würde
   * Lektionen mit vielen Türen bestrafen — gemessen und belegt am 20.08.
   */
  besteNaehe(frage: number[], topic: string): number {
    const vs = this.eingaenge.get(topic);
    if (!vs?.length) return -2;
    let best = -2;
    for (const v of vs) {
      const k = kosinus(frage, v);
      if (k > best) best = k;
    }
    return best;
  }

  /**
   * Die MITTLERE Nähe über alle Eingänge einer Lektion. -2, wenn sie keine hat.
   *
   * Sie ersetzt `besteNaehe` nicht, sie steht daneben. Am 21.08.2026 wurde
   * "Mittelwert STATT Maximum" gemessen und verworfen — er verlor auf der
   * Findequote@3 (55 und 62 Prozent gegen 58 und 63).
   *
   * Dieselbe Messung zeigte aber, dass die beiden ENTGEGENGESETZT ziehen: das
   * Maximum gewinnt auf @3, der Mittelwert auf Platz 1, gleichgerichtet auf
   * zwei unabhängigen Fragensätzen. Sie messen Verschiedenes.
   *
   *   Maximum      "gibt es EINE Tür, die genau auf diese Frage passt?"
   *   Mittelwert   "passt die Lektion als GANZE zu dieser Frage?"
   *
   * Das Maximum allein belohnt eine Lektion, die zufällig eine gut passende
   * Tür trägt und sonst am Thema vorbeigeht. Der Mittelwert allein bestraft
   * eine breit aufgestellte Lektion, die nur mit einer Tür trifft. Nebeneinander
   * heben sich die beiden Fehler teilweise auf.
   *
   * Ohne Schwelle, anders als das Maximum: ein Mittelwert liegt naturgemäß
   * niedriger, und die für das Maximum abgetastete 0,5 würde ihn fast überall
   * auf "kein Wert" drücken — das Merkmal wäre still abgeschaltet.
   */
  mittelNaehe(frage: number[], topic: string): number {
    const vs = this.eingaenge.get(topic);
    if (!vs?.length) return -2;
    let summe = 0;
    for (const v of vs) summe += kosinus(frage, v);
    return summe / vs.length;
  }

  /** Die ähnlichsten Lektionen, je Lektion ihr bester Eingang. */
  aehnlichste(frage: number[], anzahl: number): Array<{ topic: string; naehe: number }> {
    const aus: Array<{ topic: string; naehe: number }> = [];
    for (const topic of this.eingaenge.keys()) {
      aus.push({ topic, naehe: this.besteNaehe(frage, topic) });
    }
    aus.sort((a, b) => b.naehe - a.naehe);
    return aus.slice(0, anzahl);
  }
}

/**
 * Das Gewicht des Merkmals "bester Eingang" im Sortierer.
 *
 * Gemessen am 20.08.2026: 0,3 / 0,5 / 0,8 / 1,3 ergeben 57 / 58 / 57 / 57 %
 * Findequote@3. Das Merkmal ist also unempfindlich gegen sein Gewicht — wer
 * hier weiterdreht, misst Rauschen. 0,5 ist die Mitte des flachen Bereichs.
 */
export const EINGANG_GEWICHT = 0.5;

/**
 * Das Urteil über die Deckung des Bedeutungsabgleichs.
 *
 * Als eigene Funktion, damit sie prüfbar ist: `brain_doctor` steckt in einem
 * großen `switch`, und ein Wächter, den man nicht einzeln aufrufen kann, ist
 * ein Wächter, dessen Nein niemand je gesehen hat.
 *
 * Die Schwelle liegt bei 90 Prozent und nicht bei 100: eine einzelne Lektion
 * ohne Vektor ist ein Aussetzer beim Einbetten (gemessen 20.08.: 7 von 507,
 * alle beim zweiten Lauf nachgeholt), kein Systemfehler. Null ist etwas ganz
 * anderes — dann ist der Bedeutungsabgleich schlicht aus.
 */
export type Deckungsurteil = 'aus' | 'luecke' | 'gut';

export function beurteileDeckung(lektionen: number, vektoren: number): Deckungsurteil {
  if (lektionen === 0) return 'gut';       // Ein leeres Brain ist nicht krank.
  if (vektoren === 0) return 'aus';
  return (vektoren / lektionen) * 100 < 90 ? 'luecke' : 'gut';
}
