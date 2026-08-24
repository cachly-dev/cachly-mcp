/**
 * resonanz-vergleich.ts — hilft es, eine Lektion durch frueheren Fragen zu adressieren?
 *
 * ── Warum kreuzweise, und zwar zwingend ─────────────────────────────────────
 *
 * Die naive Messung ist wertlos und sieht grossartig aus: baut man die
 * Resonanz aus allen 100 Fragen und misst dann dieselben 100, findet jede
 * Frage ihre eigene Lektion, weil ihr eigener Vektor im Index steht. Das misst
 * nicht Resonanz, sondern eine Nachschlagetabelle — und wuerde nahe 100
 * Prozent zeigen.
 *
 * Deshalb: die Fragen werden in zwei Haelften geteilt. Der Index entsteht aus
 * Haelfte A, gemessen wird Haelfte B — und umgekehrt. Keine Frage traegt je zu
 * ihrer eigenen Messung bei. Das entspricht der Produktion, wo vergangene
 * Fragen kuenftige Suchen verbessern sollen.
 *
 * ── Was die Zahl NICHT sagt ─────────────────────────────────────────────────
 *
 * Der Korpus hat 100 Fragen auf 499 Lektionen. Die meisten Lektionen bekommen
 * also GAR KEINE Resonanz, und die mit welcher bekommen ein bis zwei Fragen.
 * Das ist eine ehrliche Vorschau auf den Kaltstart, nicht auf den eingelaufenen
 * Betrieb. Faellt die Idee hier durch, ist sie tot. Gewinnt sie hier, ist der
 * Gewinn im Betrieb vermutlich groesser — belegen laesst sich das erst mit
 * echten Nutzungsdaten.
 *
 * Aufruf: npx tsx src/bench/resonanz-vergleich.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, quote, type Frage, type Messung } from './auswertung.js';
import { Resonanzbestand, ueberlagere } from '../resonanz.js';
import { SINN_TOPF } from '../rangfolge-stellschrauben.js';

interface Korpus { lektionen: unknown[]; fragen: Frage[] }
interface Vektoren { fragen: Record<string, string>; eingaenge: Record<string, Record<string, string>> }

const POOL = SINN_TOPF;

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

  const mitVektor = korpus.fragen.filter((q) => fvVon(q));

  /**
   * Baut einen Resonanzbestand aus einer Fragenmenge.
   *
   * Jede Frage traegt zu ALLEN ihren als relevant markierten Lektionen bei —
   * das entspricht einem bestaetigten Treffer im Betrieb.
   */
  const baueResonanz = (fragen: Frage[], anteil: number): Resonanzbestand => {
    const r = new Resonanzbestand();
    const zwischen = new Map<string, number[]>();
    for (const q of fragen) {
      const fv = fvVon(q);
      if (!fv) continue;
      for (const topic of q.relevant) {
        zwischen.set(topic, ueberlagere(zwischen.get(topic) ?? null, fv, anteil));
      }
    }
    for (const [topic, vek] of zwischen) r.setzeDirekt(topic, vek);
    return r;
  };

  /** Zwei Haelften, streng getrennt: gerade Indizes gegen ungerade. */
  const haelfteA = mitVektor.filter((_, i) => i % 2 === 0);
  const haelfteB = mitVektor.filter((_, i) => i % 2 === 1);

  /**
   * Fuehrt die beiden Kreuzlaeufe zusammen.
   *
   * Wichtig: die Plaetze beider Haelften werden zu EINER Liste vereinigt, bevor
   * die Quoten gerechnet werden. Zwei Quoten zu mitteln waere bei ungleichen
   * Haelften falsch.
   */
  const kreuzweise = async (
    zusatz: ((r: Resonanzbestand) => { werte: (fv: number[], topic: string) => number; gewicht: number }) | null,
    anteil: number,
  ): Promise<Messung> => {
    const plaetze: number[] = [];
    for (const [bau, mess] of [[haelfteA, haelfteB], [haelfteB, haelfteA]] as Array<[Frage[], Frage[]]>) {
      const r = zusatz ? baueResonanz(bau, anteil) : null;
      const m = await messe(redis, mess, fvVon, bestaende, {
        pool: POOL,
        ...(r && zusatz ? { zusatzMerkmal: zusatz(r) } : {}),
      });
      plaetze.push(...m.plaetze);
    }
    return { plaetze, artPlaetze: new Map(), ohneFragevektor: 0 };
  };

  const zeile = (name: string, m: Messung): void => {
    const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(8);
    console.log(`  ${name.padEnd(26)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, 99999))}`);
  };

  console.log('\nResonanz-Index — kreuzweise gemessen (Index aus der anderen Haelfte)');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Bauform'.padEnd(26)}${'Platz 1'.padStart(8)}${'@3'.padStart(8)}${'Top10'.padStart(8)}${'Topf'.padStart(8)}`);

  const ohne = await kreuzweise(null, 0);
  zeile('ohne Resonanz', ohne);

  // Wie viele Lektionen haben ueberhaupt Resonanz? Die ehrliche Nebenzahl.
  const probe = baueResonanz(haelfteA, 0.3);
  console.log(`  (Index aus einer Haelfte deckt ${probe.groesse} von 499 Lektionen)`);

  for (const gewicht of [0.1, 0.2, 0.4]) {
    for (const anteil of [0.3, 1.0]) {
      const m = await kreuzweise(
        (r) => ({ werte: (fv, topic) => r.naehe(fv, topic), gewicht }),
        anteil,
      );
      zeile(`gewicht=${gewicht} anteil=${anteil}`, m);
    }
  }

  // ── Mit Schwelle: nur eine PASSENDE Resonanz ist ein Signal ──────────────
  //
  // Ohne Schwelle bekommt jede Lektion mit irgendeiner Resonanz Auftrieb,
  // auch wenn die gespeicherten Fragen mit der aktuellen nichts zu tun haben
  // (spreizeImTopf gibt fehlenden Werten 0, vorhandenen 0..1 — wer das
  // Merkmal hat, kann nur gewinnen). Bei 64 von 499 Lektionen mit Resonanz
  // ist das ein Auftrieb fuer 13 Prozent des Bestands, unabhaengig von der
  // Passung.
  //
  // Mit Schwelle zaehlt Resonanz nur, wenn sie wirklich nahe ist; darunter
  // meldet sie -2 und ist damit "kein Wert" statt "schlechter Wert".
  console.log('');
  for (const schwelle of [0.5, 0.65, 0.8]) {
    const m = await kreuzweise(
      (r) => ({
        werte: (fv, topic) => {
          const n = r.naehe(fv, topic);
          return n >= schwelle ? n : -2;
        },
        gewicht: 0.2,
      }),
      0.3,
    );
    zeile(`schwelle=${schwelle} gew=0.2`, m);
  }

  // ── Die Gegenprobe gegen Selbstbetrug ────────────────────────────────────
  //
  // Derselbe Aufbau, aber der Index enthaelt AUCH die gemessenen Fragen. Wenn
  // diese Zahl nicht deutlich hoeher liegt, ist irgendwo ein Fehler — dann
  // wirkt das Merkmal gar nicht.
  const alles = baueResonanz(mitVektor, 0.3);
  const geschummelt = await messe(redis, mitVektor, fvVon, bestaende, {
    pool: POOL,
    zusatzMerkmal: { werte: (fv, topic) => alles.naehe(fv, topic), gewicht: 0.4 },
  });
  console.log('');
  zeile('GESCHUMMELT (Index kennt', geschummelt);
  console.log('   die gemessenen Fragen)  — muss deutlich hoeher sein, sonst wirkt das Merkmal nicht');
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
