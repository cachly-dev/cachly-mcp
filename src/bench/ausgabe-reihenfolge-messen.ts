/**
 * Kommt die gemessene Reihenfolge beim Nutzer an?
 *
 * ── Die Luecke, die diese Datei schliesst (11.10.2026) ────────────────────
 *
 * Jeder Rangfolge-Bench ruft `bewerteTopf` direkt. Er misst die
 * HAUSORDNUNG: Topf, Bewertung, Tuer, Zweitmodell. Was `smart_recall` danach
 * mit dieser Ordnung macht, sieht keiner von ihnen.
 *
 * Und `smart_recall` machte etwas damit: die Hausordnung (`kwGemischt`) wurde
 * in der Ausgabe noch einmal sortiert — nach dem normierten Wortwert. Eine
 * Lektion, die nur der Bedeutungsabgleich fand, hat den Wortwert 0 und
 * rutschte damit ans Ende, auch wenn die Hausordnung sie auf Platz 1 setzte.
 * Liefer-Journal und Gedaechtniszellen lasen dagegen `kwGemischt`. Ein
 * Aufruf, zwei Reihenfolgen.
 *
 * ── Was gemessen wird ─────────────────────────────────────────────────────
 *
 * Der ECHTE Handler, je Frage einmal. Gezaehlt wird zweimal:
 *
 *   AUSGABE      — die Reihenfolge der 💡-Zeilen im Antworttext. Das ist,
 *                  was der Nutzer sieht.
 *   HAUSORDNUNG  — `kwGemischt`, abgelesen am Liefer-Journal. Das Journal
 *                  haelt die obersten drei Lektionen; fuer Platz 1 und
 *                  Treffer@3 reicht das.
 *
 * Ein Messhaken im Produkt ist dafuer nicht noetig: das Journal ist schon da.
 *
 * ── Der Bestand ───────────────────────────────────────────────────────────
 *
 * Derselbe wie in den Laeufen mit findequote-messen.ts (Messkette B2, Arm
 * A0z): korpus-gross.json (499 Lektionen), pruefsatz-3000.json (3.003
 * Fragen), eingaenge-b.json, pool-vektoren-de.json, zweitvektoren-qwen06.json.
 *
 * In den Speicher kommt, was der Schreibpfad im Produkt anlegt: Lektion,
 * Volltext-, Namens- und Zweitvektor, und als Tuer NUR die Fehlertexte
 * (schreibeEingaenge schreibt keine anderen).
 *
 * ── Ohne Netz ─────────────────────────────────────────────────────────────
 *
 * Die Einbettungen sind eingefroren. Der Lauf stellt den Anbieter auf
 * `ollama` und lenkt dessen Adresse auf die Vektordatei um — `fetch` wird
 * im Lauf abgefangen, jede andere Adresse wirft. Kein Aufruf verlaesst die
 * Maschine.
 *
 * Der Leser ist AUS. Er braucht Netz und Schluessel (POST /api/v1/rerank).
 * Er mischt nur die obersten 25 der Hausordnung um; die Frage hier — kommt
 * die Hausordnung an? — haengt nicht an ihm.
 *
 * Der Bestand wird je Frage eingefroren: Schreibzugriffe auf Lektionen
 * werden verworfen. Im Produkt zaehlt jeder Abruf `recall_count` hoch, und
 * das wirkt ueber rerankByQuality auf die naechste Suche. Im Lauf wuerde so
 * jede Frage den Bestand der naechsten veraendern.
 *
 * Aufruf (aus sdk/mcp):
 *   npx tsx src/bench/ausgabe-reihenfolge-messen.ts
 *   npx tsx src/bench/ausgabe-reihenfolge-messen.ts --stichprobe 600 --seed 7
 *   npx tsx src/bench/ausgabe-reihenfolge-messen.ts --nur-worte
 *
 * --nur-worte schaltet die Einbettung ganz ab (Anbieter `none`). Dann ist die
 * Hausordnung der reine Wortabgleich nach rerankByQuality.
 *
 * Das Tor: im Sinnpfad muessen die obersten drei der Ausgabe bei JEDER
 * Einthemen-Frage dieselben sein wie die der Hausordnung. Sonst Ausgang 1.
 * Mehrthemen-Fragen ("A und B") gruppiert die Ausgabe nach Teilfrage; sie
 * werden mitgezaehlt, aber nicht gegen die flache Hausordnung geprueft.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Redis } from 'ioredis';
import { MockRedis } from '../__tests__/redis-mock.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const Z = join(homedir(), '.cachly', 'bench-korpus');
const PFAD = {
  korpus: resolve(flag('korpus') ?? join(Z, 'korpus-gross.json')),
  pruefsatz: resolve(flag('pruefsatz') ?? join(Z, 'pruefsatz-3000.json')),
  eingaenge: resolve(flag('eingaenge') ?? join(Z, 'eingaenge-b.json')),
  vektoren: resolve(flag('vektoren') ?? join(Z, 'pool-vektoren-de.json')),
  zweit: resolve(flag('zweitvektoren') ?? join(Z, 'zweitvektoren-qwen06.json')),
};
const NUR_WORTE = argv.includes('--nur-worte');
const STICHPROBE = flag('stichprobe') ? Number(flag('stichprobe')) : 0;
const SEED = Number(flag('seed') ?? '7');

// ── Umgebung VOR dem ersten Produkt-Import ──────────────────────────────────
// embeddings.ts liest den Anbieter beim Laden des Moduls. Deshalb werden alle
// Produktmodule unten dynamisch geladen, NACH diesen Zeilen.
const VEKTOR_ADRESSE = 'http://vektoren.bench.invalid';
process.env.CACHLY_EMBED_PROVIDER = NUR_WORTE ? 'none' : 'ollama';
process.env.OLLAMA_BASE_URL = VEKTOR_ADRESSE;
process.env.CACHLY_EMBED_MODEL = '';
delete process.env.CACHLY_JWT; // ohne Schluessel kein Leser
process.env.CACHLY_LESER = 'aus';
delete process.env.CACHLY_RECALL_COMPACT;
delete process.env.CACHLY_VERSUCH;

interface Frage { query: string; relevant: string[] }
interface Lektion { topic: string; [k: string]: unknown }
interface Eingang { art: string; text: string }

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

/** Feste Stichprobe: mulberry32 + Fisher-Yates, danach in Satzreihenfolge. */
function stichprobe<T>(alle: T[], n: number, seed: number): T[] {
  let s = seed >>> 0;
  const zufall = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const idx = alle.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).sort((a, b) => a - b).map((i) => alle[i]);
}

