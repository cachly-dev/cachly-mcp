/**
 * Baut aus dem ECHTEN Lektionsbestand einen Bench-Korpus.
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Der Fixture-Bench (fixtures.ts) misst gegen 17 Lektionen und 13 Fragen. Das
 * ist ein ehrlicher Anfang, aber Precision@1 gegen 17 Kandidaten ist leicht:
 * bei so wenigen Ablenkern trifft fast jede Rangfolge. Gegen 500 Lektionen ist
 * dieselbe Zahl eine Aussage.
 *
 * Heinrich am 19.08.2026: "wir können doch aber unseren benchmark über mehr als
 * 17 lessons und 13 queries laufen lassen ... wenn es positiv ist, dann stehen
 * wir natürlich gut da und wenn nicht, dann haben wir einen Anreiz zum
 * verbessern."
 *
 * ── Warum nicht ueber `cachly export` ───────────────────────────────────────
 *
 * Weil der das nicht kann. Gemessen am 19.08.2026: `cachly export` liefert 50
 * Lektionen von 493, jede auf 120 Zeichen gekuerzt — er ruft den
 * Dashboard-Endpunkt /memory auf und liest top_lessons. Der Befehl heisst
 * export, der Endpunkt heisst memory, und niemand hat geprueft, ob das dasselbe
 * ist. Das ist ein eigener Befund (siehe Lektion
 * cachly:export-liefert-50-von-493-mit-120-zeichen) und wird getrennt behoben.
 *
 * Dieses Werkzeug geht deshalb direkt an den Speicher, so wie der Bench selbst
 * es tut: Schluessel `cachly:lesson:best:*`, voller Inhalt, kein Deckel.
 *
 * ── Was es NICHT kann, und das ist die ehrliche Grenze ──────────────────────
 *
 * Es erzeugt LEKTIONEN, keine FRAGEN. Ein Benchmark braucht beides: Dokumente
 * und Fragen mit bekannter richtiger Antwort. Fragen aus dem Lektionstext zu
 * erzeugen waere Selbstbetrug — die Frage traegt dann die Woerter der Antwort,
 * und jede Rangfolge findet sie. Die Fragen muss ein Mensch schreiben, ohne die
 * Lektion abzuschreiben.
 *
 * Deshalb: dieses Werkzeug schreibt die Lektionen und eine LEERE Fragenliste
 * plus eine Vorlage. Wer misst, fuellt sie.
 *
 * Aufruf:
 *   npx tsx src/bench/korpus-aus-brain.ts --out ./korpus.json
 *   npx tsx src/bench/korpus-aus-brain.ts --out ./korpus.json --fragen ./fragen.json
 *
 * Die Verbindung kommt aus REDIS_URL oder CACHLY_REDIS_URL.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import type { BenchLesson, BenchQuery } from './fixtures.js';

const LESSON_PREFIX = 'cachly:lesson:best:';

/** Ein Feld, das eine Zahl sein soll, aber alles sein kann. */
const zahl = (v: unknown, standard: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : standard;
};

/**
 * Liest alle Lektionen ueber SCAN — nicht ueber KEYS.
 *
 * KEYS blockiert den Server, und dieser Speicher traegt Kundendaten. SCAN
 * blaettert in Haeppchen und laesst andere Anfragen dazwischen.
 */
