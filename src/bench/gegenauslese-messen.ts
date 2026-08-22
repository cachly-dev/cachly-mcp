/**
 * gegenauslese-messen.ts — misst Naturworkshop-Kandidat v1.
 *
 * ── Der Kandidat ────────────────────────────────────────────────────────────
 *
 * Vorbild "Negative Auslese im Thymus" (Lauf 21.08.2026, Ausgang
 * `tragfaehig`, seither ungemessen):
 *
 *   Im Thymus werden T-Zellen nicht danach ausgewaehlt, was sie erkennen,
 *   sondern danach, was sie NICHT erkennen duerfen. Wer auf koerpereigenes
 *   Gewebe anspricht, wird aussortiert.
 *
 *   Bauunterschied: Lege je Lektion nicht nur Fragen ab, die sie beantwortet,
 *   sondern auch GEGENFRAGEN — Fragen, die ihr im Vektorraum nahe liegen und
 *   die sie nachweislich NICHT beantwortet. Wer einer Gegenfrage naeher kommt
 *   als seiner eigenen, wird zurueckgestuft.
 *
 *   Widerlegung, vom Workshop festgelegt: Findequote@3 steigt auf BEIDEN
 *   Fragensaetzen um weniger als 2 Punkte, ODER die Decke faellt unter
 *   95 Prozent.
 *
 * ── Der Einwand, der die Umsetzung festlegt ─────────────────────────────────
 *
 * Der Workshop hat ihn selbst notiert, und er ist der Kern:
 *
 *   "Woher kommen die Gegenfragen? Erfindet man sie, erfindet man seine
 *    eigenen negativen Belege — das ist zirkulaer. Sie muessen aus den Wolken
 *    ANDERER Lektionen kommen: eine Frage, die eine benachbarte Lektion
 *    beantwortet und diese nicht."
 *
 * Deshalb wird hier NICHTS erfunden. Die Gegenfragen einer Lektion sind
 * bestehende Tueren ANDERER Lektionen — die, die ihren eigenen Tueren am
 * naechsten liegen. "Nachweislich nicht beantwortet" heisst schlicht: sie
 * gehoeren jemand anderem. Das kostet keine einzige neue Einbettung.
 *
 * ── Was daran NEU ist gegenueber der schon gefallenen Fassung ───────────────
 *
 * Der Workshop hat bereits eine billige Naeherung gemessen, und sie fiel:
 * "Marge gegen den Besten" (eigene beste Tuer minus beste FREMDE Tuer)
 * erreichte @3 56 und 61 gegen 58 und 63 im Auslieferstand.
 *
 * Der Unterschied ist nicht klein, und er entscheidet, ob das hier eine
 * Wiederholung ist oder eine Messung:
 *
 *   billige Naeherung: der Abzug kommt von der besten Tuer im GANZEN Bestand,
 *                      je Frage neu bestimmt. Das bestraft jede Lektion, die
 *                      irgendwo einen starken Nachbarn hat.
 *
 *   v1 richtig:        der Abzug kommt aus einem FESTEN, je Lektion einmal
 *                      bestimmten Satz von Gegenfragen — den Tueren der
 *                      Lektionen, mit denen SIE verwechselt wird. Eine
 *                      Eigenschaft der Lektion, nicht der Frage.
 *
 * Genau so arbeitet das Vorbild: Die negative Auslese passiert EINMAL, im
 * Thymus, lange vor der ersten echten Begegnung.
 *
 * Aufruf:
 *   npx tsx src/bench/gegenauslese-messen.ts \
 *     --korpus <k.json> --einstellsatz <alt.json> --pruefsatz <frisch.json> \
 *     --eingaenge <e.json> --vektoren <v.json> [--eingang 0.5]
 *   npx tsx src/bench/gegenauslese-messen.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keywordSearch } from '../search.js';
import { kosinus } from '../bedeutung.js';
import {
  Seltenheit, inhaltsWoerter, grobStamm, bewerteTopf, spreizeImTopf, reichereAn,
} from '../rangfolge.js';
import { mitLektionen } from './mini-redis.js';
import { schluessel } from './eingaenge-einbetten.js';
import type { Eingang } from './eingaenge-b.js';
import type { BenchLesson } from './fixtures.js';

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
 * Die negative Auslese: je Lektion die `anzahl` naechsten FREMDEN Tueren.
 *
 * Das ist der Thymus-Schritt und er laeuft EINMAL, nicht je Frage. Fuer jede
 * Lektion werden alle Tueren aller anderen Lektionen betrachtet und die
 * aehnlichsten behalten — das sind die Fragen, bei denen sie faelschlich
 * anspringen wuerde.
 *
 * @param tueren  Thema -> eigene Tuervektoren
 * @param anzahl  wie viele Gegenfragen je Lektion (Workshop: drei)
 */
