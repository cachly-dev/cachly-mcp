/**
 * topfseltenheit-messen.ts — misst den Kandidaten des Sinnesphysiologen
 * aus dem zweiten Naturworkshop (22.08.2026).
 *
 * ── Der Kandidat ────────────────────────────────────────────────────────────
 *
 * Vorbild "Geruchsadaption an die Atemluft":
 *
 *   Eine Riechzelle meldet nicht die absolute Stoffmenge, sondern die
 *   Abweichung von dem, was in den letzten Atemzuegen ohnehin schon da war.
 *   Der Massstab fuer Auffaelligkeit wandert mit der Umgebung mit — er ist
 *   kein Wert, der einmal fuer immer feststeht.
 *
 * ── Die Unstimmigkeit, die das Vorbild sichtbar gemacht hat ─────────────────
 *
 * Sie steht in vier Zeilen in rangfolge.ts, `bewerteTopf`:
 *
 *     const t  = spreizeImTopf(topf.map((k) => k.naeheText));
 *     const th = spreizeImTopf(topf.map((k) => k.naeheThema));
 *     const r  = spreizeImTopf(topf.map((k) => k.naeheRueckkopplung));
 *     return topf.map((k, i) =>
 *         gewichte.text * t[i] + gewichte.thema * th[i]
 *       + gewichte.rueckkopplung * r[i]
 *       + gewichte.seltenheit * k.seltenheitsDeckung);   // <- ROH
 *
 * Drei Merkmale werden je Anfrage auf 0..1 gespreizt, das vierte geht
 * ungespreizt ein — und ausgerechnet dieses hat mit 1,3 das HOECHSTE Gewicht.
 * Zwei Folgen, und sie sind verschieden:
 *
 *   (a) Der Massstab stimmt nicht. Ein Gewicht von 1,3 auf einem ungespreizten
 *       Wert bedeutet etwas anderes als 1,3 auf einem gespreizten. Die Zahl
 *       sieht vergleichbar aus und ist es nicht.
 *
 *   (b) Der Bezug fehlt. Die Seltenheit eines Wortes wird ueber den GANZEN
 *       Bestand gerechnet (Seltenheitsbestand, ~499 Lektionen). "einloggen"
 *       ist global zu haeufig, um als selten zu gelten — kann aber INNERHALB
 *       eines Topfes das einzige Wort sein, das zwei fast gleiche Kandidaten
 *       trennt.
 *
 * Genau darum geht es bei den 37 verlorenen Faellen: der Gewinner ist fast nie
 * unsinnig, er ist dieselbe Sache in einem anderen Zusammenhang.
 *
 * ── Was hier gemessen wird ──────────────────────────────────────────────────
 *
 * Drei Varianten, damit (a) und (b) nicht verwechselt werden:
 *
 *   gespreizt   nur der Massstab: dieselbe globale Seltenheit, aber durch
 *               spreizeImTopf. Kostet nichts und aendert kein Merkmal.
 *   topflokal   ein FUENFTES Merkmal: Seltenheit nur ueber die Kandidaten im
 *               Topf gerechnet, zusaetzlich zur globalen.
 *   ersetzt     die globale Seltenheit wird durch die topflokale ERSETZT.
 *
 * Dazu eine Kontrolle, die aus v7 gelernt ist: eine ZUFAELLIGE Wortstatistik
 * gleicher Groesse. Wirkt sie genauso, dann wirkt nicht die Topf-Seltenheit,
 * sondern irgendein zusaetzlicher Term.
 *
 * Widerlegung (vom Vorbild selbst genannt): Findequote@3 steigt um weniger als
 * 2 Punkte, ODER Platz 1 faellt um mehr als 1 Punkt.
 *
 * Aufruf:
 *   npx tsx src/bench/topfseltenheit-messen.ts \
 *     --korpus <k.json> --einstellsatz <alt.json> --pruefsatz <frisch.json> \
 *     --eingaenge <e.json> --vektoren <v.json>
 *   npx tsx src/bench/topfseltenheit-messen.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keywordSearch } from '../search.js';
import { kosinus } from '../bedeutung.js';
import {
  Seltenheit, inhaltsWoerter, grobStamm, spreizeImTopf, reichereAn, GEWICHTE,
} from '../rangfolge.js';
import { mitLektionen } from './mini-redis.js';
import { schluessel } from './eingaenge-einbetten.js';
import type { Eingang } from './eingaenge-b.js';
import type { BenchLesson } from './fixtures.js';
import { SINN_TOPF } from '../rangfolge-stellschrauben.js';

interface Frage { query: string; relevant: string[]; art?: string }
interface Korpus { lessons: BenchLesson[]; queries: Frage[] }
interface Lektionseingaenge { topic: string; eingaenge: Eingang[] }

const PRAEFIX = 'cachly:lesson:best:';

export type Variante = 'auslieferstand' | 'gespreizt' | 'topflokal' | 'ersetzt' | 'zufall';

/** Der Platz der besten akzeptablen Antwort, 1-basiert. 0 = gar nicht dabei. */
export function bestePlatzierung(rangfolge: string[], akzeptabel: string[]): number {
  for (const [i, t] of rangfolge.entries()) if (akzeptabel.includes(t)) return i + 1;
  return 0;
}

