/**
 * tueren-vergleich.ts — verdienen die Fehlertext-Tueren ihren Platz?
 *
 * Karte j4st1pc4kpel: drei von vier Kennzahlen sind OHNE die Tueren besser.
 * Die Kopfzahlen sagen aber nicht, WER gewinnt und wer verliert — und genau
 * daran haengt die Entscheidung. Eine Tuer, die 5 Stoerungsfragen rettet und
 * 7 Vorhabenfragen verdirbt, ist kein Ausbau-Kandidat, sondern ein
 * Kandidat fuer eine BEDINGUNG (nur oeffnen, wenn die Frage wie ein
 * Fehlertext aussieht).
 *
 * Deshalb hier je Frage: Platz mit Tueren gegen Platz ohne. Drei Toepfe:
 * besser / schlechter / gleich, aufgeschluesselt nach Frageart.
 *
 * Diagnose-Werkzeug, KEIN Gate. Aufruf: npx tsx src/bench/tueren-vergleich.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, type Frage } from './auswertung.js';
import { SINN_TOPF } from '../rangfolge-stellschrauben.js';

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
    const gepackt = v.fragen[q.query];
    return gepackt ? entpacke(gepackt) : null;
  };

  // Dieselben Fragen, zweimal gemessen. Die Reihenfolge der plaetze-Arrays
  // folgt der Reihenfolge der Fragen — darauf stuetzt sich der Vergleich.
  const POOL = SINN_TOPF;
  const mit = await messe(redis, korpus.fragen, frageVektor, bestaende, { eingaenge: 'voll', pool: POOL });
  const ohne = await messe(redis, korpus.fragen, frageVektor, bestaende, { pool: POOL });

  if (mit.plaetze.length !== ohne.plaetze.length) {
    console.error(`NICHT MESSBAR: ${mit.plaetze.length} gegen ${ohne.plaetze.length} Plaetze — Reihenfolge nicht vergleichbar.`);
    process.exit(2);
  }

  type Zeile = { art: string; query: string; mitT: number; ohneT: number };
  const zeilen: Zeile[] = [];
  let i = 0;
  for (const q of korpus.fragen) {
    if (!frageVektor(q)) continue; // uebersprungene Fragen tauchen in keinem Array auf
    zeilen.push({ art: q.art ?? 'ohne', query: q.query, mitT: mit.plaetze[i], ohneT: ohne.plaetze[i] });
    i++;
  }

  // Platz 0 heisst "gar nicht im Topf" (siehe bestePlatzierung) — das ist der
  // SCHLECHTESTE Ausgang, nicht der beste. Die erste Fassung dieses Vergleichs
  // hat 0 numerisch verglichen und damit fuenf Totalausfaelle als Siege
  // gezaehlt. Fuer den Vergleich wird 0 deshalb auf Unendlich abgebildet.
  const rang = (p: number): number => (p === 0 ? Number.POSITIVE_INFINITY : p);
  const besser = zeilen.filter((z) => rang(z.mitT) < rang(z.ohneT));
  const schlechter = zeilen.filter((z) => rang(z.mitT) > rang(z.ohneT));
  const gleich = zeilen.length - besser.length - schlechter.length;

  console.log('');
  console.log('Fehlertext-Tueren — wer gewinnt, wer verliert (Platz je Frage)');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  besser mit Tueren:     ${besser.length}`);
  console.log(`  schlechter mit Tueren: ${schlechter.length}`);
  console.log(`  unveraendert:          ${gleich}`);

  const jeArt = (liste: Zeile[]): string => {
    const z = new Map<string, number>();
    for (const x of liste) z.set(x.art, (z.get(x.art) ?? 0) + 1);
    return [...z.entries()].map(([a, n]) => `${a}:${n}`).join('  ') || '—';
  };
  console.log(`\n  Gewinner je Art:  ${jeArt(besser)}`);
  console.log(`  Verlierer je Art: ${jeArt(schlechter)}`);

  const zeig = (p: number): string => (p === 0 ? 'RAUS' : String(p)).padStart(4);
  console.log('\n  Die Gewinner im Einzelnen (Platz mit -> ohne):');
  for (const z of besser) console.log(`    ${zeig(z.mitT)} -> ${zeig(z.ohneT)}  [${z.art}]  ${z.query.slice(0, 70)}`);
  console.log('\n  Die Verlierer im Einzelnen (Platz mit -> ohne):');
  for (const z of schlechter) console.log(`    ${zeig(z.mitT)} -> ${zeig(z.ohneT)}  [${z.art}]  ${z.query.slice(0, 70)}`);

  // Die entscheidende Teilmenge: Faelle, in denen die Tueren die Antwort ganz
  // aus dem Topf draengen oder sie hineinholen. Ein Platztausch ist ein
  // Schoenheitsfehler — ein Topf-Rauswurf ist ein Totalausfall.
  const rauswurf = zeilen.filter((z) => z.mitT === 0 && z.ohneT > 0);
  const rettung = zeilen.filter((z) => z.mitT > 0 && z.ohneT === 0);
  console.log(`\n  Topf-Rauswurf durch Tueren: ${rauswurf.length} · Topf-Rettung durch Tueren: ${rettung.length}`);

  // ── Die dritte Bauform: Tueren sortieren, aber nominieren nicht ──────────
  //
  // Aus der Messung oben folgt eine Hypothese: die Topf-Rauswuerfe kommen aus
  // der Vorauswahl, die Platzgewinne aus der Sortierung. Wenn das stimmt,
  // muesste "sortieren ja, nominieren nein" beide Vorteile vereinen.
  const { quote } = await import('./auswertung.js');
  const nurSort = await messe(redis, korpus.fragen, frageVektor, bestaende, { eingaenge: 'nur-sortieren', pool: POOL });

  // ── Nachtrag 21.08.2026: waren die Tueren nur falsch verrechnet? ─────────
  //
  // Bei der Resonanz-Messung fiel auf, dass `spreizeImTopf` fehlenden Werten
  // eine 0 gibt — den schlechtesten Wert im Bereich. Wer das Merkmal hat,
  // kann also nur gewinnen, wer es nicht hat, nur verlieren. Bei den Tueren
  // betraf das 108 von 507 Lektionen ohne Fehlertext.
  //
  // Mit Schwelle zaehlt die Tuer nur, wenn sie wirklich nahe ist; darunter
  // meldet sie -2 und ist "kein Wert" statt "schlechter Wert". Wenn die
  // Tueren SO gewinnen, war nicht die Idee falsch, sondern die Verrechnung —
  // und der Ausbau muesste zurueckgenommen werden.
  const mitSchwelle: Array<[number, Awaited<ReturnType<typeof messe>>]> = [];
  for (const s of [0.5, 0.65, 0.8]) {
    mitSchwelle.push([s, await messe(redis, korpus.fragen, frageVektor, bestaende, {
      pool: POOL,
      zusatzMerkmal: {
        werte: (fv, topic) => {
          const n = eingangsbestand.besteNaehe(fv, topic);
          return n >= s ? n : -2;
        },
        gewicht: 0.2,
      },
    })]);
  }
  console.log('\n  Bauformen im Vergleich:');
  const kopf = ['mit', 'ohne', 'nurSort', ...mitSchwelle.map(([s]) => `schw${s}`)];
  console.log(`  ${'Kennzahl'.padEnd(15)}${kopf.map((k) => k.padStart(9)).join('')}`);
  for (const [name, bis] of [['Platz 1', 1], ['Findequote@3', 3], ['Top 10', 10], ['im Topf', 99999]] as Array<[string, number]>) {
    const werte = [mit, ohne, nurSort, ...mitSchwelle.map(([, m]) => m)]
      .map((m) => `${(quote(m.plaetze, bis) * 100).toFixed(1)}%`.padStart(9));
    console.log(`  ${name.padEnd(15)}${werte.join('')}`);
  }
  console.log('\n  "ohne" ist der ausgelieferte Stand. Schlaegt eine Schwellen-Spalte ihn,');
  console.log('  war nicht die Idee falsch, sondern die Verrechnung.');
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
