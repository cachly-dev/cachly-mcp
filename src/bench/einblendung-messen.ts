/**
 * Was die automatische Einblendung findet — gemessen, nicht geschaetzt.
 *
 * ── Warum es diesen Messstand gibt ─────────────────────────────────────────
 *
 * `findequote-messen.ts` misst `smart_recall`: die Suche, die der Agent
 * ausdruecklich aufruft. Die EINBLENDUNG ist ein anderer Weg — sie feuert bei
 * jedem Prompt, ohne Zutun, und sie hatte bis zum 06.09.2026 eine eigene,
 * schlechtere Sortierung. Wer die eine Zahl fuer die andere haelt, misst die
 * falsche Maschine; genau das ist am 05.09.2026 passiert (7,5 % wurden als
 * cachlys Abrufguete gemeldet).
 *
 * Hier wird nichts nachgebaut, was noch existiert: Arm C ruft die
 * ausgelieferte Klasse `Einblendbestand` aus `../einblendung-kern.js` auf —
 * dieselbe Quelle, aus der `tools/ambient-recall/einblendung-kern.gen.mjs`
 * gebuendelt wird.
 *
 * ── Die drei Arme ──────────────────────────────────────────────────────────
 *
 *   A "alt"       rohe Wortzaehlung auf topic + tags + what_worked[0..120]
 *                 — der Stand bis zum 06.09.2026. Diese eine Funktion IST
 *                 nachgebaut, weil sie geloescht wurde; sie steht unten
 *                 woertlich mit Herkunftsangabe.
 *   B "alt-voll"  dieselbe rohe Wortzaehlung, aber auf dem GANZEN Text.
 *                 Der Unterschied A -> B ist der Preis der 120-Zeichen-Kuerzung.
 *   C "neu"       `Einblendbestand.sortiere` — `bewerteTopf` auf dem ganzen
 *                 Text, ohne Vektoren. Der Unterschied B -> C ist der Gewinn
 *                 der Sortierung.
 *
 * Alle drei sehen den GANZEN Bestand. Die Vorauswahl der Go-API (Decke 67,4 %,
 * gemessen in api/internal/handler/einblendung_vorauswahl_test.go) ist hier
 * bewusst NICHT davor geschaltet: sie faellt mit dem Umbau weg, und ihre
 * Wirkung ist dort schon einzeln gemessen.
 *
 * ── Die Gegenprobe ist Pflicht ─────────────────────────────────────────────
 *
 * Mit `--kontrolle` laufen dieselben Arme mit PERMUTIERTEN Fragen (fester
 * Keim). Brechen die Zahlen dabei nicht ein, misst der Stand sich selbst und
 * keine der Zahlen darf berichtet werden.
 *
 * ── Aufruf ─────────────────────────────────────────────────────────────────
 *
 *   cd sdk/mcp && Z="$HOME/.cachly/bench-korpus"
 *   npx tsx src/bench/einblendung-messen.ts \
 *     --korpus "$Z/korpus-gross.json" --pruefsatz "$Z/pruefsatz-3000.json"
 *
 * Zusaetzlich: --fragen <n> begrenzt den Satz (Probelauf), --kontrolle fuegt
 * den Permutationslauf hinzu, --nach <datei.json> schreibt die Rohplaetze.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Einblendbestand, torWoerter, zaehleBelege } from '../einblendung-kern.js';
import { lektionsText, leserText } from '../seltenheitsbestand.js';
import { leserPunkte, mischeMitLeser } from '../leser.js';
import { LESER_TIEFE, LESER_MAX_ZEICHEN } from '../rangfolge-stellschrauben.js';

interface Lektion {
  topic: string;
  what_worked?: string;
  what_failed?: string;
  tags?: string[];
  outcome?: string;
  severity?: string;
  recall_count?: number;
  [feld: string]: unknown;
}

interface Frage {
  query: string;
  relevant: string[];
  id?: string;
  guete?: string;
  sprache?: string;
}

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * ── Arm A/B: die geloeschte Bewertung, woertlich ───────────────────────────
 *
 * Das ist `scoreLesson` aus tools/ambient-recall/lib.mjs, Stand vor dem
 * Umbau vom 06.09.2026 (Commit a45a30cf, Zeilen 197-207). Sie steht hier
 * nachgebaut, weil sie sonst nirgends mehr existiert — ohne sie gibt es
 * keine Vorher-Zahl. Wer sie aendert, aendert eine Vergangenheit und macht
 * den Vergleich wertlos.
 */
