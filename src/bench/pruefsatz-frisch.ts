/**
 * Tor 0: der frische Pruefsatz — 100 neue Fragen auf 100 NEUEN Lektionen.
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Die alten 100 Fragen (fragen-gross.json) sind nach zwoelf Sortier-Varianten
 * am 19.08.2026 verbraucht. Wer weiter auf ihnen misst, misst die eigene
 * Anpassung und nennt es Qualitaet. Sie werden zum EINSTELL-Satz; geprueft wird
 * auf einem Satz, den beim Einstellen niemand gesehen hat.
 *
 * Die Trennung geht hier weiter als der Bauplan verlangt: nicht nur neue
 * FRAGEN, sondern auch neue LEKTIONEN. Die alten 100 Fragen zielen auf 60 der
 * 499 Lektionen — diese 60 sind gesperrt. Damit kann keine Einstellung, die
 * auf dem alten Satz gefunden wurde, ueber die Hintertuer "dieselbe Lektion"
 * in die Pruefzahl zurueckwirken.
 *
 * ── Was dieses Werkzeug NICHT tut ───────────────────────────────────────────
 *
 * Es erfindet keine Fragen. Es waehlt die Lektionen aus und legt Arbeitspakete
 * an; die Fragen schreibt ein anderes Modell mit einem anderen Promptstil
 * (Tor 0 verlangt das ausdruecklich — sonst prueft man, ob ein Modell seine
 * eigene Handschrift wiedererkennt). Danach fuehrt `zusammenfuehren` die
 * Antworten zusammen, misst die Zirkularitaet und friert den Satz ein.
 *
 * ── Selbstprobe ─────────────────────────────────────────────────────────────
 *
 * Vier eigene Messfehler an EINEM Tag (19.08.) sind der Beleg: jedes neue
 * Bench-Skript bekommt ein konstruiertes Beispiel, dessen Ergebnis von Hand
 * bekannt ist. `--selbstprobe` faehrt es. Fehlt eine Eingabedatei, meldet das
 * Werkzeug "nicht gemessen" und endet mit Code 2 — nie still mit 0.
 *
 * Aufruf:
 *   npx tsx src/bench/pruefsatz-frisch.ts auswaehlen \
 *     --korpus ~/.cachly/bench-korpus/korpus-gross.json \
 *     --pakete <ordner> [--anzahl 100] [--proPaket 20]
 *   npx tsx src/bench/pruefsatz-frisch.ts zusammenfuehren \
 *     --korpus ... --pakete <ordner> --out pruefsatz-frisch.json
 *   npx tsx src/bench/pruefsatz-frisch.ts --selbstprobe
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import type { BenchLesson, BenchQuery } from './fixtures.js';
import { fragenWarnung } from './korpus-aus-brain.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }

/** Kein Zufallsgenerator: dieselbe Eingabe muss dieselbe Auswahl ergeben. */
export function streuwert(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/**
 * Waehlt Lektionen aus, die den Bestand im Kleinen abbilden.
 *
 * Warum geschichtet: der Bestand ist schief (kanzlei 71, stayledger 5). Ein
 * blinder Griff traefe kanzlei sieben Mal so oft wie stayledger und die Zahl
 * am Ende waere eine Aussage ueber kanzlei. Also wird je Praefix im Verhaeltnis
 * gezogen, und INNERHALB des Praefixes nach dem Streuwert des Themennamens —
 * das ist reproduzierbar und hat mit Inhalt oder Laenge nichts zu tun.
 */
export function auswaehlen(
  lektionen: BenchLesson[],
  gesperrt: Set<string>,
  anzahl: number,
  mindestLaenge = 200,
): BenchLesson[] {
  const frei = lektionen.filter(
    (l) => !gesperrt.has(l.topic) && (l.what_worked ?? '').length >= mindestLaenge,
  );

  const gruppen = new Map<string, BenchLesson[]>();
  for (const l of frei) {
    const p = l.topic.includes(':') ? l.topic.split(':')[0] : 'ohne';
    const g = gruppen.get(p);
    if (g) g.push(l); else gruppen.set(p, [l]);
  }
  for (const g of gruppen.values()) {
    g.sort((a, b) => streuwert(a.topic).localeCompare(streuwert(b.topic)));
  }

  // Groesste Reste: erst der ganzzahlige Anteil, dann die groessten Reste —
  // so ergibt die Summe exakt die gewuenschte Anzahl, ohne dass eine kleine
  // Gruppe ganz herausfaellt.
  const gesamt = frei.length;
  const soll = [...gruppen.entries()].map(([p, g]) => {
    const genau = (g.length / gesamt) * anzahl;
    return { p, g, ganz: Math.floor(genau), rest: genau - Math.floor(genau) };
  });
  let vergeben = soll.reduce((s, x) => s + x.ganz, 0);
  soll.sort((a, b) => b.rest - a.rest || a.p.localeCompare(b.p));
  for (const s of soll) {
    if (vergeben >= anzahl) break;
    if (s.ganz < s.g.length) { s.ganz += 1; vergeben += 1; }
  }

  const aus: BenchLesson[] = [];
  for (const s of soll) aus.push(...s.g.slice(0, Math.min(s.ganz, s.g.length)));
  // Falls eine Gruppe zu klein war, von hinten auffuellen — wieder nach
  // Streuwert, damit die Auswahl reproduzierbar bleibt.
  if (aus.length < anzahl) {
    const drin = new Set(aus.map((l) => l.topic));
    const rest = frei.filter((l) => !drin.has(l.topic))
      .sort((a, b) => streuwert(a.topic).localeCompare(streuwert(b.topic)));
    aus.push(...rest.slice(0, anzahl - aus.length));
  }
  return aus.slice(0, anzahl).sort((a, b) => a.topic.localeCompare(b.topic));
}

/** Der Text, den ein Fragenschreiber sieht. Gekuerzt, damit Pakete handlich bleiben. */
function lektionsAuszug(l: BenchLesson): string {
  const wf = (l as { what_failed?: string }).what_failed ?? '';
  return [
    `topic: ${l.topic}`,
    `what_worked: ${(l.what_worked ?? '').slice(0, 1200)}`,
    wf ? `what_failed: ${wf.slice(0, 400)}` : '',
  ].filter(Boolean).join('\n');
}

function fehlt(pfad: string, was: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

function korpusLesen(pfad: string): Korpus {
  if (!existsSync(pfad)) fehlt(pfad, 'Korpus');
  return JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;
}

// ── Unterbefehl: auswaehlen ─────────────────────────────────────────────────

function befehlAuswaehlen(flag: (n: string) => string | undefined): void {
  const korpusPfad = resolve(flag('korpus') ?? '');
  const paketOrdner = resolve(flag('pakete') ?? './pakete');
  const anzahl = Number(flag('anzahl') ?? '100');
  const proPaket = Number(flag('proPaket') ?? '20');

  const korpus = korpusLesen(korpusPfad);
  const gesperrt = new Set(korpus.queries.flatMap((q) => q.relevant));
  const gewaehlt = auswaehlen(korpus.lessons, gesperrt, anzahl);

  if (gewaehlt.length < anzahl) {
    console.error(`NICHT GEMESSEN: nur ${gewaehlt.length} von ${anzahl} Lektionen frei.`);
    process.exit(2);
  }

  mkdirSync(paketOrdner, { recursive: true });
  const pakete = Math.ceil(gewaehlt.length / proPaket);
  for (let i = 0; i < pakete; i++) {
    const teil = gewaehlt.slice(i * proPaket, (i + 1) * proPaket);
    writeFileSync(
      join(paketOrdner, `paket-${String(i + 1).padStart(2, '0')}.txt`),
      teil.map((l, j) => `### ${i * proPaket + j + 1}. ${l.topic}\n${lektionsAuszug(l)}`).join('\n\n'),
      'utf8',
    );
  }
  writeFileSync(
    join(paketOrdner, 'ziel-lektionen.json'),
    JSON.stringify({ gesperrt: [...gesperrt].sort(), gewaehlt: gewaehlt.map((l) => l.topic) }, null, 1),
    'utf8',
  );

  const praefixe = new Map<string, number>();
  for (const l of gewaehlt) {
    const p = l.topic.split(':')[0];
    praefixe.set(p, (praefixe.get(p) ?? 0) + 1);
  }
  console.log(`${gewaehlt.length} Lektionen gewaehlt, ${gesperrt.size} gesperrt (alte Fragen).`);
  console.log(`${pakete} Pakete in ${paketOrdner}`);
  console.log('Mischung:', [...praefixe.entries()].sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}=${n}`).join(' '));
}

// ── Unterbefehl: zusammenfuehren ────────────────────────────────────────────

/**
 * Die ART der Frage wird mitgefuehrt — nicht als Schmuck.
 *
 * Der erste Entwurf dieses Pruefsatzes liess ALLE Fragen als Stoerungsmeldung
 * schreiben. Heinrich am 19.08.: "es geht doch nicht immer nur um fehler".
 * Er hat recht, und die Fragenschreiber hatten es selbst gemeldet ("wirkt
 * konstruiert", "eher ein Planungsprotokoll als eine Stoerung").
 *
 * Ein Gedaechtnis wird genauso oft nach einer Tatsache gefragt (wo liegt X),
 * nach einer Entscheidung (warum haben wir Y so gemacht) oder vor einem
 * Vorhaben (worauf muss ich achten). Wer nur Stoerungen misst, stellt die Suche
 * auf Stoerungen ein und merkt den Rest nie.
 */
interface Antwort { topic: string; query: string; art?: string }

function befehlZusammenfuehren(flag: (n: string) => string | undefined): void {
  const korpusPfad = resolve(flag('korpus') ?? '');
  const paketOrdner = resolve(flag('pakete') ?? './pakete');
  const ziel = resolve(flag('out') ?? './pruefsatz-frisch.json');

  const korpus = korpusLesen(korpusPfad);
  if (!existsSync(paketOrdner)) fehlt(paketOrdner, 'Paketordner');

  const antwortDateien = readdirSync(paketOrdner).filter((f) => /^antwort-\d+\.json$/.test(f));
  if (antwortDateien.length === 0) fehlt(paketOrdner, 'Antwortdateien (antwort-NN.json)');

  const antworten: Antwort[] = [];
  for (const f of antwortDateien.sort()) {
    const roh = JSON.parse(readFileSync(join(paketOrdner, f), 'utf8')) as { fragen?: Antwort[] };
    if (!roh.fragen?.length) {
      console.error(`NICHT GEMESSEN: ${f} enthaelt keine Fragen.`);
      process.exit(2);
    }
    antworten.push(...roh.fragen);
  }

  const nachTopic = new Map(korpus.lessons.map((l) => [l.topic, l]));
  const fehlend = antworten.filter((a) => !nachTopic.has(a.topic));
  if (fehlend.length) {
    console.error(`NICHT GEMESSEN: ${fehlend.length} Themen aus den Antworten gibt es nicht: ` +
      fehlend.slice(0, 5).map((a) => a.topic).join(', '));
    process.exit(3);
  }

  // Doppelte Themen sind ein Fehler des Schreibers, kein Grund still zu kuerzen.
  const gesehen = new Set<string>();
  const doppelt = antworten.filter((a) => (gesehen.has(a.topic) ? true : (gesehen.add(a.topic), false)));
  if (doppelt.length) {
    console.error(`WARNUNG: ${doppelt.length} Themen doppelt beantwortet: ` +
      doppelt.map((a) => a.topic).join(', '));
  }

  let verdaechtig = 0;
  const queries: BenchQuery[] = [];
  for (const a of antworten) {
    const l = nachTopic.get(a.topic)!;
    const w = fragenWarnung(a.query, l);
    if (w) { verdaechtig++; console.error(`  ⚠ "${a.query.slice(0, 60)}": ${w}`); }
    queries.push({ query: a.query, relevant: [a.topic], art: a.art ?? 'ohne' } as BenchQuery);
  }

  const nachArt = new Map<string, number>();
  for (const a of antworten) nachArt.set(a.art ?? 'ohne', (nachArt.get(a.art ?? 'ohne') ?? 0) + 1);

  const inhalt = {
    name: 'pruefsatz-frisch-19-08-2026',
    _hinweis: 'Tor 0. EINGEFROREN. Fragen von Claude (sonnet), Stil abweichend vom alten Satz. ' +
      'Die alten 100 Fragen sind der EINSTELL-Satz und zielen auf andere Lektionen.',
    lessons: korpus.lessons,
    queries,
  };
  writeFileSync(ziel, JSON.stringify(inhalt, null, 1), 'utf8');

  const pruefsumme = createHash('sha256')
    .update(JSON.stringify(queries)).digest('hex').slice(0, 16);
  writeFileSync(`${ziel}.pruefsumme`, `${pruefsumme}  ${queries.length} Fragen\n`, 'utf8');

  const anteil = queries.length ? Math.round((verdaechtig / queries.length) * 100) : 0;
  console.log(`${queries.length} Fragen geschrieben nach ${ziel}`);
  console.log('Nach Art:', [...nachArt.entries()].sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${a}=${n}`).join(' '));
  console.log(`Zirkularitaet: ${verdaechtig} von ${queries.length} verdaechtig (${anteil} %).`);
  console.log(`Pruefsumme (eingefroren): ${pruefsumme}`);
  if (anteil > 15) {
    console.error('STOPP: mehr als 15 % der Fragen schreiben die Lektion ab. Neu schreiben lassen.');
    process.exit(4);
  }
}

