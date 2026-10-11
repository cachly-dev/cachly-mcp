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
 *
 * ── Die Tiefe des Lesers unter Last (--tiefen) ─────────────────────────────
 *
 *   --leser                   Arm D mit der Tiefe des Hooks
 *                             (LESER_TIEFE_EINBLENDUNG).
 *   --tiefen 10,15,25         Arm D je Tiefe. Je Frage werden alle Tiefen
 *                             nacheinander gefragt, die Reihenfolge wechselt
 *                             von Frage zu Frage — so trifft eine Lastspitze
 *                             auf dem Leser-Server alle Tiefen gleich.
 *   --stichprobe <n>          feste Stichprobe (nach dem Filter), Saat aus
 *   --saat <k>                --saat (Vorgabe 7). Gleiche Saat = gleiche Fragen.
 *   --leser-zeitlimit <ms>    Zeitgrenze des MESS-Aufrufs (Vorgabe: die des
 *                             Produkts). Hoeher gesetzt sieht man die ganze
 *                             Verteilung; "Frist" zaehlt dann nur Antworten,
 *                             die binnen LESER_ZEITLIMIT_MS kamen — das, was
 *                             der Hook wirklich bekommt.
 *   --leser-protokoll <datei> je Aufruf eine Zeile JSON (Zeit, Tiefe, ms).
 *
 * Die Gegenprobe (--kontrolle) bewertet dieselben Ranglisten gegen
 * permutierte Erwartungen — ohne einen zweiten Satz Leser-Aufrufe.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Einblendbestand, torWoerter, zaehleBelege } from '../einblendung-kern.js';
import { lektionsText, leserText } from '../seltenheitsbestand.js';
import { mischeMitLeser } from '../leser.js';
import { embedConfig } from '../embeddings.js';
import { LeserSicherung, frageLeser, speicherImProzess } from '../leser-sicherung.js';
import { LESER_TIEFE_EINBLENDUNG, LESER_MAX_ZEICHEN, LESER_ZEITLIMIT_MS } from '../rangfolge-stellschrauben.js';

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

/** Nur die ersten zehn Plaetze zaehlen (@10) — mehr muss je Frage nicht aufgehoben werden. */
const AUFHEBEN = 10;

/** Die Leser-Zeiten einer Tiefe ueber den ganzen Lauf. */
interface LeserZeiten {
  aufrufe: number;
  /** Aufrufe ohne brauchbare Antwort (Zeitgrenze des Messaufrufs, Fehler). */
  ausfaelle: number;
  /** Antworten, die binnen LESER_ZEITLIMIT_MS beim Client ankamen. */
  rechtzeitig: number;
  clientMs: number[];
  serverMs: number[];
}

/** Die Ranglisten (je die ersten AUFHEBEN Themen) einer Frage. */
interface Ranglisten {
  torOffen: boolean;
  a: string[]; b: string[]; c: string[];
  /** Arm D je Tiefe: `voll` mit jeder Leser-Antwort, `frist` nur mit rechtzeitigen. */
  d: Map<number, { voll: string[]; frist: string[] }>;
}

/**
 * Ein Durchgang ueber alle Fragen: rechnet die Ranglisten, bewertet sie aber
 * nicht. Bewertet wird in `bewerte` — fuer den echten Lauf und die
 * Gegenprobe mit DENSELBEN Ranglisten. So laeuft beides durch denselben Code
 * (eine zweite Schleife waere eine zweite Wahrheit), und die Gegenprobe
 * kostet keinen zweiten Satz Leser-Aufrufe.
 */
