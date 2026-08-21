/**
 * interferenz-vergleich.ts — hebt die Varianten-Interferenz die Topfdecke?
 *
 * Die Decke ist die harte Grenze: was nicht in den Topf kommt, kann keine
 * Sortierung zurueckholen. Heute liegen dort 90 Prozent, 10 Fragen fallen
 * ganz durch.
 *
 * Gemessen wird deshalb ZUERST die Topfdeckung, nicht Platz 1. Eine
 * Vorauswahl-Aenderung, die die Decke nicht hebt, hat ihren Zweck verfehlt —
 * egal was sie mit den vorderen Plaetzen macht.
 *
 * Aufruf: npx tsx src/bench/interferenz-vergleich.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, quote, type Frage } from './auswertung.js';
import { varianten, ueberlagere, type Kandidat } from '../interferenz.js';

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
  const eingangsbestand = new Eingangsbestand();
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await eingangsbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);
  const bestaende = { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand };
  const frageVektor = (q: Frage): number[] | null => {
    const gepackt = v.fragen[q.query];
    return gepackt ? entpacke(gepackt) : null;
  };

  const alleThemen = [...seltenheitsbestand.themen()];

  /** Die Nominierung von heute, als Funktion — Grundlage fuer den Vergleich. */
  const heute = (fv: number[]): string[] => alleThemen
    .map((t) => ({ t, n: Math.max(vektorbestand.naehe(fv, t), namensbestand.naehe(fv, t)) }))
    .sort((x, y) => y.n - x.n)
    .slice(0, POOL)
    .map((x) => x.t);

  /** Die Interferenz-Nominierung mit K Varianten. */
  const interferenz = (k: number, staerke: number) => (fv: number[]): string[] => {
    const listen: Kandidat[][] = varianten(fv, k, staerke).map((variante) => alleThemen
      .map((t) => ({
        topic: t,
        naehe: Math.max(vektorbestand.naehe(variante, t), namensbestand.naehe(variante, t)),
      }))
      .sort((x, y) => y.naehe - x.naehe)
      .slice(0, POOL));
    return ueberlagere(listen, POOL);
  };

  const zeile = (name: string, m: { plaetze: number[] }): void => {
    const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(7);
    console.log(`  ${name.padEnd(22)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, 99999))}`);
  };

  console.log('\nVarianten-Interferenz in der Vorauswahl');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  ${'Bauform'.padEnd(22)}${'Platz 1'.padStart(7)}${'@3'.padStart(7)}${'Top10'.padStart(7)}${'Topf'.padStart(7)}`);

  const basis = await messe(redis, korpus.fragen, frageVektor, bestaende, { sinnNominierung: (fv) => heute(fv) });
  zeile('heute', basis);

  // Der Beweis, dass der Haken die Rechnung nicht verbiegt: dieselbe
  // Nominierung ueber den Haken muss dasselbe liefern wie ohne Haken.
  const ohneHaken = await messe(redis, korpus.fragen, frageVektor, bestaende, {});
  const gleich = basis.plaetze.every((p, i) => p === ohneHaken.plaetze[i]);
  console.log(`  ${gleich ? 'OK' : 'ACHTUNG'}: Haken liefert ${gleich ? 'identische' : 'ABWEICHENDE'} Ergebnisse wie der eingebaute Weg`);

  for (const k of [3, 5, 9]) {
    for (const s of [0.3, 0.5, 0.8]) {
      const m = await messe(redis, korpus.fragen, frageVektor, bestaende, { sinnNominierung: interferenz(k, s) });
      zeile(`K=${k} staerke=${s}`, m);
    }
  }

  // Was ist mit den zehn, die heute durchfallen?
  const durchgefallen = basis.plaetze
    .map((p, i) => ({ p, q: korpus.fragen.filter((f) => frageVektor(f))[i] }))
    .filter((x) => x.p === 0);
  console.log(`\n  Heute gar nicht im Topf: ${durchgefallen.length} Fragen`);
  const beste = await messe(redis, korpus.fragen, frageVektor, bestaende, { sinnNominierung: interferenz(5, 0.5) });
  const gerettet = durchgefallen.filter((x, i) => {
    const idx = basis.plaetze.findIndex((p, j) => p === 0 && j >= i);
    return idx >= 0 && beste.plaetze[idx] > 0;
  });
  console.log(`  Davon durch K=5/0.5 gerettet: ${gerettet.length}`);
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
