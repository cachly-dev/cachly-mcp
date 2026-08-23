/**
 * Tor 1: Wie hoch ist die Decke? Das Go/No-Go des Bauplans.
 *
 * ── Was gemessen wird ────────────────────────────────────────────────────────
 *
 * NICHT die Sortierung. Nur die VORAUSWAHL: bei wie vielen Fragen liegt
 * ueberhaupt eine akzeptable Lektion in den 25 besten des Wortpfads oder den
 * 25 besten des Bedeutungspfads? Was in dieser Vereinigung nicht vorkommt,
 * kann kein Sortierer der Welt nach vorne holen.
 *
 * Am 19.08.2026 lag diese Decke bei 84 %. Der Bauplan verlangt >= 88 %,
 * sonst STOPP.
 *
 * ── Die drei Zahlen nebeneinander ───────────────────────────────────────────
 *
 *   heute    — Wortpfad + Bedeutung ueber den VOLLTEXT-Vektor (Sicht A).
 *              Das ist der ausgelieferte Stand.
 *   VarianteB— Wortpfad + Bedeutung ueber ALLE EINGAENGE, je Lektion zaehlt
 *              der BESTE (Maximum, nicht Mittelwert). Eine Lektion wird ueber
 *              ihre passendste Tuer gefunden; die anderen duerfen schlecht
 *              passen.
 *   nur Wort / nur Bedeutung — damit sichtbar ist, WOHER ein Gewinn kommt.
 *
 * ── Warum das Maximum und nicht der Mittelwert ──────────────────────────────
 *
 * Der Mittelwert bestraft Lektionen mit vielen Tueren: wer fuenf Eingaenge hat
 * und bei einem perfekt passt, faellt gegen eine Lektion mit einem einzigen
 * mittelmaessigen Eingang zurueck. Die Tuer-Metapher IST der Mechanismus.
 *
 * Aufruf:
 *   npx tsx src/bench/decke-messen.ts --korpus <korpus.json> \
 *     --pruefsatz <pruefsatz-frisch.json> --eingaenge <eingaenge-b.json> \
 *     --vektoren <eingaenge-b.vektoren.json> [--pool 25]
 *   npx tsx src/bench/decke-messen.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keywordSearch } from '../search.js';
import { kosinus } from '../bedeutung.js';
import { mitLektionen } from './mini-redis.js';
import { schluessel } from './eingaenge-einbetten.js';
import type { Eingang } from './eingaenge-b.js';
import type { BenchLesson } from './fixtures.js';

interface Pruefsatzfrage { query: string; relevant: string[]; art?: string }
interface Korpus { lessons: BenchLesson[]; queries: Pruefsatzfrage[] }
interface Lektionseingaenge { topic: string; eingaenge: Eingang[] }

const PRAEFIX = 'cachly:lesson:best:';

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

/**
 * Die besten n Lektionen nach Bedeutung, wenn je Lektion der BESTE Eingang zaehlt.
 *
 * Lektionen ohne einen einzigen Vektor bekommen -2 und landen hinten. Sie
 * verschwinden nicht still: der Aufrufer bekommt die Zahl gemeldet.
 */
export function besteNachEingang(
  fragevektor: number[],
  eingaengeJeLektion: Map<string, number[][]>,
  themen: string[],
  n: number,
): { liste: Array<{ topic: string; naehe: number }>; ohneVektor: number } {
  let ohneVektor = 0;
  const aus = themen.map((topic) => {
    const vs = eingaengeJeLektion.get(topic);
    if (!vs || vs.length === 0) { ohneVektor++; return { topic, naehe: -2 }; }
    let best = -2;
    for (const v of vs) {
      const k = kosinus(fragevektor, v);
      if (k > best) best = k;
    }
    return { topic, naehe: best };
  });
  aus.sort((a, b) => b.naehe - a.naehe);
  return { liste: aus.slice(0, n), ohneVektor };
}

/** Enthaelt die Vereinigung zweier Trefferlisten eine akzeptable Lektion? */
export function trifft(listen: string[][], akzeptabel: string[]): boolean {
  const menge = new Set(listen.flat());
  return akzeptabel.some((t) => menge.has(t));
}

