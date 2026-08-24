/**
 * beschneiden-messen.ts — misst Naturworkshop-Kandidat v7.
 *
 * ── Der Kandidat ────────────────────────────────────────────────────────────
 *
 * Vorbild "Synaptisches Beschneiden" (Lauf 21.08.2026, Ausgang `tragfaehig`,
 * seither ungemessen):
 *
 *   Im reifenden Gehirn werden mehr Verbindungen entfernt als angelegt. Welche
 *   bleibt, entscheidet nicht ihr Alter, sondern ob sie gemeinsam mit ihrem
 *   Ziel aktiv war.
 *
 *   Bauunterschied: Entferne eine Tuer nicht nach Ablauf einer Frist, sondern
 *   wenn sie in 200 Abrufen kein einziges Mal die beste Tuer ihrer Lektion war.
 *   Das Alter geht in die Entscheidung nicht ein.
 *
 *   Widerlegung, vom Workshop festgelegt: Nach dem Entfernen faellt die
 *   Findequote@3 um mehr als 1 Punkt.
 *
 * ── Der zweite Einwand entscheidet den Aufbau ───────────────────────────────
 *
 * Der Workshop hat ihn selbst notiert:
 *
 *   "Beschneiden ist unumkehrbar. Eine Tuer, die in 200 Fragen nie die beste
 *   war, kann bei Frage 201 die einzige sein."
 *
 * Genau deshalb waere die naheliegende Messung wertlos: zaehlen und pruefen auf
 * DEMSELBEN Fragensatz. Dort kann eine weggeschnittene Tuer per Konstruktion
 * nicht fehlen — sie hat ja auf diesen Fragen nie gewonnen. Man wuerde messen,
 * dass Wegwerfen nicht schadet, was man weggeworfen hat, weil es nicht half.
 * Das ist keine Messung, das ist eine Tautologie mit Prozentzeichen.
 *
 * Dieses Werkzeug trennt deshalb streng:
 *
 *   ZAEHLEN  auf `pruefsatz-alt.json`     — dem Einstell-Satz
 *   PRUEFEN  auf `pruefsatz-frisch.json`  — dem eingefrorenen Satz, 100 Fragen,
 *                                            die der alte Satz nicht benutzt
 *
 * Frage 201 ist damit keine Redewendung mehr, sondern hundert echte Fragen.
 *
 * Zur Kontrolle wird zusaetzlich auf dem EINSTELL-Satz gemessen. Steht dort ein
 * Gewinn und auf dem frischen Satz ein Verlust, ist das der Beweis fuer
 * Anpassung an den eigenen Messsatz — und nicht fuer einen Mechanismus.
 *
 * ── Der Sortierer ist derselbe wie im Auslieferstand ────────────────────────
 *
 * `bewerteTopf`, `GEWICHTE`, `spreizeImTopf` kommen aus src/rangfolge.ts. Wer
 * hier nachbaut, misst eine Zahl, die es im Produkt nicht gibt.
 *
 * Aufruf:
 *   npx tsx src/bench/beschneiden-messen.ts \
 *     --korpus <k.json> --einstellsatz <alt.json> --pruefsatz <frisch.json> \
 *     --eingaenge <e.json> --vektoren <v.json> [--eingang 0.5]
 *   npx tsx src/bench/beschneiden-messen.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keywordSearch } from '../search.js';
import { kosinus } from '../bedeutung.js';
import {
  Seltenheit, inhaltsWoerter, grobStamm, bewerteTopf, spreizeImTopf,
  reichereAn,
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

/** Der Platz der besten akzeptablen Antwort, 1-basiert. 0 = gar nicht dabei. */
export function bestePlatzierung(rangfolge: string[], akzeptabel: string[]): number {
  for (const [i, t] of rangfolge.entries()) if (akzeptabel.includes(t)) return i + 1;
  return 0;
}

/**
 * Zaehlt je Tuer, wie oft sie die beste Tuer IHRER Lektion war.
 *
 * Das ist die woertliche Uebersetzung des Vorbilds: nicht "wie gut ist die
 * Tuer absolut", sondern "war sie diejenige, ueber die ihre Lektion gefunden
 * wurde". Eine Tuer, deren Lektion nie in Frage kam, gewinnt nie — genau wie
 * eine Synapse, die nie gemeinsam mit ihrem Ziel feuert.
 *
 * @param tueren   Thema -> Liste von Tuervektoren
 * @param fragen   die Fragevektoren, ueber die gezaehlt wird
 * @returns        Thema -> Liste von Siegzahlen, gleiche Reihenfolge wie tueren
 */
