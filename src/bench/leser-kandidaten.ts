/**
 * Die Kandidatenliste fuer den Leser (Stichentscheid Stufe B).
 *
 * Liest den Merkmalsauszug von `findequote-messen.ts --merkmale-nach` und
 * schreibt je Frage die obersten N Kandidaten in HAUS-Reihenfolge — samt der
 * Punktzahl, mit der das Haus sie sortiert hat, und dem Platz der richtigen
 * Antwort. Ein Leser (Cross-Encoder, Sprachmodell) bekommt genau diese Liste
 * und darf sie neu ordnen; verglichen wird dann gegen die Hausordnung
 * derselben Liste.
 *
 * Die Punktzahl wird NICHT nachgebaut: `punktzahl` kommt aus
 * beleg-kaskade-messen.ts und ist dort per Eichprobe an die ausgelieferte
 * `bewerteTopf` gebunden. Sie kennt weder `besterZeuge` noch das Zweitmodell
 * (der Auszug traegt beides nicht) — die Grundlinie hier liegt deshalb etwa
 * einen bis drei Punkte unter dem vollen Bench. Fuer den VERGLEICH Leser
 * gegen Haus ist das gleichgueltig, weil beide Seiten dieselbe Liste sehen.
 *
 * Aufruf:
 *   npx tsx src/bench/leser-kandidaten.ts --merkmale <auszug.jsonl> \
 *     --nach <kandidaten.jsonl> [--tiefe 25]
 *
 * Ausgabe je Zeile: { query, relevant, art, bestPunkt, platzHaus,
 *   kandidaten: [{ t, p }...] }  — `p` ist die Hauspunktzahl, absteigend.
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { punktzahl } from './beleg-kaskade-messen.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bZ?: number; bE: number };
type Zeile = { query: string; art: string; relevant: string[]; topf: Kandidat[] };

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const quelle = flag('merkmale');
  const ziel = flag('nach');
  const tiefe = Number(flag('tiefe') ?? '25');
  if (!quelle || !ziel) {
    process.stderr.write('Aufruf: --merkmale <auszug.jsonl> --nach <kandidaten.jsonl> [--tiefe 25]\n');
    process.exit(2);
  }

  const zeilen: string[] = [];
  let n = 0; let imTopf = 0; let inTiefe = 0; let top3 = 0;
  const rl = createInterface({ input: createReadStream(resolve(quelle)) });
  for await (const roh of rl) {
    if (!roh.trim()) continue;
    const z = JSON.parse(roh) as Zeile;
    const punkte = punktzahl(z.topf);
    const rang = z.topf
      .map((k, i) => ({ t: k.t, p: punkte[i] }))
      .sort((a, b) => b.p - a.p);
    const gold = new Set(z.relevant);
    let platz = 0;
    for (let i = 0; i < rang.length; i++) if (gold.has(rang[i].t)) { platz = i + 1; break; }
    n++;
    if (platz >= 1) imTopf++;
    if (platz >= 1 && platz <= tiefe) inTiefe++;
    if (platz >= 1 && platz <= 3) top3++;
    zeilen.push(JSON.stringify({
      query: z.query,
      relevant: z.relevant,
      art: z.art || 'ohne',
      bestPunkt: rang[0]?.p ?? 0,
      platzHaus: platz,
      kandidaten: rang.slice(0, tiefe),
    }));
  }
  writeFileSync(resolve(ziel), `${zeilen.join('\n')}\n`, 'utf8');
  const proz = (x: number) => `${((x / n) * 100).toFixed(1)} %`;
  process.stdout.write(
    `${n} Fragen -> ${ziel}\n`
    + `  Haus-Grundlinie auf dieser Punktzahl: @3 ${top3} (${proz(top3)})\n`
    + `  im Topf ueberhaupt: ${imTopf} (${proz(imTopf)})\n`
    + `  in den obersten ${tiefe} (= Decke des Lesers): ${inTiefe} (${proz(inTiefe)})\n`,
  );
}

main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
