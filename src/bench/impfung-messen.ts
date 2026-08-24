/**
 * impfung-messen.ts — bringt eine Fragewolke die richtige Lektion nach vorn?
 *
 * ── Der Aufbau, und warum er so streng ist ──────────────────────────────────
 *
 * Geimpft sind 40 Lektionen: 20 ZIELE (von Sortierfehlern getroffen) und 20
 * ABLENKER (zufaellig gezogen, deterministisch). Beide Gruppen haben gleich
 * viele Fragen bekommen, von derselben Hand, mit derselben Sorgfalt.
 *
 * Ohne die Ablenker waere der Test wertlos: haetten NUR die richtigen
 * Antworten ein zusaetzliches Merkmal, wuerde es nicht Passung messen, sondern
 * Zugehoerigkeit zur Loesungsmenge. Das Ergebnis waere grossartig und leer.
 *
 * ── Was gemessen wird ───────────────────────────────────────────────────────
 *
 * Nur die Fragen, deren Ziel-Lektion geimpft ist. Die uebrigen 80 Fragen
 * koennen sich durch die Impfung hoechstens verschlechtern (durch Ablenker,
 * die aufsteigen) — auch das wird gezeigt, denn ein Merkmal, das anderen
 * schadet, ist kein Gewinn.
 *
 * Aufruf: npx tsx src/bench/impfung-messen.ts --vektoren <datei.json>
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, quote, type Frage } from './auswertung.js';
import { SINN_TOPF } from '../rangfolge-stellschrauben.js';

interface Korpus { lektionen: Array<{ topic: string }>; fragen: Frage[] }
interface Vektoren { fragen: Record<string, string>; eingaenge: Record<string, Record<string, string>> }

const POOL = SINN_TOPF;
const SCHWELLE = 0.5;
const GEWICHT = 0.2;

async function baue(vektorDatei: string, korpus: Korpus): Promise<{
  redis: unknown; bestaende: Parameters<typeof messe>[3]; fv: (q: Frage) => number[] | null;
  eingangsbestand: Eingangsbestand;
}> {
  const v = JSON.parse(readFileSync(vektorDatei, 'utf8')) as Vektoren;
  const redis = baueBestand(korpus as never, v as never);
  const vektorbestand = new Vektorbestand();
  const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
  const eingangsbestand = new Eingangsbestand();
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await eingangsbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);
  return {
    redis,
    bestaende: { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand },
    fv: (q: Frage): number[] | null => {
      const g = v.fragen[q.query];
      return g ? entpacke(g) : null;
    },
    eingangsbestand,
  };
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--vektoren');
  if (i === -1) { console.error('Aufruf: impfung-messen.ts --vektoren <datei.json>'); process.exit(2); }
  const geimpfteDatei = process.argv[i + 1];

  const hier = dirname(fileURLToPath(import.meta.url));
  const korpus = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus.json'), 'utf8')) as Korpus;
  const originalDatei = join(hier, 'korpus', 'korpus-vektoren.json');

  const original = await baue(originalDatei, korpus);
  const geimpft = await baue(geimpfteDatei, korpus);

  // Welche Lektionen sind NEU geimpft? Differenz der Eingaenge-Schluessel.
  const vOrig = JSON.parse(readFileSync(originalDatei, 'utf8')) as Vektoren;
  const vNeu = JSON.parse(readFileSync(geimpfteDatei, 'utf8')) as Vektoren;
  const neuGeimpft = new Set<string>();
  for (const [topic, tueren] of Object.entries(vNeu.eingaenge ?? {})) {
    const alt = Object.keys(vOrig.eingaenge?.[topic] ?? {});
    for (const frage of Object.keys(tueren)) {
      if (!alt.includes(frage)) { neuGeimpft.add(topic); break; }
    }
  }
  console.log(`\nNeu geimpfte Lektionen: ${neuGeimpft.size}`);

  const opt = (e: Eingangsbestand) => ({
    pool: POOL,
    zusatzMerkmal: {
      werte: (fv: number[], topic: string): number => {
        const n = e.besteNaehe(fv, topic);
        return n >= SCHWELLE ? n : -2;
      },
      gewicht: GEWICHT,
    },
  });

  const mitVektor = korpus.fragen.filter((q) => original.fv(q));
  const a = await messe(original.redis, mitVektor, original.fv, original.bestaende, opt(original.eingangsbestand));
  const b = await messe(geimpft.redis, mitVektor, geimpft.fv, geimpft.bestaende, opt(geimpft.eingangsbestand));

  // Aufteilen: Fragen, deren Ziel geimpft ist — und alle uebrigen.
  const betroffen: number[] = []; const betroffenNeu: number[] = [];
  const rest: number[] = []; const restNeu: number[] = [];
  for (const [idx, q] of mitVektor.entries()) {
    const trifftGeimpfte = q.relevant.some((t) => neuGeimpft.has(t));
    if (trifftGeimpfte) { betroffen.push(a.plaetze[idx]); betroffenNeu.push(b.plaetze[idx]); }
    else { rest.push(a.plaetze[idx]); restNeu.push(b.plaetze[idx]); }
  }

  const zeile = (name: string, vor: number[], nach: number[]): void => {
    // Eine leere Gruppe hat keine Quote. quote() liefert dafuer 0, und "0,0 %"
    // liest sich wie ein Totalausfall — dieselbe Fehlerklasse wie
    // klassifiziereDeckung, das bei 0 Lektionen 100 Prozent meldete. Bei einer
    // VOLLimpfung ist die Gruppe "uebrige" zwangslaeufig leer: das ist kein
    // Ergebnis, sondern die Abwesenheit einer Messung, und muss so dastehen.
    if (vor.length === 0) {
      console.log(`  ${name.padEnd(22)}nicht messbar — Gruppe ist leer`);
      return;
    }
    const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(8);
    const d = (v: number, n: number): string => {
      const diff = (n - v) * 100;
      return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`.padStart(7);
    };
    console.log(`  ${name.padEnd(22)}${p(quote(vor, 1))}${p(quote(nach, 1))}${d(quote(vor, 1), quote(nach, 1))}   |`
      + `${p(quote(vor, 3))}${p(quote(nach, 3))}${d(quote(vor, 3), quote(nach, 3))}`);
  };

  console.log('\nImpfung — vorher gegen nachher');
  console.log('──────────────────────────────────────────────────────────────────────────────');
  console.log(`  ${''.padEnd(22)}${'Platz1 vor'.padStart(8)}${'nach'.padStart(8)}${'Diff'.padStart(7)}   |${'@3 vor'.padStart(8)}${'nach'.padStart(8)}${'Diff'.padStart(7)}`);
  zeile(`betroffen (${betroffen.length})`, betroffen, betroffenNeu);
  zeile(`uebrige (${rest.length})`, rest, restNeu);
  zeile(`alle (${mitVektor.length})`, a.plaetze, b.plaetze);

  // Je-Frage-Bilanz auf den betroffenen Fragen: die ehrlichste Zahl.
  const rang = (p: number): number => (p === 0 ? Number.POSITIVE_INFINITY : p);
  let besser = 0; let schlechter = 0;
  for (const [k, vor] of betroffen.entries()) {
    if (rang(betroffenNeu[k]) < rang(vor)) besser++;
    else if (rang(betroffenNeu[k]) > rang(vor)) schlechter++;
  }
  console.log(`\n  Je Frage (betroffen): besser ${besser} · schlechter ${schlechter} · gleich ${betroffen.length - besser - schlechter}`);

  if (rest.length === 0) {
    console.log('  Je Frage (uebrige):   nicht messbar — keine Frage ausserhalb der geimpften Menge');
    console.log('\n  VOLLIMPFUNG: es gibt keine ungeimpfte Vergleichsgruppe mehr. Genau das ist der');
    console.log('  Zweck — der Nachteil aus spreizeImTopf (fehlender Wert = Null) kann nicht mehr');
    console.log('  entstehen, weil keine Lektion ohne Wolke uebrig ist. Massgeblich ist die Zeile');
    console.log('  "alle": sie vergleicht denselben Fragensatz vor und nach der Impfung.');
  } else {
    let rBesser = 0; let rSchlechter = 0;
    for (const [k, vor] of rest.entries()) {
      if (rang(restNeu[k]) < rang(vor)) rBesser++;
      else if (rang(restNeu[k]) > rang(vor)) rSchlechter++;
    }
    console.log(`  Je Frage (uebrige):   besser ${rBesser} · schlechter ${rSchlechter} · gleich ${rest.length - rBesser - rSchlechter}`);
    console.log('\n  Die uebrigen duerfen sich NICHT verschlechtern — sonst schaden die Ablenker mehr,');
    console.log('  als die Ziele nutzen, und das Merkmal ist netto negativ.');
  }
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
