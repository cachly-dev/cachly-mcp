/**
 * LongMemEval — ein Pruefstand, den jemand anders gebaut hat.
 *
 * ── Warum (Karte tf98ujtvy36t; Jonathan Murray, 23.08.2026) ────────────────
 *
 * "Self-reported precision@1 against your own corpus is always going to be
 * soft — you wrote the queries and the ground truth." Die Fremdernte loest
 * die Haelfte davon (der Frager ist nie der Antworter); dieser Pruefstand
 * loest den Rest: Fragen, Bestand und Wahrheit stammen von Wu et al.
 * (LongMemEval, ICLR 2025), 500 Fragen, je ~54 Chat-Sitzungen Heuhaufen.
 *
 * ── Was gemessen wird — und was AUSDRUECKLICH NICHT ────────────────────────
 *
 * Gemessen wird RETRIEVAL auf Sitzungs-Ebene: liegt eine der
 * Beweis-Sitzungen (answer_session_ids) unter den ersten K der Suche?
 * Das ist unsere Aufgabe (Suche ueber einen Bestand), nicht die des
 * urspruenglichen Benchmarks (Antwort-Generierung, von einem Modell
 * beurteilt). Deshalb steht hier KEINE Zahl neben den veroeffentlichten
 * LongMemEval-Ergebnissen anderer Systeme — zwei Aufgaben, zwei Massstaebe.
 *
 * Der Lauf faehrt den WORT-Pfad (keywordSearch, BM25) — die
 * Produktionskonfiguration ohne Einbettungsdienst. Der Bedeutungsabgleich
 * wuerde zehntausende Live-Einbettungen brauchen; die TEI-Dienste rechnen
 * gerade den Fremdkorpus (Karte lcheuc2kngh2) und werden hier nicht
 * gekapert.
 *
 * ── Abstention: der dritte Ausgang am fremden Massstab ─────────────────────
 *
 * 30 der 500 Fragen (_abs) haben ihre Beweis-Sitzung NICHT im Heuhaufen —
 * die einzige ehrliche Antwort ist "weiss ich aus dem Bestand nicht".
 * Unser Urteil dafuer ist die Drei-Ausgaenge-Mechanik: Schweigen (keine
 * Treffer) oder knapper Sieg (Abstand Platz 1 zu Platz 2 unter
 * ABLEHN_ABSTAND). Die GEGENPROBE laeuft immer mit: dieselbe Regel darf
 * normale Fragen nicht massenhaft faelschlich abweisen — ein System, das
 * immer Nein sagt, waere auf den _abs-Fragen perfekt und als Speicher
 * wertlos.
 *
 * ── DAS URTEIL zur Wort-Kalibrierung (31.08.2026, Haelfte A): WIDERLEGT ────
 *
 * Zwei Kandidaten gegen die 0/30-Blindheit, beide nur auf der
 * Einstellhaelfte (245 Fragen, 15 _abs) geprueft:
 *
 *   maxWortBelege absolut   _abs p50=3,5  normale p50=5,5  — Ueberlappung
 *   Anteil an Frageworten   _abs p50=0,50 normale p50=0,60 — deckungsgleich
 *
 * KEINE Schwelle erreicht die vorregistrierte Latte (>=50 % _abs erkannt
 * bei <3 % falschem Nein). Haelfte B wurde NICHT angefasst. Die Lehre:
 * die _abs-Fragen sind wort-NAH an ihren Ablenkern konstruiert — die Frage
 * nennt das Thema, nur die Antwort fehlt. Wortstatistik sieht Themennaehe,
 * nicht Antwortbesitz. Der naechste Kandidat braucht ein semantisches
 * Signal (nach der Einbettungswelle) oder die Lese-Ebene.
 *
 * Aufruf (Heap: die Datei ist 278 MB gross):
 *   node --max-old-space-size=4096 dist/src/bench/longmemeval.js \
 *     --datei <pfad>/longmemeval_s.json [--limit N] [--topk 5]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Redis } from 'ioredis';
import { MiniRedis } from './mini-redis.js';
import { keywordSearch, tokenize } from '../search.js';
import { ABLEHN_ABSTAND } from '../rangfolge.js';
import { haelfteFuer } from './messstand-je-projekt.js';

interface Turn { role: string; content: string; has_answer?: boolean }
export interface LmeFrage {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

export interface FragenErgebnis {
  typ: string;
  abs: boolean;
  /** 1-basierter Rang der besten Beweis-Sitzung; null = nicht in den Treffern. */
  sessionRang: number | null;
  /** Drei-Ausgaenge-Urteil der Suche: wuerde sie abraten? */
  abgeraten: boolean;
  /** Hoechste Zahl wirklich enthaltener Frageworte ueber alle Treffer. */
  maxWortBelege: number;
  /** Kernwoerter der Frage (tokenize) — Nenner fuer das Anteils-Kriterium. */
  frageWoerter: number;
}

