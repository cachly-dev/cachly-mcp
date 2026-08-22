/**
 * Kandidat B: Tuer-Trennschaerfe — jeder Schluessel beweist, was er NICHT oeffnet.
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Gemessen am 20.08.2026: mehr Tueren SENKEN die Decke (89 % auf 86 %,
 * tor0-tor1 §4). Der Grund ist nicht die Zahl der Tueren, sondern ihre
 * Promiskuitaet: eine Tuer, die den Nachbarn genauso gut beschreibt wie die
 * eigene Lektion, hebt im Vorauswahl-Maximum die Punktzahl JEDER Lektion und
 * draengt die richtige aus den Top-25.
 *
 * Naturvorbild (Workshop 2, ungemessen bis heute): Eierschrift gegen
 * Brutparasiten. Ein Wirtsvogel erkennt sein Ei nicht daran, dass es ihm
 * aehnlich sieht, sondern daran, dass es sich von FREMDEN Eiern unterscheidet.
 *
 * ── Was gerechnet wird ──────────────────────────────────────────────────────
 *
 * Je Tuer:  trennschaerfe = Naehe zur EIGENEN Volltext-Sicht
 *                         − beste Naehe zu einer FREMDEN Volltext-Sicht.
 *
 * Positiv: die Tuer zeigt eher auf die eigene Lektion als auf irgendeine
 * fremde. Negativ: die Tuer ist ein Schluessel, der fremde Tueren besser
 * oeffnet als die eigene — ein Kandidat fuers Streichen.
 *
 * Dieses Werkzeug MISST nur und schreibt eine Filterdatei. Angewendet wird der
 * Filter in decke-messen.ts / findequote-messen.ts ueber --tuerfilter und
 * --schwelle. Volltext-Tueren werden dort NIE gestrichen: sie sind die
 * Grundlinie "heute", und eine veraenderte Grundlinie macht jede alte Messung
 * unvergleichbar.
 *
 * Abgrenzung, damit es niemand doppelt baut: v7-Beschneiden streicht nach
 * SIEGEN (Nutzung im Messlauf), B streicht nach UNTERSCHEIDBARKEIT
 * (Geometrie, ohne einen einzigen Messlauf). v7 hat @3 gehalten, nie gehoben.
 *
 * Aufruf:
 *   npx tsx src/bench/tuer-trennschaerfe.ts --eingaenge <eingaenge-b.json> \
 *     --vektoren <eingaenge-b.vektoren.json> --out <tuerfilter.json>
 *   npx tsx src/bench/tuer-trennschaerfe.ts --selbstprobe
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { kosinus } from '../bedeutung.js';
import { schluessel } from './eingaenge-einbetten.js';
import type { Eingang } from './eingaenge-b.js';

interface Lektionseingaenge { topic: string; eingaenge: Eingang[] }

export interface Tuerfilter {
  /** Je Tuer-Schluessel (art:sha1) die Trennschaerfe. */
  tueren: Record<string, number>;
  /** Tueren ohne eigene Volltext-Sicht — nicht bewertbar, nie streichen. */
  unbewertbar: string[];
}

/**
 * Trennschaerfe aller Tueren.
 *
 * Erwartet je Lektion die Tuer-Vektoren und je Lektion den Volltext-Vektor.
 * Eine Tuer ohne eigenen Volltext-Vektor ist nicht bewertbar und landet in
 * `unbewertbar` — sie zu streichen hiesse, eine Lektion fuer eine Luecke der
 * MESSUNG zu bestrafen.
 */
export function trennschaerfen(
  lektionen: Array<{ topic: string; tueren: Array<{ key: string; vektor: number[] }> }>,
  volltext: Map<string, number[]>,
): Tuerfilter {
  const aus: Tuerfilter = { tueren: {}, unbewertbar: [] };
  const fremde = lektionen.map((l) => ({ topic: l.topic, v: volltext.get(l.topic) }));
  for (const l of lektionen) {
    const eigen = volltext.get(l.topic);
    for (const t of l.tueren) {
      if (!eigen) { aus.unbewertbar.push(t.key); continue; }
      const naeheEigen = kosinus(t.vektor, eigen);
      let fremdMax = -2;
      for (const f of fremde) {
        if (f.topic === l.topic || !f.v) continue;
        const k = kosinus(t.vektor, f.v);
        if (k > fremdMax) fremdMax = k;
      }
      aus.tueren[t.key] = naeheEigen - fremdMax;
    }
  }
  return aus;
}