function alteBewertung(frageTokens: string[], topicKlein: string, heuhaufen: string, l: Lektion): number {
  let punkte = 0;
  for (const tok of frageTokens) {
    if (heuhaufen.includes(tok)) punkte += topicKlein.includes(tok) ? 2 : 1;
  }
  if (l.outcome === 'success') punkte += 0.5;
  if (l.severity === 'critical') punkte += 0.5;
  return punkte;
}

/** Der Heuhaufen des alten Hooks: topic + tags + what_worked, auf 120 Zeichen gekuerzt. */
function heuhaufenAlt(l: Lektion, kuerzen: boolean): string {
  const ww = String(l.what_worked ?? '');
  const text = kuerzen ? ww.slice(0, 120) : `${ww}\n${String(l.what_failed ?? '')}`;
  return `${l.topic ?? ''} ${(l.tags ?? []).join(' ')} ${text}`.toLowerCase();
}

interface Kennzahlen { platz1: number; drei: number; zehn: number; ohneTor: number; }

function leer(): Kennzahlen { return { platz1: 0, drei: 0, zehn: 0, ohneTor: 0 }; }

/** Der Platz der besten passenden Lektion, 1-basiert. 0 = nicht gefunden. */
function platzVon(reihenfolge: string[], relevant: Set<string>): number {
  for (let i = 0; i < reihenfolge.length; i++) if (relevant.has(reihenfolge[i])) return i + 1;
  return 0;
}

function buche(k: Kennzahlen, platz: number, torOffen: boolean): void {
  if (!torOffen) { k.ohneTor++; return; }
  if (platz === 1) k.platz1++;
  if (platz >= 1 && platz <= 3) k.drei++;
  if (platz >= 1 && platz <= 10) k.zehn++;
}

function zeile(name: string, k: Kennzahlen, n: number): string {
  const p = (x: number) => `${((x / n) * 100).toFixed(1).padStart(5)} %`;
  return `${name.padEnd(10)} ${String(k.platz1).padStart(5)} ${p(k.platz1)}`
    + `  ${String(k.drei).padStart(5)} ${p(k.drei)}`
    + `  ${String(k.zehn).padStart(5)} ${p(k.zehn)}`
    + `  ${String(k.ohneTor).padStart(5)}`;
}

/**
 * Ein Durchgang ueber alle Fragen.
 *
 * `zuordnung[i]` sagt, welche Frage auf welchen Erwartungssatz trifft. Fuer
 * den echten Lauf ist das die Reihenfolge selbst; fuer die Gegenprobe eine
 * Permutation. So laeuft BEIDES durch denselben Code — eine zweite Schleife
 * waere eine zweite Wahrheit.
 */
