/**
 * Die EINE Auswertung — geteilt zwischen dem Lauf am echten Bestand und dem
 * Lauf am eingefrorenen Korpus.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Am 20.08.2026 stellte sich heraus, dass der ausgelieferte Messstand
 * (17 Lektionen, 13 Fragen) die beiden Rangfolge-Formeln GENAU VERKEHRT HERUM
 * einsortiert: er belohnte mit 92,3 gegen 69,2 Prozent die Fassung, die auf
 * 498 echten Lektionen 15 statt 30 Prozent erreichte.
 *
 * Der Grund war nicht nur die Groesse. Der kleine Messstand hatte auch seine
 * eigene Rechnung. Ein Messstand mit eigener Rechnung misst am Ende sich
 * selbst.
 *
 * Deshalb steht die Auswertung hier EINMAL und bekommt den Speicher als
 * Parameter. Ob dahinter ein echter Valkey steht oder ein MiniRedis mit einem
 * eingefrorenen Korpus, ist ihr gleichgueltig — und genau das ist der Punkt:
 * dieselbe Rechnung, zwei Bestaende.
 *
 * ── Was sie NICHT tut ───────────────────────────────────────────────────────
 *
 * Sie bildet die Einblendungslogik von brain.ts nicht nach (Freitarif-Deckel,
 * Textausgabe). Gemessen wird die Rangfolge, nicht die Darstellung.
 */

import { keywordSearch } from '../search.js';
import type { Vektorbestand } from '../bedeutung.js';
import type { Eingangsbestand } from '../eingaenge.js';
import { EINGANG_GEWICHT } from '../eingaenge.js';
import type { Seltenheitsbestand } from '../seltenheitsbestand.js';
import {
  bewerteTopf, bewerteTopfStreng, spreizeImTopf, reichereAn, inhaltsWoerter, grobStamm, GEWICHTE,
} from '../rangfolge.js';

export const LEKTION_PRAEFIX = 'cachly:lesson:best:';

export interface Frage { query: string; relevant: string[]; art?: string }

export interface Bestaende {
  vektorbestand: Vektorbestand;
  namensbestand: Vektorbestand;
  eingangsbestand: Eingangsbestand;
  seltenheitsbestand: Seltenheitsbestand;
}

export interface Messung {
  /** Je Frage der Platz der besten akzeptablen Antwort. 0 = gar nicht dabei. */
  plaetze: number[];
  /** Dasselbe, aufgeteilt nach Art der Frage. */
  artPlaetze: Map<string, number[]>;
  /** Fragen, fuer die kein Vektor vorlag — uebersprungen, nicht als Fehltreffer gezaehlt. */
  ohneFragevektor: number;
}

/** Der Platz der besten akzeptablen Antwort, 1-basiert. 0 = gar nicht dabei. */
export function bestePlatzierung(rangfolge: string[], akzeptabel: string[]): number {
  for (const [i, t] of rangfolge.entries()) if (akzeptabel.includes(t)) return i + 1;
  return 0;
}

/** Anteil der Fragen, deren Treffer auf Platz 1 bis `bis` steht. */
export function quote(plaetze: number[], bis: number): number {
  if (plaetze.length === 0) return 0;
  return plaetze.filter((p) => p > 0 && p <= bis).length / plaetze.length;
}