/**
 * Die Bewertung, aber mit waehlbarer Behandlung der Seltenheit.
 *
 * Bewusst NICHT `bewerteTopf` aus rangfolge.ts aufgerufen: die Variante
 * `auslieferstand` muss hier Zeile fuer Zeile dasselbe rechnen wie dort, damit
 * der Vergleich einer ist. Eine Probe unten haelt beide gegeneinander — sonst
 * misst dieses Werkzeug seinen eigenen Nachbau.
 */
export function bewerteMitVariante(
  topf: Array<{
    naeheText: number; naeheThema: number; naeheRueckkopplung: number;
    seltenheitsDeckung: number; topfSeltenheit: number;
  }>,
  variante: Variante,
  gewichtTopf = 1.3,
): number[] {
  const t = spreizeImTopf(topf.map((k) => k.naeheText));
  const th = spreizeImTopf(topf.map((k) => k.naeheThema));
  const r = spreizeImTopf(topf.map((k) => k.naeheRueckkopplung));
  const grund = topf.map((_, i) =>
    GEWICHTE.text * t[i] + GEWICHTE.thema * th[i] + GEWICHTE.rueckkopplung * r[i]);

  const roh = topf.map((k) => k.seltenheitsDeckung);
  const gespreizteSeltenheit = spreizeImTopf(roh);
  const topfWerte = spreizeImTopf(topf.map((k) => k.topfSeltenheit));

  return topf.map((_, i) => {
    switch (variante) {
      case 'auslieferstand':
        return grund[i] + GEWICHTE.seltenheit * roh[i];
      case 'gespreizt':
        return grund[i] + GEWICHTE.seltenheit * gespreizteSeltenheit[i];
      case 'topflokal':
        return grund[i] + GEWICHTE.seltenheit * roh[i] + gewichtTopf * topfWerte[i];
      case 'ersetzt':
        return grund[i] + GEWICHTE.seltenheit * topfWerte[i];
      case 'zufall':
        return grund[i] + GEWICHTE.seltenheit * roh[i] + gewichtTopf * topfWerte[i];
    }
  });
}

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  p('Platz 1 wird als 1 gemeldet', bestePlatzierung(['a', 'b'], ['a']) === 1);
  p('nicht dabei ist 0', bestePlatzierung(['a', 'b'], ['z']) === 0);

  const topf = [
    { naeheText: 0.9, naeheThema: 0.8, naeheRueckkopplung: 0.9, seltenheitsDeckung: 0.2, topfSeltenheit: 0.9 },
    { naeheText: 0.9, naeheThema: 0.8, naeheRueckkopplung: 0.9, seltenheitsDeckung: 0.2, topfSeltenheit: 0.1 },
  ];

  // Im Auslieferstand sind beide gleich — die Topf-Seltenheit zaehlt nicht.
  const a = bewerteMitVariante(topf, 'auslieferstand');
  p('Auslieferstand sieht die Topf-Seltenheit nicht', Math.abs(a[0] - a[1]) < 1e-9);

  // Mit topflokal gewinnt der mit der hoeheren Topf-Seltenheit.
  const b = bewerteMitVariante(topf, 'topflokal');
  p('topflokal trennt zwei sonst gleiche Kandidaten', b[0] > b[1]);

  // KONTROLLE: bei GLEICHER Topf-Seltenheit aendert topflokal die Reihenfolge nicht.
  const gleich = topf.map((k) => ({ ...k, topfSeltenheit: 0.5 }));
  const c = bewerteMitVariante(gleich, 'topflokal');
  p('bei gleicher Topf-Seltenheit bleibt es gleich', Math.abs(c[0] - c[1]) < 1e-9);

  // KONTROLLE: `gespreizt` aendert nichts, wenn alle Seltenheiten gleich sind.
  const d = bewerteMitVariante(gleich, 'gespreizt');
  p('gespreizt ist bei gleichen Werten wirkungslos', Math.abs(d[0] - d[1]) < 1e-9);

  // KONTROLLE: `ersetzt` benutzt WIRKLICH nur die Topf-Seltenheit.
  const nurTopf = [
    { naeheText: 0.5, naeheThema: 0.5, naeheRueckkopplung: 0.5, seltenheitsDeckung: 1.0, topfSeltenheit: 0.0 },
    { naeheText: 0.5, naeheThema: 0.5, naeheRueckkopplung: 0.5, seltenheitsDeckung: 0.0, topfSeltenheit: 1.0 },
  ];
  const e = bewerteMitVariante(nurTopf, 'ersetzt');
  p('ersetzt ignoriert die globale Seltenheit', e[1] > e[0]);

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--selbstprobe')) { selbstprobe(); return; }

  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const korpusPfad = resolve(flag('korpus') ?? '');
  const einstellPfad = resolve(flag('einstellsatz') ?? '');
  const satzPfad = resolve(flag('pruefsatz') ?? '');
  const eingPfad = resolve(flag('eingaenge') ?? '');
  const vekPfad = resolve(flag('vektoren') ?? '');
  const POOL = Number(flag('pool') ?? String(SINN_TOPF));
  const eingangsGewicht = Number(flag('eingang') ?? '0.5');

  for (const [was, pfad] of [['Korpus', korpusPfad], ['Einstellsatz', einstellPfad],
    ['Pruefsatz', satzPfad], ['Eingangsdatei', eingPfad], ['Vektordatei', vekPfad]] as const) {
    if (!existsSync(pfad)) fehlt(was, pfad);
  }

  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as Korpus;
  const einstell = JSON.parse(readFileSync(einstellPfad, 'utf8')) as Korpus;
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Korpus;
  const { lektionen } = JSON.parse(readFileSync(eingPfad, 'utf8')) as { lektionen: Lektionseingaenge[] };
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> };

  const volltextVektor = new Map<string, number[]>();
  const themaVektor = new Map<string, number[]>();
  const tuerVektoren = new Map<string, number[][]>();
  for (const l of lektionen) {
    const vs: number[][] = [];
    for (const e of l.eingaenge) {
      const v = vektoren[schluessel(e.art, e.text)];
      if (!v) continue;
      if (e.art === 'volltext') volltextVektor.set(l.topic, v);
      if (e.art === 'name') themaVektor.set(l.topic, v);
      vs.push(v);
    }
    tuerVektoren.set(l.topic, vs);
  }

  const themen = korpus.lessons.map((l) => l.topic);
  const redis = mitLektionen(korpus.lessons);
  const volltext = (l: BenchLesson): string =>
    [l.topic, l.what_worked, (l as { what_failed?: string }).what_failed].filter(Boolean).join(' ');
  const textVon = new Map(korpus.lessons.map((l) => [l.topic, volltext(l)]));
  const seltenheit = new Seltenheit(korpus.lessons.map(volltext));
  const textWoerter = new Map(korpus.lessons.map(
    (l) => [l.topic, new Set([...inhaltsWoerter(volltext(l))].map(grobStamm))],
  ));

  // Fuer die Zufalls-Kontrolle: eine feste, aber willkuerliche Zuordnung von
  // Themen zu "Texten". Fester Startwert — eine Kontrolle, die jedes Mal etwas
  // anderes liefert, ist keine.
  let z = 20260822;
  const wuerfel = (): number => (z = (z * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gemischteThemen = [...themen];
  for (let i = gemischteThemen.length - 1; i > 0; i--) {
    const j = Math.floor(wuerfel() * (i + 1));
    [gemischteThemen[i], gemischteThemen[j]] = [gemischteThemen[j], gemischteThemen[i]];
  }
  const zufallsText = new Map(themen.map((t, i) => [t, textVon.get(gemischteThemen[i]) ?? '']));

  let topfUnterschiede = 0;

  async function miss(fragen: readonly Frage[], variante: Variante): Promise<number[]> {
    const plaetze: number[] = [];
    for (const q of fragen) {
      const fv = vektoren[schluessel('frage', q.query)];
      if (!fv) fehlt(`Vektor fuer "${q.query.slice(0, 40)}"`, vekPfad);

      const wortListe = (await keywordSearch(redis as never, [`${PRAEFIX}*`], q.query, POOL) as Array<{ key: string }>)
        .map((h) => h.key.replace(PRAEFIX, ''));

      const besterEingangVon = (t: string): number => {
        const vs = tuerVektoren.get(t) ?? [];
        let best = -2;
        for (const v of vs) { const k = kosinus(fv, v); if (k > best) best = k; }
        return best;
      };

      const sinnListe = themen
        .map((t) => ({ t, n: besterEingangVon(t) }))
        .sort((a, b) => b.n - a.n).slice(0, POOL).map((x) => x.t);
      const topf = [...new Set([...wortListe, ...sinnListe])];

      const besteDrei = sinnListe.slice(0, 3).map((t) => volltextVektor.get(t)).filter(Boolean) as number[][];
      const angereichert = besteDrei.length ? reichereAn(fv, besteDrei) : fv;
      const fw = inhaltsWoerter(q.query);

      /*
       * DER KERN: eine ZWEITE Seltenheit, gerechnet nur ueber die Kandidaten im
       * Topf. Dieselbe Klasse, dieselbe Rechnung — nur eine kleinere Eingabe.
       * Ein Wort gilt hier als selten, wenn es nur eine Minderheit der aktuell
       * KONKURRIERENDEN Kandidaten traegt, egal wie haeufig es im Bestand ist.
       */
      const quelle = variante === 'zufall' ? zufallsText : textVon;
      const topfSeltenheit = new Seltenheit(topf.map((t) => quelle.get(t) ?? ''));

      const bewertbar = topf.map((t) => {
        const wt = textWoerter.get(t) ?? new Set<string>();
        const global = seltenheit.deckung(fw, wt);
        const lokal = topfSeltenheit.deckung(fw, wt);
        if (Math.abs(global - lokal) > 0.05) topfUnterschiede++;
        return {
          naeheText: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2,
          naeheThema: themaVektor.has(t) ? kosinus(fv, themaVektor.get(t)!) : -2,
          naeheRueckkopplung: volltextVektor.has(t) ? kosinus(angereichert, volltextVektor.get(t)!) : -2,
          seltenheitsDeckung: global,
          topfSeltenheit: lokal,
        };
      });

      let punkte = bewerteMitVariante(bewertbar, variante);
      if (eingangsGewicht > 0) {
        const gespreizt = spreizeImTopf(topf.map(besterEingangVon));
        punkte = punkte.map((p, i) => p + eingangsGewicht * gespreizt[i]);
      }

      const rangfolge = topf.map((t, i) => ({ t, p: punkte[i] }))
        .sort((a, b) => b.p - a.p).map((x) => x.t);
      plaetze.push(bestePlatzierung(rangfolge, q.relevant));
    }
    return plaetze;
  }

  const q = (ps: number[], bis: number): number =>
    (ps.filter((p) => p > 0 && p <= bis).length / ps.length) * 100;
  const p = (x: number): string => `${x.toFixed(1)} %`.padStart(9);
  const vz = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

  console.log('\n  Naturworkshop II — Geruchsadaption an die Atemluft (Topf-Seltenheit)');
  console.log('  ════════════════════════════════════════════════════════════════════');
  console.log(`  Lektionen ${korpus.lessons.length} · Pruefsatz ${satz.queries.length} · Einstellsatz ${einstell.queries.length}`);
  console.log('');
  console.log('  Die Unstimmigkeit: von vier Merkmalen laufen DREI durch spreizeImTopf.');
  console.log('  Das vierte — mit dem HOECHSTEN Gewicht 1,3 — geht ungespreizt ein.');

  const varianten: Variante[] = ['auslieferstand', 'gespreizt', 'topflokal', 'ersetzt', 'zufall'];
  const frisch = new Map<Variante, number[]>();
  const alt = new Map<Variante, number[]>();
  for (const v of varianten) {
    topfUnterschiede = 0;
    frisch.set(v, await miss(satz.queries, v));
    alt.set(v, await miss(einstell.queries, v));
  }

  console.log('\n  FRISCHER Satz (100 ungesehene Fragen)');
  console.log('  ────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Variante'.padEnd(30)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'@10'.padStart(9)}`);
  const namen: Record<Variante, string> = {
    auslieferstand: 'Auslieferstand',
    gespreizt: 'nur Massstab (gespreizt)',
    topflokal: 'Topf-Seltenheit dazu',
    ersetzt: 'Topf-Seltenheit ersetzt',
    zufall: 'KONTROLLE Zufallstexte',
  };
  for (const v of varianten) {
    const ps = frisch.get(v)!;
    console.log(`  ${namen[v].padEnd(30)}${p(q(ps, 1))}${p(q(ps, 3))}${p(q(ps, 10))}`);
  }

  console.log('\n  EINSTELL-Satz (zum Gegenpruefen)');
  console.log('  ────────────────────────────────────────────────────────────────────');
  for (const v of varianten) {
    const ps = alt.get(v)!;
    console.log(`  ${namen[v].padEnd(30)}${p(q(ps, 1))}${p(q(ps, 3))}${p(q(ps, 10))}`);
  }

  const g = frisch.get('auslieferstand')!;
  const gAlt = alt.get('auslieferstand')!;

  console.log('\n  Urteil');
  console.log('  ════════════════════════════════════════════════════════════════════');
  console.log('  Widerlegt, wenn @3 um weniger als 2 Punkte steigt ODER Platz 1 um');
  console.log('  mehr als 1 Punkt faellt.');
  console.log('');
  console.log(`  Faelle, in denen sich globale und Topf-Seltenheit um >0,05 unterscheiden: ${topfUnterschiede}`);
  console.log('');
  for (const v of varianten.filter((x) => x !== 'auslieferstand')) {
    const d3 = q(frisch.get(v)!, 3) - q(g, 3);
    const d1 = q(frisch.get(v)!, 1) - q(g, 1);
    const d3a = q(alt.get(v)!, 3) - q(gAlt, 3);
    console.log(`  ${namen[v].padEnd(30)} @3 ${vz(d3).padStart(5)}  Platz1 ${vz(d1).padStart(5)}  (Einstell @3 ${vz(d3a)})`);
  }
  console.log('');

  /*
   * BEWEIS, DASS ES LAEUFT. Unterscheiden sich globale und Topf-Seltenheit
   * nirgends, dann ist der Eingriff wirkungslos — und "keine Aenderung" heisst
   * dann NICHT "Kandidat widerlegt", sondern "Werkzeug misst nichts". Genau
   * dieser Trugschluss hat am 22.08. den Kandidaten v3 fast falsch erledigt.
   */
  if (topfUnterschiede === 0) {
    console.log('  NICHT GEMESSEN: globale und Topf-Seltenheit sind ueberall gleich.');
    console.log('  Dann greift der Eingriff gar nicht, und keine Zahl oben bedeutet etwas.');
    return;
  }

  const beste = varianten
    .filter((v) => v !== 'auslieferstand' && v !== 'zufall')
    .reduce((b, v) => (q(frisch.get(v)!, 3) > q(frisch.get(b)!, 3) ? v : b), 'gespreizt' as Variante);
  const d3Beste = q(frisch.get(beste)!, 3) - q(g, 3);
  const d1Beste = q(frisch.get(beste)!, 1) - q(g, 1);
  const d3Zufall = q(frisch.get('zufall')!, 3) - q(g, 3);

  if (d3Beste >= 2 && d1Beste >= -1 && d3Zufall < d3Beste - 0.5) {
    console.log(`  NICHT WIDERLEGT. Beste Variante: ${namen[beste]} mit ${vz(d3Beste)} Punkten @3.`);
    console.log(`  Und die Kontrolle traegt: Zufallstexte bringen nur ${vz(d3Zufall)}.`);
    console.log('  ZUM ERSTEN MAL bewegt sich die Bestmarke.');
  } else if (d3Beste >= 2 && d3Zufall >= d3Beste - 0.5) {
    console.log('  NICHT BELEGT. Die Zufallskontrolle wirkt genauso gut.');
    console.log('  Dann wirkt irgendein zusaetzlicher Term, nicht die Topf-Seltenheit.');
  } else if (d1Beste < -1) {
    console.log(`  WIDERLEGT ueber Platz 1: ${vz(d1Beste)} Punkte.`);
  } else {
    console.log(`  WIDERLEGT. Beste Variante ${namen[beste]} bringt nur ${vz(d3Beste)} Punkte @3.`);
  }
  console.log('');
}

if (process.argv.includes('--selbstprobe')) { selbstprobe(); }
else { main().catch((e) => { console.error(e); process.exit(1); }); }