// Arm D (--leser / --tiefen): die besten `tiefe` von Arm C liest der
// Leser-Endpunkt (POST /api/v1/rerank, Instanz aus CACHLY_BRAIN_INSTANCE_ID —
// die API waehlt den Leser), ueber denselben Anruf wie der Hook (frageLeser),
// gemischt wie im Hook (einblendung.ts selectRelevantMitLeser). Braucht
// CACHLY_JWT; ohne Antwort zaehlt die Frage mit der Ordnung von Arm C.
async function lauf(
  lektionen: Lektion[],
  fragen: Frage[],
  minBelege: number,
  topf: number | undefined,
  tiefen: number[],
  messZeitlimitMs: number,
  protokoll: string | undefined,
): Promise<{ ranglisten: Ranglisten[]; zeiten: Map<number, LeserZeiten> }> {
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

  const instanz = process.env.CACHLY_BRAIN_INSTANCE_ID || '';
  // CACHLY_ADMIN_KEY stellt den Messlauf vom Embed-Limiter frei (60/min je
  // Nutzer, gilt auch fuer /rerank). Ohne ihn zaehlen 429er als Leser-Ausfall.
  const adminKopf = process.env.CACHLY_ADMIN_KEY ? { 'X-Admin-Key': process.env.CACHLY_ADMIN_KEY } : undefined;
  const zeiten = new Map(tiefen.map((t) => [t, { aufrufe: 0, ausfaelle: 0, rechtzeitig: 0, clientMs: [], serverMs: [] } as LeserZeiten]));
  const ranglisten: Ranglisten[] = [];

  for (let i = 0; i < fragen.length; i++) {
    const text = fragen[i].query;
    const tokens = torWoerter(text);

    // Das Tor ist in allen Armen dasselbe (>= minBelege verschiedene
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

    const d = new Map<number, { voll: string[]; frist: string[] }>();
    // Reihenfolge der Tiefen wechselt je Frage: keine Tiefe sitzt immer auf
    // dem ersten (kalten) oder letzten Aufruf.
    const reihe = tiefen.map((_, k) => tiefen[(k + i) % tiefen.length]);
    for (const tiefe of reihe) {
      let voll = pC;
      let frist = pC;
      if (torOffen && sortiertC.length > 1) {
        const kopf = sortiertC.slice(0, tiefe);
        const z = zeiten.get(tiefe)!;
        const t0 = performance.now();
        const antwort = await frageLeser({
          url: `${embedConfig.apiUrl}/api/v1/rerank`,
          jwt: embedConfig.jwt,
          frage: text,
          texte: kopf.map((x) => leserText(x.lektion as Record<string, unknown>, LESER_MAX_ZEICHEN)),
          instanceId: instanz,
          zeitlimitMs: messZeitlimitMs,
          zusatzKopf: adminKopf,
        }, new LeserSicherung(speicherImProzess()));
        const ms = performance.now() - t0;
        z.aufrufe++;
        if (antwort.art === 'punkte') {
          const neu = mischeMitLeser(kopf.map((x) => x.punkte), antwort.scores);
          voll = [...neu.map((k) => kopf[k].lektion.topic as string), ...pC.slice(tiefe)];
          z.clientMs.push(ms);
          z.serverMs.push(antwort.ms);
          if (ms <= LESER_ZEITLIMIT_MS) { frist = voll; z.rechtzeitig++; }
        } else {
          z.ausfaelle++;
        }
        if (protokoll) {
          appendFileSync(protokoll, `${JSON.stringify({ t: new Date().toISOString(), frage: i, tiefe, art: antwort.art, clientMs: Math.round(ms), serverMs: antwort.art === 'punkte' ? antwort.ms : null, anbieter: antwort.art === 'punkte' ? antwort.provider : null })}\n`);
        }
      }
      d.set(tiefe, { voll: voll.slice(0, AUFHEBEN), frist: frist.slice(0, AUFHEBEN) });
    }

    ranglisten.push({ torOffen, a: pA.slice(0, AUFHEBEN), b: pB.slice(0, AUFHEBEN), c: pC.slice(0, AUFHEBEN), d });
    if (tiefen.length && (i + 1) % 50 === 0) {
      process.stderr.write(`  ${i + 1}/${fragen.length} Fragen\n`);
    }
  }
  return { ranglisten, zeiten };
}

/**
 * Bewertet die Ranglisten. `zuordnung[i]` sagt, welche Frage auf welchen
 * Erwartungssatz trifft: fuer den echten Lauf die Reihenfolge selbst, fuer die
 * Gegenprobe eine Permutation.
 */