// ── Selbstprobe ─────────────────────────────────────────────────────────────

function selbstprobe(): void {
  const machLektion = (topic: string, laenge = 300): BenchLesson =>
    ({ topic, outcome: 'success', what_worked: 'x'.repeat(laenge), confidence: 1, recall_count: 0 } as BenchLesson);

  // Konstruiert: 3 Praefixe im Verhaeltnis 6:3:1, ein gesperrtes Thema,
  // eine zu kurze Lektion. Erwartet: 10 Stueck, das gesperrte und das kurze
  // nicht dabei, Mischung 6:3:1 gespiegelt.
  const lektionen = [
    ...Array.from({ length: 60 }, (_, i) => machLektion(`a:${i}`)),
    ...Array.from({ length: 30 }, (_, i) => machLektion(`b:${i}`)),
    ...Array.from({ length: 10 }, (_, i) => machLektion(`c:${i}`)),
    machLektion('a:gesperrt'),
    machLektion('a:zukurz', 10),
  ];
  const gewaehlt = auswaehlen(lektionen, new Set(['a:gesperrt']), 10);
  const topics = gewaehlt.map((l) => l.topic);
  const zaehl = (p: string) => topics.filter((t) => t.startsWith(`${p}:`)).length;

  const proben: Array<[string, boolean]> = [
    ['genau 10 gewaehlt', gewaehlt.length === 10],
    ['gesperrtes Thema nicht dabei', !topics.includes('a:gesperrt')],
    ['zu kurze Lektion nicht dabei', !topics.includes('a:zukurz')],
    ['Mischung 6/3/1', zaehl('a') === 6 && zaehl('b') === 3 && zaehl('c') === 1],
    ['reproduzierbar', JSON.stringify(auswaehlen(lektionen, new Set(['a:gesperrt']), 10)
      .map((l) => l.topic)) === JSON.stringify(topics)],
    ['Zirkularitaet schlaegt an', fragenWarnung(
      'warum steht speicherplatz und aufraeumen und registry im protokoll',
      { topic: 't', outcome: 'success', what_worked: 'speicherplatz aufraeumen registry protokoll' } as BenchLesson,
    ) !== null],
    ['Zirkularitaet schweigt bei fremden Woertern', fragenWarnung(
      'warum haengt der vorgang seit gestern abend fest',
      { topic: 't', outcome: 'success', what_worked: 'speicherplatz aufraeumen registry protokoll' } as BenchLesson,
    ) === null],
  ];

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

// ── Einstieg ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

if (argv.includes('--selbstprobe')) selbstprobe();
else if (argv[0] === 'auswaehlen') befehlAuswaehlen(flag);
else if (argv[0] === 'zusammenfuehren') befehlZusammenfuehren(flag);
else {
  console.error('Unterbefehl fehlt: auswaehlen | zusammenfuehren | --selbstprobe');
  process.exit(2);
}
