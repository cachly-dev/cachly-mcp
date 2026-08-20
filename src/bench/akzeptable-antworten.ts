/**
 * Tor 0b: Welche Lektionen duerfen als richtige Antwort gelten?
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Eine Frage hat oft mehr als eine richtige Antwort. Wer nur EINE Lektion als
 * richtig zaehlt, bestraft die Suche dafuer, dass sie eine ebenso passende
 * Nachbarlektion nach vorne holt — und misst damit den Bestand, nicht die
 * Suche.
 *
 * Der Bauplan verlangt deshalb: die Menge der akzeptablen Antworten steht
 * FEST, BEVOR das System einmal gelaufen ist. Sonst ist es Torverschieben.
 *
 * ── Woher die Kandidaten kommen — und woher NICHT ───────────────────────────
 *
 * NICHT aus der Suche. Wer die Kandidaten mit dem Werkzeug bestimmt, das
 * gleich geprueft wird, hat die Pruefung schon verloren.
 *
 * Stattdessen aus dem Verhaeltnis der LEKTIONEN ZUEINANDER — das ist von der
 * Frage und vom Sortierer unabhaengig:
 *   (a) Bedeutungsnaehe der Lektionstexte (Sicht A, Kosinus)
 *   (b) Ueberlappung SELTENER Woerter in den Themennamen
 * Beide Wege zusammen, damit weder ein Vektor noch ein Wortabgleich allein
 * bestimmt, was als Doppelgaenger gilt.
 *
 * ── Was die Messung vom 19.08. dazu sagt ────────────────────────────────────
 *
 * Der Bestand hat weniger Doppelgaenger als vermutet: der aehnlichste Nachbar
 * liegt im Median bei 0,680, nur 8 von 494 Lektionen haben einen Nachbarn ueber
 * 0,80, keine ueber 0,85. Die Schwelle 0,65 ist deshalb bewusst grosszuegig —
 * sie SAMMELT Kandidaten ein, entscheiden tut ein Leser.
 *
 * Aufruf:
 *   npx tsx src/bench/akzeptable-antworten.ts vorschlagen \
 *     --korpus <korpus.json> --pruefsatz <pruefsatz-frisch.json> --pakete <ordner>
 *   npx tsx src/bench/akzeptable-antworten.ts zusammenfuehren \
 *     --pruefsatz <pruefsatz-frisch.json> --pakete <ordner> --out <pruefsatz-frisch.json>
 *   npx tsx src/bench/akzeptable-antworten.ts --selbstprobe
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { kosinus } from '../bedeutung.js';
import type { BenchLesson } from './fixtures.js';

interface Frage { query: string; relevant: string[]; art?: string }
interface Korpus { lessons: BenchLesson[]; queries: Frage[] }

const NAEHE_SCHWELLE = 0.65;
const JE_WEG = 3;

/** Woerter eines Themennamens, umlautfrei und ohne Kurzes. */
export function themenWoerter(topic: string): Set<string> {
  return new Set(topic.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

/**
 * Kandidaten ueber seltene gemeinsame Woerter im Themennamen.
 *
 * Gewichtet, nicht gezaehlt: zwei Lektionen, die sich "nicht" teilen, sind
 * nicht verwandt; zwei, die sich "fail2ban" teilen, praktisch sicher.
 */
export function nachbarnNachWoertern(
  ziel: string, alleThemen: string[], anzahl: number,
): string[] {
  const df = new Map<string, number>();
  for (const t of alleThemen) for (const w of themenWoerter(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const seltenheit = (w: string): number => Math.log((alleThemen.length + 1) / ((df.get(w) ?? 0) + 1));

  const zw = themenWoerter(ziel);
  const gesamt = [...zw].reduce((s, w) => s + seltenheit(w), 0);
  if (gesamt <= 0) return [];

  return alleThemen
    .filter((t) => t !== ziel)
    .map((t) => {
      const tw = themenWoerter(t);
      const geteilt = [...zw].filter((w) => tw.has(w)).reduce((s, w) => s + seltenheit(w), 0);
      // Symmetrisch messen: ein kurzer Themenname, der ALLES mit einem langen
      // teilt, ist verwandt — auch wenn er nur die Haelfte von dessen Woertern
      // abdeckt. Sonst findet ein langer Name nie seinen knappen Doppelgaenger.
      const kandGesamt = [...tw].reduce((s, w) => s + seltenheit(w), 0);
      const bezug = Math.min(gesamt, kandGesamt) || gesamt;
      return { t, anteil: geteilt / bezug };
    })
    .filter((x) => x.anteil >= 0.34)
    .sort((a, b) => b.anteil - a.anteil)
    .slice(0, anzahl)
    .map((x) => x.t);
}

/** Kandidaten ueber Bedeutungsnaehe der Lektionstexte. */
export function nachbarnNachBedeutung(
  zielPlatz: number, vektoren: Array<number[] | null>, themen: string[],
  anzahl: number, schwelle = NAEHE_SCHWELLE,
): string[] {
  const zv = vektoren[zielPlatz];
  if (!zv) return [];
  return themen
    .map((t, j) => ({ t, n: j === zielPlatz || !vektoren[j] ? -2 : kosinus(zv, vektoren[j]!) }))
    .filter((x) => x.n >= schwelle)
    .sort((a, b) => b.n - a.n)
    .slice(0, anzahl)
    .map((x) => x.t);
}

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

const auszug = (l: BenchLesson, n = 420): string => {
  const wf = (l as { what_failed?: string }).what_failed ?? '';
  return `${l.what_worked ?? ''}${wf ? ` | vergeblich: ${wf}` : ''}`
    .replace(/<\/?(what_worked|what_failed)>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
};

// ── Unterbefehl: vorschlagen ────────────────────────────────────────────────

function befehlVorschlagen(flag: (n: string) => string | undefined): void {
  const korpusPfad = resolve(flag('korpus') ?? '');
  const satzPfad = resolve(flag('pruefsatz') ?? '');
  const paketOrdner = resolve(flag('pakete') ?? './pakete-akzeptabel');
  const proPaket = Number(flag('proPaket') ?? '20');

  if (!existsSync(korpusPfad)) fehlt('Korpus', korpusPfad);
  if (!existsSync(satzPfad)) fehlt('Pruefsatz', satzPfad);
  const vekPfad = korpusPfad.replace(/\.json$/, '.einbettungen.json');
  if (!existsSync(vekPfad)) fehlt('Vektordatei', vekPfad);

  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as Korpus;
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Korpus;
  const vek = (JSON.parse(readFileSync(vekPfad, 'utf8')) as { lektionen: Array<number[] | null> })
    .lektionen.slice(0, korpus.lessons.length);

  const themen = korpus.lessons.map((l) => l.topic);
  const platz = new Map(themen.map((t, i) => [t, i]));
  const nachThema = new Map(korpus.lessons.map((l) => [l.topic, l]));

  mkdirSync(paketOrdner, { recursive: true });
  const bloecke: string[] = [];
  let mitKandidaten = 0;
  let kandidatenGesamt = 0;

  const eintraege = satz.queries.map((q, i) => {
    const ziel = q.relevant[0];
    const p = platz.get(ziel);
    if (p === undefined) fehlt(`Lektion ${ziel}`, korpusPfad);
    const kand = [...new Set([
      ...nachbarnNachBedeutung(p, vek, themen, JE_WEG),
      ...nachbarnNachWoertern(ziel, themen, JE_WEG),
    ])].filter((t) => t !== ziel);
    if (kand.length) { mitKandidaten++; kandidatenGesamt += kand.length; }
    return { i, q, ziel, kand };
  });

  for (const { i, q, ziel, kand } of eintraege) {
    if (kand.length === 0) continue;
    bloecke.push([
      `### FRAGE ${i + 1} (${q.art ?? 'ohne'})`,
      `Frage: ${q.query}`,
      `RICHTIGE Lektion (${ziel}): ${auszug(nachThema.get(ziel)!)}`,
      'Kandidaten:',
      ...kand.map((t) => `  - ${t}: ${auszug(nachThema.get(t)!, 320)}`),
    ].join('\n'));
  }

  const pakete = Math.ceil(bloecke.length / proPaket);
  for (let k = 0; k < pakete; k++) {
    writeFileSync(
      join(paketOrdner, `kandidaten-${String(k + 1).padStart(2, '0')}.txt`),
      bloecke.slice(k * proPaket, (k + 1) * proPaket).join('\n\n'),
      'utf8',
    );
  }

  console.log(`${satz.queries.length} Fragen, ${mitKandidaten} mit Kandidaten, ${kandidatenGesamt} Kandidaten gesamt.`);
  console.log(`${pakete} Pakete in ${paketOrdner}`);
  console.log(`${satz.queries.length - mitKandidaten} Fragen haben keinen Nachbarn — dort bleibt es bei EINER richtigen Antwort.`);
}

// ── Unterbefehl: zusammenfuehren ────────────────────────────────────────────

function befehlZusammenfuehren(flag: (n: string) => string | undefined): void {
  const satzPfad = resolve(flag('pruefsatz') ?? '');
  const paketOrdner = resolve(flag('pakete') ?? './pakete-akzeptabel');
  const ziel = resolve(flag('out') ?? satzPfad);

  if (!existsSync(satzPfad)) fehlt('Pruefsatz', satzPfad);
  if (!existsSync(paketOrdner)) fehlt('Paketordner', paketOrdner);

  const dateien = readdirSync(paketOrdner).filter((f) => /^urteil-\d+\.json$/.test(f));
  if (dateien.length === 0) fehlt('Urteilsdateien (urteil-NN.json)', paketOrdner);

  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Korpus;
  let dazu = 0;
  for (const f of dateien.sort()) {
    const roh = JSON.parse(readFileSync(join(paketOrdner, f), 'utf8')) as
      { urteile?: Array<{ frage: number; akzeptabel: string[] }> };
    if (!roh.urteile) fehlt(`Urteile in ${f}`, paketOrdner);
    for (const u of roh.urteile) {
      const q = satz.queries[u.frage - 1];
      if (!q) {
        console.error(`NICHT GEMESSEN: Frage ${u.frage} gibt es nicht (${satz.queries.length} Fragen).`);
        process.exit(3);
      }
      for (const t of u.akzeptabel) {
        if (!q.relevant.includes(t)) { q.relevant.push(t); dazu++; }
      }
    }
  }

  writeFileSync(ziel, JSON.stringify(satz, null, 1), 'utf8');
  const pruefsumme = createHash('sha256')
    .update(JSON.stringify(satz.queries)).digest('hex').slice(0, 16);
  writeFileSync(`${ziel}.pruefsumme`, `${pruefsumme}  ${satz.queries.length} Fragen, Tor 0b eingearbeitet\n`, 'utf8');

  const mehrfach = satz.queries.filter((q) => q.relevant.length > 1).length;
  console.log(`${dazu} zusaetzliche akzeptable Lektionen eingetragen.`);
  console.log(`${mehrfach} von ${satz.queries.length} Fragen haben jetzt mehr als eine richtige Antwort.`);
  console.log(`EINGEFROREN. Pruefsumme: ${pruefsumme}`);
}

// ── Selbstprobe ─────────────────────────────────────────────────────────────

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  const themen = [
    'node1:fail2ban-bannt-deploy-kanal',
    'node1:fail2ban-ignoreip-fehlt',
    'ci:node3-platte-voll',
    'markt:preisgestaltung-2026',
  ];
  const w = nachbarnNachWoertern('node1:fail2ban-bannt-deploy-kanal', themen, 3);
  p('seltenes gemeinsames Wort findet den Nachbarn', w.includes('node1:fail2ban-ignoreip-fehlt'));
  p('fremdes Thema wird nicht Nachbar', !w.includes('markt:preisgestaltung-2026'));
  p('das Ziel ist nie sein eigener Nachbar', !w.includes('node1:fail2ban-bannt-deploy-kanal'));

  const v: Array<number[] | null> = [[1, 0, 0], [0.98, 0.2, 0], [0, 1, 0], null];
  const b = nachbarnNachBedeutung(0, v, themen, 3);
  p('naher Vektor wird Nachbar', b.includes('node1:fail2ban-ignoreip-fehlt'));
  p('ferner Vektor faellt raus', !b.includes('ci:node3-platte-voll'));
  p('fehlender Vektor faellt raus', !b.includes('markt:preisgestaltung-2026'));
  p('ohne eigenen Vektor keine Nachbarn', nachbarnNachBedeutung(3, v, themen, 3).length === 0);

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
else if (argv[0] === 'vorschlagen') befehlVorschlagen(flag);
else if (argv[0] === 'zusammenfuehren') befehlZusammenfuehren(flag);
else {
  console.error('Unterbefehl fehlt: vorschlagen | zusammenfuehren | --selbstprobe');
  process.exit(2);
}
