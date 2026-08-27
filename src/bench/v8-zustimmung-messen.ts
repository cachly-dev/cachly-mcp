/**
 * ══ V8 nachgebaut: bei Unsicherheit Zaehlungen statt Punktzahlen ═══════════
 *
 * ── Woher die Idee kommt ──────────────────────────────────────────────────
 *
 * Naturworkshop 2 (23.08.2026), Vorbild V8 "Schwellenschaltung", als
 * tragfaehig bewertet (vorbilder.md:199-213). Mechanik woertlich:
 *
 *   "zaehleZustimmung(listen, tiefe=20), aufgerufen NUR, wenn die hoechste
 *    Punktzahl unter 2,453 liegt. Vier Ranglisten ueber den Topf; wer in
 *    mindestens 3 unter den ersten 20 steht, wandert vor alle anderen,
 *    untereinander in bisheriger Reihenfolge. Punktzahlen werden nicht mehr
 *    verglichen, sondern nur noch Zaehlungen."
 *
 * Der Gedanke dahinter: bei einer unsicheren Frage ist die Punktsumme
 * Rauschen — aber wenn VIER verschiedene Sichten (Text, Rueckkopplung,
 * Seltenheit, Tuer) unabhaengig dieselbe Lektion vorne sehen, ist das ein
 * Quorum, kein Zufall. Der Workshop mass +4 Punkte auf der vagen Gruppe,
 * die praezise Gruppe fiel keinen Punkt.
 *
 * ── Was hier ANNAHME ist ──────────────────────────────────────────────────
 *
 * Welche vier Listen der Workshop benutzte, steht dort nicht. Hier sind es
 * die vier Merkmale des Auszugs: nT (Text), nR (Rueckkopplung), sD
 * (Seltenheit), bE (beste Tuer) — je absteigend sortiert. Weicht das vom
 * Workshop ab, misst dieses Skript eine VERWANDTE Mechanik, nicht dieselbe;
 * das Urteil gilt dann fuer diese Fassung.
 *
 * Die 2,453 wird hier ausnahmsweise DOCH mitgeprueft: Stufe A hat gezeigt,
 * dass sie exakt das 0,55-Quantil unserer Punkteskala ist — die Skalen
 * stimmen also ueberein. Abgetastet wird trotzdem breiter.
 *
 * Aufruf:
 *   npx tsx src/bench/v8-zustimmung-messen.ts --merkmale <datei.jsonl>
 *   npx tsx src/bench/v8-zustimmung-messen.ts --selbstprobe
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { punktzahl } from './beleg-kaskade-messen.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; art: string; relevant: string[]; topf: Kandidat[] };

const TIEFE = 20;
const QUORUM = 3;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const proz = (x: number) => `${(x * 100).toFixed(1)} %`;

/**
 * Wer steht in mindestens QUORUM der vier Sichten unter den ersten TIEFE?
 *
 * Rueckgabe: Indexmenge der Kandidaten mit Quorum. Gleichstaende innerhalb
 * einer Sicht werden durch die stabile Sortierung entschieden — dieselbe
 * Willkuer fuer alle Kandidaten, also fair.
 */
