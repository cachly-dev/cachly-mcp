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
  bewerteTopf, spreizeImTopf, reichereAn, inhaltsWoerter, grobStamm, GEWICHTE,
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
  /** Die Fehlertext-Tuer weglassen — fuer den Vergleich mit und ohne. */
  ohneEingaenge?: boolean;
  /** Nur der Wortabgleich, ohne Bedeutung — die Grundlinie. */
  nurWorte?: boolean;
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
      o.ohneEingaenge ? -2 : b.eingangsbestand.besteNaehe(fv, t),
    );
    const sinnThemen = [...b.seltenheitsbestand.themen()]
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
    let punkte = bewerteTopf(bewertbar, GEWICHTE);
    if (!o.ohneEingaenge && b.eingangsbestand.groesse > 0) {
      const gespreizt = spreizeImTopf(topf.map((t) => b.eingangsbestand.besteNaehe(fv, t)));
      punkte = punkte.map((p, i) => p + EINGANG_GEWICHT * gespreizt[i]);
    }

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