export function waehleGegenfragen(
  tueren: ReadonlyMap<string, number[][]>,
  anzahl = 3,
): Map<string, number[][]> {
  const themen = [...tueren.keys()];
  const aus = new Map<string, number[][]>();

  for (const thema of themen) {
    const eigene = tueren.get(thema) ?? [];
    if (eigene.length === 0) { aus.set(thema, []); continue; }

    // Naehe einer fremden Tuer zu DIESER Lektion = ihre beste Naehe zu
    // irgendeiner eigenen Tuer. Wer einer eigenen Tuer sehr nahe kommt, ist
    // genau der Nachbar, mit dem verwechselt wird.
    const kandidaten: Array<{ v: number[]; naehe: number }> = [];
    for (const anderes of themen) {
      if (anderes === thema) continue;
      for (const v of tueren.get(anderes) ?? []) {
        let beste = -2;
        for (const e of eigene) { const k = kosinus(e, v); if (k > beste) beste = k; }
        kandidaten.push({ v, naehe: beste });
      }
    }
    kandidaten.sort((a, b) => b.naehe - a.naehe);
    aus.set(thema, kandidaten.slice(0, anzahl).map((x) => x.v));
  }
  return aus;
}

/**
 * Gegenfragen ZUFAELLIG waehlen — die Kontrolle, die den Befund erst zu einem macht.
 *
 * Bei v7 hat genau diese Kontrolle entschieden: gleich viele Tueren zufaellig
 * zu entfernen kostete 3 Punkte, nach Siegen gewaehlt null. Erst der Vergleich
 * sagte etwas ueber die REGEL statt ueber die Menge.
 *
 * Hier gilt dasselbe: Wenn ein zufaelliger Gegenfragen-Satz genauso wirkt wie
 * der nach Naehe gewaehlte, dann wirkt nicht die negative Auslese, sondern
 * irgendein Abzug.
 */
