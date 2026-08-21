/**
 * topfgroesse.ts — was kostet und was bringt ein groesserer Topf?
 *
 * ── Der Anlass ──────────────────────────────────────────────────────────────
 *
 * Am 20.08.2026 wurde eine Decke von 84 (spaeter 90) Prozent gemessen und als
 * feste Groesse behandelt: "kein Sortierer kommt darueber". Die Diagnose vom
 * 21.08. (warum-durchgefallen.ts) zeigt, dass das keine Naturkonstante ist,
 * sondern eine Folge von POOL = 25:
 *
 *   Bedeutungs-Topf   Fragen mit Antwort darin
 *   Top  25                  77
 *   Top  50                  85
 *   Top 100                  89
 *   Top 200                  96
 *
 * Die Decke war ein Parameter, kein Naturgesetz.
 *
 * ── Warum das nicht einfach "hochdrehen" heisst ─────────────────────────────
 *
 * Ein groesserer Topf gibt der Sortierung mehr Kandidaten — und mehr
 * Gelegenheiten, den richtigen zu verfehlen. Schon heute ist die Sortierung
 * das groessere Problem: von 90 Antworten im Topf landen nur 51 in den Top 3.
 * Ein Topf, der die Decke hebt und dabei Platz 1 senkt, ist kein Gewinn.
 *
 * Deshalb misst diese Datei BEIDE Enden je Groesse — Decke und Platz 1 — und
 * dazu die Rechenzeit, denn der Topf wird bei jeder Anfrage sortiert.
 *
 * Aufruf: npx tsx src/bench/topfgroesse.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, quote, type Frage } from './auswertung.js';

interface Korpus { lektionen: unknown[]; fragen: Frage[] }
interface Vektoren { fragen: Record<string, string>; eingaenge: Record<string, Record<string, string>> }

async function main(): Promise<void> {
  const hier = dirname(fileURLToPath(import.meta.url));
  const korpus = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus.json'), 'utf8')) as Korpus;
  const v = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus-vektoren.json'), 'utf8')) as Vektoren;

  const redis = baueBestand(korpus as never, v as never);
  const vektorbestand = new Vektorbestand();
  const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
  const eingangsbestand = new Eingangsbestand();
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await eingangsbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);
  const bestaende = { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand };
  const frageVektor = (q: Frage): number[] | null => {
    const g = v.fragen[q.query];
    return g ? entpacke(g) : null;
  };

  console.log('\nTopfgroesse — Decke gegen Genauigkeit');
  console.log('──────────────────────────────────────────────────────────────────');
  console.log(`  ${'POOL'.padStart(5)}${'Platz 1'.padStart(9)}${'@3'.padStart(8)}${'Top10'.padStart(8)}${'Topf'.padStart(8)}${'ms/Frage'.padStart(10)}`);

  for (const pool of [25, 40, 50, 75, 100, 150]) {
    const t0 = Date.now();
    const m = await messe(redis, korpus.fragen, frageVektor, bestaende, { pool });
    const ms = (Date.now() - t0) / korpus.fragen.length;
    const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(8);
    console.log(`  ${String(pool).padStart(5)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, 99999))}${ms.toFixed(1).padStart(10)}`);
  }

  console.log('\n  Lesart: die Topf-Spalte ist die Decke — was hier fehlt, kann keine');
  console.log('  Sortierung zurueckholen. Die Platz-1-Spalte ist der Preis dafuer.');
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