/**
 * Der Speicher der Handler-Proben, an zwei Stellen fuer den Lauf ergaenzt.
 *
 * 1. `scan` findet auch Hash-Schluessel. MockRedis sucht nur in den
 *    Zeichenketten — die Fehlertext-Tueren (Hashes) blieben sonst fuer den
 *    Eingangsbestand unsichtbar, und der Lauf maesse eine Suchmaschine ohne
 *    Tuer-Merkmal.
 * 2. Lektionen sind nach `einfrieren()` nur noch lesbar (siehe Kopf).
 */
class BenchRedis extends MockRedis {
  private hashSchluessel = new Set<string>();
  private eingefroren = false;
  verworfen = 0;

  einfrieren(): void { this.eingefroren = true; }

  override async set(key: string, value: string, ...opts: unknown[]): Promise<'OK' | null> {
    if (this.eingefroren && key.startsWith('cachly:lesson:best:')) { this.verworfen++; return 'OK'; }
    return super.set(key, value, ...opts);
  }

  override async hset(key: string, ...felder: string[]): Promise<number> {
    this.hashSchluessel.add(key);
    return super.hset(key, ...felder);
  }

  override async scan(cursor: string | number, ...rest: Array<string | number>): Promise<[string, string[]]> {
    const [weiter, treffer] = await super.scan(cursor, ...rest);
    let match = '*';
    for (let i = 0; i < rest.length - 1; i++) {
      if (String(rest[i]).toUpperCase() === 'MATCH') match = String(rest[i + 1]);
    }
    const muster = new RegExp(`^${match.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return [weiter, [...treffer, ...[...this.hashSchluessel].filter((k) => muster.test(k))]];
  }

  anzahlHashes(praefix: string): number {
    return [...this.hashSchluessel].filter((k) => k.startsWith(praefix)).length;
  }
}

async function main(): Promise<void> {
  for (const [was, pfad] of Object.entries(PFAD)) if (!existsSync(pfad)) fehlt(was, pfad);

  const { handleBrainTool } = await import('../handlers/brain.js');
  const {
    packe, VEKTOR_PRAEFIX, NAME_VEKTOR_PRAEFIX, ZWEIT_VEKTOR_PRAEFIX,
  } = await import('../bedeutung.js');
  const { EINGANG_PRAEFIX } = await import('../eingaenge.js');
  const { ZWEIT_MODELL } = await import('../rangfolge-stellschrauben.js');
  const { lieferJournalSchluessel } = await import('../etiketten.js');
  const { bestePlatzierung, quote } = await import('./auswertung.js');
  const { schluessel } = await import('./eingaenge-einbetten.js');

  const korpus = JSON.parse(readFileSync(PFAD.korpus, 'utf8')) as { lessons: Lektion[] };
  const satz = JSON.parse(readFileSync(PFAD.pruefsatz, 'utf8')) as { queries: Frage[] };
  const { lektionen } = JSON.parse(readFileSync(PFAD.eingaenge, 'utf8')) as {
    lektionen: Array<{ topic: string; eingaenge: Eingang[] }>;
  };
  const haupt = (JSON.parse(readFileSync(PFAD.vektoren, 'utf8')) as { vektoren: Record<string, number[]> }).vektoren;
  const zweit = (JSON.parse(readFileSync(PFAD.zweit, 'utf8')) as { vektoren: Record<string, number[]> }).vektoren;

  // ── Die Einbettung aus der Datei ──────────────────────────────────────────
  let frageTreffer = 0;
  let frageFehlt = 0;
  let fremdeAdressen = 0;
  const echtesFetch = globalThis.fetch;
  globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
    const url = typeof eingabe === 'string' ? eingabe : eingabe instanceof URL ? eingabe.href : eingabe.url;
    if (url.startsWith(VEKTOR_ADRESSE)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; prompt?: string };
      const quelle = body.model === ZWEIT_MODELL ? zweit : haupt;
      const v = quelle[schluessel('frage', body.prompt ?? '')];
      if (!v) { frageFehlt++; return new Response('{}', { status: 404, statusText: 'nicht eingefroren' }); }
      frageTreffer++;
      return new Response(JSON.stringify({ embedding: v }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    fremdeAdressen++;
    throw new Error(`Bench ohne Netz: ${url}`);
  }) as typeof fetch;

  // ── Der Bestand ───────────────────────────────────────────────────────────
  const redis = new BenchRedis();
  const ohne = { volltext: 0, name: 0, zweit: 0 };
  let tueren = 0;
  const eingVon = new Map(lektionen.map((l) => [l.topic, l.eingaenge]));
  for (const l of korpus.lessons) {
    await redis.set(`cachly:lesson:best:${l.topic}`, JSON.stringify(l));
    const eing = eingVon.get(l.topic) ?? [];
    const volltext = eing.find((e) => e.art === 'volltext');
    const name = eing.find((e) => e.art === 'name');
    const vv = volltext ? haupt[schluessel('volltext', volltext.text)] : undefined;
    const vn = name ? haupt[schluessel('name', name.text)] : undefined;
    const vz = volltext ? zweit[schluessel('volltext', volltext.text)] : undefined;
    if (vv) await redis.set(`${VEKTOR_PRAEFIX}${l.topic}`, packe(vv)); else ohne.volltext++;
    if (vn) await redis.set(`${NAME_VEKTOR_PRAEFIX}${l.topic}`, packe(vn)); else ohne.name++;
    if (vz) await redis.set(`${ZWEIT_VEKTOR_PRAEFIX}${l.topic}`, packe(vz)); else ohne.zweit++;
    const felder: string[] = [];
    for (const e of eing.filter((x) => x.art === 'fehlertext')) {
      const v = haupt[schluessel('fehlertext', e.text)];
      if (v) felder.push(e.text.slice(0, 200), packe(v));
    }
    if (felder.length > 0) { await redis.hset(`${EINGANG_PRAEFIX}${l.topic}`, ...felder); tueren += felder.length / 2; }
  }
  redis.einfrieren();

  const fragen = STICHPROBE > 0 ? stichprobe(satz.queries, STICHPROBE, SEED) : satz.queries;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async <T>(): Promise<T> =>
    ({ ok: false, status: 503, json: async () => ({}) }) as unknown as T;
  const journal = lieferJournalSchluessel('bench');
  const LABEL = /\*\*💡 (.+?)\*\*/g;

  console.log('\n🧭  Kommt die Hausordnung in der Ausgabe an? (echter smart_recall-Handler)');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  Lektionen ${korpus.lessons.length} · Fragen ${fragen.length} von ${satz.queries.length}`
    + (STICHPROBE > 0 ? ` (feste Stichprobe, Seed ${SEED})` : ' (voller Satz)'));
  console.log(`  Vektoren: ohne Volltext ${ohne.volltext} · ohne Name ${ohne.name} · ohne Zweit ${ohne.zweit} · Fehlertext-Tueren ${tueren}`);
  console.log(`  Pfad: ${NUR_WORTE ? 'NUR WORTE (Einbettung aus)' : 'Sinnpfad mit eingefrorenen Einbettungen'} · Leser AUS`);

  const ausgabe: number[] = [];
  const haus: number[] = [];
  let gleichOben3 = 0;
  let einthemig = 0;
  let schweigen = 0;
  let mehrthemig = 0;
  let mehrthemigAnders = 0;
  const abweichungen: string[] = [];
  const start = Date.now();

  for (const [n, q] of fragen.entries()) {
    if (n > 0 && n % 250 === 0) console.log(`  … ${n} Fragen in ${((Date.now() - start) / 1000).toFixed(0)} s`);
    await redis.ltrim(journal, 1, 0); // leeren: gelesen wird nur die Zeile DIESES Abrufs
    const out = String(await handleBrainTool('smart_recall', { instance_id: 'bench', query: q.query }, getConn, noopApiFetch));
    const gezeigt = [...out.matchAll(LABEL)].map((m) => m[1].trim());
    const zeile = (await redis.lrange(journal, 0, 0))[0];
    const hausOben = zeile ? (JSON.parse(zeile) as { themen: string[] }).themen : [];

    ausgabe.push(bestePlatzierung(gezeigt, q.relevant));
    haus.push(bestePlatzierung(hausOben, q.relevant));
    // Die Zurueckhaltung zeigt keine Liste — das ist eine andere Frage als
    // die Reihenfolge und wird getrennt gezaehlt, nicht als Abweichung.
    if (out.includes('Nichts Passendes im Bestand')) { schweigen++; continue; }
    const ausgabeOben = gezeigt.slice(0, hausOben.length);
    const gleich = ausgabeOben.length === hausOben.length && ausgabeOben.every((t, i) => t === hausOben[i]);
    // Mehrthemen-Fragen gruppiert die Ausgabe nach Teilfrage ("_Detected N
    // sub-topics:_"), je Gruppe hoechstens vier. Das ist eine eigene
    // Darstellung: sie wird gezaehlt (Platz 1, Treffer@3 oben), aber nicht
    // gegen die flache Hausordnung geprueft.
    if (out.includes('sub-topics:_')) {
      mehrthemig++;
      if (!gleich) mehrthemigAnders++;
      continue;
    }
    einthemig++;
    if (gleich) gleichOben3++;
    else if (abweichungen.length < 5) {
      abweichungen.push(`"${q.query.slice(0, 70)}"\n      Ausgabe:     ${ausgabeOben.join(' | ')}\n      Hausordnung: ${hausOben.join(' | ')}`);
    }
  }
  globalThis.fetch = echtesFetch;

  const sek = (Date.now() - start) / 1000;
  const zahl = (ps: number[], bis: number): string => {
    const k = ps.filter((p) => p > 0 && p <= bis).length;
    return `${String(k).padStart(5)} von ${ps.length} (${(quote(ps, bis) * 100).toFixed(1).padStart(4)} %)`;
  };

  console.log('');
  console.log('  Reihenfolge     Platz 1                     Treffer@3');
  console.log(`  Ausgabe        ${zahl(ausgabe, 1)}    ${zahl(ausgabe, 3)}`);
  console.log(`  Hausordnung    ${zahl(haus, 1)}    ${zahl(haus, 3)}`);
  const d1 = ausgabe.filter((p) => p === 1).length - haus.filter((p) => p === 1).length;
  const d3 = ausgabe.filter((p) => p > 0 && p <= 3).length - haus.filter((p) => p > 0 && p <= 3).length;
  console.log(`  Unterschied    ${d1 >= 0 ? '+' : ''}${d1} auf Platz 1 · ${d3 >= 0 ? '+' : ''}${d3} bei Treffer@3 (Ausgabe minus Hausordnung)`);
  console.log('');
  console.log(`  Oberste drei identisch: ${gleichOben3} von ${einthemig} Einthemen-Fragen`);
  console.log(`  Mehrthemen-Fragen (nach Teilfrage gruppiert): ${mehrthemig}, davon oben anders als die Hausordnung: ${mehrthemigAnders}`);
  console.log(`  Zurueckhaltung (keine Liste): ${schweigen}`);
  console.log(`  Einbettungen aus der Datei: ${frageTreffer} · nicht eingefroren: ${frageFehlt} · fremde Adressen: ${fremdeAdressen}`);
  console.log(`  Verworfene Lektions-Schreibzugriffe: ${redis.verworfen} · Pfad-Tueren entstanden: ${redis.anzahlHashes('cachly:lesson:pfad:')}`);
  console.log(`  Laufzeit ${sek.toFixed(0)} s (${((sek * 1000) / fragen.length).toFixed(0)} ms je Frage)`);
  if (abweichungen.length > 0) {
    console.log('\n  Erste Abweichungen:');
    for (const a of abweichungen) console.log(`    ${a}`);
  }
  console.log('──────────────────────────────────────────────────────────────────────');

  if (!NUR_WORTE && frageFehlt > 0) {
    console.error(`NICHT VOLL GEMESSEN: ${frageFehlt} Einbettungen fehlten in der Vektordatei — diese Fragen liefen nur ueber Woerter.`);
    process.exit(2);
  }
  if (!NUR_WORTE && gleichOben3 < einthemig) {
    console.error(`ZWEI REIHENFOLGEN: bei ${einthemig - gleichOben3} von ${einthemig} Einthemen-Fragen zeigt die Ausgabe oben etwas anderes als die Hausordnung.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