/** Sitzungs-Rangliste: jede Sitzung zaehlt an der Position ihres besten Turns. */
export function sessionRaenge(treffer: ReadonlyArray<{ key: string }>): string[] {
  const gesehen = new Set<string>();
  const folge: string[] = [];
  for (const t of treffer) {
    const m = t.key.match(/^cachly:ctx:lme:(.+)#\d+$/);
    if (!m) continue;
    if (!gesehen.has(m[1])) { gesehen.add(m[1]); folge.push(m[1]); }
  }
  return folge;
}

/** Schweigen oder knapper Sieg — dieselbe Mechanik wie die Drei Ausgaenge. */
export function abgeraten(treffer: ReadonlyArray<{ score: number }>): boolean {
  if (treffer.length === 0) return true;
  if (treffer.length === 1) return false;
  return treffer[0].score - treffer[1].score < ABLEHN_ABSTAND;
}

/**
 * Das Woerter-Kriterium (Karte fnm7zesl10st): abraten, wenn KEIN Treffer
 * mindestens `schwelle` getippte Woerter wirklich enthaelt.
 *
 * Warum nicht der Score-Abstand: `score` ist min-max-normiert, Platz 1
 * bekommt IMMER 1,0 — der Abstand misst nur, wie dicht Platz 2 folgt,
 * nie ob irgendetwas passt. `wortBelege` ist die absolute Zahl aus der
 * Suche selbst (exakt 1, unscharf 0,5, Synonyme zaehlen nicht).
 */
export function abgeratenNachWoertern(
  treffer: ReadonlyArray<{ wortBelege: number }>,
  schwelle: number,
): boolean {
  if (treffer.length === 0) return true;
  return Math.max(...treffer.map((t) => t.wortBelege)) < schwelle;
}

export async function messeFrage(f: LmeFrage, topK: number): Promise<FragenErgebnis> {
  const mini = new MiniRedis();
  f.haystack_sessions.forEach((sitzung, si) => {
    const sid = f.haystack_session_ids[si];
    const datum = f.haystack_dates[si] ?? '';
    sitzung.forEach((turn, ti) => {
      mini.set('cachly:ctx:lme:' + sid + '#' + ti, '[' + datum + '] ' + turn.role + ': ' + turn.content);
    });
  });
  const treffer = await keywordSearch(mini as unknown as Redis, ['cachly:ctx:*'], f.question, 25);
  const raenge = sessionRaenge(treffer);
  const beweis = new Set(f.answer_session_ids);
  let rang: number | null = null;
  for (let i = 0; i < raenge.length && i < topK; i++) {
    if (beweis.has(raenge[i])) { rang = i + 1; break; }
  }
  return {
    typ: f.question_type,
    abs: f.question_id.endsWith('_abs'),
    sessionRang: rang,
    abgeraten: abgeraten(treffer),
    maxWortBelege: treffer.length === 0 ? 0 : Math.max(...treffer.map((t) => t.wortBelege)),
    frageWoerter: tokenize(f.question).length,
  };
}

function prozent(n: number, von: number): string {
  return von === 0 ? '—' : ((100 * n) / von).toFixed(1) + ' %';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : undefined; };
  const pfad = flag('datei');
  if (!pfad) { console.error('NICHT GEMESSEN: --datei fehlt.'); process.exit(2); }
  const topK = Number(flag('topk') ?? 5);
  const limit = Number(flag('limit') ?? 0);

  const fragen = JSON.parse(readFileSync(pfad, 'utf8')) as LmeFrage[];
  // A/B-Teilung fuer die Abstention-Kalibrierung (Karte fnm7zesl10st):
  // Kriterien werden auf 'einstellen' entworfen, auf 'pruefen' genau EINMAL
  // bestaetigt. Derselbe FNV-1a wie beim Fremdsatz — stabil ueber Jahre.
  const haelfte = flag('haelfte');
  const geteilte = haelfte
    ? fragen.filter((f) => haelfteFuer(f.question_id) === haelfte)
    : fragen;
  const satz = limit > 0 ? geteilte.slice(0, limit) : geteilte;
  console.log('');
  console.log('LongMemEval-s: ' + satz.length + ' Fragen (von ' + fragen.length + ') · Wortpfad · Sitzungs-Treffer@{1,3,' + topK + '}');
  console.log('');

  const ergebnisse: FragenErgebnis[] = [];
  let fertig = 0;
  for (const f of satz) {
    ergebnisse.push(await messeFrage(f, topK));
    fertig++;
    if (fertig % 50 === 0) console.log('  … ' + fertig + '/' + satz.length);
  }

  const typen = [...new Set(ergebnisse.map((e) => e.typ))].sort();
  console.log('');
  console.log('  ' + 'Klasse'.padEnd(26) + ' ' + 'n'.padStart(4) + '  ' + 'S@1'.padStart(7) + '  ' + 'S@3'.padStart(7) + '  ' + ('S@' + topK).padStart(7));
  const zeile = (name: string, es: FragenErgebnis[]): void => {
    const bei = (k: number) => es.filter((e) => e.sessionRang !== null && e.sessionRang <= k).length;
    console.log('  ' + name.padEnd(26) + ' ' + String(es.length).padStart(4) + '  '
      + prozent(bei(1), es.length).padStart(7) + '  ' + prozent(bei(3), es.length).padStart(7) + '  ' + prozent(bei(topK), es.length).padStart(7));
  };
  const normale = ergebnisse.filter((e) => !e.abs);
  for (const t of typen) zeile(t, normale.filter((e) => e.typ === t));
  zeile('GESAMT (ohne _abs)', normale);

  const abs = ergebnisse.filter((e) => e.abs);
  const absEhrlich = abs.filter((e) => e.abgeraten).length;
  const falschesNein = normale.filter((e) => e.abgeraten).length;
  const woerterSchwelle = Number(flag('abstain-woerter') ?? 0);
  if (woerterSchwelle > 0) {
    const absErkannt = abs.filter((e) => abgeratenNachWoertern([{ wortBelege: e.maxWortBelege }], woerterSchwelle)).length;
    const falsch = normale.filter((e) => abgeratenNachWoertern([{ wortBelege: e.maxWortBelege }], woerterSchwelle)).length;
    console.log('');
    console.log('  Woerter-Kriterium (abraten, wenn kein Treffer >= ' + woerterSchwelle + ' getippte Woerter enthaelt):');
    console.log('    erkannte _abs: ' + absErkannt + ' von ' + abs.length + ' (' + prozent(absErkannt, abs.length) + ')');
    console.log('    falsches Nein bei normalen Fragen: ' + falsch + ' von ' + normale.length + ' (' + prozent(falsch, normale.length) + ')');
  }

  if (argv.includes('--abstain-bericht')) {
    console.log('');
    console.log('  Verteilung maxWortBelege (nur zum ENTWERFEN — Haelfte einstellen!):');
    const vert = (es: FragenErgebnis[], name: string): void => {
      const werte = es.map((e) => e.maxWortBelege).sort((x, y) => x - y);
      const q = (p: number) => werte[Math.min(werte.length - 1, Math.floor(p * werte.length))] ?? 0;
      console.log('    ' + name.padEnd(10) + ' n=' + String(es.length).padStart(4)
        + '  p10=' + q(0.1) + ' p25=' + q(0.25) + ' p50=' + q(0.5) + ' p75=' + q(0.75) + ' p90=' + q(0.9));
    };
    vert(abs, '_abs');
    vert(normale, 'normale');
    console.log('');
    console.log('  Verteilung ANTEIL (maxWortBelege / Frageworte):');
    const vertA = (es: FragenErgebnis[], name: string): void => {
      const werte = es.map((e) => (e.frageWoerter === 0 ? 0 : e.maxWortBelege / e.frageWoerter)).sort((x, y) => x - y);
      const q = (p: number) => (werte[Math.min(werte.length - 1, Math.floor(p * werte.length))] ?? 0).toFixed(2);
      console.log('    ' + name.padEnd(10) + ' n=' + String(es.length).padStart(4)
        + '  p10=' + q(0.1) + ' p25=' + q(0.25) + ' p50=' + q(0.5) + ' p75=' + q(0.75) + ' p90=' + q(0.9));
    };
    vertA(abs, '_abs');
    vertA(normale, 'normale');
  }

  console.log('');
  console.log('  Abstention (' + abs.length + ' _abs-Fragen, Beweis fehlt im Heuhaufen):');
  console.log('    ehrliches Nein (Schweigen/knapper Sieg): ' + absEhrlich + ' von ' + abs.length + ' (' + prozent(absEhrlich, abs.length) + ')');
  console.log('    GEGENPROBE — falsches Nein bei normalen Fragen: ' + falschesNein + ' von ' + normale.length + ' (' + prozent(falschesNein, normale.length) + ')');
  console.log('    (Immer-Nein waere auf _abs perfekt und als Speicher wertlos — beide Zahlen gehoeren zusammen.)');

  console.log('');
  console.log('  Was diese Zahlen NICHT sagen: nichts ueber Antwort-Qualitaet (das misst');
  console.log('  der Original-Benchmark mit einem Modell als Richter), nichts im Vergleich');
  console.log('  zu veroeffentlichten LongMemEval-Zahlen anderer Systeme (andere Aufgabe),');
  console.log('  und nichts ueber den Bedeutungsabgleich (Wortpfad ohne Einbettung).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('NICHT GEMESSEN:', (e as Error).message); process.exit(1); });
}