function bewerte(
  ranglisten: Ranglisten[],
  fragen: Frage[],
  zuordnung: number[],
  plaetzeNach: Array<Record<string, unknown>> | null,
): { a: Kennzahlen; b: Kennzahlen; c: Kennzahlen; d: Map<number, { voll: Kennzahlen; frist: Kennzahlen }> } {
  const a = leer(); const b = leer(); const c = leer();
  const d = new Map<number, { voll: Kennzahlen; frist: Kennzahlen }>();
  ranglisten.forEach((r, i) => {
    const erwartet = new Set(fragen[zuordnung[i]].relevant);
    const platzA = platzVon(r.a, erwartet);
    const platzB = platzVon(r.b, erwartet);
    const platzC = platzVon(r.c, erwartet);
    buche(a, platzA, r.torOffen);
    buche(b, platzB, r.torOffen);
    buche(c, platzC, r.torOffen);
    // Plaetze je Tiefe auch je Frage — fuer den gepaarten Vergleich zweier
    // Tiefen (welche Fragen gewinnt die eine, welche die andere).
    const leserPlaetze: Record<string, number> = {};
    for (const [tiefe, l] of r.d) {
      if (!d.has(tiefe)) d.set(tiefe, { voll: leer(), frist: leer() });
      const pv = platzVon(l.voll, erwartet);
      const pf = platzVon(l.frist, erwartet);
      buche(d.get(tiefe)!.voll, pv, r.torOffen);
      buche(d.get(tiefe)!.frist, pf, r.torOffen);
      leserPlaetze[`T${tiefe}`] = pv;
      leserPlaetze[`T${tiefe}F`] = pf;
    }
    if (plaetzeNach) {
      plaetzeNach.push({ id: fragen[i].id ?? i, guete: fragen[i].guete, sprache: fragen[i].sprache, alt: platzA, altVoll: platzB, neu: platzC, tor: r.torOffen, ...(r.d.size ? { leser: leserPlaetze } : {}) });
    }
  });
  return { a, b, c, d };
}

