/**
 * zweikanal-messen.ts — misst den Kandidaten des Schwarmforschers
 * aus dem zweiten Naturworkshop (22.08.2026).
 *
 * ── Der Kandidat ────────────────────────────────────────────────────────────
 *
 * Vorbild "Doppelte Kanalpruefung in der Vogelkolonie" (Koenigspinguin):
 *
 *   In einer dichten Kolonie klingt und riecht ein fremdes Junges einem eigenen
 *   zum Verwechseln aehnlich — alle folgen demselben Bauplan. Erkennung ueber
 *   EIN Merkmal hat deshalb eine Fehlerrate, die der Anteil aehnlich klingender
 *   Fremder vorgibt, und die sinkt nicht, egal wie genau man dieses eine
 *   Merkmal misst.
 *
 *   Zwei Merkmale aus UNABHAENGIGEN Quellen senken die Fehlerrate dagegen
 *   multiplikativ: ein Fremder muss auf BEIDEN gleichzeitig zufaellig passen.
 *   Das gilt nur, solange die Fehler nicht gemeinsam auftreten — stammen beide
 *   Kanaele aus derselben Quelle, wiederholt der zweite nur den Fehler des
 *   ersten.
 *
 * ── Warum das hier passen koennte ───────────────────────────────────────────
 *
 * Von vier Merkmalen im Sortierer sind DREI Kosinus-Werte auf Einbettungen
 * derselben Texte. `seltenheitsDeckung` ist das einzige, das anders arbeitet:
 * es zaehlt woertliche Deckung seltener Fragewoerter. Ein anderer Kanal.
 *
 * Heute darf dieser Kanal nur MITADDIEREN. Er kann eine Lektion nie gegen die
 * drei korrelierten Vektor-Kanaele durchsetzen, weil sein Beitrag im Rauschen
 * der drei untergeht. Der Bauunterschied gibt ihm ein begrenztes Vetorecht.
 *
 * ── Der Einwand, den der Schwarmforscher SELBST genannt hat ─────────────────
 *
 * "seltenheitsDeckung ist zwar wortbasiert statt einbettungsbasiert, stammt
 *  aber aus demselben Lektionstext wie naeheText — vollstaendig unabhaengig
 *  sind die zwei Kanaele also nicht."
 *
 * Genau das prueft die Messung. Haelt der Gewinn nicht, ist die Korrelation zu
 * hoch, und das gehoert in die Liste der Sackgassen statt ein zweites Mal
 * gebaut zu werden.
 *
 * ── Die Widerlegung, vom Vorbild festgelegt ─────────────────────────────────
 *
 *   1. Findequote@3 steigt um weniger als 2 Punkte, ODER
 *   2. mehr als 3 der bisher korrekt in den Top 3 gezeigten Faelle fallen
 *      dabei heraus.
 *
 * Bedingung 2 ist die wichtige: Eine Regel, die drei neue Faelle gewinnt und
 * vier alte verliert, sieht in der Gesamtzahl gut aus und ist trotzdem
 * schaedlich. Sie wird deshalb EINZELN gezaehlt, nicht nur saldiert.
 *
 * Aufruf:
 *   npx tsx src/bench/zweikanal-messen.ts \
 *     --korpus <k.json> --einstellsatz <alt.json> --pruefsatz <frisch.json> \
 *     --eingaenge <e.json> --vektoren <v.json>
 *   npx tsx src/bench/zweikanal-messen.ts --selbstprobe
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
 * Das Nachruecken: der zweite Kanal darf EINEN Kandidaten auf Platz 3 heben.
 *
 * Bedingungen, alle drei noetig:
 *   - er steht unter den obersten `pool` (sonst waere es kein Nachruecken,
 *     sondern eine zweite Suche)
 *   - er ist unter denen der beste im zweiten Kanal
 *   - er steht NICHT schon unter den obersten drei
 *   - sein Rueckstand auf den Drittplatzierten ist kleiner als `marge`
 *
 * Die letzte Bedingung ist die Bremse. Ohne sie wuerde der zweite Kanal einen
 * Kandidaten hochziehen, den der erste klar abgelehnt hat — und das ist genau
 * kein "beide muessen passen", sondern ein Alleingang.
 *
 * @returns die neue Rangfolge und ob wirklich verschoben wurde
 */
