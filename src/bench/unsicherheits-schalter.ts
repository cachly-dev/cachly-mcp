/**
 * Kandidat C1: Trennt ein Unsicherheits-Schalter Gewinn- von Verlustfaellen?
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Kandidat C2 (Mehrfach-Lesart der Frage per Sprachmodell) kostet je Ausloesung
 * einen Modell-Aufruf plus drei Einbettungen. Das lohnt nur, wenn ein billiger
 * Schalter die unsicheren Faelle VORHER erkennt. Der Architektenlauf vom
 * 22.08.2026 verlangt deshalb: erst die Trennschaerfe des Schalters messen —
 * OHNE Sprachmodell, aus Groessen, die der Sortierer ohnehin berechnet.
 * Trennt der Schalter nicht, wird C2 nie gebaut.
 *
 * Vorhersage des Architekten: der Schalter markiert >= 25 der Verlustfaelle
 * bei hoechstens 25 Fehlalarmen unter den Gewinnfaellen.
 *
 * ── Was gemessen wird ───────────────────────────────────────────────────────
 *
 * Eingabe ist die --diagnose-Ausgabe von findequote-messen.ts (der ECHTE
 * Messweg, keine zweite Fassung). Verlust = beste akzeptable Antwort nicht in
 * den Top 3. Je Merkmal wird die Schwelle durchgefahren („unsicher, wenn Wert
 * <= s") und der beste Arbeitspunkt unter der Fehlalarm-Grenze gemeldet; dazu
 * die beste ODER-Kombination aus zwei Merkmalen.
 *
 * WICHTIG: Die hier gefundene Schwelle ist auf DIESEM Satz eingestellt. Vor
 * einer Uebernahme gehoert sie auf den anderen eingefrorenen Satz bzw. den
 * 3000er-Pool — eine Schwelle, die nur ihre eigene Stichprobe trennt, ist
 * eine Eigenschaft der Stichprobe (kreuzweise-Regel aus rangfolge.ts).
 *
 * Aufruf:
 *   npx tsx src/bench/unsicherheits-schalter.ts --diagnose <diag.jsonl> [--fehlalarme 25]
 *   npx tsx src/bench/unsicherheits-schalter.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface Zeile {
  query: string; art: string; platz: number; topf: number;
  bestPunkt: number; abstand12: number; abstand34: number;
  deckungGewinner: number; besterEingang: number;
}

export interface Arbeitspunkt {
  merkmal: string; schwelle: number;
  markierteVerluste: number; verluste: number;
  fehlalarme: number; gewinne: number;
}

/**
 * Bester Arbeitspunkt eines Merkmals: maximal markierte Verluste, solange die
 * Fehlalarme unter der Grenze bleiben. Bei Gleichstand die kleinere Schwelle
 * (weniger Ausloesungen).
 */
export function besterPunkt(
  zeilen: Array<{ wert: number; verlust: boolean }>,
  merkmal: string,
  maxFehlalarme: number,
): Arbeitspunkt {
  const verluste = zeilen.filter((z) => z.verlust).length;
  const gewinne = zeilen.length - verluste;
  const kandidaten = [...new Set(zeilen.map((z) => z.wert))].sort((a, b) => a - b);
  let best: Arbeitspunkt = {
    merkmal, schwelle: Number.NEGATIVE_INFINITY,
    markierteVerluste: 0, verluste, fehlalarme: 0, gewinne,
  };
  for (const s of kandidaten) {
    const markiert = zeilen.filter((z) => z.wert <= s);
    const mv = markiert.filter((z) => z.verlust).length;
    const fa = markiert.length - mv;
    if (fa <= maxFehlalarme && mv > best.markierteVerluste) {
      best = { merkmal, schwelle: s, markierteVerluste: mv, verluste, fehlalarme: fa, gewinne };
    }
  }
  return best;
}