export async function lektionenLesen(redis: Redis): Promise<BenchLesson[]> {
  const schluessel: string[] = [];
  let cursor = '0';
  do {
    const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${LESSON_PREFIX}*`, 'COUNT', 500);
    cursor = next;
    schluessel.push(...gefunden);
  } while (cursor !== '0');

  if (schluessel.length === 0) return [];

  // In Bloecken holen: ein MGET ueber 500 Schluessel ist eine Rundreise statt
  // 500. Bei noch groesseren Bestaenden bleibt der Block trotzdem handlich.
  const lektionen: BenchLesson[] = [];
  for (let i = 0; i < schluessel.length; i += 100) {
    const block = schluessel.slice(i, i + 100);
    const werte = await redis.mget(...block);
    for (const [j, roh] of werte.entries()) {
      if (!roh) continue;
      let l: Record<string, unknown>;
      try {
        l = JSON.parse(roh) as Record<string, unknown>;
      } catch {
        continue; // eine kaputte Zeile ist ein Thema fuer doctor, nicht fuer den Bench
      }
      const topic = typeof l.topic === 'string' && l.topic
        ? l.topic
        : (block[j] ?? '').replace(LESSON_PREFIX, '');
      if (!topic) continue;
      lektionen.push({
        topic,
        outcome: (l.outcome as BenchLesson['outcome']) ?? 'success',
        what_worked: typeof l.what_worked === 'string' ? l.what_worked : '',
        what_failed: typeof l.what_failed === 'string' ? l.what_failed : undefined,
        severity: (l.severity as BenchLesson['severity']) ?? undefined,
        confidence: zahl(l.confidence, 1),
        recall_count: zahl(l.recall_count, 0),
        ts: typeof l.ts === 'string' ? l.ts : undefined,
        review_level: (l.review_level as BenchLesson['review_level']) ?? undefined,
        reviewed_by: typeof l.reviewed_by === 'string' ? l.reviewed_by : undefined,
        endorsements: zahl(l.endorsements, 0),
      } as BenchLesson);
    }
  }
  return lektionen;
}

/**
 * Prueft, ob eine Frage ihre eigene Antwort verraet.
 *
 * Der klassische Selbstbetrug beim Benchmark-Bauen: die Frage wird aus dem
 * Lektionstext gebildet, traegt dessen seltene Woerter, und jede Rangfolge
 * findet sie. Das Ergebnis sieht grossartig aus und misst nichts.
 *
 * Faustregel hier: teilt die Frage mehr als die Haelfte ihrer laengeren Woerter
 * woertlich mit dem Lektionstext, ist sie verdaechtig. Kein Verbot — ein
 * Hinweis, denn manche echte Frage benutzt nun einmal denselben Fachbegriff.
 */
export function fragenWarnung(frage: string, lektion: BenchLesson): string | null {
  const woerter = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-zäöüß0-9-]+/).filter((w) => w.length > 5));
  const f = woerter(frage);
  if (f.size === 0) return null;
  const l = woerter(`${lektion.what_worked} ${lektion.what_failed ?? ''}`);
  const gemeinsam = [...f].filter((w) => l.has(w));
  if (gemeinsam.length * 2 <= f.size) return null;
  return (
    `Frage teilt ${gemeinsam.length} von ${f.size} langen Woertern woertlich mit der Lektion ` +
    `(${gemeinsam.slice(0, 4).join(', ')}) — moeglicherweise aus dem Text abgeschrieben.`
  );
}

interface Fragendatei {
  queries: BenchQuery[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const url = process.env.CACHLY_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) {
    console.error('Keine Verbindung: CACHLY_REDIS_URL oder REDIS_URL setzen.');
    console.error('Die Adresse liefert das Werkzeug get_connection_string.');
    process.exit(2);
  }
  const ziel = resolve(flag('out') ?? './korpus.json');

  const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
  let lektionen: BenchLesson[];
  try {
    lektionen = await lektionenLesen(redis);
  } finally {
    redis.disconnect();
  }

  if (lektionen.length === 0) {
    console.error(`Keine Lektionen unter ${LESSON_PREFIX}* gefunden — falsche Instanz?`);
    process.exit(3);
  }

  // Fragen kommen von aussen oder gar nicht. Erfundene Fragen waeren schlimmer
  // als keine: sie erzeugen eine Zahl, die nichts bedeutet.
  let queries: BenchQuery[] = [];
  const fragenPfad = flag('fragen');
  if (fragenPfad) {
    const roh = JSON.parse(await readFile(resolve(fragenPfad), 'utf-8')) as Fragendatei;
    queries = roh.queries ?? [];
    const bekannt = new Set(lektionen.map((l) => l.topic));
    const unbekannt = queries.flatMap((q) => q.relevant.filter((t) => !bekannt.has(t)));
    if (unbekannt.length) {
      console.error(`Diese erwarteten Lektionen gibt es im Bestand nicht: ${unbekannt.join(', ')}`);
      process.exit(4);
    }
    for (const q of queries) {
      for (const t of q.relevant) {
        const l = lektionen.find((x) => x.topic === t);
        const warnung = l && fragenWarnung(q.query, l);
        if (warnung) console.error(`  ⚠ "${q.query.slice(0, 50)}": ${warnung}`);
      }
    }
  }

  const korpus = {
    name: `cachly-echtbestand-${new Date().toISOString().slice(0, 10)}`,
    // Karte tupujdmpjk0q: ohne Datum altert der Korpus, ohne es zu sagen —
    // echter-korpus.ts druckt es in den Kopf und warnt ab 90 Tagen.
    erzeugt_am: new Date().toISOString(),
    _hinweis:
      'Lektionen aus dem echten Bestand. Die Fragen muss ein Mensch schreiben, ' +
      'ohne die Lektion abzuschreiben — sonst misst der Bench sich selbst.',
    lessons: lektionen,
    queries,
  };
  await writeFile(ziel, JSON.stringify(korpus, null, 2));

  const mitText = lektionen.filter((l) => (l.what_worked ?? '').length > 200).length;
  console.log(`Korpus geschrieben: ${ziel}`);
  console.log(`  Lektionen: ${lektionen.length} (davon ${mitText} mit mehr als 200 Zeichen Text)`);
  console.log(`  Fragen:    ${queries.length}`);
  if (queries.length === 0) {
    console.log('');
    console.log('  Ohne Fragen kann der Bench nicht laufen. Vorlage:');
    console.log('    {"queries":[{"query":"...","relevant":["topic:slug"]}]}');
    console.log('  Dann:  npx tsx src/bench/korpus-aus-brain.ts --out ./korpus.json --fragen ./fragen.json');
  } else {
    console.log('');
    console.log(`  Messen mit:  npm run bench:external -- ${ziel}`);
  }
}

const istHauptmodul = process.argv[1]?.endsWith('korpus-aus-brain.ts');
if (istHauptmodul) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