// ── Selbstprobe ─────────────────────────────────────────────────────────────

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  // Zwei Lektionen. Tuer "scharf" zeigt klar auf a, Tuer "promisk" liegt
  // zwischen beiden, Tuer "fremdgaenger" zeigt auf b, gehoert aber zu a.
  const volltext = new Map<string, number[]>([
    ['a', [1, 0, 0]],
    ['b', [0, 1, 0]],
  ]);
  const f = trennschaerfen([
    {
      topic: 'a',
      tueren: [
        { key: 'scharf', vektor: [0.95, 0.05, 0] },
        { key: 'promisk', vektor: [0.7, 0.7, 0] },
        { key: 'fremdgaenger', vektor: [0.1, 0.95, 0] },
      ],
    },
    { topic: 'b', tueren: [] },
  ], volltext);

  p('scharfe Tuer deutlich positiv', f.tueren['scharf'] > 0.5);
  p('promiske Tuer nahe null', Math.abs(f.tueren['promisk']) < 0.05);
  p('fremdgehende Tuer negativ', f.tueren['fremdgaenger'] < -0.5);

  const ohne = trennschaerfen(
    [{ topic: 'x', tueren: [{ key: 'k', vektor: [1, 0, 0] }] }],
    new Map(),
  );
  p('ohne Volltext-Sicht: unbewertbar, nicht bewertet',
    ohne.unbewertbar.includes('k') && !('k' in ohne.tueren));

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

// ── Hauptteil ───────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const eingPfad = resolve(flag('eingaenge') ?? '');
  const vekPfad = resolve(flag('vektoren') ?? '');
  const ziel = resolve(flag('out') ?? './tuerfilter.json');
  for (const [was, pfad] of [['Eingangsdatei', eingPfad], ['Vektordatei', vekPfad]] as const) {
    if (!existsSync(pfad)) {
      console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
      process.exit(2);
    }
  }

  const { lektionen } = JSON.parse(readFileSync(eingPfad, 'utf8')) as { lektionen: Lektionseingaenge[] };
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> };

  const volltext = new Map<string, number[]>();
  const artVon = new Map<string, string>();
  let ohneVektor = 0;
  const eingabe = lektionen.map((l) => {
    const tueren: Array<{ key: string; vektor: number[] }> = [];
    for (const e of l.eingaenge) {
      const key = schluessel(e.art, e.text);
      const v = vektoren[key];
      if (!v) { ohneVektor++; continue; }
      if (e.art === 'volltext') volltext.set(l.topic, v);
      artVon.set(key, e.art);
      tueren.push({ key, vektor: v });
    }
    return { topic: l.topic, tueren };
  });

  const filter = trennschaerfen(eingabe, volltext);

  // Verteilung je Tuerart — die Zahl, an der die Schwelle haengt.
  const jeArt = new Map<string, number[]>();
  for (const [key, wert] of Object.entries(filter.tueren)) {
    const art = artVon.get(key) ?? 'unbekannt';
    if (!jeArt.has(art)) jeArt.set(art, []);
    jeArt.get(art)!.push(wert);
  }
  const q = (xs: number[], p: number): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  console.log('');
  console.log(`  ${Object.keys(filter.tueren).length} Tueren bewertet, ${filter.unbewertbar.length} unbewertbar, ${ohneVektor} ohne Vektor.`);
  console.log('');
  console.log('  Trennschaerfe je Tuerart (Median, 10%-, 25%-Quantil, Anteil negativ):');
  for (const [art, xs] of [...jeArt.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const neg = xs.filter((x) => x < 0).length;
    console.log(`    ${art.padEnd(12)} n=${String(xs.length).padStart(4)}`
      + `  median ${q(xs, 0.5).toFixed(3)}  q10 ${q(xs, 0.1).toFixed(3)}  q25 ${q(xs, 0.25).toFixed(3)}`
      + `  negativ ${neg} (${Math.round((neg / xs.length) * 100)} %)`);
  }
  writeFileSync(ziel, JSON.stringify(filter, null, 1), 'utf8');
  console.log('');
  console.log(`  Geschrieben nach ${ziel}`);
  console.log('  Anwenden: decke-messen/findequote-messen mit --tuerfilter <datei> --schwelle <x>.');
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/tuer-trennschaerfe.ts');
if (direktGestartet && process.argv.includes('--selbstprobe')) selbstprobe();
else if (direktGestartet) main();