// Arm D (--leser): die besten LESER_TIEFE von Arm C liest der Leser-Endpunkt
// (POST /api/v1/rerank, Instanz aus CACHLY_BRAIN_INSTANCE_ID — die API waehlt
// eigenen Dienst oder Jev), gemischt wie im Hook (lib.mjs selectRelevantMitLeser).
// Braucht CACHLY_JWT; ohne Antwort zaehlt die Frage mit der Ordnung von Arm C.
let leserAusfaelle = 0;
async function lauf(
  lektionen: Lektion[],
  fragen: Frage[],
  zuordnung: number[],
  minBelege: number,
  plaetzeNach: Array<Record<string, unknown>> | null,
  topf: number | undefined,
  leser = false,
): Promise<{ a: Kennzahlen; b: Kennzahlen; c: Kennzahlen; d: Kennzahlen | null }> {
  const themen = lektionen.map((l) => l.topic);
  const topicKlein = lektionen.map((l) => String(l.topic ?? '').toLowerCase());
  const hayKurz = lektionen.map((l) => heuhaufenAlt(l, true));
  const hayVoll = lektionen.map((l) => heuhaufenAlt(l, false));
  const torHeuhaufen = lektionen.map((l) => lektionsText(l as Record<string, unknown>).toLowerCase());
  // --topf <n>: Topfgroesse des Wortkanals fuer Arm C. Ohne Flag die
  // Auslieferungsvorgabe (WORT_TOPF) — damit der Standardlauf die
  // ausgelieferte Maschine misst und nicht eine Zahl aus diesem Messstand.
  // Genau diese Falle stand im grossen Messstand: Produkt 25, Bench 75.
  const bestand = new Einblendbestand(lektionen, topf !== undefined ? { topf } : {});

  const a = leer(); const b = leer(); const c = leer();
  const d = leser ? leer() : null;
  const instanz = process.env.CACHLY_BRAIN_INSTANCE_ID || '';
  // CACHLY_ADMIN_KEY stellt den Messlauf vom Embed-Limiter frei (60/min je
  // Nutzer, gilt auch fuer /rerank). Ohne ihn zaehlen 429er als Leser-Ausfall.
  const adminKopf = process.env.CACHLY_ADMIN_KEY ? { 'X-Admin-Key': process.env.CACHLY_ADMIN_KEY } : undefined;

  for (let i = 0; i < fragen.length; i++) {
    const text = fragen[i].query;
    const erwartet = new Set(fragen[zuordnung[i]].relevant);
    const tokens = torWoerter(text);

    // Das Tor ist in allen drei Armen dasselbe (>= minBelege verschiedene
    // Frageworte im Text). Waere es je Arm anders, verglichen wir zwei
    // Dinge auf einmal.
    const torOffen = torHeuhaufen.some((h) => zaehleBelege(tokens, h) >= minBelege);

    const ordne = (punkte: number[]): string[] => themen
      .map((t, j) => ({ t, p: punkte[j], r: Number(lektionen[j].recall_count ?? 0) }))
      .sort((x, y) => y.p - x.p || y.r - x.r)
      .map((x) => x.t);

    const pA = ordne(lektionen.map((l, j) => alteBewertung(tokens, topicKlein[j], hayKurz[j], l)));
    const pB = ordne(lektionen.map((l, j) => alteBewertung(tokens, topicKlein[j], hayVoll[j], l)));
    const sortiertC = bestand.sortiere(text);
    const pC = sortiertC.map((x) => x.lektion.topic as string);

    const platzA = platzVon(pA, erwartet);
    const platzB = platzVon(pB, erwartet);
    const platzC = platzVon(pC, erwartet);
    buche(a, platzA, torOffen);
    buche(b, platzB, torOffen);
    buche(c, platzC, torOffen);
    if (d) {
      let pD = pC;
      if (torOffen && sortiertC.length > 1) {
        const kopf = sortiertC.slice(0, LESER_TIEFE);
        const lp = await leserPunkte(
          text,
          kopf.map((x) => leserText(x.lektion as Record<string, unknown>, LESER_MAX_ZEICHEN)),
          { instanceId: instanz, zusatzKopf: adminKopf },
        );
        if (lp) {
          const neu = mischeMitLeser(kopf.map((x) => x.punkte), lp);
          pD = [...neu.map((k) => kopf[k].lektion.topic as string), ...pC.slice(LESER_TIEFE)];
        } else {
          leserAusfaelle++;
        }
      }
      buche(d, platzVon(pD, erwartet), torOffen);
    }

    if (plaetzeNach) {
      plaetzeNach.push({ id: fragen[i].id ?? i, guete: fragen[i].guete, sprache: fragen[i].sprache, alt: platzA, altVoll: platzB, neu: platzC, tor: torOffen });
    }
  }
  return { a, b, c, d };
}

