/**
 * topfschnitt-adaptiv.ts — misst Naturworkshop-Kandidat v5.
 *
 * ── Der Kandidat ────────────────────────────────────────────────────────────
 *
 * Vorbild "Tragfaehigkeit eines Lebensraums" (Lauf 21.08.2026, Ausgang
 * `tragfaehig`, seither ungemessen):
 *
 *   Bestimme die Zahl der Kandidaten JE FRAGE aus dem groessten Abfall
 *   zwischen aufeinanderfolgenden Naehewerten, statt sie fest auf 25 zu
 *   setzen.
 *
 *   Widerlegung, vom Workshop selbst festgelegt: die Decke faellt unter
 *   95 Prozent, ODER die Findequote@3 steigt um weniger als 2 Punkte.
 *
 * ── Der Einwand, der schon im Workshop stand ────────────────────────────────
 *
 * Die Decke wird AM Topf gemessen. Ein kleinerer Topf senkt sie fast
 * zwangslaeufig. Die Frage ist nicht, ob sie faellt, sondern ob die Sortierung
 * mehr gewinnt, als die Decke verliert. Deshalb misst diese Datei beide Enden
 * nebeneinander — und zaehlt zusaetzlich FRAGEN statt nur Prozentpunkte:
 * 25:5 ist Bewegung, 21:27 ist Wackeln, bei denselben "4 Punkten".
 *
 * ── Warum ein Mindest- und ein Hoechstwert ──────────────────────────────────
 *
 * Ohne Untergrenze schneidet ein steiler erster Abfall den Topf auf 1 bis 2
 * Kandidaten — dann ist die Findequote@3 gar nicht mehr erreichbar, und die
 * Messung misst eine Bauart, die niemand ausliefern wuerde. Ohne Obergrenze
 * waere es kein Schnitt, sondern nur eine teurere Art, POOL zu sagen.
 *
 * Aufruf:
 *   npx tsx src/bench/topfschnitt-adaptiv.ts [--korpus <k.json>] [--vektoren <v.json>]
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

/**
 * Der Schnitt am groessten Abfall.
 *
 * `sortiert` ist absteigend nach Naehe. Gesucht ist die Stelle, an der die
 * Werte am staerksten einbrechen — dort endet der "Lebensraum".
 *
 * Der Schnitt wird NUR zwischen `min` und `max` gesucht: davor ist die Kante
 * fast immer nach dem ersten Treffer (jede Frage haette dann einen Kandidaten),
 * danach traegt er nichts mehr bei.
 */
export function schnittAmGroesstenAbfall(
  sortiert: readonly number[],
  min: number,
  max: number,
): number {
  const obergrenze = Math.min(max, sortiert.length);
  if (obergrenze <= min) return obergrenze;
  let besteStelle = obergrenze;
  let groessterAbfall = -Infinity;
  for (let i = min; i < obergrenze; i++) {
    const abfall = sortiert[i - 1] - sortiert[i];
    if (abfall > groessterAbfall) {
      groessterAbfall = abfall;
      besteStelle = i;
    }
  }
  return besteStelle;
}

