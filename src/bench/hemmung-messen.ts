/**
 * hemmung-messen.ts — misst Naturworkshop-Kandidat v3.
 *
 * ── Der Kandidat ────────────────────────────────────────────────────────────
 *
 * Vorbild "Laterale Hemmung in der Netzhaut" (Lauf 21.08.2026, Ausgang
 * `tragfaehig`, seither ungemessen):
 *
 *   Senke nach der Bewertung die Punktzahl jedes Kandidaten um einen Anteil
 *   der Punktzahl seiner naechsten Nachbarn im Vektorraum. Zwei fast gleiche
 *   Lektionen daempfen einander, statt beide Plaetze zu belegen.
 *
 *   Widerlegung, vom Workshop festgelegt: Findequote@3 steigt um weniger als
 *   2 Punkte, ODER Platz 1 faellt um mehr als 1 Punkt.
 *
 * ── Der Einwand, der schon im Workshop stand ────────────────────────────────
 *
 * Die Netzhaut hemmt RAEUMLICHE Nachbarn — dort ist Naehe immer Redundanz.
 * Unsere Nachbarn liegen im Vektorraum, und dort koennen zwei nahe Lektionen
 * einander ERGAENZEN statt sich zu wiederholen. Genau da fuehrt das Vorbild in
 * die Irre. Deshalb misst diese Datei Platz 1 mit — wer nur @3 ansieht,
 * uebersieht, ob die Daempfung die richtige Antwort vom ersten Platz schiebt.
 *
 * Aufruf:
 *   npx tsx src/bench/hemmung-messen.ts [--korpus <k.json>] [--vektoren <v.json>]
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

/** Kosinus zwischen zwei Rohvektoren. Beide sind bereits normiert. */
function kosinus(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Die Daempfung — SCHRITTWEISE, und das ist der ganze Punkt.
 *
 * ── Der Fehlversuch, der hier stand ─────────────────────────────────────────
 *
 * Die erste Fassung zog jedem Kandidaten EINMAL die Punkte seiner staerkeren
 * Nachbarn ab. Gemessen am 22.08.2026: exakt null Aenderung an Platz 1, @3,
 * Top10 und Decke — bei drei verschiedenen Anteilen, auf allen 100 Fragen.
 *
 * Der Grund ist eine Rechenregel, keine Eigenschaft des Bestands: wer mehr
 * staerkere Nachbarn hat, bekommt zwangslaeufig mehr Abzug. Der Abzug waechst
 * also MONOTON mit dem Rang, und eine monotone Verschiebung kann die
 * Reihenfolge nicht umkehren — egal wie gross der Anteil ist. Die Werte fielen
 * von 2 auf -1338, und die Quoten blieben auf die Stelle gleich.
 *
 * Haette ich das als "v3 ist widerlegt" gemeldet, waere die Widerlegung meiner
 * eigenen Umsetzung gegolten und nicht dem Kandidaten.
 *
 * ── Wie es die Netzhaut wirklich macht ──────────────────────────────────────
 *
 * Die gereizte Zelle hemmt ihre Umgebung, und die gehemmte Umgebung hemmt
 * danach ihre eigene. Das ist ein ABLAUF, keine einmalige Rechnung. Uebersetzt:
 * nimm den Besten, daempfe alle, die ihm aehneln, nimm den naechsten Besten aus
 * dem, was uebrig ist, und so weiter. Wer einem bereits Gewaehlten aehnelt,
 * faellt zurueck — wer etwas Neues beitraegt, rueckt auf. Genau das soll das
 * Vorbild bewirken.
 */
export function daempfeSchrittweise(
  punkte: readonly number[],
  vektoren: readonly (readonly number[] | null)[],
  anteil: number,
  naeheAb = 0.7,
): number[] {
  const rest = punkte.map((p, i) => ({ i, p }));
  const neu = [...punkte];
  const gewaehlt: number[] = [];

  while (rest.length > 0) {
    // Der jeweils Beste aus dem, was uebrig ist.
    let bestIdx = 0;
    for (let k = 1; k < rest.length; k++) if (rest[k].p > rest[bestIdx].p) bestIdx = k;
    const gewinner = rest.splice(bestIdx, 1)[0];
    neu[gewinner.i] = gewinner.p;
    gewaehlt.push(gewinner.i);

    // Alle Verbliebenen, die IHM aehneln, verlieren.
    const vg = vektoren[gewinner.i];
    if (!vg) continue;
    for (const kandidat of rest) {
      const vk = vektoren[kandidat.i];
      if (!vk) continue;
      const naehe = kosinus(vg, vk);
      if (naehe < naeheAb) continue;
      kandidat.p -= anteil * Math.abs(gewinner.p) * naehe;
    }
  }

  /*
   * Zurueckgegeben werden Punkte, die die AUSWAHLREIHENFOLGE abbilden — die
   * Nachbearbeitung in auswertung.ts sortiert danach. Sonst gingen die
   * Zwischenstaende verloren und die Reihenfolge waere wieder die alte.
   */
  return punkte.map((_, i) => -gewaehlt.indexOf(i));
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

  const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(9);
  console.log('\n  Laterale Hemmung — Daempfung durch naechste Nachbarn');
  console.log('  ────────────────────────────────────────────────────────────────');
  console.log(`  ${'Variante'.padEnd(20)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'Top10'.padStart(9)}${'Decke'.padStart(9)}`);

  const ohne = await messe(redis, korpus.fragen, frageVektor, bestaende, {});
  console.log(`  ${'ohne Daempfung'.padEnd(20)}${p(quote(ohne.plaetze, 1))}${p(quote(ohne.plaetze, 3))}${p(quote(ohne.plaetze, 10))}${p(quote(ohne.plaetze, 99999))}`);

  for (const anteil of [0.15, 0.3, 0.5]) {
    /*
     * BEWEIS, DASS ES LAEUFT. Eine Messung, die exakt null Aenderung zeigt,
     * ist erst dann ein Ergebnis, wenn feststeht, dass der Eingriff ueberhaupt
     * stattgefunden hat — sonst wird Stille als gruen gebucht. Gezaehlt wird
     * deshalb, wie oft die Nachbearbeitung lief und wie oft sie wirklich einen
     * Wert geaendert hat.
     */
    let laeufe = 0; let veraendert = 0; let groessteAenderung = 0; let rangGeaendert = 0;
    const m = await messe(redis, korpus.fragen, frageVektor, bestaende, {
      punkteNachbearbeitung: (punkte, topf) => {
        laeufe++;
        const neuP = daempfeSchrittweise(punkte, topf.map((t) => vektorbestand.rohvektor(t) ?? null), anteil);
        for (let i = 0; i < punkte.length; i++) {
          const d = Math.abs(neuP[i] - punkte[i]);
          if (d > 1e-9) veraendert++;
          if (d > groessteAenderung) groessteAenderung = d;
        }
        // Aendert sich die REIHENFOLGE ueberhaupt? Das ist die Frage, nicht ob
        // sich Zahlen aendern.
        const rangAlt = punkte.map((_, i) => i).sort((a, b) => punkte[b] - punkte[a]).join(',');
        const rangNeu = neuP.map((_, i) => i).sort((a, b) => neuP[b] - neuP[a]).join(',');
        if (rangAlt !== rangNeu) rangGeaendert++;
        if (laeufe <= 2) {
          const top = punkte.map((x, i) => ({ x, n: neuP[i] })).sort((a, b) => b.x - a.x).slice(0, 5);
          console.log(`    [Probe ${laeufe}] Punkte oben: ${top.map((t) => `${t.x.toFixed(0)}→${t.n.toFixed(0)}`).join('  ')}`);
        }
        return neuP;
      },
    });
    console.log(`  ${`Anteil ${anteil}`.padEnd(20)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, 99999))}`);

    // FRAGEN zaehlen. "Nicht gefunden" ist Platz 0 — der Fehler, der den
    // ersten v5-Lauf gekostet hat (siehe topfschnitt-adaptiv.ts).
    const drin = (x: number): boolean => x > 0 && x <= 3;
    let besser = 0; let schlechter = 0;
    m.plaetze.forEach((platz, i) => {
      if (drin(platz) && !drin(ohne.plaetze[i])) besser++;
      if (!drin(platz) && drin(ohne.plaetze[i])) schlechter++;
    });
    console.log(`  ${''.padEnd(20)}${besser} Fragen besser, ${schlechter} schlechter (@3)`);
    console.log(`  ${''.padEnd(20)}BEWEIS: ${laeufe} Laeufe, ${veraendert} Punktwerte geaendert, REIHENFOLGE geaendert bei ${rangGeaendert} von ${laeufe} Fragen`);
  }

  console.log('\n  Widerlegung des Workshops: @3 steigt um weniger als 2 Punkte,');
  console.log('  ODER Platz 1 faellt um mehr als 1 Punkt.');
}

const direkt = process.argv[1]?.replace(/\\/g, '/').endsWith('/hemmung-messen.ts');
if (direkt) main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
