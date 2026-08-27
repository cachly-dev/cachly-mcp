/**
 * Wie oft sagt der Abruf Nein — und stimmt das Nein?
 *
 * ── Die Luecke, die diese Datei schliesst (27.08.2026) ────────────────────
 *
 * `npm run bench` misst die RANGFOLGE. Er ruft `smart_recall` gar nicht auf.
 * Die Zurueckhaltung aus Karte bninni0fimfy ist damit von KEINEM Tor gedeckt:
 * wer sie aendert, hat nichts, das ihn aufhaelt.
 *
 * Aufgefallen ist das beim Widerlegen von `besterZeuge` (PR #526) — ich wollte
 * eine Aenderung gegen den Pflicht-Bench halten und stellte fest, dass der
 * Bench sie nicht sehen kann.
 *
 * ── Was gemessen wird ─────────────────────────────────────────────────────
 *
 * Zwei Fragensaetze, zwei Zahlen, und die zweite ist die wichtige:
 *
 *   FALSCHES SCHWEIGEN — der Abruf sagt Nein zu einer Frage, die eine Antwort
 *     im Bestand HAT. Das ist der teure Fehler: der Nutzer sieht nur, dass
 *     nichts da war, und niemand erfaehrt, dass etwas verschwiegen wurde.
 *     Diese Zahl muss NULL sein.
 *
 *   RICHTIGES SCHWEIGEN — der Abruf sagt Nein zu einer Frage, die keine
 *     Antwort hat. Das ist der Zweck. Ist die Zahl niedrig, taugt die
 *     Zurueckhaltung nichts; sie darf aber niemals fuer die erste Zahl
 *     erkauft werden.
 *
 * ── Warum es eine eigene Datei ist ────────────────────────────────────────
 *
 * `echter-korpus.ts` misst die Sortierung ueber `messe()`; sein Ergebnis haengt
 * an Rangplaetzen. Diese Messung braucht den ECHTEN Handler samt Ausgabetext,
 * also einen anderen Weg. Beide teilen sich aber den Bestand: `baueBestand()`
 * aus derselben Datei, damit nicht zwei Speicher entstehen, die auseinander
 * laufen.
 *
 * Aufruf:  npx tsx src/bench/zurueckhaltung-messen.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Redis } from 'ioredis';
import { baueBestand } from './echter-korpus.js';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from '../__tests__/redis-mock.js';

const HIER = dirname(fileURLToPath(import.meta.url));

/** Der Satz, den die Zurueckhaltung ausgibt — die Erkennung steht neben der Zahl. */
const SCHWEIGT = 'Nichts Passendes im Bestand';

/**
 * Fragen OHNE Antwort im Bestand.
 *
 * Bewusst aus einer anderen Welt: Kochen, Garten, Musik, Tiere. Ein Bestand
 * ueber Infrastruktur und Software hat dazu nichts zu sagen, und genau das
 * soll der Abruf zugeben.
 *
 * Die Liste ist absichtlich in ALLTAGSSPRACHE gehalten, mit vielen
 * Fuellwoertern ("wie stelle ich", "wie lange muss") — denn das ist der Fall,
 * an dem die aktuelle Regel scheitert: sie zaehlt getippte Woerter, und
 * "stelle" steht in jeder zweiten Lektion.
 */
const OHNE_ANTWORT = [
  'Wie stelle ich den Vergaser eines Zweitaktmotors auf Winterbetrieb um',
  'Welches Futter braucht ein Wellensittich im Winter',
  'Wie lange muss ein Rinderbraten im Ofen bleiben',
  'Wann bluehen Tulpen in Norddeutschland',
  'Wie wechsle ich die Saiten einer Konzertgitarre',
  'Welcher Duenger passt zu Rhododendren im Herbst',
  'Wie binde ich eine Krawatte im Windsor-Knoten',
  'Wie erkenne ich einen echten Steinpilz',
  'Welche Temperatur braucht ein Sauerteig zum Gehen',
  'Wie stimme ich eine Geige ohne Stimmgeraet',
];

interface Korpus {
  lektionen: Record<string, unknown>[];
  fragen: { query: string }[];
}
interface Vektoren {
  volltext: Record<string, string>;
  name: Record<string, string>;
  eingaenge: Record<string, Record<string, string>>;
}