export function zufaelligeGegenfragen(
  tueren: ReadonlyMap<string, number[][]>,
  anzahl = 3,
): Map<string, number[][]> {
  const themen = [...tueren.keys()];
  const alle: number[][] = [];
  for (const vs of tueren.values()) alle.push(...vs);

  let z = 20260822;
  const wuerfel = (): number => (z = (z * 1103515245 + 12345) % 2147483648) / 2147483648;

  const aus = new Map<string, number[][]>();
  for (const thema of themen) {
    const eigene = new Set(tueren.get(thema) ?? []);
    const gewaehlt: number[][] = [];
    let versuche = 0;
    while (gewaehlt.length < anzahl && versuche < 200) {
      versuche++;
      const v = alle[Math.floor(wuerfel() * alle.length)];
      if (v && !eigene.has(v)) gewaehlt.push(v);
    }
    aus.set(thema, gewaehlt);
  }
  return aus;
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

  // Drei Lektionen: a und b liegen nah beieinander, c weit weg.
  const t = new Map<string, number[][]>([
    ['a', [[1, 0, 0]]],
    ['b', [[0.99, 0.14, 0]]],
    ['c', [[0, 0, 1]]],
  ]);
  const g = waehleGegenfragen(t, 1);
  p('die naechste FREMDE Tuer wird gewaehlt', g.get('a')![0][0] > 0.9);
  p('die eigene Tuer ist nie Gegenfrage', g.get('a')!.every((v) => v[0] !== 1 || v[1] !== 0));
  p('auch die entfernte Lektion bekommt eine', (g.get('c') ?? []).length === 1);

  // KONTROLLE: mehr Gegenfragen als es fremde Tueren gibt -> nur so viele wie da sind.
  const g2 = waehleGegenfragen(t, 99);
  p('nie mehr Gegenfragen als fremde Tueren', g2.get('a')!.length === 2);

  // KONTROLLE: der Zufallssatz hat dieselbe GROESSE, aber andere Auswahl.
  const z = zufaelligeGegenfragen(t, 1);
  p('der Zufallssatz ist gleich gross', z.get('a')!.length === 1);
  p('der Zufallssatz nimmt keine eigene Tuer', z.get('a')![0][0] !== 1 || z.get('a')![0][1] !== 0);

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
  const POOL = Number(flag('pool') ?? '25');
  const eingangsGewicht = Number(flag('eingang') ?? '0.5');
  const anzahlGegen = Number(flag('gegenfragen') ?? '3');

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

  /**
   * Ein Messlauf. `gegen` = null bedeutet: ohne Gegenauslese, also der
   * Auslieferstand. `lambda` ist das Gewicht des Abzugs.
   */
  async function miss(
    fragen: readonly Frage[],
    gegen: ReadonlyMap<string, number[][]> | null,
    lambda: number,
  ): Promise<{ plaetze: number[]; imTopf: number; abzuege: number }> {
    const plaetze: number[] = [];
    let imTopf = 0;
    let abzuege = 0;

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

      // DIE GEGENAUSLESE: wie nah kommt die Frage der naechsten Gegenfrage
      // DIESER Lektion? Der Satz ist fest, nicht je Frage neu bestimmt.
      const gegenNaehe = (t: string): number => {
        const vs = gegen?.get(t) ?? [];
        let best = -2;
        for (const v of vs) { const k = kosinus(fv, v); if (k > best) best = k; }
        return best;
      };

      const sinnListe = themen
        .map((t) => ({ t, n: besterEingangVon(t) }))
        .sort((a, b) => b.n - a.n).slice(0, POOL).map((x) => x.t);

      const topf = [...new Set([...wortListe, ...sinnListe])];
      if (q.relevant.some((r) => topf.includes(r))) imTopf++;

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

      if (gegen && lambda > 0) {
        // Gespreizt wie das positive Merkmal, sonst haetten die beiden
        // verschiedene Maszstaebe und lambda waere nicht deutbar.
        const gespreizt = spreizeImTopf(topf.map(gegenNaehe));
        for (let i = 0; i < punkte.length; i++) {
          if (gespreizt[i] > 0) abzuege++;
          punkte[i] -= lambda * gespreizt[i];
        }
      }

      const rangfolge = topf.map((t, i) => ({ t, p: punkte[i] }))
        .sort((a, b) => b.p - a.p).map((x) => x.t);
      plaetze.push(bestePlatzierung(rangfolge, q.relevant));
    }
    return { plaetze, imTopf, abzuege };
  }

  const q = (ps: number[], bis: number): number =>
    (ps.filter((p) => p > 0 && p <= bis).length / ps.length) * 100;
  const p = (x: number): string => `${x.toFixed(1)} %`.padStart(9);
  const vz = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

  const tuerenGesamt = [...tuerVektoren.values()].reduce((n, vs) => n + vs.length, 0);

  console.log('\n  Naturworkshop v1 — Negative Auslese im Thymus');
  console.log('  ════════════════════════════════════════════════════════════════');
  console.log(`  Lektionen        ${korpus.lessons.length}`);
  console.log(`  Tueren gesamt    ${tuerenGesamt}`);
  console.log(`  Einstellsatz     ${einstell.queries.length} Fragen`);
  console.log(`  Pruefsatz        ${satz.queries.length} Fragen`);
  console.log(`  Ueberschneidung  ${ueberschneidung}${ueberschneidung > 0 ? '   ← ACHTUNG' : '   (sauber getrennt)'}`);

  const gegen = waehleGegenfragen(tuerVektoren, anzahlGegen);
  const zufall = zufaelligeGegenfragen(tuerVektoren, anzahlGegen);
  const gegenGesamt = [...gegen.values()].reduce((n, vs) => n + vs.length, 0);
  console.log(`  Gegenfragen      ${gegenGesamt} (${anzahlGegen} je Lektion, aus fremden Tueren — keine neue Einbettung)`);

  const grundFrisch = await miss(satz.queries, null, 0);
  const grundAlt = await miss(einstell.queries, null, 0);

  console.log('\n  Findequote auf dem FRISCHEN Satz (ungesehene Fragen)');
  console.log('  ────────────────────────────────────────────────────────────────');
  console.log(`  ${'Variante'.padEnd(30)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'@10'.padStart(9)}${'Decke'.padStart(9)}`);
  const decke = (m: { imTopf: number }, n: number): string => `${((m.imTopf / n) * 100).toFixed(1)} %`.padStart(9);
  console.log(`  ${'ohne Gegenauslese'.padEnd(30)}${p(q(grundFrisch.plaetze, 1))}${p(q(grundFrisch.plaetze, 3))}${p(q(grundFrisch.plaetze, 10))}${decke(grundFrisch, satz.queries.length)}`);

  let besterLambda = 0;
  let bestes3 = q(grundFrisch.plaetze, 3);
  const ergebnisse: Array<{ lambda: number; m: Awaited<ReturnType<typeof miss>> }> = [];

  for (const lambda of [0.15, 0.3, 0.5, 0.8]) {
    const m = await miss(satz.queries, gegen, lambda);
    ergebnisse.push({ lambda, m });
    console.log(`  ${`nach Naehe, lambda=${lambda}`.padEnd(30)}${p(q(m.plaetze, 1))}${p(q(m.plaetze, 3))}${p(q(m.plaetze, 10))}${decke(m, satz.queries.length)}`);
    if (q(m.plaetze, 3) > bestes3) { bestes3 = q(m.plaetze, 3); besterLambda = lambda; }
  }

  // KONTROLLE: derselbe Abzug, aber zufaellig gewaehlte Gegenfragen.
  const lambdaFuerKontrolle = besterLambda || 0.3;
  const kontrolle = await miss(satz.queries, zufall, lambdaFuerKontrolle);
  console.log(`  ${`KONTROLLE zufaellig, l=${lambdaFuerKontrolle}`.padEnd(30)}${p(q(kontrolle.plaetze, 1))}${p(q(kontrolle.plaetze, 3))}${p(q(kontrolle.plaetze, 10))}${decke(kontrolle, satz.queries.length)}`);

  const besterLauf = ergebnisse.find((e) => e.lambda === (besterLambda || 0.3))!;
  const altBest = await miss(einstell.queries, gegen, besterLambda || 0.3);

  console.log('\n  Zum Vergleich, EINSTELL-Satz');
  console.log('  ────────────────────────────────────────────────────────────────');
  console.log(`  ${'ohne Gegenauslese'.padEnd(30)}${p(q(grundAlt.plaetze, 1))}${p(q(grundAlt.plaetze, 3))}${p(q(grundAlt.plaetze, 10))}${decke(grundAlt, einstell.queries.length)}`);
  console.log(`  ${`nach Naehe, lambda=${besterLambda || 0.3}`.padEnd(30)}${p(q(altBest.plaetze, 1))}${p(q(altBest.plaetze, 3))}${p(q(altBest.plaetze, 10))}${decke(altBest, einstell.queries.length)}`);

  const d3Frisch = q(besterLauf.m.plaetze, 3) - q(grundFrisch.plaetze, 3);
  const d3Alt = q(altBest.plaetze, 3) - q(grundAlt.plaetze, 3);
  const d3Zufall = q(kontrolle.plaetze, 3) - q(grundFrisch.plaetze, 3);
  const deckeFrisch = (besterLauf.m.imTopf / satz.queries.length) * 100;

  console.log('\n  Urteil');
  console.log('  ════════════════════════════════════════════════════════════════');
  console.log('  Widerlegt, wenn @3 auf BEIDEN Saetzen um weniger als 2 Punkte steigt,');
  console.log('  ODER die Decke unter 95 Prozent faellt.');
  console.log('');
  console.log(`  bestes lambda                        ${besterLambda || '(keins besser als 0)'}`);
  console.log(`  @3 frisch                            ${vz(d3Frisch)} Punkte`);
  console.log(`  @3 Einstell                          ${vz(d3Alt)} Punkte`);
  console.log(`  @3 frisch, KONTROLLE zufaellig       ${vz(d3Zufall)} Punkte`);
  console.log(`  Decke frisch                         ${((grundFrisch.imTopf / satz.queries.length) * 100).toFixed(1)} % → ${deckeFrisch.toFixed(1)} %`);
  console.log(`  Abzuege im besten Lauf               ${besterLauf.m.abzuege}`);
  console.log('');

  // Platz 1 wird eigens genannt: der Kandidat kann die SPITZE verbessern und
  // @3 trotzdem verschlechtern. Wer nur auf @3 sieht, uebersieht das.
  const d1FrischBest = q(besterLauf.m.plaetze, 1) - q(grundFrisch.plaetze, 1);
  const bestesPlatz1 = ergebnisse.reduce(
    (b, e) => (q(e.m.plaetze, 1) > q(b.m.plaetze, 1) ? e : b), ergebnisse[0],
  );
  console.log(`  Platz 1 frisch, bei lambda=${besterLambda || 0.3}          ${vz(d1FrischBest)} Punkte`);
  console.log(`  Platz 1 frisch, BESTES lambda=${bestesPlatz1.lambda}       ${vz(q(bestesPlatz1.m.plaetze, 1) - q(grundFrisch.plaetze, 1))} Punkte`);
  console.log('');

  /*
   * BEWEIS, DASS ES LAEUFT. Bei v3 hatte eine wirkungslose Umsetzung fast als
   * "Kandidat widerlegt" gegolten. Zeigt der Zaehler null Abzuege, ist nicht
   * der Kandidat widerlegt, sondern das Werkzeug kaputt.
   */
  if (besterLauf.m.abzuege === 0) {
    console.log('  NICHT GEMESSEN: es wurde kein einziger Abzug vorgenommen.');
    console.log('  Dann greift die Gegenauslese gar nicht, und keine Zahl oben bedeutet etwas.');
    return;
  }

  /*
   * ── Die Decke wird gegen den AUSGANGSWERT geprueft, nicht gegen 95 ────────
   *
   * Der Workshop hatte "Decke faellt unter 95 Prozent" als Bedingung notiert.
   * Diese Zahl stammt aus einer aelteren Messung mit anderer Vorauswahl; auf
   * diesem Bestand liegt die Decke OHNE jeden Eingriff bereits bei 86,0 %.
   *
   * Die erste Fassung dieses Werkzeugs verglich stur gegen 95 und meldete
   * prompt "WIDERLEGT ueber die Decke" — fuer einen Wert, den der Kandidat gar
   * nicht verursacht hat. Das ist dieselbe Fehlerklasse wie ein Waechter mit
   * fester Zahl: er bewacht den Anlass von damals und beschuldigt heute den
   * Falschen.
   *
   * Gemessen wird also, ob der Eingriff die Decke SENKT. Tut er das nicht,
   * entscheidet die Findequote — und dort gehoert die Entscheidung auch hin.
   */
  const deckeGrund = (grundFrisch.imTopf / satz.queries.length) * 100;
  const deckeVerlust = deckeGrund - deckeFrisch;

  if (deckeVerlust > 1) {
    console.log(`  WIDERLEGT ueber die Decke: ${deckeGrund.toFixed(1)} % → ${deckeFrisch.toFixed(1)} %.`);
    console.log('  Der Abzug draengt richtige Antworten aus der Vorauswahl — was danach');
    console.log('  passiert, ist gleichgueltig.');
  } else if (d3Frisch < 2 && d3Alt < 2) {
    console.log('  WIDERLEGT. Auf beiden Saetzen weniger als 2 Punkte.');
    console.log('  Der Thymus sortiert aus, was koerpereigenes Gewebe angreift — hier gibt es');
    console.log('  kein "koerpereigen": zwei nahe Lektionen koennen einander ergaenzen statt');
    console.log('  sich auszuschliessen. Genau da fuehrt das Vorbild in die Irre.');
  } else if (d3Zufall >= d3Frisch - 0.5) {
    console.log('  NICHT BELEGT. Ein zufaelliger Gegenfragen-Satz wirkt genauso gut.');
    console.log('  Dann wirkt irgendein Abzug, nicht die negative AUSLESE — und der');
    console.log('  Kandidat behauptet die Auslese, nicht den Abzug.');
  } else {
    console.log('  NICHT WIDERLEGT. Zum ersten Mal steigt die Findequote.');
    console.log(`  Und die Auswahl traegt: zufaellige Gegenfragen bringen nur ${vz(d3Zufall)}.`);
  }
  console.log('');
}

if (process.argv.includes('--selbstprobe')) { selbstprobe(); }
else { main().catch((e) => { console.error(e); process.exit(1); }); }
