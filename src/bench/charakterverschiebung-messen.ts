/**
 * charakterverschiebung-messen.ts — misst den Kandidaten des Oekologen
 * aus dem zweiten Naturworkshop (22.08.2026).
 *
 * ── Der Kandidat ────────────────────────────────────────────────────────────
 *
 * Vorbild "Charakterverschiebung" (character displacement), Darwin-Finken:
 *
 *   Zwei Vogelarten auf derselben Insel brauchen denselben Samentyp, und ihre
 *   Schnaebel sind fast gleich gross. Leben beide zusammen, ueberlebt eher, wer
 *   vom anderen ABWEICHT — einer wird kleiner, einer groesser. Auf einer
 *   Nachbarinsel mit nur einer der Arten fehlt dieser Druck, und ihr Schnabel
 *   bleibt beim alten, ueberlappenden Mass.
 *
 *   Verschoben wird NUR das eine Mass, um das konkurriert wird. Alles andere
 *   bleibt gleich.
 *
 * ── Warum das der Gegenentwurf zu v1 ist ────────────────────────────────────
 *
 * v1 (Negative Auslese) zog zur ABRUFZEIT Punkte ab und ist widerlegt: @3 fiel
 * um 3 Punkte, und die Kontrolle zeigte, dass die Auswahl gar nichts trug.
 *
 * Hier passiert nichts zur Abrufzeit. Die Lektion selbst bekommt EINMAL eine
 * andere Position, dauerhaft. Der Sortierer bleibt unveraendert, es gibt kein
 * neues Merkmal und kein neues Gewicht. Nur die Vektoren, aus denen er liest,
 * stehen etwas weiter auseinander.
 *
 * ── Die drei Bedingungen, die der Oekologe selbst genannt hat ───────────────
 *
 * Widerlegt, wenn EINE davon zutrifft:
 *   1. @3 steigt bei KEINEM der drei Schritte um mindestens 2 Punkte.
 *   2. Platz 1 faellt bei irgendeinem Schritt um mehr als 1 Punkt.
 *   3. Dieselbe Verschiebung auf ZUFAELLIG gepaarten Lektionen liegt innerhalb
 *      von 0,5 Punkten am @3-Ergebnis der echten Paarung.
 *
 * Bedingung 3 ist die wichtige, und sie stammt aus der Lehre von v7: Erst der
 * Vergleich mit dem Zufall sagt etwas ueber die REGEL statt ueber die Menge.
 *
 * Dazu, ebenfalls vom Oekologen gefordert: Das Werkzeug MUSS zaehlen, bei wie
 * vielen der 499 Lektionen sich der Vektor wirklich geaendert hat. Null heisst
 * "nicht gemessen", nicht "widerlegt" — die Falle aus dem ersten v3-Lauf.
 *
 * Aufruf:
 *   npx tsx src/bench/charakterverschiebung-messen.ts \
 *     --korpus <k.json> --einstellsatz <alt.json> --pruefsatz <frisch.json> \
 *     --eingaenge <e.json> --vektoren <v.json>
 *   npx tsx src/bench/charakterverschiebung-messen.ts --selbstprobe
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

/** Mittelwert mehrerer Vektoren, normiert. Leere Eingabe ergibt null. */
export function mittel(vs: readonly number[][]): number[] | null {
  if (vs.length === 0) return null;
  const n = vs[0].length;
  const s = new Array<number>(n).fill(0);
  for (const v of vs) for (let i = 0; i < n; i++) s[i] += v[i];
  let laenge = 0;
  for (let i = 0; i < n; i++) { s[i] /= vs.length; laenge += s[i] * s[i]; }
  laenge = Math.sqrt(laenge);
  if (laenge === 0) return null;
  return s.map((x) => x / laenge);
}

/**
 * GEGENSEITIG naechste Nachbarn — und nur die.
 *
 * "A waehlt B" allein reicht nicht: In einem Vektorraum hat ein Knotenpunkt
 * viele Lektionen, die ihn als naechsten waehlen, ohne dass er sie zurueck
 * waehlt. Wer die einseitig naechsten nimmt, verschiebt einen beliebten
 * Knotenpunkt dutzendfach in alle Richtungen — das Ergebnis waere Rauschen.
 *
 * Die Gegenseitigkeit ist die Uebersetzung von "beide Arten leben auf DERSELBEN
 * Insel". Nur dort herrscht der Druck.
 */
