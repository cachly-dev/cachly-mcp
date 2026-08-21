/**
 * Die Gegenprobe am ECHTEN Bestand — nicht an Dateien.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Am 20.08.2026 stellte sich heraus, dass der Messstand eine andere Anordnung
 * misst als die ausgelieferte (`bewerteTopf` gegen `mischeRangfolgen`). Ein
 * Messstand, der etwas anderes misst als das Produkt, ist kein Beleg.
 *
 * Diese Probe schließt die Lücke von der anderen Seite: sie benutzt die
 * PRODUKTIONSKLASSEN (Vektorbestand, Eingangsbestand, Seltenheitsbestand,
 * bewerteTopf) gegen den ECHTEN Speicher und rechnet dieselbe Punktzahl wie
 * `brain.ts`. Was hier herauskommt, ist das, was ein Nutzer bekommt —
 * abzüglich der Einblendungslogik darüber.
 *
 * ── Was sie NICHT beweist ───────────────────────────────────────────────────
 *
 * Die Fragen stammen aus dem eingefrorenen Prüfsatz und zielen auf Lektionen,
 * die es am 19.08. gab. Der echte Bestand ist inzwischen gewachsen: neue
 * Lektionen sind zusätzliche Ablenker, und das macht die Zahl eher zu
 * schlecht als zu gut. Das ist der ehrlichere Fehler von beiden.
 *
 * Aufruf:
 *   REDIS_URL=... npx tsx src/bench/am-echten-bestand.ts \
 *     --pruefsatz <pruefsatz-frisch.json> --vektoren <eingaenge-b.vektoren.json>
 *   npx tsx src/bench/am-echten-bestand.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { schluessel } from './eingaenge-einbetten.js';
import { messe, bestePlatzierung, quote, type Frage } from './auswertung.js';

export { bestePlatzierung };

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [
    ['Platz 1 wird als 1 gemeldet', bestePlatzierung(['a', 'b'], ['a']) === 1],
    ['die BESTE akzeptable zaehlt', bestePlatzierung(['a', 'b', 'c'], ['c', 'b']) === 2],
    ['nicht dabei ist 0', bestePlatzierung(['a'], ['z']) === 0],
  ];
  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const url = process.env.CACHLY_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) { console.error('NICHT GEMESSEN: REDIS_URL fehlt.'); process.exit(2); }
  const satzPfad = resolve(flag('pruefsatz') ?? '');
  const vekPfad = resolve(flag('vektoren') ?? '');
  const POOL = Number(flag('pool') ?? '25');
  // Seit dem 21.08.2026 sind die Tueren in Produktion AUS — der Schalter
  // zeigt deshalb in die andere Richtung als frueher.
  const mitEingaengen = argv.includes('--mit-eingaengen');

  for (const [was, p] of [['Pruefsatz', satzPfad], ['Fragevektoren', vekPfad]] as const) {
    if (!existsSync(p)) { console.error(`NICHT GEMESSEN: ${was} fehlt (${p}).`); process.exit(2); }
  }
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as { queries: Frage[] };
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> };

  const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
  try {
    const vektorbestand = new Vektorbestand();
    const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
    const eingangsbestand = new Eingangsbestand();
    const seltenheitsbestand = new Seltenheitsbestand();
    await vektorbestand.aktualisiere(redis);
    await namensbestand.aktualisiere(redis);
    await eingangsbestand.aktualisiere(redis);
    await seltenheitsbestand.aktualisiere(redis);

    console.log('');
    console.log(`  ${seltenheitsbestand.groesse} Lektionen im echten Bestand`);
    console.log(`  ${vektorbestand.groesse} Volltextvektoren · ${namensbestand.groesse} Namensvektoren`);
    console.log(`  ${eingangsbestand.groesse} Lektionen mit Eingaengen (${eingangsbestand.anzahlEingaenge} Eingaenge)`);
    if (vektorbestand.groesse === 0) {
      console.error('NICHT GEMESSEN: kein einziger Volltextvektor — der Bedeutungsabgleich waere aus.');
      process.exit(3);
    }

    // Die Rechnung steht in auswertung.ts und wird mit dem eingefrorenen
    // Korpus geteilt. Zwei Rechnungen waeren zwei Wahrheiten — genau der
    // Fehler, an dem der alte Messstand gescheitert ist.
    const { plaetze, artPlaetze, ohneFragevektor } = await messe(
      redis,
      satz.queries,
      (q: Frage) => vektoren[schluessel('frage', q.query)] ?? null,
      { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand },
      { pool: POOL, eingaenge: mitEingaengen ? 'voll' : 'aus' },
    );

    if (plaetze.length === 0) {
      console.error('NICHT GEMESSEN: keine einzige Frage hatte einen Vektor.');
      process.exit(4);
    }
    if (ohneFragevektor > 0) {
      console.error(`WARNUNG: ${ohneFragevektor} Fragen ohne Vektor uebersprungen.`);
    }

    const zeile = (ps: number[], bis: number): string => {
      const n = ps.filter((p) => p > 0 && p <= bis).length;
      return `${n} von ${ps.length} (${Math.round(quote(ps, bis) * 100)} %)`;
    };
    console.log('');
    console.log(`  ${mitEingaengen ? 'MIT' : 'OHNE'} Eingaengen · Vorauswahl je ${POOL}`);
    console.log(`    Platz 1        ${zeile(plaetze, 1)}`);
    console.log(`    FINDEQUOTE@3   ${zeile(plaetze, 3)}`);
    console.log(`    Top 10         ${zeile(plaetze, 10)}`);
    console.log(`    im Topf        ${zeile(plaetze, 99999)}`);
    console.log('');
    const arten = [...artPlaetze.keys()].sort();
    if (arten.length > 1) {
      console.log('  Nach Art der Frage (Findequote@3):');
      for (const a of arten) console.log(`    ${a.padEnd(14)} ${zeile(artPlaetze.get(a)!, 3)}`);
    }
  } finally {
    redis.disconnect();
  }
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/am-echten-bestand.ts');
if (direktGestartet && process.argv.includes('--selbstprobe')) selbstprobe();
else if (direktGestartet) void main();
