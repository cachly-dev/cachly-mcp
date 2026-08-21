/**
 * fusion-vergleich.ts — Summe gegen Produkt: verlangt Stimmigkeit mehr als Masse?
 *
 * ── Die Frage ───────────────────────────────────────────────────────────────
 *
 * Die Sortierung ist seit dem Topf-Umbau der Engpass: 97 von 100 Antworten
 * liegen im Topf, aber nur 55 kommen in die Top 3. Die heutige Formel ist
 * eine SUMME — ein Kandidat kann totale Schwaeche in einem Merkmal mit
 * Staerke in einem anderen voll ausgleichen. Die Vermutung: genau solche
 * einseitigen Blender verdraengen die richtigen Antworten.
 *
 * Das kinetische Korrekturlesen (Hopfield 1974) sagt: Trennschaerfe entsteht
 * durch eine KETTE von Pruefungen, deren Ergebnisse sich multiplizieren.
 * bewerteTopfStreng bildet das nach; `basis` stellt die Strenge ein (gross =
 * fast Summe, klein = eine Null ist toedlich).
 *
 * ── Lehren aus den letzten Experimenten, hier eingebaut ─────────────────────
 *
 * 1. Fehlende Werte duerfen nicht bestraft werden (spreizeImTopf-Fund) — die
 *    Spreizung laeuft VOR dem Logarithmus, fehlend bleibt 0 im Band [0,1].
 *    Bei kleiner Basis ist eine 0 hart — das ist hier ABSICHT und der ganze
 *    Inhalt der Hypothese. Faellt sie durch, steht es hier.
 * 2. Ein Gewinn braucht BREITE ueber den Parameter (schwelle-abtasten-Lehre):
 *    gemessen wird eine Basis-Reihe, nicht ein Einzelwert.
 * 3. Je-Frage-Bilanz statt Kopfzahl (tueren-vergleich-Lehre).
 *
 * ── ERGEBNIS (21.08.2026): STRENGE VERLIERT, UND ZWAR MONOTON ──────────────
 *
 *   Bauform            Platz 1    @3     Top 10
 *   Summe (heute)       40,0    55,0     72,0
 *   Produkt basis=1     41,0    56,0     69,0   <- +1/+1, aber -3 auf Top 10
 *   Produkt basis=0,5   38,0    54,0     70,0
 *   Produkt basis=0,3   38,0    52,0     68,0
 *   Produkt basis=0,15  35,0    50,0     68,0
 *   Produkt basis=0,05  34,0    47,0     61,0
 *
 * Nur basis=1 gewinnt, hauchduenn und ohne Breite (0,5 verliert schon) — nach
 * der schwelle-abtasten-Regel ist das kein Umbau-Grund. Der monotone Abfall
 * ist der eigentliche Befund: unsere Merkmale sind KEINE unabhaengigen
 * Pruefschritte desselben Signals (dann wuerde Multiplizieren schaerfen),
 * sondern KOMPLEMENTAERE SINNE — jedes faengt Faelle, die die anderen nicht
 * sehen. Wer Sinne multipliziert, bestraft den legitimen Einzelfund.
 *
 * Konsequenz fuer die naechsten Ideen: nicht mehr Strenge, sondern klügere
 * Wägung — Merkmale je Frage nach ihrer Trennschaerfe gewichten (optimale
 * Reizkombination, Ernst & Banks 2002) oder die UNEINIGKEIT der Kanaele
 * selbst als Information nutzen (Schallortung der Schleiereule).
 *
 * Aufruf: npx tsx src/bench/fusion-vergleich.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, quote, type Frage, type Messung } from './auswertung.js';

interface Korpus { lektionen: unknown[]; fragen: Frage[] }
interface Vektoren { fragen: Record<string, string>; eingaenge: Record<string, Record<string, string>> }

const POOL = 75;
const EINGANG_SCHWELLE = 0.5;

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
  const fvVon = (q: Frage): number[] | null => {
    const g = v.fragen[q.query];
    return g ? entpacke(g) : null;
  };

  // Beide Bauformen bekommen dasselbe Tueren-Merkmal wie die Produktion —
  // verglichen wird NUR die Fusion, nicht zwei Dinge auf einmal.
  const produktion = {
    pool: POOL,
    zusatzMerkmal: {
      werte: (fv: number[], topic: string): number => {
        const n = eingangsbestand.besteNaehe(fv, topic);
        return n >= EINGANG_SCHWELLE ? n : -2;
      },
      gewicht: 0.2,
    },
  };

  const zeile = (name: string, m: Messung): void => {
    const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(8);
    console.log(`  ${name.padEnd(18)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, 99999))}`);
  };

  console.log('\nFusion — Summe gegen Produkt (kinetisches Korrekturlesen)');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  ${'Bauform'.padEnd(18)}${'Platz 1'.padStart(8)}${'@3'.padStart(8)}${'Top10'.padStart(8)}${'Topf'.padStart(8)}`);

  const summe = await messe(redis, korpus.fragen, fvVon, bestaende, produktion);
  zeile('Summe (heute)', summe);

  let besteBasis = 0;
  let bestes: Messung | null = null;
  for (const basis of [1.0, 0.5, 0.3, 0.15, 0.05]) {
    const m = await messe(redis, korpus.fragen, fvVon, bestaende, { ...produktion, fusion: { basis } });
    zeile(`Produkt basis=${basis}`, m);
    if (!bestes || quote(m.plaetze, 3) > quote(bestes.plaetze, 3)) { bestes = m; besteBasis = basis; }
  }

  // Je-Frage-Bilanz der besten Produkt-Variante gegen die Summe.
  if (bestes) {
    const rang = (p: number): number => (p === 0 ? Number.POSITIVE_INFINITY : p);
    let besser = 0; let schlechter = 0;
    for (const [i, p] of bestes.plaetze.entries()) {
      if (rang(p) < rang(summe.plaetze[i])) besser++;
      else if (rang(p) > rang(summe.plaetze[i])) schlechter++;
    }
    console.log(`\n  Beste Produkt-Variante (basis=${besteBasis}) je Frage gegen die Summe:`);
    console.log(`  besser ${besser} · schlechter ${schlechter} · unveraendert ${bestes.plaetze.length - besser - schlechter}`);
  }
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