export function gegenseitigePaare(
  mittelwerte: ReadonlyMap<string, number[]>,
): Array<[string, string]> {
  const themen = [...mittelwerte.keys()];
  const naechster = new Map<string, string>();

  for (const a of themen) {
    const va = mittelwerte.get(a)!;
    let bestes = '';
    let beste = -2;
    for (const b of themen) {
      if (b === a) continue;
      const k = kosinus(va, mittelwerte.get(b)!);
      if (k > beste) { beste = k; bestes = b; }
    }
    if (bestes) naechster.set(a, bestes);
  }

  const paare: Array<[string, string]> = [];
  const gesehen = new Set<string>();
  for (const [a, b] of naechster) {
    if (gesehen.has(a)) continue;
    if (naechster.get(b) === a) {
      paare.push([a, b]);
      gesehen.add(a);
      gesehen.add(b);
    }
  }
  return paare;
}

/**
 * Schiebt zwei Vektoren entlang ihrer Verbindungsachse auseinander.
 *
 * Der Schritt ist ein Anteil der Vektorlaenge (die Vektoren sind normiert, also
 * Laenge 1). Nach dem Schieben wird neu normiert — sonst waeren die Kosinus-
 * Werte nicht mehr vergleichbar.
 */
export function schiebeAuseinander(
  a: readonly number[],
  b: readonly number[],
  schritt: number,
): [number[], number[]] {
  const n = Math.min(a.length, b.length);
  const achse = new Array<number>(n);
  let laenge = 0;
  for (let i = 0; i < n; i++) { achse[i] = a[i] - b[i]; laenge += achse[i] * achse[i]; }
  laenge = Math.sqrt(laenge);
  if (laenge === 0) return [[...a], [...b]];   // identisch: nichts zu trennen
  for (let i = 0; i < n; i++) achse[i] /= laenge;

  const normiere = (v: number[]): number[] => {
    let l = 0;
    for (const x of v) l += x * x;
    l = Math.sqrt(l);
    return l === 0 ? v : v.map((x) => x / l);
  };

  const neuA = normiere(a.map((x, i) => x + schritt * achse[i]));
  const neuB = normiere(b.map((x, i) => x - schritt * achse[i]));
  return [neuA, neuB];
}

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  p('Platz 1 wird als 1 gemeldet', bestePlatzierung(['a', 'b'], ['a']) === 1);
  p('Mittelwert einer leeren Liste ist null', mittel([]) === null);
  p('Mittelwert eines Vektors ist er selbst', Math.abs((mittel([[1, 0]]) ?? [])[0] - 1) < 1e-9);

  // Gegenseitigkeit: a und b sind einander am naechsten, c liegt weit weg.
  const m = new Map<string, number[]>([
    ['a', [1, 0, 0]],
    ['b', [0.99, 0.141, 0]],
    ['c', [0, 0, 1]],
  ]);
  const paare = gegenseitigePaare(m);
  p('a und b bilden ein gegenseitiges Paar', paare.length === 1);
  p('c ist in keinem Paar', !paare.flat().includes('c'));

  // KONTROLLE: ein Knotenpunkt, den alle waehlen, bildet nur EIN Paar.
  const nabe = new Map<string, number[]>([
    ['nabe', [1, 0, 0]],
    ['x', [0.9, 0.436, 0]],
    ['y', [0.9, -0.436, 0]],
    ['z', [0.8, 0, 0.6]],
  ]);
  const nabenPaare = gegenseitigePaare(nabe);
  p('ein Knotenpunkt erzeugt hoechstens ein Paar', nabenPaare.length <= 1);

  // Schieben: der Abstand wird groesser, die Laenge bleibt 1.
  const [na, nb] = schiebeAuseinander([1, 0], [0.99, 0.141], 0.1);
  const vorher = kosinus([1, 0], [0.99, 0.141]);
  const nachher = kosinus(na, nb);
  p('nach dem Schieben sind sie weniger aehnlich', nachher < vorher);
  const laengeA = Math.sqrt(na.reduce((s, x) => s + x * x, 0));
  p('die Laenge bleibt 1', Math.abs(laengeA - 1) < 1e-9);

  // KONTROLLE: Schritt 0 aendert nichts.
  const [g1, g2] = schiebeAuseinander([1, 0], [0.99, 0.141], 0);
  p('Schritt 0 laesst alles, wie es ist', Math.abs(kosinus(g1, g2) - vorher) < 1e-9);

  // KONTROLLE: zwei identische Vektoren lassen sich nicht trennen — kein Absturz.
  const [i1, i2] = schiebeAuseinander([1, 0], [1, 0], 0.1);
  p('identische Vektoren stuerzen nicht ab', i1[0] === 1 && i2[0] === 1);

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
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> };

  /*
   * ── ACHT VEKTOREN SIND KEINE VEKTOREN (gefunden 22.08.2026) ──────────────
   *
   * In der Vektordatei stehen acht Eintraege als Zeichenkette "leer" statt als
   * Zahlenfeld. Alle acht gehoeren zu Lektionen mit entartetem Themennamen:
   * `code`, `ci:ci`, `fix:go`, `api:`, `auth:` — zu kurz oder leer hinter dem
   * Doppelpunkt, der Einbettungsdienst hat sie abgewiesen.
   *
   * Das ist stiller, als es aussieht. `kosinus` laeuft ueber
   * Math.min(a.length, b.length); eine Zeichenkette HAT eine Laenge, und
   * `"leer"[0] * 0.3` ergibt NaN. `spreizeImTopf` filtert mit
   * Number.isFinite und macht daraus lautlos eine 0. Es faellt also nichts um
   * — der Themen-Abgleich ist fuer diese acht Lektionen einfach aus, ohne dass
   * es irgendwo steht.
   *
   * KORREKTUR ZUR ERSTEN FASSUNG DIESES KOMMENTARS: "leer" ist KEIN Fehler und
   * kein Produktionsproblem. Es ist eine dokumentierte Vereinbarung des
   * Messkorpus — `bench/zwei-sichten.ts:47` sagt es woertlich: "'leer' bedeutet:
   * diese Lektion hat keinen Symptomtext." Ich hatte es zuerst als Datenfehler
   * gemeldet; das war falsch.
   *
   * Der Befund bleibt trotzdem, nur an anderer Stelle: SECHS von sieben
   * Messwerkzeugen fangen die Zeichenkette NICHT ab (Stand 22.08.2026 —
   * findequote-messen, wo-verliert-der-sortierer, gegenauslese-messen,
   * beschneiden-messen, topfseltenheit-messen, decke-messen). Dort wird aus
   * "leer" lautlos eine 0, und der Themen-Abgleich ist fuer diese acht
   * Lektionen aus, ohne dass es in der Ausgabe steht.
   *
   * Messbare Folge: die Grundlinie fuer Platz 1 steht in diesem Werkzeug bei
   * 38,0 %, in den ungeschuetzten bei 39,0 %. Ein Punkt Unterschied, allein
   * durch das Abfangen. Alle Urteile von heute bleiben gueltig — sie
   * vergleichen jeweils INNERHALB eines Werkzeugs — aber die absoluten Zahlen
   * zweier Werkzeuge sind nicht ohne Weiteres vergleichbar.
   *
   * Hier wird das abgefangen und GEZAEHLT, statt es weiterzureichen.
   */
  const grundVolltext = new Map<string, number[]>();
  const grundThema = new Map<string, number[]>();
  const tuerVektoren = new Map<string, number[][]>();
  let keineVektoren = 0;
  for (const l of lektionen) {
    const vs: number[][] = [];
    for (const e of l.eingaenge) {
      const v = vektoren[schluessel(e.art, e.text)];
      if (!v) continue;
      if (!Array.isArray(v)) { keineVektoren++; continue; }
      if (e.art === 'volltext') grundVolltext.set(l.topic, v);
      if (e.art === 'name') grundThema.set(l.topic, v);
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

  // ── Der Thymus-Schritt des Oekologen: einmal, offline ─────────────────────
  const mittelwerte = new Map<string, number[]>();
  for (const [t, vs] of tuerVektoren) {
    const m = mittel(vs);
    if (m) mittelwerte.set(t, m);
  }
  const paare = gegenseitigePaare(mittelwerte);

  // Zufallspaarung gleicher ANZAHL, fester Startwert — Bedingung 3.
  let z = 20260822;
  const wuerfel = (): number => (z = (z * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gemischt = [...mittelwerte.keys()];
  for (let i = gemischt.length - 1; i > 0; i--) {
    const j = Math.floor(wuerfel() * (i + 1));
    [gemischt[i], gemischt[j]] = [gemischt[j], gemischt[i]];
  }
  const zufallsPaare: Array<[string, string]> = [];
  for (let i = 0; i + 1 < gemischt.length && zufallsPaare.length < paare.length; i += 2) {
    zufallsPaare.push([gemischt[i], gemischt[i + 1]]);
  }

  /** Wendet die Verschiebung an und meldet, wie viele Vektoren sich aenderten. */
  function verschiebe(
    welche: ReadonlyArray<[string, string]>,
    schritt: number,
  ): { volltext: Map<string, number[]>; thema: Map<string, number[]>; geaendert: number } {
    const nv = new Map(grundVolltext);
    const nt = new Map(grundThema);
    let geaendert = 0;
    for (const [a, b] of welche) {
      const va = grundVolltext.get(a);
      const vb = grundVolltext.get(b);
      if (va && vb) {
        const [na, nb] = schiebeAuseinander(va, vb, schritt);
        if (kosinus(na, va) < 1 - 1e-12) geaendert++;
        if (kosinus(nb, vb) < 1 - 1e-12) geaendert++;
        nv.set(a, na); nv.set(b, nb);
      }
      const ta = grundThema.get(a);
      const tb = grundThema.get(b);
      if (ta && tb) {
        const [na, nb] = schiebeAuseinander(ta, tb, schritt);
        nt.set(a, na); nt.set(b, nb);
      }
    }
    return { volltext: nv, thema: nt, geaendert };
  }

  async function miss(
    fragen: readonly Frage[],
    vt: ReadonlyMap<string, number[]>,
    th: ReadonlyMap<string, number[]>,
  ): Promise<number[]> {
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

      const besteDrei = sinnListe.slice(0, 3).map((t) => vt.get(t)).filter(Boolean) as number[][];
      const angereichert = besteDrei.length ? reichereAn(fv, besteDrei) : fv;
      const fw = inhaltsWoerter(q.query);

      let punkte = bewerteTopf(topf.map((t) => ({
        naeheText: vt.has(t) ? kosinus(fv, vt.get(t)!) : -2,
        naeheThema: th.has(t) ? kosinus(fv, th.get(t)!) : -2,
        naeheRueckkopplung: vt.has(t) ? kosinus(angereichert, vt.get(t)!) : -2,
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
  const vz = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

  console.log('\n  Naturworkshop II — Charakterverschiebung (Darwin-Finken)');
  console.log('  ════════════════════════════════════════════════════════════════════');
  console.log(`  Lektionen                     ${korpus.lessons.length}`);
  console.log(`  Lektionen mit Tuermittel      ${mittelwerte.size}`);
  console.log(`  GEGENSEITIGE Paare            ${paare.length}  (${paare.length * 2} Lektionen, ${((paare.length * 2 / mittelwerte.size) * 100).toFixed(1)} %)`);
  console.log(`  Zufallspaare (Kontrolle)      ${zufallsPaare.length}`);
  if (keineVektoren > 0) {
    console.log(`  HINWEIS: ${keineVektoren} Eintraege in der Vektordatei sind keine Zahlenfelder`);
    console.log('           (Zeichenkette "leer"). Sie sind uebersprungen, nicht gerechnet.');
  }

  if (paare.length === 0) {
    console.log('\n  NICHT GEMESSEN: kein einziges gegenseitiges Paar gefunden.');
    return;
  }

  const grundFrisch = await miss(satz.queries, grundVolltext, grundThema);
  const grundAlt = await miss(einstell.queries, grundVolltext, grundThema);

  console.log('\n  FRISCHER Satz (100 ungesehene Fragen)');
  console.log('  ────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Variante'.padEnd(30)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'@10'.padStart(9)}${'geaendert'.padStart(11)}`);
  console.log(`  ${'ohne Verschiebung'.padEnd(30)}${p(q(grundFrisch, 1))}${p(q(grundFrisch, 3))}${p(q(grundFrisch, 10))}${'0'.padStart(11)}`);

  const schritte = [0.03, 0.06, 0.10];
  const ergebnisse: Array<{ schritt: number; frisch: number[]; alt: number[]; geaendert: number }> = [];
  for (const s of schritte) {
    const v = verschiebe(paare, s);
    const frisch = await miss(satz.queries, v.volltext, v.thema);
    const alt = await miss(einstell.queries, v.volltext, v.thema);
    ergebnisse.push({ schritt: s, frisch, alt, geaendert: v.geaendert });
    console.log(`  ${`Schritt ${s}`.padEnd(30)}${p(q(frisch, 1))}${p(q(frisch, 3))}${p(q(frisch, 10))}${String(v.geaendert).padStart(11)}`);
  }

  // Bedingung 3: dieselbe Verschiebung, zufaellig gepaart.
  const bester = ergebnisse.reduce((b, e) => (q(e.frisch, 3) > q(b.frisch, 3) ? e : b), ergebnisse[0]);
  const zufall = verschiebe(zufallsPaare, bester.schritt);
  const zufallFrisch = await miss(satz.queries, zufall.volltext, zufall.thema);
  console.log(`  ${`KONTROLLE zufaellig, ${bester.schritt}`.padEnd(30)}${p(q(zufallFrisch, 1))}${p(q(zufallFrisch, 3))}${p(q(zufallFrisch, 10))}${String(zufall.geaendert).padStart(11)}`);

  console.log('\n  EINSTELL-Satz');
  console.log('  ────────────────────────────────────────────────────────────────────');
  console.log(`  ${'ohne Verschiebung'.padEnd(30)}${p(q(grundAlt, 1))}${p(q(grundAlt, 3))}${p(q(grundAlt, 10))}`);
  console.log(`  ${`Schritt ${bester.schritt}`.padEnd(30)}${p(q(bester.alt, 1))}${p(q(bester.alt, 3))}${p(q(bester.alt, 10))}`);

  const d3 = q(bester.frisch, 3) - q(grundFrisch, 3);
  const d1 = q(bester.frisch, 1) - q(grundFrisch, 1);
  const d3Zufall = q(zufallFrisch, 3) - q(grundFrisch, 3);
  const schlechtestesPlatz1 = Math.min(...ergebnisse.map((e) => q(e.frisch, 1))) - q(grundFrisch, 1);

  console.log('\n  Urteil');
  console.log('  ════════════════════════════════════════════════════════════════════');
  console.log(`  bester Schritt                       ${bester.schritt}`);
  console.log(`  @3 frisch                            ${vz(d3)} Punkte`);
  console.log(`  Platz 1 frisch, bester Schritt       ${vz(d1)} Punkte`);
  console.log(`  Platz 1 frisch, SCHLECHTESTER Fall   ${vz(schlechtestesPlatz1)} Punkte`);
  console.log(`  @3 frisch, KONTROLLE zufaellig       ${vz(d3Zufall)} Punkte`);
  console.log(`  Vektoren wirklich geaendert          ${bester.geaendert}`);
  console.log('');

  if (bester.geaendert === 0) {
    console.log('  NICHT GEMESSEN: kein einziger Vektor hat sich geaendert.');
    console.log('  Dann greift die Verschiebung nicht, und keine Zahl oben bedeutet etwas.');
    return;
  }

  if (schlechtestesPlatz1 < -1) {
    console.log(`  WIDERLEGT ueber Platz 1: im schlechtesten Fall ${vz(schlechtestesPlatz1)} Punkte.`);
  } else if (d3 < 2) {
    console.log(`  WIDERLEGT. Kein Schritt bringt 2 Punkte @3 — bestenfalls ${vz(d3)}.`);
    console.log('  Auf der Insel weichen die Schnaebel voneinander ab, weil Abweichen das');
    console.log('  UEBERLEBEN sichert. Hier gibt es keinen solchen Druck: eine verschobene');
    console.log('  Lektion wird nicht besser gefunden, nur anders platziert.');
  } else if (d3Zufall >= d3 - 0.5) {
    console.log('  NICHT BELEGT. Zufaellige Paarung wirkt genauso gut.');
    console.log('  Dann wirkt das Verschieben an sich, nicht die gegenseitige Nachbarschaft.');
  } else {
    console.log('  NICHT WIDERLEGT, UND DIE PAARUNG TRAEGT.');
    console.log(`  Zufaellige Paarung bringt nur ${vz(d3Zufall)}, die gegenseitige ${vz(d3)}.`);
    console.log('  ZUM ERSTEN MAL bewegt sich die Bestmarke.');
  }
  console.log('');
}

if (process.argv.includes('--selbstprobe')) { selbstprobe(); }
else { main().catch((e) => { console.error(e); process.exit(1); }); }
