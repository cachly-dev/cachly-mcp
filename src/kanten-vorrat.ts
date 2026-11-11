/**
 * Die Kanten-Suche von smart_recall (Layer 3, "fixes"-Kanten im Wissensgraph),
 * mit parallelen Netzwegen und in der alten Reihenfolge.
 *
 * ── Warum es diese Datei gibt (04.11.2026) ─────────────────────────────────
 *
 * Gemessen mit CACHLY_ZEITMESSUNG=1: Der Block "Sinn-Dienst und CKG" kostete
 * je Suche 2,2 bis 2,5 s. Er lief Befehl fuer Befehl: je Fragewort ein SCAN
 * ueber den ganzen Bestand in 20er-Schritten, danach je Knoten ein SMEMBERS,
 * je Kante ein GET, je Lektion ein GET — jeder ein eigener Weg zum Brain.
 *
 * Hier laufen die Wege gleichzeitig. Das ERGEBNIS bleibt Stueck fuer Stueck
 * gleich, weil die Reihenfolge erhalten bleibt, in der die alte Schleife Knoten
 * und Kanten sah: Woerter in Fragereihenfolge, je Wort die SCAN-Stapel in ihrer
 * Reihenfolge, je Knoten die ersten 6 Kanten. Angewendet wird danach in
 * brain.ts mit genau der alten Logik (seenFroms, Schwelle 0,35, nur "fixes").
 */
import type { CKGEdge } from './ckg.js';

/** Was die Kanten-Suche braucht — ein Ausschnitt von ioredis. */
export interface KantenRedis {
  scanStream(opts: { match: string; count: number }): {
    on(ereignis: 'data', f: (stapel: string[]) => void): unknown;
    on(ereignis: 'end', f: () => void): unknown;
    on(ereignis: 'error', f: (e: unknown) => void): unknown;
  };
  smembers(schluessel: string): Promise<string[]>;
  get(schluessel: string): Promise<string | null>;
}

/** Eine Kante in der Reihenfolge der alten Schleife, mit dem Inhalt ihrer Lektion. */
export interface KantenFund {
  kante: CKGEdge;
  /** Inhalt von `cachly:lesson:best:<from>`, null wenn es die Lektion nicht gibt. */
  inhalt: string | null;
}

function parse(roh: string | null): CKGEdge | null {
  if (!roh) return null;
  try { return JSON.parse(roh) as CKGEdge; } catch { return null; }
}

/**
 * Holt alle Kanten, die die alte Schleife betrachtet haette, gleichzeitig.
 * Wirft, wenn ein SCAN scheitert — der Aufrufer faengt das wie bisher ab.
 */
/**
 * Schrittweite des SCAN ueber den ganzen Speicher.
 *
 * Bis 11.11.2026 waren es 20 Schluessel je Schritt. Ein Brain mit rund 1.250
 * Lektionen hat aber zehntausende Schluessel (Kontexte, Spuren, Graph): je
 * Fragewort tausende Wege zum Speicher und zurueck. Ueber ein entferntes Netz
 * kostete dieser Block 53 bis 55 s JE smart_recall — mehr als alles andere
 * zusammen. Bei 1.000 je Schritt sind es rund 50 Wege.
 *
 * Mit dem groesseren Schritt entfaellt die Grenze "5 je Stapel": bei 20
 * Schluesseln je Stapel griff sie praktisch nie, bei 1.000 wuerde sie Treffer
 * abschneiden, die vorher mitkamen. Gezaehlt wird jetzt jeder Treffer in
 * SCAN-Reihenfolge; die Grenze von 12 Knoten weiter unten bleibt.
 */
export const SPEICHER_SCAN_SCHRITT = 1000;

export async function holeKantenVorrat(redis: KantenRedis, fragewoerter: string[]): Promise<KantenFund[]> {
  // 1. Je Wort ein SCAN — alle gleichzeitig, jedes Ergebnis in Stapelreihenfolge.
  const jeWort = await Promise.all(fragewoerter.map((wort) => new Promise<string[]>((fertig, fehler) => {
    const ids: string[] = [];
    const strom = redis.scanStream({ match: `cachly:ckg:node:*${wort}*`, count: SPEICHER_SCAN_SCHRITT });
    strom.on('data', (stapel: string[]) => {
      for (const k of stapel) ids.push(k.replace('cachly:ckg:node:', ''));
    });
    strom.on('end', () => fertig(ids));
    strom.on('error', fehler);
  })));
  // Dieselbe Menge in derselben Einfuegereihenfolge wie die alte Schleife.
  const knotenMenge = new Set<string>();
  for (const ids of jeWort) for (const id of ids) knotenMenge.add(id);
  const knoten = [...knotenMenge].slice(0, 12);

  // 2. Die eingehenden Kanten je Knoten — gleichzeitig, je Knoten die ersten 6.
  const jeKnoten = await Promise.all(knoten.map((k) => redis.smembers(`cachly:ckg:idx:to:${k}`)));
  const kantenSchluessel = jeKnoten.flatMap((ks) => ks.slice(0, 6));

  // 3. Die Kanten selbst — gleichzeitig, in Reihenfolge.
  const kanten = (await Promise.all(kantenSchluessel.map((ek) => redis.get(ek)))).map(parse);

  // 4. Die Lektionen der in Frage kommenden Kanten — gleichzeitig, je Lektion einmal.
  // Vorab geholt, auch wenn die Lektion schon ein Wort-Treffer ist: ein GET
  // mehr im selben Schub kostet weniger als ein spaeterer Weg.
  const froms = [...new Set(kanten
    .filter((e): e is CKGEdge => !!e && e.edgeType === 'fixes' && e.confidence >= 0.35)
    .map((e) => e.from))];
  const inhalte = new Map<string, string | null>();
  await Promise.all(froms.map(async (f) => {
    inhalte.set(f, await redis.get(`cachly:lesson:best:${f}`).catch(() => null));
  }));

  return kanten
    .filter((e): e is CKGEdge => !!e)
    .map((kante) => ({ kante, inhalt: inhalte.get(kante.from) ?? null }));
}

/**
 * Tarif und Vektor-Zugang einer Instanz: bis 0.10.229 bei JEDER Suche neu von
 * der API geholt (ein Weg ins Netz je smart_recall). Beides aendert sich nur
 * beim Tarifwechsel. Fuenf Minuten im Prozess gemerkt; ein Fehlschlag wird
 * nicht gemerkt.
 */
const TARIF_MERKEN_MS = 5 * 60_000;
const tarifMerker = new Map<string, { bis: number; wert: Promise<unknown> }>();

export function gemerkterTarif<T>(instanzId: string, holen: () => Promise<T | null>): Promise<T | null> {
  const jetzt = Date.now();
  const alt = tarifMerker.get(instanzId);
  if (alt && alt.bis > jetzt) return alt.wert as Promise<T | null>;
  const wert = holen().catch(() => null);
  tarifMerker.set(instanzId, { bis: jetzt + TARIF_MERKEN_MS, wert });
  void wert.then((w) => { if (w === null) tarifMerker.delete(instanzId); });
  return wert;
}

/** Nur fuer Tests. */
export function vergissTarife(): void {
  tarifMerker.clear();
}
