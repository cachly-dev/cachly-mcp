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
import { keywordSearch } from '../search.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX } from '../bedeutung.js';
import { Eingangsbestand, EINGANG_GEWICHT } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import {
  bewerteTopf, spreizeImTopf, reichereAn, inhaltsWoerter, grobStamm, GEWICHTE,
} from '../rangfolge.js';
import { schluessel } from './eingaenge-einbetten.js';

const PRAEFIX = 'cachly:lesson:best:';

interface Frage { query: string; relevant: string[]; art?: string }

/** Der Platz der besten akzeptablen Antwort, 1-basiert. 0 = gar nicht dabei. */
export function bestePlatzierung(rangfolge: string[], akzeptabel: string[]): number {
  for (const [i, t] of rangfolge.entries()) if (akzeptabel.includes(t)) return i + 1;
  return 0;
}

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
  const ohneEingaenge = argv.includes('--ohne-eingaenge');

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

    const plaetze: number[] = [];
    const artPlaetze = new Map<string, number[]>();
    let ohneFragevektor = 0;

    for (const q of satz.queries) {
      const fv = vektoren[schluessel('frage', q.query)];
      if (!fv) { ohneFragevektor++; continue; }

      const wortThemen = (await keywordSearch(redis as never, [`${PRAEFIX}*`], q.query, POOL) as Array<{ key: string }>)
        .map((h) => h.key.replace(PRAEFIX, ''));
      // Maximum ueber ALLE Tueren, genau wie brain.ts. Mit --ohne-eingaenge
      // faellt die Fehlertext-Tuer weg, der Rest bleibt gleich.
      const naeheBesteTuer = (t: string): number => Math.max(
        vektorbestand.naehe(fv, t),
        namensbestand.naehe(fv, t),
        ohneEingaenge ? -2 : eingangsbestand.besteNaehe(fv, t),
      );
      const sinnThemen = [...seltenheitsbestand.themen()]
        .map((t) => ({ t, n: naeheBesteTuer(t) }))
        .sort((a, b) => b.n - a.n)
        .slice(0, POOL)
        .map((x) => x.t);

      const topf = [...new Set([...wortThemen, ...sinnThemen])];
      const besteDrei = sinnThemen.slice(0, 3)
        .map((t) => vektorbestand.rohvektor(t)).filter(Boolean) as number[][];
      const angereichert = besteDrei.length ? reichereAn(fv, besteDrei) : fv;
      const frageWoerter = inhaltsWoerter(q.query);
      const statistik = seltenheitsbestand.statistik;

      const bewertbar = topf.map((t) => ({
        naeheText: vektorbestand.naehe(fv, t),
        naeheThema: namensbestand.naehe(fv, t),
        naeheRueckkopplung: vektorbestand.naehe(angereichert, t),
        seltenheitsDeckung: statistik
          ? statistik.deckung(
            frageWoerter,
            new Set([...inhaltsWoerter(seltenheitsbestand.textVon(t))].map(grobStamm)),
          )
          : 0,
      }));
      let punkte = bewerteTopf(bewertbar, GEWICHTE);
      if (!ohneEingaenge && eingangsbestand.groesse > 0) {
        const gespreizt = spreizeImTopf(topf.map((t) => eingangsbestand.besteNaehe(fv, t)));
        punkte = punkte.map((p, i) => p + EINGANG_GEWICHT * gespreizt[i]);
      }

      const rang = topf.map((t, i) => ({ t, p: punkte[i] }))
        .sort((a, b) => b.p - a.p).map((x) => x.t);
      const platz = bestePlatzierung(rang, q.relevant);
      plaetze.push(platz);
      const art = q.art ?? 'ohne';
      if (!artPlaetze.has(art)) artPlaetze.set(art, []);
      artPlaetze.get(art)!.push(platz);
    }

    if (plaetze.length === 0) {
      console.error('NICHT GEMESSEN: keine einzige Frage hatte einen Vektor.');
      process.exit(4);
    }
    if (ohneFragevektor > 0) {
      console.error(`WARNUNG: ${ohneFragevektor} Fragen ohne Vektor uebersprungen.`);
    }

    const quote = (ps: number[], bis: number): string => {
      const n = ps.filter((p) => p > 0 && p <= bis).length;
      return `${n} von ${ps.length} (${Math.round((n / ps.length) * 100)} %)`;
    };
    console.log('');
    console.log(`  ${ohneEingaenge ? 'OHNE' : 'MIT'} Eingaengen · Vorauswahl je ${POOL}`);
    console.log(`    Platz 1        ${quote(plaetze, 1)}`);
    console.log(`    FINDEQUOTE@3   ${quote(plaetze, 3)}`);
    console.log(`    Top 10         ${quote(plaetze, 10)}`);
    console.log(`    im Topf        ${quote(plaetze, 99999)}`);
    console.log('');
    const arten = [...artPlaetze.keys()].sort();
    if (arten.length > 1) {
      console.log('  Nach Art der Frage (Findequote@3):');
      for (const a of arten) console.log(`    ${a.padEnd(14)} ${quote(artPlaetze.get(a)!, 3)}`);
    }
  } finally {
    redis.disconnect();
  }
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/am-echten-bestand.ts');
if (direktGestartet && process.argv.includes('--selbstprobe')) selbstprobe();
else if (direktGestartet) void main();