export interface Optionen {
  /** Wie viele Kandidaten je Weg in den Topf. */
  pool?: number;
  /**
   * Was die Fehlertext-Tueren duerfen. Standard: NICHTS — das ist seit dem
   * 21.08.2026 das Produktionsverhalten (brain.ts), und die Messung ohne
   * Option muss die Produktion spiegeln.
   *
   * Gemessen am 21.08.2026 (tueren-vergleich.ts, eingefrorener 100-Fragen-
   * Satz): die Tueren wirken an zwei Stellen, beide netto negativ.
   *
   *   Bauform            Platz 1   @3     Top 10   im Topf
   *   voll                37,0    52,0    70,0     86,0
   *   aus                 39,0    51,0    71,0     90,0
   *   nur-sortieren       35,0    50,0    71,0     90,0
   *
   * In der VORAUSWAHL draengen sie die richtige Antwort fuenfmal ganz aus dem
   * Topf und retten sie einmal. Die SORTIERUNG allein (auf dem tuerlosen
   * Topf) faellt sogar auf 35 Prozent. Die Optionen bleiben, damit
   * tueren-vergleich.ts die Behauptung jederzeit nachmessen kann.
   */
  eingaenge?: 'aus' | 'voll' | 'nur-sortieren';
  /** Nur der Wortabgleich, ohne Bedeutung — die Grundlinie. */
  nurWorte?: boolean;
  /**
   * Ersetzt die Bedeutungs-Nominierung (Tuer 2) durch eine eigene — fuer
   * Experimente an der VORAUSWAHL, ohne die Sortierung anzufassen.
   *
   * Warum als Haken statt als Kopie: die Tueren-Messung hat gezeigt, dass
   * Vorauswahl und Sortierung getrennt schwingen (eine Aenderung kann der
   * einen nutzen und der anderen schaden). Ein Experiment, das seine eigene
   * Sortierung mitbringt, misst am Ende zwei Aenderungen auf einmal — und
   * ein Messstand mit eigener Rechnung misst sich selbst.
   */
  sinnNominierung?: (fv: number[], q: Frage) => string[];
  /**
   * Nachbearbeitung der fertigen Punkte, MIT Blick auf den ganzen Topf.
   *
   * Anders als `zusatzMerkmal`, das je Kandidat einzeln rechnet: hier sieht
   * die Funktion alle Punkte und alle Themen nebeneinander. Gebraucht fuer
   * Verfahren, bei denen Kandidaten einander beeinflussen — etwa die laterale
   * Hemmung aus dem Naturworkshop (v3): jeder Kandidat wird um einen Anteil
   * der Punktzahl seiner naechsten Nachbarn im Vektorraum gedaempft.
   *
   * Ohne die Option aendert sich nichts. Der Messstand muss ohne Schalter
   * genau das tun, was die Produktion tut.
   */
  punkteNachbearbeitung?: (punkte: number[], topf: string[], fv: number[]) => number[];
  /**
   * Ein zusaetzliches Merkmal fuer die SORTIERUNG — fuer Experimente am
   * anderen Ende als `sinnNominierung`.
   *
   * Liefert je Thema eine Zahl (hoeher = besser, -2 = kein Wert). Sie wird wie
   * die alte Eingangs-Tuer behandelt: ueber den Topf gespreizt und mit
   * `gewicht` auf die Punkte addiert. Genau dieser Weg hat bei den
   * Fehlertext-Tueren VERLOREN — deshalb bekommt jedes neue Merkmal dieselbe
   * Messung, bevor es in den Recall-Pfad darf.
   */
  /**
   * Ein oder MEHRERE zusaetzliche Merkmale fuer die Sortierung.
   *
   * Die Mehrzahl kam am 21.08.2026 dazu, und der Anlass ist ein Messergebnis:
   * Maximum und Mittelwert ueber die Tueren ziehen ENTGEGENGESETZT. Das
   * Maximum gewinnt auf Findequote@3 (58 gegen 55), der Mittelwert auf Platz 1
   * (41 gegen 40) — auf zwei unabhaengigen Fragensaetzen gleichgerichtet. Sie
   * messen Verschiedenes: das Maximum die naechste Tuer, der Mittelwert die
   * Passung der ganzen Lektion.
   *
   * Solange nur EINES ging, musste man sich entscheiden. Jedes Merkmal wird
   * einzeln durch spreizeImTopf gestreckt und dann gewichtet addiert — genau
   * wie das einzelne vorher, damit ein Lauf mit einem Merkmal Zahl fuer Zahl
   * dasselbe liefert wie zuvor.
   */
  zusatzMerkmal?:
    | { werte: (fv: number[], topic: string) => number; gewicht: number }
    | Array<{ werte: (fv: number[], topic: string) => number; gewicht: number }>;
  /**
   * Strenge Fusion statt Summe: Merkmale multiplizieren (bewerteTopfStreng).
   * Nur fuer Experimente — die Produktion nutzt die Summe, solange die
   * Messung nichts anderes sagt (src/bench/fusion-vergleich.ts).
   */
  fusion?: { basis: number };
}

/**
 * Misst eine Fragenliste gegen einen Bestand.
 *
 * `frageVektor` liefert den Vektor zu einer Frage oder `null`. Warum als
 * Funktion und nicht als Tabelle: der Lauf am echten Bestand liest sie aus
 * einer Datei, der Lauf am Korpus aus dem Korpus selbst. Der Unterschied
 * gehoert an den Rand, nicht in die Rechnung.
 */