async function main(): Promise<void> {
  const korpus = JSON.parse(
    readFileSync(join(HIER, 'korpus', 'korpus.json'), 'utf8'),
  ) as Korpus;
  const vektoren = JSON.parse(
    readFileSync(join(HIER, 'korpus', 'korpus-vektoren.json'), 'utf8'),
  ) as Vektoren;

  /*
   * Der Bestand wird mit baueBestand() gebaut — DERSELBE Aufbau wie im
   * Rangfolge-Bench — und dann in den MockRedis der Proben umgefuellt.
   *
   * Warum der Umweg: MiniRedis ist auf die Rangfolge zugeschnitten. Er
   * antwortet synchron und kennt weder `incr` noch die uebrigen Befehle, die
   * `smart_recall` unterwegs braucht. Der erste Versuch war, ihn mit einer
   * Huelle nachzuruesten — nach `set`, dann `scanStream`, dann `incr` war klar,
   * dass hier eine Attrappe an den echten Handler angepasst wird statt
   * umgekehrt.
   *
   * MockRedis kann all das schon; er traegt seit Monaten die Handler-Proben.
   * Umgefuellt wird ueber die OEFFENTLICHEN Felder von MiniRedis, damit die
   * Schluesselnamen weiter aus baueBestand() kommen und nicht hier ein
   * zweites Mal entstehen.
   */
  const roh = baueBestand(korpus as never, vektoren as never);
  const redis = new MockRedis();
  for (const [k, v] of roh.store) await redis.set(k, v);
  for (const [k, felder] of roh.hashes) {
    const flach: string[] = [];
    for (const [f, w] of Object.entries(felder)) flach.push(f, w);
    if (flach.length > 0) await redis.hset(k, ...flach);
  }

  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () =>
    ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const frag = async (query: string): Promise<boolean> => {
    const out = String(
      await handleBrainTool('smart_recall', { instance_id: 'bench', query }, getConn, noopApiFetch),
    );
    return out.includes(SCHWEIGT);
  };

  console.log('\n🤐  Zurueckhaltung am echten Bestand');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  Lektionen ${korpus.lektionen.length}`);
  console.log(`  Erkennung: die Antwort enthaelt "${SCHWEIGT}"`);

  // ── Fragen MIT Antwort: hier darf NIE geschwiegen werden ────────────────
  const falschStumm: string[] = [];
  for (const f of korpus.fragen) {
    if (await frag(f.query)) falschStumm.push(f.query);
  }

  // ── Fragen OHNE Antwort: hier SOLL geschwiegen werden ───────────────────
  const richtigStumm: string[] = [];
  for (const f of OHNE_ANTWORT) {
    if (await frag(f)) richtigStumm.push(f);
  }

  const q = (a: number, b: number) => `${((a / b) * 100).toFixed(1).padStart(5)} %`;

  console.log('');
  console.log(`  Fragen MIT Antwort:   ${korpus.fragen.length}`);
  console.log(
    `    faelschlich verschwiegen: ${falschStumm.length}  ${q(falschStumm.length, korpus.fragen.length)}`,
  );
  for (const f of falschStumm.slice(0, 8)) console.log(`      "${f}"`);

  console.log('');
  console.log(`  Fragen OHNE Antwort:  ${OHNE_ANTWORT.length}`);
  console.log(
    `    richtig verschwiegen:     ${richtigStumm.length}  ${q(richtigStumm.length, OHNE_ANTWORT.length)}`,
  );
  for (const f of OHNE_ANTWORT.filter((f) => !richtigStumm.includes(f)).slice(0, 8)) {
    console.log(`      NICHT verschwiegen: "${f}"`);
  }

  console.log('\n──────────────────────────────────────────────────────────────────────');

  /*
   * Das Tor. Nur EINE Bedingung ist hart.
   *
   * Ein falsches Schweigen frisst einen Treffer, der geholfen haette — und
   * niemand merkt es, weil der Nutzer nur sieht, dass nichts da war. Deshalb
   * bricht der Lauf daran ab.
   *
   * Die zweite Zahl ist bewusst KEIN Tor. Sie ist heute niedrig, und das ist
   * ein bekannter, gemessener Mangel (siehe zeugen-abtasten.ts). Ein rotes Tor
   * daraus zu machen, bevor ein taugliches Mass gefunden ist, wuerde nur dazu
   * fuehren, dass jemand die Schwelle hochdreht und dabei Treffer frisst.
   */
  if (falschStumm.length > 0) {
    console.error(
      `FALSCHES SCHWEIGEN: ${falschStumm.length} von ${korpus.fragen.length} Fragen mit Antwort ` +
        'wurden verschwiegen.\nDas ist der teure Fehler: der Nutzer sieht nur, dass nichts da war.',
    );
    process.exit(1);
  }
  console.log('  Kein falsches Schweigen — die Zurueckhaltung frisst keinen Treffer.');
  if (richtigStumm.length === 0) {
    console.log(
      '  ABER: sie schweigt auch bei KEINER der fremden Fragen. Sie ist damit\n' +
        '  wirkungslos — bekannt und gemessen, siehe zeugen-abtasten.ts.',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
