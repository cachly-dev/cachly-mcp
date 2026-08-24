/**
 * schwelle-abtasten.ts — ist die gefundene Schwelle echt oder ein Gluecksfall?
 *
 * ── Warum das noetig ist ────────────────────────────────────────────────────
 *
 * Am 21.08.2026 zeigte Schwelle 0,5 bei Gewicht 0,2 einen Sprung von 38 auf
 * 40 Prozent auf Platz 1. Bei 100 Fragen sind zwei Punkte ZWEI FRAGEN. Wenn
 * nur dieser eine Punkt gewinnt und 0,45 und 0,55 daneben verlieren, ist es
 * Rauschen mit einer schoenen Geschichte.
 *
 * Eine echte Wirkung sieht anders aus: sie hat eine BREITE. Die Nachbarwerte
 * muessen mitgehen, sonst wurde eine Zufallskonstellation gefunden.
 *
 * Genau daran ist am 19.08. die alte Rangfolge-Formel gescheitert: auf 17
 * Fixtures eingestellt, auf 499 Lektionen das Gegenteil. Ein Wert, der nur an
 * genau einer Stelle wirkt, ist eine Eigenschaft des Pruefsatzes.
 *
 * ── Zusaetzlich: die Kreuzprobe ─────────────────────────────────────────────
 *
 * Die Fragen werden geteilt. Auf einer Haelfte wird der beste Wert gesucht,
 * auf der ANDEREN gemessen — und umgekehrt. Haelt der Gewinn das nicht aus,
 * ist er eingestellt und nicht gemessen.
 *
 * Aufruf: npx tsx src/bench/schwelle-abtasten.ts
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

  const merkmal = (schwelle: number, gewicht: number) => ({
    werte: (fv: number[], topic: string): number => {
      const n = eingangsbestand.besteNaehe(fv, topic);
      return n >= schwelle ? n : -2;
    },
    gewicht,
  });

  const lauf = async (fragen: Frage[], schwelle: number | null, gewicht: number) =>
    messe(redis, fragen, fvVon, bestaende, {
      pool: POOL,
      ...(schwelle === null ? {} : { zusatzMerkmal: merkmal(schwelle, gewicht) }),
    });

  // ── Teil 1: hat der Gewinn eine Breite? ───────────────────────────────────
  console.log('\nTeil 1 — Schwelle abtasten (Gewicht 0,2), alle 100 Fragen');
  console.log('──────────────────────────────────────────────────────────────');
  const basis = await lauf(korpus.fragen, null, 0);
  console.log(`  ohne Merkmal          Platz1 ${(quote(basis.plaetze, 1) * 100).toFixed(1)}%   @3 ${(quote(basis.plaetze, 3) * 100).toFixed(1)}%`);
  for (const s of [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70]) {
    const m = await lauf(korpus.fragen, s, 0.2);
    const p1 = quote(m.plaetze, 1) * 100;
    const p3 = quote(m.plaetze, 3) * 100;
    const pfeil = p1 > quote(basis.plaetze, 1) * 100 ? '  <' : '';
    console.log(`  schwelle=${s.toFixed(2)}        Platz1 ${p1.toFixed(1)}%   @3 ${p3.toFixed(1)}%${pfeil}`);
  }

  console.log('\nTeil 2 — Gewicht abtasten (Schwelle 0,5)');
  console.log('──────────────────────────────────────────────────────────────');
  for (const g of [0.1, 0.15, 0.2, 0.3, 0.4]) {
    const m = await lauf(korpus.fragen, 0.5, g);
    console.log(`  gewicht=${g.toFixed(2)}         Platz1 ${(quote(m.plaetze, 1) * 100).toFixed(1)}%   @3 ${(quote(m.plaetze, 3) * 100).toFixed(1)}%`);
  }

  // ── Teil 3: die Kreuzprobe ────────────────────────────────────────────────
  //
  // Auf einer Haelfte einstellen, auf der anderen messen. Was das nicht
  // aushaelt, ist eingestellt und nicht gemessen.
  console.log('\nTeil 3 — Kreuzprobe: auf einer Haelfte gesucht, auf der anderen gemessen');
  console.log('──────────────────────────────────────────────────────────────');
  const mitVektor = korpus.fragen.filter((q) => fvVon(q));
  const A = mitVektor.filter((_, i) => i % 2 === 0);
  const B = mitVektor.filter((_, i) => i % 2 === 1);

  const kandidaten: Array<[number, number]> = [];
  for (const s of [0.35, 0.40, 0.45, 0.50, 0.55, 0.60]) for (const g of [0.1, 0.15, 0.2, 0.3]) kandidaten.push([s, g]);

  const bestesAuf = async (fragen: Frage[]): Promise<[number, number]> => {
    let beste: [number, number] = [0.5, 0.2];
    let bester = -1;
    for (const [s, g] of kandidaten) {
      const m = await lauf(fragen, s, g);
      // Nach @3 gesucht: das ist, was der Nutzer sieht.
      const w = quote(m.plaetze, 3);
      if (w > bester) { bester = w; beste = [s, g]; }
    }
    return beste;
  };

  const plaetze: number[] = [];
  for (const [stellEin, miss] of [[A, B], [B, A]] as Array<[Frage[], Frage[]]>) {
    const [s, g] = await bestesAuf(stellEin);
    const m = await lauf(miss, s, g);
    console.log(`  auf einer Haelfte gefunden: schwelle=${s} gewicht=${g}  ->  auf der anderen @3 ${(quote(m.plaetze, 3) * 100).toFixed(1)}%`);
    plaetze.push(...m.plaetze);
  }
  const kreuzBasis: number[] = [];
  for (const h of [A, B]) kreuzBasis.push(...(await lauf(h, null, 0)).plaetze);

  console.log('');
  console.log(`  KREUZWEISE mit Merkmal:  Platz1 ${(quote(plaetze, 1) * 100).toFixed(1)}%   @3 ${(quote(plaetze, 3) * 100).toFixed(1)}%`);
  console.log(`  KREUZWEISE ohne:         Platz1 ${(quote(kreuzBasis, 1) * 100).toFixed(1)}%   @3 ${(quote(kreuzBasis, 3) * 100).toFixed(1)}%`);
  console.log('\n  Nur wenn die kreuzweise Zeile gewinnt, ist der Gewinn gemessen und nicht eingestellt.');
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