export function zustimmung(topf: Kandidat[]): Set<number> {
  const sichten: Array<(k: Kandidat) => number> = [
    (k) => k.nT, (k) => k.nR, (k) => k.sD, (k) => k.bE,
  ];
  const stimmen = new Array<number>(topf.length).fill(0);
  for (const sicht of sichten) {
    const reihen = topf
      .map((k, i) => ({ i, w: sicht(k) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, TIEFE);
    for (const r of reihen) stimmen[r.i]++;
  }
  const drin = new Set<number>();
  stimmen.forEach((s, i) => { if (s >= QUORUM) drin.add(i); });
  return drin;
}

/** Rangfolge: Quorum-Kandidaten nach vorn, Reihenfolge sonst unveraendert. */
export function ordneMitZustimmung(topf: Kandidat[], punkte: number[]): string[] {
  const drin = zustimmung(topf);
  const rang = topf
    .map((k, i) => ({ t: k.t, p: punkte[i], vorn: drin.has(i) ? 0 : 1 }))
    .sort((a, b) => a.vorn - b.vorn || b.p - a.p);
  return rang.map((r) => r.t);
}

function platzVon(rangfolge: string[], relevant: string[]): number {
  const gold = new Set(relevant);
  for (let i = 0; i < rangfolge.length; i++) if (gold.has(rangfolge[i])) return i + 1;
  return 0;
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  // 25 Fuellkandidaten, damit TIEFE=20 ueberhaupt trennt: der Zielkandidat
  // steht in drei Sichten VORNE, aber seine Punktsumme ist klein.
  const fuller: Kandidat[] = Array.from({ length: 24 }, (_, i) => ({
    t: `fuller-${i}`, nT: 0.5 + i * 0.01, nTh: 0, nR: 0.01, sD: 0.01, bE: 0.01,
  }));
  const ziel: Kandidat = { t: 'ziel', nT: 0.4, nTh: 0, nR: 0.9, sD: 0.9, bE: 0.9 };
  const topf = [...fuller, ziel];
  const punkte = punktzahl(topf);

  const drin = zustimmung(topf);
  p('der Zielkandidat hat das Quorum', drin.has(topf.length - 1));
  const rang = ordneMitZustimmung(topf, punkte);
  p('das Quorum stellt ihn nach vorn', rang.indexOf('ziel') < 3);

  // Gegenprobe: hat NIEMAND ein Quorum ueber die Fueller hinaus, aendert
  // sich die Reihenfolge nicht gegenueber der reinen Punktsumme.
  const gleichfoermig: Kandidat[] = Array.from({ length: 25 }, (_, i) => ({
    t: `k-${i}`, nT: 0.9 - i * 0.01, nTh: 0, nR: 0.8 - i * 0.01, sD: 0.7 - i * 0.01, bE: 0.6 - i * 0.01,
  }));
  const p2 = punktzahl(gleichfoermig);
  const nurPunkte = gleichfoermig
    .map((k, i) => ({ t: k.t, p: p2[i] })).sort((a, b) => b.p - a.p).map((r) => r.t);
  const mitQuorum = ordneMitZustimmung(gleichfoermig, p2);
  p('gleichfoermige Sichten: Reihenfolge unveraendert',
    JSON.stringify(nurPunkte.slice(0, 5)) === JSON.stringify(mitQuorum.slice(0, 5)));

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes('--selbstprobe')) selbstprobe();

  const pfad = flag('merkmale');
  if (!pfad) {
    console.error('NICHT GEMESSEN: --merkmale <datei.jsonl> ist Pflicht.');
    process.exit(2);
  }
  const zeilen: Zeile[] = [];
  const leser = createInterface({ input: createReadStream(resolve(pfad)), crlfDelay: Infinity });
  for await (const z of leser) {
    if (z.trim()) zeilen.push(JSON.parse(z) as Zeile);
  }
  if (zeilen.length < 100) {
    console.error(`NICHT GEMESSEN: nur ${zeilen.length} Zeilen.`);
    process.exit(3);
  }
  const mittlererTopf = zeilen.reduce((s, z) => s + z.topf.length, 0) / zeilen.length;
  if (mittlererTopf < 60) {
    console.error(`NICHT GEMESSEN: mittlere Topfgroesse ${mittlererTopf.toFixed(0)} — Pool-25-Welt.`);
    process.exit(4);
  }

  // Vorrechnen: Punkte, heutiger Platz, Platz mit Zustimmung — einmal je Frage.
  const faelle = zeilen.map((z) => {
    const punkte = punktzahl(z.topf);
    const rangHeute = z.topf
      .map((k, i) => ({ t: k.t, p: punkte[i] })).sort((a, b) => b.p - a.p).map((r) => r.t);
    return {
      art: z.art || 'ohne',
      best: Math.max(...punkte),
      heute: platzVon(rangHeute, z.relevant),
      mitV8: platzVon(ordneMitZustimmung(z.topf, punkte), z.relevant),
    };
  });
  const n = faelle.length;
  const at3 = (xs: typeof faelle, f: (x: (typeof faelle)[0]) => number) =>
    xs.filter((x) => f(x) >= 1 && f(x) <= 3).length;

  console.log('');
  console.log('⚖️  V8-Zustimmung — Zaehlen statt Punkten, nur bei Unsicherheit');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${n} Fragen · Topf ${mittlererTopf.toFixed(0)} · Tiefe ${TIEFE} · Quorum ${QUORUM} von 4 Sichten`);
  console.log(`  heute: @3 ${proz(at3(faelle, (x) => x.heute) / n)}`);
  console.log('');
  console.log('  Schwelle   loest aus   @3 gesamt   @3 ausgeloest (heute -> V8)');
  for (const s of [2.271, 2.337, 2.393, 2.453, 2.51]) {
    const ausg = faelle.filter((x) => x.best < s);
    const ruhig = faelle.filter((x) => x.best >= s);
    const gesamt = (at3(ruhig, (x) => x.heute) + at3(ausg, (x) => x.mitV8)) / n;
    console.log(
      `   ${s.toFixed(3)}    ${proz(ausg.length / n).padStart(7)}   ${proz(gesamt).padStart(7)}      `
      + `${proz(ausg.length ? at3(ausg, (x) => x.heute) / ausg.length : 0)} -> ${proz(ausg.length ? at3(ausg, (x) => x.mitV8) / ausg.length : 0)}`,
    );
  }

  // Je Frageart, an der Workshop-Schwelle.
  const S = 2.453;
  console.log('');
  console.log(`  Nach Frageart (@3 gesamt, Schwelle ${S}):`);
  const arten = [...new Set(faelle.map((x) => x.art))].sort();
  for (const art of arten) {
    const xs = faelle.filter((x) => x.art === art);
    const heute = at3(xs, (x) => x.heute) / xs.length;
    const v8 = (at3(xs.filter((x) => x.best >= S), (x) => x.heute)
      + at3(xs.filter((x) => x.best < S), (x) => x.mitV8)) / xs.length;
    console.log(`    ${art.padEnd(14)} ${proz(heute).padStart(7)} -> ${proz(v8).padStart(7)}   (${xs.length} Fragen)`);
  }
  console.log('');
  console.log('  Annahme dieser Fassung: die vier Sichten sind nT/nR/sD/bE. Welche');
  console.log('  der Workshop benutzte, ist dort nicht dokumentiert.');
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('v8-zustimmung-messen.ts');
if (direktGestartet) {
  main().catch((e: unknown) => {
    console.error('NICHT GEMESSEN:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