// ── Selbstprobe ─────────────────────────────────────────────────────────────

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  // Konstruiert: drei Lektionen, ein Fragevektor. Lektion "b" passt NUR ueber
  // ihren zweiten Eingang. Wer den Mittelwert nimmt, findet sie nicht.
  // "b" hat eine perfekt passende Tuer und drei schlechte — genau der Fall,
  // um den es geht: viele Tueren duerfen nicht bestrafen.
  const frage = [1, 0, 0];
  const eing = new Map<string, number[][]>([
    ['a', [[0.5, 0.4, 0]]],
    ['b', [[0.95, 0.1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]]],
    ['c', [[0, 0, 1]]],
  ]);
  const { liste, ohneVektor } = besteNachEingang(frage, eing, ['a', 'b', 'c'], 2);
  p('bester Eingang bringt b nach vorne', liste[0].topic === 'b');
  p('keine Lektion ohne Vektor', ohneVektor === 0);

  const mittel = ['a', 'b', 'c'].map((t) => {
    const vs = eing.get(t)!;
    const m = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
    return { t, n: kosinus(frage, m) };
  }).sort((x, y) => y.n - x.n);
  p('Mittelwert wuerde b NICHT nach vorne bringen', mittel[0].t !== 'b');

  const leer = besteNachEingang(frage, new Map([['a', []]]), ['a', 'z'], 2);
  p('Lektionen ohne Vektor werden gezaehlt', leer.ohneVektor === 2);
  p('sie landen hinten, nicht vorne', leer.liste.every((x) => x.naehe === -2));

  p('Treffer bei zweiter akzeptabler Lektion',
    trifft([['x', 'y'], ['q']], ['nein', 'y']));
  p('kein Treffer, wenn nichts passt', !trifft([['x'], ['q']], ['nein']));

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