/** Quantil einer Zahlenreihe (naechster Rang), 0 bei leerer Reihe. */
function quantil(werte: number[], q: number): number {
  if (!werte.length) return 0;
  const s = [...werte].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function armZeilen(d: Map<number, { voll: Kennzahlen; frist: Kennzahlen }>, n: number, mitFrist: boolean): string {
  let s = '';
  for (const [tiefe, k] of d) {
    s += `${zeile(`D T${tiefe}`, k.voll, n)}\n`;
    if (mitFrist) s += `${zeile(`D T${tiefe} F`, k.frist, n)}\n`;
  }
  return s;
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
  // Ein Messlauf will JEDE Frage beim Leser sehen. Mit Leser-Sicherung
  // (leser-sicherung.ts) wuerden nach 3 Ausfaellen in Folge 10 Minuten lang
  // alle Fragen als "Leser-Ausfall" gezaehlt, ohne dass gefragt wurde.
  process.env.CACHLY_LESER_SICHERUNG ??= 'aus';
  const korpusPfad = flag('korpus');
  const satzPfad = flag('pruefsatz');
  if (!korpusPfad || !satzPfad) {
    process.stderr.write('Aufruf: --korpus <datei> --pruefsatz <datei> [--fragen n] [--kontrolle] [--nach datei] [--leser | --tiefen 10,15,25] [--stichprobe n --saat k] [--leser-zeitlimit ms] [--leser-protokoll datei]\n');
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

  // --stichprobe <n>: feste Auswahl mit Saat — gleiche Saat, gleiche Fragen,
  // in der Reihenfolge des Pruefsatzes.
  const stichprobe = Number(flag('stichprobe') ?? '0');
  const saat = Number(flag('saat') ?? '7');
  const ungefiltert = fragen.length;
  if (stichprobe > 0 && stichprobe < fragen.length) {
    const r = keimZufall(saat);
    const idx = fragen.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const gewaehlt = idx.slice(0, stichprobe).sort((x, y) => x - y);
    fragen = gewaehlt.map((i) => fragen[i]);
  }

  process.stdout.write(
    `Bestand ${lektionen.length} Lektionen · Fragen ${ungefiltert} von ${vorher}`
    + ` (${vorher - ungefiltert} ohne passende Lektion im Korpus)`
    + (fragen.length < ungefiltert ? ` · Stichprobe ${fragen.length} (Saat ${saat})` : '')
    + `\nTor: mindestens ${minBelege} verschiedene Frageworte im Text\n\n`,
  );

  const plaetze: Array<Record<string, unknown>> | null = flag('nach') ? [] : null;
  const topfFlag = flag('topf');
  const topf = topfFlag !== undefined ? Number(topfFlag) : undefined;
  const tiefenFlag = flag('tiefen');
  const tiefen = tiefenFlag
    ? tiefenFlag.split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 1)
    : (argv.includes('--leser') ? [LESER_TIEFE_EINBLENDUNG] : []);
  const messZeitlimit = Number(flag('leser-zeitlimit') ?? String(LESER_ZEITLIMIT_MS));
  const mitFrist = messZeitlimit > LESER_ZEITLIMIT_MS;
  const t0 = Date.now();
  const { ranglisten, zeiten } = await lauf(lektionen, fragen, minBelege, topf, tiefen, messZeitlimit, flag('leser-protokoll'));
  const dauer = Date.now() - t0;
  const gerade = fragen.map((_, i) => i);
  const echt = bewerte(ranglisten, fragen, gerade, plaetze);

  const n = fragen.length;
  let zeitTafel = '';
  if (tiefen.length) {
    zeitTafel = `\nLeser-Zeit je Tiefe (Client = was der Hook wartet, Server = API bis Leser und zurueck; Frist ${LESER_ZEITLIMIT_MS} ms, Messgrenze ${messZeitlimit} ms)\n`;
    for (const [tiefe, z] of zeiten) {
      const rz = z.aufrufe ? ((z.rechtzeitig / z.aufrufe) * 100).toFixed(1) : '-';
      zeitTafel += `  T${String(tiefe).padEnd(3)} Aufrufe ${z.aufrufe} · Client p50 ${Math.round(quantil(z.clientMs, 0.5))} / p95 ${Math.round(quantil(z.clientMs, 0.95))} ms`
        + ` · Server p50 ${Math.round(quantil(z.serverMs, 0.5))} / p95 ${Math.round(quantil(z.serverMs, 0.95))} ms`
        + ` · rechtzeitig ${z.rechtzeitig} (${rz} %) · Ausfaelle ${z.ausfaelle}\n`;
    }
  }
  process.stdout.write(
    `Wortkanal-Topf fuer Arm C: ${topf ?? 'Auslieferungsvorgabe (WORT_TOPF)'}\n\n`
    + `${''.padEnd(10)} ${'Platz 1'.padStart(13)}  ${'@3'.padStart(13)}  ${'@10'.padStart(13)}  Tor zu\n`
    + `${zeile('A alt', echt.a, n)}\n`
    + `${zeile('B alt-voll', echt.b, n)}\n`
    + `${zeile('C neu', echt.c, n)}\n`
    + armZeilen(echt.d, n, mitFrist)
    + (mitFrist ? `(D Tn = jede Leser-Antwort genutzt · D Tn F = nur Antworten binnen ${LESER_ZEITLIMIT_MS} ms, sonst Ordnung C)\n` : '')
    + zeitTafel
    + `\n(${dauer} ms fuer ${n} Fragen · ${(dauer / n).toFixed(1)} ms je Frage`
    + (tiefen.length ? ` · Instanz ${process.env.CACHLY_BRAIN_INSTANCE_ID ? 'gesetzt' : 'FEHLT'}` : '')
    + ')\n',
  );

  if (argv.includes('--kontrolle')) {
    const r = keimZufall(42);
    const perm = fragen.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const kontrolle = bewerte(ranglisten, fragen, perm, null);
    process.stdout.write(
      '\nGEGENPROBE — dieselben Ranglisten, Erwartungen permutiert (Keim 42).\n'
      + 'Brechen diese Zahlen NICHT ein, misst der Stand sich selbst.\n'
      + `${zeile('A alt', kontrolle.a, n)}\n`
      + `${zeile('B alt-voll', kontrolle.b, n)}\n`
      + `${zeile('C neu', kontrolle.c, n)}\n`
      + armZeilen(kontrolle.d, n, mitFrist),
    );
  }

  const nach = flag('nach');
  if (nach && plaetze) {
    writeFileSync(resolve(nach), JSON.stringify({ bestand: lektionen.length, fragen: n, plaetze }, null, 1), 'utf8');
    process.stdout.write(`\nPlaetze je Frage: ${nach}\n`);
  }
}

main();
