/**
 * warum-durchgefallen.ts — die Diagnose vor der naechsten Idee.
 *
 * Zehn von hundert Fragen kommen gar nicht in den Topf. Bevor irgendjemand
 * eine bessere Vorauswahl baut, muss feststehen, WARUM sie durchfallen.
 * Es gibt drei sehr verschiedene Gruende, und sie verlangen drei verschiedene
 * Loesungen:
 *
 *   A) knapp verfehlt   — die richtige Lektion liegt auf Platz 26-60 der
 *                         Bedeutungsliste. Dann hilft ein groesserer Topf
 *                         oder eine leichte Streuung.
 *   B) weit weg         — sie liegt auf Platz 200+. Dann ist die Frage
 *                         semantisch nicht in der Naehe der Lektion, und
 *                         KEINE Vektorrechnung holt sie. Nur ein anderer
 *                         Kanal (Nutzung, frueher gestellte Fragen) kann das.
 *   C) gar kein Vektor  — die Lektion ist im Bestand nicht eingebettet.
 *                         Dann ist es ein Datenproblem, kein Suchproblem.
 *
 * Diese Datei zaehlt nach, statt zu raten.
 *
 * Ausserdem: wie stark streuen die Vektorraum-Varianten ueberhaupt? Wenn
 * Variante 0 und Variante 3 zu 0,99 aehnlich sind, kann Interferenz nichts
 * bewirken — dann war die Umsetzung schwach, nicht die Idee.
 *
 * Aufruf: npx tsx src/bench/warum-durchgefallen.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke, kosinus } from '../bedeutung.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import type { Frage } from './auswertung.js';
import { varianten } from '../interferenz.js';

interface Korpus { lektionen: unknown[]; fragen: Frage[] }
interface Vektoren { fragen: Record<string, string>; eingaenge: Record<string, Record<string, string>> }

const POOL = 25;

async function main(): Promise<void> {
  const hier = dirname(fileURLToPath(import.meta.url));
  const korpus = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus.json'), 'utf8')) as Korpus;
  const v = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus-vektoren.json'), 'utf8')) as Vektoren;

  const redis = baueBestand(korpus as never, v as never);
  const vektorbestand = new Vektorbestand();
  const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);

  const alleThemen = [...seltenheitsbestand.themen()];
  const fv = (q: Frage): number[] | null => {
    const g = v.fragen[q.query];
    return g ? entpacke(g) : null;
  };

  // ── Teil 1: wie stark streuen die Varianten? ──────────────────────────────
  console.log('\nTeil 1 — Streuen die Vektorraum-Varianten ueberhaupt?');
  console.log('─────────────────────────────────────────────────────');
  const probe = fv(korpus.fragen.find((q) => fv(q))!)!;
  for (const s of [0.3, 0.5, 0.8]) {
    const vs = varianten(probe, 5, s);
    const naehen = vs.slice(1).map((x) => kosinus(probe, x).toFixed(4));
    console.log(`  staerke=${s}: Kosinus Variante 0 zu 1..4 = ${naehen.join('  ')}`);
  }
  console.log('  (1,0000 = identisch. Alles ueber ~0,97 kann die Rangfolge kaum bewegen.)');

  // ── Teil 2: warum fallen Fragen durch? ────────────────────────────────────
  console.log('\nTeil 2 — Warum kommen Fragen nicht in den Topf?');
  console.log('─────────────────────────────────────────────────────');

  let knapp = 0; let weitWeg = 0; let ohneVektor = 0; let drin = 0;
  const beispiele: string[] = [];

  for (const q of korpus.fragen) {
    const f = fv(q);
    if (!f) continue;
    // Volle Bedeutungs-Rangfolge ueber ALLE Themen, nicht nur Top 25.
    const rang = alleThemen
      .map((t) => ({ t, n: Math.max(vektorbestand.naehe(f, t), namensbestand.naehe(f, t)) }))
      .sort((x, y) => y.n - x.n)
      .map((x) => x.t);

    const platzDerBesten = Math.min(...q.relevant
      .map((r) => rang.indexOf(r))
      .filter((i) => i >= 0)
      .concat([Number.POSITIVE_INFINITY]));

    const hatVektor = q.relevant.some((r) => vektorbestand.rohvektor(r) !== null);

    if (!hatVektor) { ohneVektor++; beispiele.push(`  [kein Vektor]  ${q.query.slice(0, 62)}`); continue; }
    if (platzDerBesten < POOL) { drin++; continue; }
    if (platzDerBesten < 100) { knapp++; beispiele.push(`  [Platz ${String(platzDerBesten + 1).padStart(3)}]    ${q.query.slice(0, 62)}`); continue; }
    weitWeg++;
    beispiele.push(`  [Platz ${platzDerBesten === Number.POSITIVE_INFINITY ? '???' : String(platzDerBesten + 1).padStart(3)}]    ${q.query.slice(0, 62)}`);
  }

  console.log(`  in den Top ${POOL} der Bedeutung:        ${drin}`);
  console.log(`  knapp verfehlt (Platz ${POOL + 1}-100):     ${knapp}   -> groesserer Topf / Streuung hilft`);
  console.log(`  weit weg (Platz 100+):              ${weitWeg}   -> nur ein ANDERER Kanal hilft`);
  console.log(`  Lektion hat gar keinen Vektor:      ${ohneVektor}   -> Datenproblem`);
  console.log('\n  Die Verfehlten im Einzelnen:');
  for (const b of beispiele.slice(0, 30)) console.log(b);

  // ── Teil 3: was wuerde ein groesserer Topf bringen? ───────────────────────
  console.log('\nTeil 3 — Was bringt ein groesserer Topf?');
  console.log('─────────────────────────────────────────────────────');
  for (const p of [25, 50, 100, 200]) {
    let gefunden = 0;
    for (const q of korpus.fragen) {
      const f = fv(q);
      if (!f) continue;
      const rang = alleThemen
        .map((t) => ({ t, n: Math.max(vektorbestand.naehe(f, t), namensbestand.naehe(f, t)) }))
        .sort((x, y) => y.n - x.n)
        .slice(0, p)
        .map((x) => x.t);
      if (q.relevant.some((r) => rang.includes(r))) gefunden++;
    }
    console.log(`  Top ${String(p).padStart(3)}: ${gefunden} von 100 Fragen haetten ihre Antwort im Bedeutungs-Topf`);
  }
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