export function zaehleSiege(
  tueren: ReadonlyMap<string, number[][]>,
  fragen: readonly number[][],
): Map<string, number[]> {
  const siege = new Map<string, number[]>();
  for (const [thema, vs] of tueren) siege.set(thema, new Array(vs.length).fill(0));

  for (const fv of fragen) {
    for (const [thema, vs] of tueren) {
      if (vs.length === 0) continue;
      let besteI = -1;
      let beste = -2;
      for (let i = 0; i < vs.length; i++) {
        const k = kosinus(fv, vs[i]);
        if (k > beste) { beste = k; besteI = i; }
      }
      if (besteI >= 0) siege.get(thema)![besteI]++;
    }
  }
  return siege;
}

/**
 * Schneidet die Tueren weg, die nie gewonnen haben.
 *
 * Eine Lektion behaelt IMMER mindestens eine Tuer. Ohne diese Regel koennte
 * eine Lektion, die im Einstell-Satz gar nicht vorkam, alle ihre Tueren
 * verlieren und waere danach ueber den Bedeutungsweg unauffindbar. Das waere
 * kein Beschneiden mehr, sondern Loeschen — und es wuerde die Messung
 * verfaelschen, weil der Verlust dann vom Abschneiden ganzer Lektionen kaeme
 * und nicht vom Kandidaten.
 */