// ── Hauptteil ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const korpusPfad = resolve(flag('korpus') ?? '');
  const satzPfad = resolve(flag('pruefsatz') ?? '');
  const eingPfad = resolve(flag('eingaenge') ?? '');
  const vekPfad = resolve(flag('vektoren') ?? '');
  /**
   * Wie viele Plaetze jeder Kanal bekommt.
   *
   * ── WARUM ES ZWEI ZAHLEN BRAUCHT (gefunden am 23.08.2026) ─────────────────
   *
   * Bis heute gab `--pool` beiden Kanaelen dieselbe Zahl, und die Voreinstellung
   * war 25. Das PRODUKT faehrt anders: `handlers/brain.ts:1478` gibt dem
   * Wortabgleich 25 Plaetze, `brain.ts:105` gibt dem Bedeutungskanal 75
   * (`SINN_TOPF`).
   *
   * Der Unterschied ist kein Detail, er verschiebt die Zielgroesse:
   *
   *   Topf 25 je Kanal   nur Woerter 68 %   Woerter+Bedeutung 87 %
   *   Topf 75 je Kanal   nur Woerter 82 %   Woerter+Bedeutung 95 %
   *
   * Zwei Tage lang haben ein Naturworkshop mit zwoelf Rollen und der
   * Orchestrator an einer Luecke von 13 Punkten gearbeitet, die im Produkt
   * 5 Punkte gross ist. Aufgefallen ist es dem Zweifler, der als einziger
   * nachgesehen hat, mit welcher Topfgroesse der Bench eigentlich faehrt.
   *
   * `--pool` bleibt als gemeinsame Zahl erhalten, damit alte Aufrufe und
   * Vergleiche gegen frueher weiter gelten. `--wortpool` und `--sinnpool`
   * ueberschreiben sie einzeln. Wer den AUSLIEFERSTAND messen will, nimmt
   * `--wortpool 25 --sinnpool 75`.
   */
  const POOL = Number(flag('pool') ?? '25');
  const WORTPOOL = Number(flag('wortpool') ?? String(POOL));
  const SINNPOOL = Number(flag('sinnpool') ?? String(POOL));

  for (const [was, pfad] of [['Korpus', korpusPfad], ['Pruefsatz', satzPfad],
    ['Eingangsdatei', eingPfad], ['Vektordatei', vekPfad]] as const) {
    if (!existsSync(pfad)) fehlt(was, pfad);
  }

  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as Korpus;
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Korpus;

  // --streng: nur die EINE urspruenglich gemeinte Lektion zaehlt. Zeigt, wie
  // viel die akzeptablen Nachbarn aus Tor 0b zur Zahl beitragen.
  if (argv.includes('--streng')) {
    for (const q of satz.queries) q.relevant = q.relevant.slice(0, 1);
    console.log('  STRENG: nur die urspruenglich gemeinte Lektion zaehlt.');
  }

  // --nur name,erstsatz : nur diese Eingangsarten benutzen. Damit laesst sich
  // messen, WELCHE Tuer traegt und welche nur Laerm macht.
  const nurArten = flag('nur')?.split(',').map((s2) => s2.trim()).filter(Boolean);
  const { lektionen } = JSON.parse(readFileSync(eingPfad, 'utf8')) as { lektionen: Lektionseingaenge[] };
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> };

  // --tuerfilter <datei> --schwelle <x>: Tueren unter der Trennschaerfe-Schwelle
  // streichen (Kandidat B, tuer-trennschaerfe.ts). Volltext-Tueren sind davon
  // ausgenommen — sie sind die Grundlinie "heute", und eine veraenderte
  // Grundlinie macht jede alte Messung unvergleichbar.
  const filterPfad = flag('tuerfilter');
  const schwelle = Number(flag('schwelle') ?? '0');
  const tuerfilter = filterPfad
    ? (JSON.parse(readFileSync(resolve(filterPfad), 'utf8')) as { tueren: Record<string, number> })
    : null;
  let gestrichen = 0;

  if (satz.queries.length === 0) fehlt('Fragen im Pruefsatz', satzPfad);

  // Sicht A getrennt halten: sie ist die Grundlinie "heute".
  const volltextVektor = new Map<string, number[]>();
  const alleEingaenge = new Map<string, number[][]>();
  let eingaengeOhneVektor = 0;
  for (const l of lektionen) {
    const vs: number[][] = [];
    for (const e of l.eingaenge) {
      if (nurArten && !nurArten.includes(e.art)) {
        // Der Volltextvektor wird trotzdem gemerkt: er ist die Grundlinie.
        const vg = vektoren[schluessel(e.art, e.text)];
        if (e.art === 'volltext' && vg) volltextVektor.set(l.topic, vg);
        continue;
      }
      const key = schluessel(e.art, e.text);
      const v = vektoren[key];
      if (!v) { eingaengeOhneVektor++; continue; }
      if (e.art === 'volltext') volltextVektor.set(l.topic, v);
      if (tuerfilter && e.art !== 'volltext') {
        const w = tuerfilter.tueren[key];
        if (w !== undefined && w < schwelle) { gestrichen++; continue; }
      }
      vs.push(v);
    }
    alleEingaenge.set(l.topic, vs);
  }

  const themen = korpus.lessons.map((l) => l.topic);
  const redis = mitLektionen(korpus.lessons);

  const fehlendeFragen = satz.queries.filter((q) => !vektoren[schluessel('frage', q.query)]).length;
  if (fehlendeFragen > 0) {
    console.error(`NICHT GEMESSEN: ${fehlendeFragen} von ${satz.queries.length} Fragen haben keinen Vektor.`);
    process.exit(3);
  }
  if (eingaengeOhneVektor > 0) {
    console.error(`WARNUNG: ${eingaengeOhneVektor} Eingaenge ohne Vektor — die Decke ist damit eher zu niedrig als zu hoch.`);
  }

  interface Zeile { art: string; wort: boolean; sinnA: boolean; sinnB: boolean; heute: boolean; varianteB: boolean }
  const zeilen: Zeile[] = [];

  for (const q of satz.queries) {
    const fv = vektoren[schluessel('frage', q.query)];
    const wortTreffer = (await keywordSearch(redis as never, [`${PRAEFIX}*`], q.query, WORTPOOL) as Array<{ key: string }>)
      .map((h) => h.key.replace(PRAEFIX, ''));

    const sinnAListe = themen
      .map((t) => ({ topic: t, naehe: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2 }))
      .sort((a, b) => b.naehe - a.naehe).slice(0, SINNPOOL).map((x) => x.topic);

    const sinnBListe = besteNachEingang(fv, alleEingaenge, themen, SINNPOOL).liste.map((x) => x.topic);

    zeilen.push({
      art: q.art ?? 'ohne',
      wort: trifft([wortTreffer], q.relevant),
      sinnA: trifft([sinnAListe], q.relevant),
      sinnB: trifft([sinnBListe], q.relevant),
      heute: trifft([wortTreffer, sinnAListe], q.relevant),
      varianteB: trifft([wortTreffer, sinnBListe], q.relevant),
    });
  }

  const n = zeilen.length;
  const anteil = (f: (z: Zeile) => boolean): string =>
    `${zeilen.filter(f).length} von ${n} (${Math.round((zeilen.filter(f).length / n) * 100)} %)`;

  console.log('');
  // Die Topfgroesse steht in JEDER Ausgabe, und bei ungleichen Kanaelen
  // getrennt. Eine Deckenzahl ohne sie ist nicht einzuordnen — genau das hat
  // am 23.08.2026 zwei Tage Arbeit auf eine falsche Zielgroesse gelenkt.
  const topfText = WORTPOOL === SINNPOOL
    ? `Vorauswahl je ${WORTPOOL}`
    : `Vorauswahl Wort ${WORTPOOL} · Bedeutung ${SINNPOOL}`
      + (WORTPOOL === 25 && SINNPOOL === 75 ? ' (AUSLIEFERSTAND)' : '');
  console.log(`  ${korpus.lessons.length} Lektionen · ${n} frische Fragen · ${topfText}`);
  console.log(`  ${[...alleEingaenge.values()].reduce((s2, v) => s2 + v.length, 0)} Eingaenge mit Vektor`
    + (nurArten ? ` (nur: ${nurArten.join(', ')})` : '')
    + (tuerfilter ? ` · Tuerfilter Schwelle ${schwelle}: ${gestrichen} gestrichen` : ''));
  console.log('');
  console.log('  DECKE — enthaelt die Vorauswahl ueberhaupt eine akzeptable Lektion?');
  console.log(`    nur Woerter                 ${anteil((z) => z.wort)}`);
  console.log(`    nur Bedeutung (Volltext)    ${anteil((z) => z.sinnA)}`);
  console.log(`    nur Bedeutung (Eingaenge)   ${anteil((z) => z.sinnB)}`);
  console.log(`    HEUTE   Woerter + Volltext  ${anteil((z) => z.heute)}`);
  console.log(`    VAR. B  Woerter + Eingaenge ${anteil((z) => z.varianteB)}`);
  console.log('');

  const arten = [...new Set(zeilen.map((z) => z.art))].sort();
  if (arten.length > 1) {
    console.log('  Nach Art der Frage:');
    for (const a of arten) {
      const g = zeilen.filter((z) => z.art === a);
      const h = g.filter((z) => z.heute).length;
      const b = g.filter((z) => z.varianteB).length;
      console.log(`    ${a.padEnd(14)} ${g.length.toString().padStart(3)} Fragen · heute ${h} · Variante B ${b}`);
    }
    console.log('');
  }

  const deckeB = zeilen.filter((z) => z.varianteB).length / n;
  const deckeHeute = zeilen.filter((z) => z.heute).length / n;
  const gewonnen = zeilen.filter((z) => z.varianteB && !z.heute).length;
  const verloren = zeilen.filter((z) => !z.varianteB && z.heute).length;
  console.log(`  Variante B gewinnt ${gewonnen} Fragen und verliert ${verloren}.`);
  console.log('');
  if (deckeB >= 0.88) {
    console.log(`  TOR 1 BESTANDEN: ${Math.round(deckeB * 100)} % >= 88 %. (heute: ${Math.round(deckeHeute * 100)} %)`);
  } else {
    console.log(`  TOR 1 GERISSEN: ${Math.round(deckeB * 100)} % < 88 %. (heute: ${Math.round(deckeHeute * 100)} %)`);
    console.log('  Der Bauplan sagt: STOPP. Naechster Hebel ist das Einbettungsmodell, kein weiteres Merkmal.');
  }
}

if (process.argv.includes('--selbstprobe')) selbstprobe();
else void main();