export async function messe(
  redis: unknown,
  fragen: Frage[],
  frageVektor: (q: Frage) => number[] | null,
  b: Bestaende,
  o: Optionen = {},
): Promise<Messung> {
  const POOL = o.pool ?? 25;
  const plaetze: number[] = [];
  const artPlaetze = new Map<string, number[]>();
  let ohneFragevektor = 0;

  for (const q of fragen) {
    const wortThemen = (await keywordSearch(redis as never, [`${LEKTION_PRAEFIX}*`], q.query, POOL) as Array<{ key: string }>)
      .map((h) => h.key.replace(LEKTION_PRAEFIX, ''));

    if (o.nurWorte) {
      // Die Grundlinie: was der reine Wortabgleich liefert. Ohne diesen
      // Vergleich ist jede Zahl unten eine Behauptung ohne Bezug.
      const platz = bestePlatzierung(wortThemen, q.relevant);
      plaetze.push(platz);
      const art = q.art ?? 'ohne';
      if (!artPlaetze.has(art)) artPlaetze.set(art, []);
      artPlaetze.get(art)!.push(platz);
      continue;
    }

    const fv = frageVektor(q);
    if (!fv) { ohneFragevektor++; continue; }

    // Maximum ueber ALLE Tueren, genau wie brain.ts.
    const naeheBesteTuer = (t: string): number => Math.max(
      b.vektorbestand.naehe(fv, t),
      b.namensbestand.naehe(fv, t),
      (o.eingaenge ?? 'aus') === 'voll' ? b.eingangsbestand.besteNaehe(fv, t) : -2,
    );
    const sinnThemen = o.sinnNominierung
      ? o.sinnNominierung(fv, q)
      : [...b.seltenheitsbestand.themen()]
        .map((t) => ({ t, n: naeheBesteTuer(t) }))
        .sort((x, y) => y.n - x.n)
        .slice(0, POOL)
        .map((x) => x.t);

    const topf = [...new Set([...wortThemen, ...sinnThemen])];
    const besteDrei = sinnThemen.slice(0, 3)
      .map((t) => b.vektorbestand.rohvektor(t)).filter(Boolean) as number[][];
    const angereichert = besteDrei.length ? reichereAn(fv, besteDrei) : fv;
    const frageWoerter = inhaltsWoerter(q.query);
    const statistik = b.seltenheitsbestand.statistik;

    const bewertbar = topf.map((t) => ({
      naeheText: b.vektorbestand.naehe(fv, t),
      naeheThema: b.namensbestand.naehe(fv, t),
      naeheRueckkopplung: b.vektorbestand.naehe(angereichert, t),
      seltenheitsDeckung: statistik
        ? statistik.deckung(
          frageWoerter,
          new Set([...inhaltsWoerter(b.seltenheitsbestand.textVon(t))].map(grobStamm)),
        )
        : 0,
    }));
    let punkte = o.fusion
      ? bewerteTopfStreng(bewertbar, GEWICHTE, o.fusion.basis)
      : bewerteTopf(bewertbar, GEWICHTE);
    if ((o.eingaenge ?? 'aus') !== 'aus' && b.eingangsbestand.groesse > 0) {
      const gespreizt = spreizeImTopf(topf.map((t) => b.eingangsbestand.besteNaehe(fv, t)));
      punkte = punkte.map((p, i) => p + EINGANG_GEWICHT * gespreizt[i]);
    }
    if (o.zusatzMerkmal) {
      const merkmale = Array.isArray(o.zusatzMerkmal) ? o.zusatzMerkmal : [o.zusatzMerkmal];
      for (const m of merkmale) {
        const gespreizt = spreizeImTopf(topf.map((t) => m.werte(fv, t)));
        punkte = punkte.map((p, i) => p + m.gewicht * gespreizt[i]);
      }
    }

    if (o.punkteNachbearbeitung) punkte = o.punkteNachbearbeitung(punkte, topf, fv);

    const rang = topf.map((t, i) => ({ t, p: punkte[i] }))
      .sort((x, y) => y.p - x.p).map((x) => x.t);
    const platz = bestePlatzierung(rang, q.relevant);
    plaetze.push(platz);
    const art = q.art ?? 'ohne';
    if (!artPlaetze.has(art)) artPlaetze.set(art, []);
    artPlaetze.get(art)!.push(platz);
  }

  return { plaetze, artPlaetze, ohneFragevektor };
}