export function beschneide(
  tueren: ReadonlyMap<string, number[][]>,
  siege: ReadonlyMap<string, number[]>,
): { tueren: Map<string, number[][]>; entfernt: number; behalten: number; gerettet: number } {
  const neu = new Map<string, number[][]>();
  let entfernt = 0;
  let behalten = 0;
  let gerettet = 0;

  for (const [thema, vs] of tueren) {
    const s = siege.get(thema) ?? [];
    const bleibt = vs.filter((_, i) => (s[i] ?? 0) > 0);
    if (bleibt.length === 0 && vs.length > 0) {
      // Keine einzige Tuer hat je gewonnen: die staerkste behalten. "Staerkste"
      // heisst hier schlicht die erste — ohne Siege gibt es keine Rangfolge,
      // und eine willkuerliche Wahl ist ehrlicher als eine erfundene.
      neu.set(thema, [vs[0]]);
      entfernt += vs.length - 1;
      behalten += 1;
      gerettet++;
      continue;
    }
    neu.set(thema, bleibt);
    entfernt += vs.length - bleibt.length;
    behalten += bleibt.length;
  }
  return { tueren: neu, entfernt, behalten, gerettet };
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

  // Zaehlen: zwei Tueren, eine passt zur Frage, die andere nicht.
  const tueren = new Map<string, number[][]>([['t', [[1, 0], [0, 1]]]]);
  const s1 = zaehleSiege(tueren, [[1, 0]]);
  p('die passende Tuer gewinnt', s1.get('t')![0] === 1 && s1.get('t')![1] === 0);

  const s2 = zaehleSiege(tueren, [[1, 0], [1, 0], [0, 1]]);
  p('Siege werden aufaddiert', s2.get('t')![0] === 2 && s2.get('t')![1] === 1);

  // Beschneiden: die nie gewinnende Tuer faellt.
  const b1 = beschneide(tueren, s1);
  p('die nie gewinnende Tuer faellt', b1.tueren.get('t')!.length === 1);
  p('die entfernte Tuer wird gezaehlt', b1.entfernt === 1);

  // KONTROLLE: eine Lektion ohne jeden Sieg behaelt eine Tuer.
  const ohneSieg = new Map<string, number[]>([['t', [0, 0]]]);
  const b2 = beschneide(tueren, ohneSieg);
  p('eine Lektion ohne Siege verliert nicht alles', b2.tueren.get('t')!.length === 1);
  p('die Rettung wird gezaehlt', b2.gerettet === 1);

  // KONTROLLE: wer ueberall gewinnt, verliert nichts.
  const alleSiegen = new Map<string, number[]>([['t', [3, 4]]]);
  const b3 = beschneide(tueren, alleSiegen);
  p('gewinnende Tueren bleiben alle', b3.tueren.get('t')!.length === 2 && b3.entfernt === 0);

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
  if (satz.queries.length === 0) fehlt('Fragen im Pruefsatz', satzPfad);
  if (einstell.queries.length === 0) fehlt('Fragen im Einstellsatz', einstellPfad);

  // Beweis, dass die beiden Saetze wirklich verschieden sind. Ohne das koennte
  // ein Tippfehler im Pfad die ganze Messung zur Tautologie machen, ohne dass
  // irgendetwas rot wuerde.
  const einstellFragen = new Set(einstell.queries.map((q) => q.query));
  const ueberschneidung = satz.queries.filter((q) => einstellFragen.has(q.query)).length;

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
  const seltenheit = new Seltenheit(korpus.lessons.map(volltext));
  const textWoerter = new Map(korpus.lessons.map(
    (l) => [l.topic, new Set([...inhaltsWoerter(volltext(l))].map(grobStamm))],
  ));

  /** Ein kompletter Messlauf ueber einen Fragensatz mit einem Tuerbestand. */
  async function miss(fragen: readonly Frage[], tueren: ReadonlyMap<string, number[][]>): Promise<number[]> {
    const plaetze: number[] = [];
    for (const q of fragen) {
      const fv = vektoren[schluessel('frage', q.query)];
      if (!fv) fehlt(`Vektor fuer "${q.query.slice(0, 40)}"`, vekPfad);

      const wortListe = (await keywordSearch(redis as never, [`${PRAEFIX}*`], q.query, POOL) as Array<{ key: string }>)
        .map((h) => h.key.replace(PRAEFIX, ''));

      const besterEingangVon = (t: string): number => {
        const vs = tueren.get(t) ?? [];
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
      let punkte = bewerteTopf(topf.map((t) => ({
        naeheText: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2,
        naeheThema: themaVektor.has(t) ? kosinus(fv, themaVektor.get(t)!) : -2,
        naeheRueckkopplung: volltextVektor.has(t) ? kosinus(angereichert, volltextVektor.get(t)!) : -2,
        seltenheitsDeckung: seltenheit.deckung(fw, textWoerter.get(t) ?? new Set()),
      })));

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

  const tuerenGesamt = [...tuerVektoren.values()].reduce((n, vs) => n + vs.length, 0);

  console.log('\n  Naturworkshop v7 — Synaptisches Beschneiden');
  console.log('  ════════════════════════════════════════════════════════════════');
  console.log(`  Lektionen        ${korpus.lessons.length}`);
  console.log(`  Tueren gesamt    ${tuerenGesamt}`);
  console.log(`  Einstellsatz     ${einstell.queries.length} Fragen  (${einstellPfad.split(/[\\/]/).pop()})`);
  console.log(`  Pruefsatz        ${satz.queries.length} Fragen  (${satzPfad.split(/[\\/]/).pop()})`);
  console.log(`  Ueberschneidung  ${ueberschneidung} Fragen${ueberschneidung > 0 ? '   ← ACHTUNG, die Messung ist dann nicht sauber' : '   (sauber getrennt)'}`);

  // ── Zaehlen auf dem EINSTELL-Satz ───────────────────────────────────────
  const einstellVektoren = einstell.queries
    .map((f) => vektoren[schluessel('frage', f.query)])
    .filter(Boolean) as number[][];
  if (einstellVektoren.length !== einstell.queries.length) {
    console.log(`  HINWEIS: nur ${einstellVektoren.length} von ${einstell.queries.length} Einstellfragen haben einen Vektor.`);
  }

  const siege = zaehleSiege(tuerVektoren, einstellVektoren);
  const nachSiegen = beschneide(tuerVektoren, siege);

  /*
   * Zwei Kontrollen, und sie laufen IMMER mit — nicht hinter einem Schalter.
   *
   * Der erste Lauf am 22.08.2026 ergab exakt null Aenderung bei 287 entfernten
   * Tueren. "Null Aenderung" traegt drei voellig verschiedene Bedeutungen, und
   * ohne Kontrolle sind sie nicht zu unterscheiden:
   *
   *   a) die Regel trifft genau die toten Tueren        -> der Kandidat traegt
   *   b) das Beschneiden kommt in der Messung nicht an  -> das Werkzeug ist kaputt
   *   c) der Bestand hat schlicht 287 Tueren zu viel    -> die Regel ist egal
   *
   * KAHLSCHLAG (eine Tuer je Lektion) trennt b) ab: bewegen sich die Zahlen
   * dabei nicht, ist das Werkzeug kaputt und keine Zahl oben bedeutet etwas.
   *
   * ZUFALL (gleich VIELE Tueren, zufaellig gewaehlt) trennt c) ab: tut der
   * Zufallsschnitt weh und der Siegschnitt nicht, dann liegt es an der REGEL
   * und nicht an der Menge. Das ist die eigentliche Aussage.
   *
   * Beide standen zuerst hinter einem Schalter, und der Kontrolllauf druckte
   * dabei sein eigenes "WIDERLEGT" — als waere es das Ergebnis. Eine Kontrolle,
   * die man extra aufrufen muss, ruft niemand auf; eine, die wie das Ergebnis
   * aussieht, ist schlimmer als keine.
   */
  function kahlschlag(): { tueren: Map<string, number[][]>; entfernt: number } {
    const kahl = new Map<string, number[][]>();
    let weg = 0;
    for (const [t, vs] of tuerVektoren) {
      kahl.set(t, vs.slice(0, 1));
      weg += Math.max(0, vs.length - 1);
    }
    return { tueren: kahl, entfernt: weg };
  }

  /** Entfernt GENAU sollWeg Tueren, zufaellig gewaehlt, fester Startwert. */
  function zufallsschnitt(sollWeg: number): { tueren: Map<string, number[][]>; entfernt: number } {
    // Fester Startwert statt Math.random: eine Kontrolle, die bei jedem Lauf
    // eine andere Zahl liefert, ist keine.
    let z = 20260822;
    const wuerfel = (): number => (z = (z * 1103515245 + 12345) % 2147483648) / 2147483648;
    const kandidaten: Array<[string, number]> = [];
    for (const [t, vs] of tuerVektoren) for (let i = 1; i < vs.length; i++) kandidaten.push([t, i]);
    for (let i = kandidaten.length - 1; i > 0; i--) {
      const j = Math.floor(wuerfel() * (i + 1));
      [kandidaten[i], kandidaten[j]] = [kandidaten[j], kandidaten[i]];
    }
    const raus = new Set(kandidaten.slice(0, sollWeg).map(([t, i]) => `${t} ${i}`));
    const neu = new Map<string, number[][]>();
    let weg = 0;
    for (const [t, vs] of tuerVektoren) {
      const bleibt = vs.filter((_, i) => !raus.has(`${t} ${i}`));
      neu.set(t, bleibt.length ? bleibt : [vs[0]]);
      weg += vs.length - neu.get(t)!.length;
    }
    return { tueren: neu, entfernt: weg };
  }

  console.log('\n  Beschnitten nach Siegen auf dem Einstell-Satz');
  console.log('  ────────────────────────────────────────────────────────────────');
  console.log(`  entfernt         ${nachSiegen.entfernt} von ${tuerenGesamt} (${((nachSiegen.entfernt / tuerenGesamt) * 100).toFixed(1)} %)`);
  console.log(`  behalten         ${nachSiegen.behalten}`);
  console.log(`  Lektionen, die nur durch die Mindestregel eine Tuer behielten: ${nachSiegen.gerettet}`);

  if (nachSiegen.entfernt === 0) {
    console.log('\n  NICHT GEMESSEN: es wurde keine einzige Tuer entfernt.');
    console.log('  Jede Tuer hat auf dem Einstell-Satz mindestens einmal gewonnen.');
    console.log('  Der Kandidat ist damit weder bestaetigt noch widerlegt — er greift hier nicht.');
    return;
  }

  const zufall = zufallsschnitt(nachSiegen.entfernt);
  const kahl = kahlschlag();

  const frischVoll = await miss(satz.queries, tuerVektoren);
  const altVoll = await miss(einstell.queries, tuerVektoren);
  const frischSieg = await miss(satz.queries, nachSiegen.tueren);
  const altSieg = await miss(einstell.queries, nachSiegen.tueren);
  const frischZufall = await miss(satz.queries, zufall.tueren);
  const frischKahl = await miss(satz.queries, kahl.tueren);

  const zeile = (name: string, tueren: number, ps: number[]): void => {
    console.log(`  ${name.padEnd(34)}${String(tueren).padStart(8)}${p(q(ps, 1))}${p(q(ps, 3))}${p(q(ps, 10))}`);
  };

  console.log('\n  Findequote auf dem FRISCHEN Satz (100 ungesehene Fragen)');
  console.log('  ────────────────────────────────────────────────────────────────');
  console.log(`  ${'Bestand'.padEnd(34)}${'Tueren'.padStart(8)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'@10'.padStart(9)}`);
  zeile('alle Tueren', tuerenGesamt, frischVoll);
  zeile('nach Siegen beschnitten', nachSiegen.behalten, frischSieg);
  zeile('KONTROLLE gleich viele, zufaellig', tuerenGesamt - zufall.entfernt, frischZufall);
  zeile('KONTROLLE eine je Lektion', tuerenGesamt - kahl.entfernt, frischKahl);

  console.log('\n  Zum Vergleich, EINSTELL-Satz (die Fragen, auf denen gezaehlt wurde)');
  console.log('  ────────────────────────────────────────────────────────────────');
  zeile('alle Tueren', tuerenGesamt, altVoll);
  zeile('nach Siegen beschnitten', nachSiegen.behalten, altSieg);

  const d3 = q(frischSieg, 3) - q(frischVoll, 3);
  const d1 = q(frischSieg, 1) - q(frischVoll, 1);
  const d3Alt = q(altSieg, 3) - q(altVoll, 3);
  const d3Zufall = q(frischZufall, 3) - q(frischVoll, 3);
  const d3Kahl = q(frischKahl, 3) - q(frischVoll, 3);
  const vz = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

  console.log('\n  Urteil');
  console.log('  ════════════════════════════════════════════════════════════════');
  console.log('  Widerlegungsbedingung des Workshops: @3 faellt um mehr als 1 Punkt.');
  console.log('');
  console.log(`  @3 frisch, nach Siegen beschnitten   ${vz(d3)} Punkte`);
  console.log(`  Platz 1 frisch, nach Siegen          ${vz(d1)} Punkte`);
  console.log(`  @3 Einstell, nach Siegen             ${vz(d3Alt)} Punkte`);
  console.log(`  @3 frisch, KONTROLLE zufaellig       ${vz(d3Zufall)} Punkte   (gleich viele Tueren)`);
  console.log(`  @3 frisch, KONTROLLE Kahlschlag      ${vz(d3Kahl)} Punkte   (${kahl.entfernt} Tueren)`);
  console.log('');

  // Erst pruefen, ob das Werkzeug ueberhaupt etwas sieht.
  if (Math.abs(d3Kahl) < 0.5 && Math.abs(d3Zufall) < 0.5) {
    console.log('  NICHT GEMESSEN. Auch der Kahlschlag bewegt nichts — dann misst dieses');
    console.log('  Werkzeug die Tueren gar nicht, und keine der Zahlen oben bedeutet etwas.');
    return;
  }

  if (d3 < -1) {
    console.log('  WIDERLEGT. Der frische Satz verliert mehr als einen Punkt.');
    console.log('  Der zweite Einwand des Workshops trifft zu: eine Tuer, die auf dem');
    console.log('  Einstell-Satz nie gewann, war auf ungesehenen Fragen die einzige.');
  } else if (d3Alt > 0.5 && d3 < -0.5) {
    console.log('  WIDERLEGT durch Anpassung. Auf dem eigenen Satz ein Gewinn, auf dem');
    console.log('  frischen ein Verlust — das ist kein Mechanismus, das ist Zurechtlegen.');
  } else if (d3Zufall < -1) {
    console.log('  NICHT WIDERLEGT, UND DIE REGEL TRAEGT.');
    console.log(`  Gleich viele Tueren zufaellig zu entfernen kostet ${vz(d3Zufall)} Punkte,`);
    console.log(`  nach Siegen gewaehlt kostet es ${vz(d3)}. Der Unterschied liegt an der`);
    console.log('  AUSWAHL und nicht an der Menge — genau das behauptet der Kandidat.');
  } else {
    console.log('  NICHT WIDERLEGT, ABER OHNE BELEG FUER DIE REGEL.');
    console.log(`  Zufaellig gleich viele zu entfernen kostet ebenfalls nur ${vz(d3Zufall)} Punkte.`);
    console.log('  Dann hat dieser Bestand einfach Tueren zu viel, und die Siegzaehlung ist');
    console.log('  nicht der Grund. Der Kandidat ist damit nicht belegt.');
  }
  console.log('');
}

if (process.argv.includes('--selbstprobe')) { selbstprobe(); }
else { main().catch((e) => { console.error(e); process.exit(1); }); }