// ── Selbstprobe ─────────────────────────────────────────────────────────────

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  // Merkmal trennt perfekt: Verluste bei 0.1, Gewinne bei 0.9.
  const perfekt = [
    { wert: 0.1, verlust: true }, { wert: 0.1, verlust: true },
    { wert: 0.9, verlust: false }, { wert: 0.9, verlust: false },
  ];
  const a = besterPunkt(perfekt, 'x', 0);
  p('perfektes Merkmal markiert alle Verluste ohne Fehlalarm',
    a.markierteVerluste === 2 && a.fehlalarme === 0);

  // Merkmal trennt gar nicht: gleiche Werte ueberall.
  const nutzlos = [
    { wert: 0.5, verlust: true }, { wert: 0.5, verlust: false },
    { wert: 0.5, verlust: false }, { wert: 0.5, verlust: false },
  ];
  const b = besterPunkt(nutzlos, 'x', 0);
  p('nutzloses Merkmal markiert nichts (Fehlalarm-Grenze haelt)',
    b.markierteVerluste === 0);
  const c = besterPunkt(nutzlos, 'x', 3);
  p('mit lockerer Grenze markiert es alles inkl. Fehlalarme',
    c.markierteVerluste === 1 && c.fehlalarme === 3);

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
  const pfad = resolve(flag('diagnose') ?? '');
  const maxFA = Number(flag('fehlalarme') ?? '25');
  if (!existsSync(pfad)) {
    console.error(`NICHT GEMESSEN: Diagnosedatei fehlt (${pfad}). Erst findequote-messen.ts mit --diagnose fahren.`);
    process.exit(2);
  }
  const zeilen = readFileSync(pfad, 'utf8').split('\n').filter((z) => z.trim())
    .map((z) => JSON.parse(z) as Zeile);
  const verlust = (z: Zeile): boolean => z.platz === 0 || z.platz > 3;
  const nV = zeilen.filter(verlust).length;

  console.log('');
  console.log(`  ${zeilen.length} Fragen · ${nV} Verluste (nicht in Top 3) · Fehlalarm-Grenze ${maxFA}`);
  console.log('');
  console.log('  Je Merkmal der beste Arbeitspunkt („unsicher, wenn Wert <= Schwelle"):');

  const merkmale: Array<[string, (z: Zeile) => number]> = [
    ['bestPunkt', (z) => z.bestPunkt],
    ['abstand12', (z) => z.abstand12],
    ['abstand34', (z) => z.abstand34],
    ['deckungGewinner', (z) => z.deckungGewinner],
    ['besterEingang', (z) => z.besterEingang],
  ];
  const punkte: Arbeitspunkt[] = [];
  for (const [name, wert] of merkmale) {
    const a = besterPunkt(zeilen.map((z) => ({ wert: wert(z), verlust: verlust(z) })), name, maxFA);
    punkte.push(a);
    console.log(`    ${name.padEnd(16)} Schwelle ${a.schwelle.toFixed(3).padStart(8)}`
      + `  markiert ${a.markierteVerluste}/${a.verluste} Verluste`
      + `  Fehlalarme ${a.fehlalarme}/${a.gewinne}`);
  }

  // Beste ODER-Kombination zweier Merkmale: beide Einzel-Schwellen werden
  // gemeinsam durchgefahren (grob: je Merkmal der eigene beste Punkt bei
  // halber Fehlalarm-Grenze, dann vereinigt).
  punkte.sort((a, b) => b.markierteVerluste - a.markierteVerluste);
  const [m1, m2] = punkte;
  if (m1 && m2) {
    const w1 = merkmale.find(([n]) => n === m1.merkmal)![1];
    const w2 = merkmale.find(([n]) => n === m2.merkmal)![1];
    const h1 = besterPunkt(zeilen.map((z) => ({ wert: w1(z), verlust: verlust(z) })), m1.merkmal, Math.floor(maxFA / 2));
    const h2 = besterPunkt(zeilen.map((z) => ({ wert: w2(z), verlust: verlust(z) })), m2.merkmal, Math.floor(maxFA / 2));
    const markiert = zeilen.filter((z) => w1(z) <= h1.schwelle || w2(z) <= h2.schwelle);
    const mv = markiert.filter(verlust).length;
    console.log('');
    console.log(`  ODER-Kombination ${m1.merkmal} <= ${h1.schwelle.toFixed(3)} | ${m2.merkmal} <= ${h2.schwelle.toFixed(3)}:`);
    console.log(`    markiert ${mv}/${nV} Verluste · Fehlalarme ${markiert.length - mv} · Ausloesequote ${Math.round((markiert.length / zeilen.length) * 100)} %`);
  }

  console.log('');
  console.log('  ACHTUNG: Schwellen sind auf DIESEM Satz eingestellt — vor einer');
  console.log('  Uebernahme auf dem anderen eingefrorenen Satz bestaetigen.');
  const bestes = punkte[0];
  console.log('');
  console.log(bestes.markierteVerluste >= 25
    ? `  VORHERSAGE ERFUELLT: ${bestes.markierteVerluste} >= 25 Verluste markiert (${bestes.merkmal}).`
    : `  VORHERSAGE NICHT ERFUELLT: bestes Merkmal markiert ${bestes.markierteVerluste} < 25 Verluste — C2 nach Architekten-Regel NICHT bauen.`);
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/unsicherheits-schalter.ts');
if (direktGestartet && process.argv.includes('--selbstprobe')) selbstprobe();
else if (direktGestartet) main();