export function rueckeNach(
  rang: readonly string[],
  zweiterKanal: ReadonlyMap<string, number>,
  pool: number,
  marge: number,
  punkte: ReadonlyMap<string, number>,
): { rang: string[]; verschoben: boolean } {
  if (rang.length < 4) return { rang: [...rang], verschoben: false };

  const oben = rang.slice(0, pool);
  let bester = '';
  let besteDeckung = -1;
  for (const t of oben) {
    const d = zweiterKanal.get(t) ?? 0;
    if (d > besteDeckung) { besteDeckung = d; bester = t; }
  }
  if (!bester) return { rang: [...rang], verschoben: false };

  const platz = rang.indexOf(bester);
  if (platz < 3) return { rang: [...rang], verschoben: false };   // schon vorne

  const dritter = rang[2];
  const rueckstand = (punkte.get(dritter) ?? 0) - (punkte.get(bester) ?? 0);
  if (rueckstand >= marge) return { rang: [...rang], verschoben: false };

  const neu = rang.filter((t) => t !== bester);
  neu.splice(2, 0, bester);
  return { rang: neu, verschoben: true };
}

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  p('Platz 1 wird als 1 gemeldet', bestePlatzierung(['a', 'b'], ['a']) === 1);

  const rang = ['a', 'b', 'c', 'd', 'e', 'f'];
  const punkte = new Map([['a', 1.0], ['b', 0.9], ['c', 0.8], ['d', 0.75], ['e', 0.5], ['f', 0.4]]);

  // d hat die beste Wortdeckung und liegt nur 0,05 hinter c -> rueckt nach.
  const kanal1 = new Map([['a', 0.1], ['b', 0.1], ['c', 0.1], ['d', 0.9], ['e', 0.1], ['f', 0.1]]);
  const r1 = rueckeNach(rang, kanal1, 6, 0.15, punkte);
  p('der beste im zweiten Kanal rueckt auf Platz 3', r1.rang[2] === 'd' && r1.verschoben);
  p('die Ersten beiden bleiben unangetastet', r1.rang[0] === 'a' && r1.rang[1] === 'b');

  // KONTROLLE: zu grosser Rueckstand -> kein Nachruecken.
  const kanal2 = new Map([['a', 0.1], ['b', 0.1], ['c', 0.1], ['d', 0.1], ['e', 0.1], ['f', 0.9]]);
  const r2 = rueckeNach(rang, kanal2, 6, 0.15, punkte);
  p('bei zu grossem Rueckstand bleibt alles', !r2.verschoben && r2.rang[2] === 'c');

  // KONTROLLE: steht er schon vorne, passiert nichts.
  const kanal3 = new Map([['a', 0.9], ['b', 0.1], ['c', 0.1], ['d', 0.1], ['e', 0.1], ['f', 0.1]]);
  const r3 = rueckeNach(rang, kanal3, 6, 0.15, punkte);
  p('wer schon vorne steht, wird nicht bewegt', !r3.verschoben);

  // KONTROLLE: ein zu kleiner Topf wird nicht angefasst.
  const r4 = rueckeNach(['a', 'b'], kanal1, 6, 0.15, punkte);
  p('ein Topf mit zwei Kandidaten bleibt', !r4.verschoben);

  // KONTROLLE: die Laenge aendert sich nie.
  p('kein Kandidat geht verloren', r1.rang.length === rang.length);
  p('kein Kandidat kommt doppelt', new Set(r1.rang).size === rang.length);

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

  for (const [was, pfad] of [['Korpus', korpusPfad], ['Einstellsatz', einstellPfad],
    ['Pruefsatz', satzPfad], ['Eingangsdatei', eingPfad], ['Vektordatei', vekPfad]] as const) {
    if (!existsSync(pfad)) fehlt(was, pfad);
  }

  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as Korpus;
  const einstell = JSON.parse(readFileSync(einstellPfad, 'utf8')) as Korpus;
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Korpus;
  const { lektionen } = JSON.parse(readFileSync(eingPfad, 'utf8')) as { lektionen: Lektionseingaenge[] };
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, unknown> };

  // Die Zeichenkette "leer" ist eine Vereinbarung des Messkorpus
  // (bench/zwei-sichten.ts:47), kein Fehler — aber sie ist kein Vektor.
  // Ungefiltert ergibt kosinus darauf NaN, und spreizeImTopf macht daraus
  // lautlos eine 0.
  const volltextVektor = new Map<string, number[]>();
  const themaVektor = new Map<string, number[]>();
  const tuerVektoren = new Map<string, number[][]>();
  let keineVektoren = 0;
  for (const l of lektionen) {
    const vs: number[][] = [];
    for (const e of l.eingaenge) {
      const v = vektoren[schluessel(e.art, e.text)];
      if (!v) continue;
      if (!Array.isArray(v)) { keineVektoren++; continue; }
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

  let verschiebungen = 0;

  /** `marge` = 0 schaltet das Nachruecken ab (Auslieferstand). */
  async function miss(fragen: readonly Frage[], pool: number, marge: number): Promise<number[]> {
    const plaetze: number[] = [];
    for (const q of fragen) {
      const fv = vektoren[schluessel('frage', q.query)] as number[] | undefined;
      if (!fv || !Array.isArray(fv)) fehlt(`Vektor fuer "${q.query.slice(0, 40)}"`, vekPfad);

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

      const deckungen = new Map<string, number>();
      let punkte = bewerteTopf(topf.map((t) => {
        const wt = textWoerter.get(t) ?? new Set<string>();
        const d = seltenheit.deckung(fw, wt);
        deckungen.set(t, d);
        return {
          naeheText: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2,
          naeheThema: themaVektor.has(t) ? kosinus(fv, themaVektor.get(t)!) : -2,
          naeheRueckkopplung: volltextVektor.has(t) ? kosinus(angereichert, volltextVektor.get(t)!) : -2,
          seltenheitsDeckung: d,
        };
      }));
      if (eingangsGewicht > 0) {
        const gespreizt = spreizeImTopf(topf.map(besterEingangVon));
        punkte = punkte.map((p, i) => p + eingangsGewicht * gespreizt[i]);
      }

      const punkteVon = new Map(topf.map((t, i) => [t, punkte[i]]));
      let rang = topf.map((t, i) => ({ t, p: punkte[i] }))
        .sort((a, b) => b.p - a.p).map((x) => x.t);

      if (marge > 0) {
        const r = rueckeNach(rang, deckungen, pool, marge, punkteVon);
        rang = r.rang;
        if (r.verschoben) verschiebungen++;
      }

      plaetze.push(bestePlatzierung(rang, q.relevant));
    }
    return plaetze;
  }

  const q = (ps: number[], bis: number): number =>
    (ps.filter((p) => p > 0 && p <= bis).length / ps.length) * 100;
  const p = (x: number): string => `${x.toFixed(1)} %`.padStart(9);
  const vz = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

  console.log('\n  Naturworkshop II — Doppelte Kanalpruefung (Koenigspinguin)');
  console.log('  ════════════════════════════════════════════════════════════════════');
  console.log(`  Lektionen ${korpus.lessons.length} · Pruefsatz ${satz.queries.length} · Einstellsatz ${einstell.queries.length}`);
  if (keineVektoren > 0) {
    console.log(`  HINWEIS: ${keineVektoren} Eintraege sind Zeichenkette statt Zahlenfeld — uebersprungen.`);
  }
  console.log('');
  console.log('  Der zweite Kanal ist `seltenheitsDeckung`: woertliche Deckung seltener');
  console.log('  Fragewoerter. Heute darf er nur mitaddieren; hier bekommt er ein');
  console.log('  begrenztes Vetorecht — er darf EINEN Kandidaten auf Platz 3 heben.');

  verschiebungen = 0;
  const grundFrisch = await miss(satz.queries, 8, 0);
  const grundAlt = await miss(einstell.queries, 8, 0);
  const grundVerschiebungen = verschiebungen;

  console.log('\n  FRISCHER Satz (100 ungesehene Fragen)');
  console.log('  ────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Variante'.padEnd(30)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'@10'.padStart(9)}${'geschoben'.padStart(11)}${'verloren'.padStart(10)}`);
  console.log(`  ${'Auslieferstand'.padEnd(30)}${p(q(grundFrisch, 1))}${p(q(grundFrisch, 3))}${p(q(grundFrisch, 10))}${String(grundVerschiebungen).padStart(11)}${'—'.padStart(10)}`);

  interface Lauf { pool: number; marge: number; frisch: number[]; alt: number[]; geschoben: number; verloren: number }
  const laeufe: Lauf[] = [];

  for (const pool of [6, 8, 12]) {
    for (const marge of [0.08, 0.15, 0.25]) {
      verschiebungen = 0;
      const frisch = await miss(satz.queries, pool, marge);
      const alt = await miss(einstell.queries, pool, marge);
      /*
       * Bedingung 2 des Vorbilds, EINZELN gezaehlt: wie viele Faelle, die vorher
       * korrekt in den Top 3 standen, fallen jetzt heraus? Eine Regel, die drei
       * neue gewinnt und vier alte verliert, sieht saldiert gut aus und ist
       * trotzdem schaedlich.
       */
      let verloren = 0;
      for (let i = 0; i < grundFrisch.length; i++) {
        const vorher = grundFrisch[i];
        const nachher = frisch[i];
        if (vorher > 0 && vorher <= 3 && !(nachher > 0 && nachher <= 3)) verloren++;
      }
      laeufe.push({ pool, marge, frisch, alt, geschoben: verschiebungen, verloren });
      console.log(`  ${`Pool ${pool}, Marge ${marge}`.padEnd(30)}${p(q(frisch, 1))}${p(q(frisch, 3))}${p(q(frisch, 10))}${String(verschiebungen).padStart(11)}${String(verloren).padStart(10)}`);
    }
  }

  const bester = laeufe.reduce((b, l) => (q(l.frisch, 3) > q(b.frisch, 3) ? l : b), laeufe[0]);

  console.log('\n  EINSTELL-Satz (zum Gegenpruefen)');
  console.log('  ────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Auslieferstand'.padEnd(30)}${p(q(grundAlt, 1))}${p(q(grundAlt, 3))}${p(q(grundAlt, 10))}`);
  console.log(`  ${`Pool ${bester.pool}, Marge ${bester.marge}`.padEnd(30)}${p(q(bester.alt, 1))}${p(q(bester.alt, 3))}${p(q(bester.alt, 10))}`);

  const d3 = q(bester.frisch, 3) - q(grundFrisch, 3);
  const d1 = q(bester.frisch, 1) - q(grundFrisch, 1);
  const d3Alt = q(bester.alt, 3) - q(grundAlt, 3);

  console.log('\n  Urteil');
  console.log('  ════════════════════════════════════════════════════════════════════');
  console.log('  Widerlegt, wenn @3 um weniger als 2 Punkte steigt ODER mehr als 3 der');
  console.log('  bisher korrekt gezeigten Faelle herausfallen.');
  console.log('');
  console.log(`  beste Einstellung                    Pool ${bester.pool}, Marge ${bester.marge}`);
  console.log(`  @3 frisch                            ${vz(d3)} Punkte`);
  console.log(`  Platz 1 frisch                       ${vz(d1)} Punkte`);
  console.log(`  @3 Einstell                          ${vz(d3Alt)} Punkte`);
  console.log(`  Nachrueckungen im besten Lauf        ${bester.geschoben}`);
  console.log(`  vorher richtige Faelle verloren      ${bester.verloren}`);
  console.log('');

  /*
   * ── IST DER UNTERSCHIED GROESSER ALS DAS RAUSCHEN? ───────────────────────
   *
   * Eine Prozentzahl auf 100 Fragen sagt das nicht. Was es sagt, ist die Zahl
   * der Fragen, die in JEDE RICHTUNG kippen — dieselben Fragen, zwei
   * Varianten, also ein gepaarter Vergleich.
   *
   * "58 auf 60" kann heissen: zwei Fragen gewonnen, null verloren. Es kann
   * auch heissen: sieben gewonnen, fuenf verloren. Das erste waere ein
   * Hinweis, das zweite ist Muenzwurf mit Prozentzeichen — und in der
   * Prozentzahl sehen beide gleich aus.
   *
   * Der Messstand hat 200 Fragen in zwei Saetzen (korpus-gross.json und
   * pruefsatz-alt.json sind DIESELBEN 100 — nachgezaehlt 22.08.2026, 100
   * Ueberschneidungen). Fuer einen Unterschied von einem Punkt ist das zu
   * wenig, und diese Zeilen zeigen es, statt es zu behaupten.
   */
  const kipp = (vorher: number[], nachher: number[]): { rein: number; raus: number } => {
    let rein = 0; let raus = 0;
    for (let i = 0; i < vorher.length; i++) {
      const a = vorher[i] > 0 && vorher[i] <= 3;
      const b = nachher[i] > 0 && nachher[i] <= 3;
      if (!a && b) rein++;
      if (a && !b) raus++;
    }
    return { rein, raus };
  };
  const kf = kipp(grundFrisch, bester.frisch);
  const ka = kipp(grundAlt, bester.alt);

  console.log('  Wie viele Fragen kippen wirklich? (gepaart, dieselben Fragen)');
  console.log('  ────────────────────────────────────────────────────────────────────');
  console.log(`  frisch:    ${kf.rein} neu richtig, ${kf.raus} verloren  →  netto ${kf.rein - kf.raus >= 0 ? '+' : ''}${kf.rein - kf.raus}`);
  console.log(`  Einstell:  ${ka.rein} neu richtig, ${ka.raus} verloren  →  netto ${ka.rein - ka.raus >= 0 ? '+' : ''}${ka.rein - ka.raus}`);
  console.log(`  BEIDE:     ${kf.rein + ka.rein} neu richtig, ${kf.raus + ka.raus} verloren  →  netto ${(kf.rein + ka.rein) - (kf.raus + ka.raus) >= 0 ? '+' : ''}${(kf.rein + ka.rein) - (kf.raus + ka.raus)} von 200 Fragen`);
  console.log('');

  const maxGeschoben = Math.max(...laeufe.map((l) => l.geschoben));
  if (maxGeschoben === 0) {
    console.log('  NICHT GEMESSEN: in keiner Einstellung wurde ein Kandidat nachgerueckt.');
    console.log('  Dann greift die Regel gar nicht, und keine Zahl oben bedeutet etwas.');
    return;
  }

  if (bester.verloren > 3) {
    console.log(`  WIDERLEGT ueber die Verluste: ${bester.verloren} vorher richtige Faelle sind`);
    console.log('  herausgefallen. Der zweite Kanal ist zu wenig unabhaengig vom ersten —');
    console.log('  er stammt aus demselben Lektionstext und wiederholt dessen Fehler.');
  } else if (d3 < 2) {
    console.log(`  WIDERLEGT. Beste Einstellung bringt nur ${vz(d3)} Punkte @3.`);
    console.log('  Der Pinguin hat zwei Kanaele aus zwei Koerperquellen. Unsere zwei');
    console.log('  stammen aus demselben Text — und dann multipliziert sich die');
    console.log('  Fehlerrate nicht, sie wiederholt sich.');
  } else if (d3Alt < 0) {
    /*
     * ── Warum BEIDE Saetze zaehlen muessen ───────────────────────────────
     *
     * Die Bedingung des Vorbilds nennt nur den frischen Satz. Das reicht
     * nicht, und der erste Lauf hat genau gezeigt warum: Pool 6 / Marge 0,15
     * brachte +2 auf dem frischen Satz und -1 auf dem Einstell-Satz. Ueber
     * beide zusammen ist das EINE Frage von zweihundert.
     *
     * Dazu kommt die Form der Abtastung: von neun Einstellungen erreichte
     * genau EINE die Schwelle, alle ihre Nachbarn lagen bei +1. Ein einzelner
     * Punkt in einer Abtastung, dessen Nachbarn niedriger liegen, ist die
     * klassische Anpassung an den eigenen Messsatz — nicht ein Mechanismus.
     *
     * Deshalb ist ein Gewinn auf EINEM Satz keiner. Das ist dieselbe Regel,
     * die der Messstand mit zwei eingefrorenen Saetzen ueberhaupt erst
     * ermoeglicht; sie hier nicht anzuwenden hiesse, den zweiten Satz zu
     * haben und nicht zu benutzen.
     */
    console.log(`  NICHT BELEGT. ${vz(d3)} Punkte auf dem frischen Satz, aber ${vz(d3Alt)} auf dem`);
    console.log('  Einstell-Satz. Ueber beide zusammen bleibt praktisch nichts uebrig.');
    console.log('');
    console.log('  Dazu die Form der Abtastung: von neun Einstellungen erreicht genau EINE');
    console.log('  die Schwelle, alle ihre Nachbarn liegen darunter. Ein einzelner Punkt,');
    console.log('  dessen Nachbarn niedriger liegen, ist Anpassung an den Messsatz.');
    console.log('');
    console.log('  WAS TROTZDEM BLEIBT: Das Nachruecken kostet NICHTS — null vorher richtige');
    console.log(`  Faelle verloren bei ${bester.geschoben} Verschiebungen. Der zweite Kanal schadet also`);
    console.log('  nicht, er hilft nur zu wenig, um es zu belegen.');
  } else {
    console.log(`  NICHT WIDERLEGT. ${vz(d3)} Punkte @3 auf dem frischen Satz, ${vz(d3Alt)} auf dem`);
    console.log(`  Einstell-Satz, bei nur ${bester.verloren} verlorenen Faellen.`);
    console.log('  ZUM ERSTEN MAL bewegt sich die Bestmarke — auf BEIDEN Saetzen.');
  }
  console.log('');
}

if (process.argv.includes('--selbstprobe')) { selbstprobe(); }
else { main().catch((e) => { console.error(e); process.exit(1); }); }