async function main(): Promise<void> {
  const hier = dirname(fileURLToPath(import.meta.url));
  const ki = process.argv.indexOf('--korpus');
  const kDatei = ki > -1 ? process.argv[ki + 1] : join(hier, 'korpus', 'korpus.json');
  const vi = process.argv.indexOf('--vektoren');
  const vDatei = vi > -1 ? process.argv[vi + 1] : join(hier, 'korpus', 'korpus-vektoren.json');

  const korpus = JSON.parse(readFileSync(kDatei, 'utf8')) as Korpus;
  const v = JSON.parse(readFileSync(vDatei, 'utf8')) as Vektoren;
  console.log(`\n  Korpus:   ${kDatei}`);
  console.log(`  Vektoren: ${vDatei}`);
  console.log(`  Fragen:   ${korpus.fragen.length}`);

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

  /** Wie viele Kandidaten der Schnitt je Frage uebrig laesst — fuer die Mittelwerte. */
  const groessen: number[] = [];

  const nominiereAdaptiv = (min: number, max: number) => (fv: number[]): string[] => {
    const bewertet = [...seltenheitsbestand.themen()]
      .map((t) => ({
        t,
        n: Math.max(vektorbestand.naehe(fv, t), namensbestand.naehe(fv, t)),
      }))
      .sort((x, y) => y.n - x.n);
    const werte = bewertet.map((x) => x.n);
    const stelle = schnittAmGroesstenAbfall(werte, min, max);
    groessen.push(stelle);
    return bewertet.slice(0, stelle).map((x) => x.t);
  };

  const zeile = (name: string, m: Awaited<ReturnType<typeof messe>>, topfMittel: string): void => {
    const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(8);
    console.log(
      `  ${name.padEnd(22)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, 99999))}${topfMittel.padStart(10)}`,
    );
  };

  console.log('\n  Adaptiver Topfschnitt gegen feste Topfgroesse');
  console.log('  ──────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Variante'.padEnd(22)}${'Platz 1'.padStart(8)}${'@3'.padStart(8)}${'Top10'.padStart(8)}${'Decke'.padStart(8)}${'Topf ⌀'.padStart(10)}`);

  // Grundlinien: feste Toepfe. Ohne sie ist jede Zahl unten eine Behauptung.
  const grundlinien: Record<number, number[]> = {};
  for (const pool of [25, 50, 75]) {
    const m = await messe(redis, korpus.fragen, frageVektor, bestaende, { pool });
    grundlinien[pool] = m.plaetze;
    zeile(`fest ${pool}`, m, String(pool));
  }

  // Der Kandidat, in drei Zuschnitten.
  for (const [min, max] of [[3, 25], [5, 50], [10, 75]] as const) {
    groessen.length = 0;
    const m = await messe(redis, korpus.fragen, frageVektor, bestaende, {
      pool: max,
      sinnNominierung: nominiereAdaptiv(min, max),
    });
    const mittel = groessen.length ? (groessen.reduce((a, b) => a + b, 0) / groessen.length).toFixed(1) : '—';
    zeile(`adaptiv ${min}-${max}`, m, mittel);

    /*
     * FRAGEN zaehlen, nicht nur Prozentpunkte (Regel vom 22.08.2026).
     *
     * ACHTUNG, hier stand ein Fehler und er kostete den ersten Messlauf:
     * "nicht gefunden" ist PLATZ 0 (bestePlatzierung, auswertung.ts:59), und
     * 0 <= 3 ist wahr. Die erste Fassung zaehlte damit jede Frage, deren
     * Antwort im kleineren Topf GAR NICHT mehr vorkam, als "besser" — und
     * meldete "15 besser, 1 schlechter" bei gleichzeitig FALLENDER Quote.
     * Dieselbe Fehlerklasse wie spreizeImTopf mit seiner Null und
     * klassifiziereDeckung mit seinen hundert Prozent: der fehlende dritte
     * Zustand. Deshalb ueberall `> 0` mitpruefen, genau wie quote() es tut.
     */
    const basis = grundlinien[max];
    const drin = (p: number): boolean => p > 0 && p <= 3;
    let besser = 0; let schlechter = 0; let verloren = 0;
    m.plaetze.forEach((platz, i) => {
      const alt = basis[i];
      if (drin(platz) && !drin(alt)) besser++;
      if (!drin(platz) && drin(alt)) schlechter++;
      // Ganz aus dem Topf gefallen: die Sortierung kann sie nicht mehr holen.
      if (platz === 0 && alt > 0) verloren++;
    });
    console.log(
      `  ${''.padEnd(22)}gegen fest ${max}: ${besser} Fragen besser, ${schlechter} schlechter (@3), `
      + `${verloren} ganz aus dem Topf`,
    );
  }

  console.log('\n  Lesart: "Decke" ist, was ueberhaupt im Topf liegt — was hier fehlt, kann');
  console.log('  keine Sortierung zurueckholen. Die Widerlegung des Workshops lautete:');
  console.log('  Decke unter 95 % ODER @3 steigt um weniger als 2 Punkte.');
}

const direkt = process.argv[1]?.replace(/\\/g, '/').endsWith('/topfschnitt-adaptiv.ts');
if (direkt) main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