/** Ein festgekeimter Zufallsgenerator — damit die Gegenprobe wiederholbar ist. */
function keimZufall(keim: number): () => number {
  let s = keim >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function main(): Promise<void> {
  const korpusPfad = flag('korpus');
  const satzPfad = flag('pruefsatz');
  if (!korpusPfad || !satzPfad) {
    process.stderr.write('Aufruf: --korpus <datei> --pruefsatz <datei> [--fragen n] [--kontrolle] [--nach datei]\n');
    process.exit(2);
  }
  const minBelege = Number(flag('belege') ?? '2');

  const korpus = JSON.parse(readFileSync(resolve(korpusPfad), 'utf8')) as { lessons: Lektion[] };
  const satz = JSON.parse(readFileSync(resolve(satzPfad), 'utf8')) as { queries: Frage[] };
  const lektionen = korpus.lessons;
  let fragen = satz.queries;
  const grenze = Number(flag('fragen') ?? '0');
  if (grenze > 0) fragen = fragen.slice(0, grenze);

  // Fragen ohne Erwartung koennen nichts belegen und wuerden jede Quote
  // verwaessern. Sie fallen raus, und die Zahl steht im Kopf.
  const themenDa = new Set(lektionen.map((l) => l.topic));
  const vorher = fragen.length;
  fragen = fragen.filter((q) => Array.isArray(q.relevant) && q.relevant.some((t) => themenDa.has(t)));

  process.stdout.write(
    `Bestand ${lektionen.length} Lektionen · Fragen ${fragen.length} von ${vorher}`
    + ` (${vorher - fragen.length} ohne passende Lektion im Korpus)\n`
    + `Tor: mindestens ${minBelege} verschiedene Frageworte im Text\n\n`,
  );

  const plaetze: Array<Record<string, unknown>> | null = flag('nach') ? [] : null;
  const topfFlag = flag('topf');
  const topf = topfFlag !== undefined ? Number(topfFlag) : undefined;
  const gerade = fragen.map((_, i) => i);
  const t0 = Date.now();
  const leserAn = argv.includes('--leser');
  const echt = await lauf(lektionen, fragen, gerade, minBelege, plaetze, topf, leserAn);
  const dauer = Date.now() - t0;

  const n = fragen.length;
  process.stdout.write(
    `Wortkanal-Topf fuer Arm C: ${topf ?? 'Auslieferungsvorgabe (WORT_TOPF)'}\n\n`
    + `${''.padEnd(10)} ${'Platz 1'.padStart(13)}  ${'@3'.padStart(13)}  ${'@10'.padStart(13)}  Tor zu\n`
    + `${zeile('A alt', echt.a, n)}\n`
    + `${zeile('B alt-voll', echt.b, n)}\n`
    + `${zeile('C neu', echt.c, n)}\n`
    + (echt.d ? `${zeile('D Leser', echt.d, n)}\n` : '')
    + `\n(${dauer} ms fuer ${n} Fragen · ${(dauer / n).toFixed(1)} ms je Frage`
    + (leserAn ? ` · Leser-Ausfaelle ${leserAusfaelle} · Instanz ${process.env.CACHLY_BRAIN_INSTANCE_ID ? 'gesetzt' : 'FEHLT'}` : '')
    + ')\n',
  );

  if (argv.includes('--kontrolle')) {
    const r = keimZufall(42);
    const perm = fragen.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const kontrolle = await lauf(lektionen, fragen, perm, minBelege, null, topf, leserAn);
    process.stdout.write(
      '\nGEGENPROBE — dieselben Fragen, Erwartungen permutiert (Keim 42).\n'
      + 'Brechen diese Zahlen NICHT ein, misst der Stand sich selbst.\n'
      + `${zeile('A alt', kontrolle.a, n)}\n`
      + `${zeile('B alt-voll', kontrolle.b, n)}\n`
      + `${zeile('C neu', kontrolle.c, n)}\n`
      + (kontrolle.d ? `${zeile('D Leser', kontrolle.d, n)}\n` : ''),
    );
  }

  const nach = flag('nach');
  if (nach && plaetze) {
    writeFileSync(resolve(nach), JSON.stringify({ bestand: lektionen.length, fragen: n, plaetze }, null, 1), 'utf8');
    process.stdout.write(`\nPlaetze je Frage: ${nach}\n`);
  }
}

main();
