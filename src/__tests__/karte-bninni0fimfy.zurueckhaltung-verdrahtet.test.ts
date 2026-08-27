import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';

/**
 * Karte bninni0fimfy — die Zurueckhaltung haengt am ausgelieferten Pfad.
 *
 * `abstention.test.ts` prueft das Modul fuer sich: Belege hinein, Urteil
 * heraus. Das sagt NICHTS darueber, ob der Abruf es je aufruft. Genau diese
 * Luecke ist die Fehlerklasse "Modul ohne Aufrufer": elf gruene Proben, und
 * im Produkt aendert sich kein Zeichen.
 *
 * Diese Datei prueft die Verdrahtung — und die eine Verwechslung, die sie
 * still zerstoeren wuerde: die Uebergabe der RANGZAHL statt der Belege.
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const quelle = (rel: string) => readFileSync(join(HIER, rel), 'utf-8').replace(/\r\n/g, '\n');

/**
 * Kommentare raus, bevor irgendetwas gesucht wird.
 *
 * Diese Datei erklaert ihre Absicht in langen Kommentaren — sie enthaelt die
 * gesuchten Woerter also mehrfach als Prosa. Ein Waechter, der Prosa liest,
 * prueft nichts (belegt am 19.08.2026, achtmal).
 */
function nurCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Verdrahtung: die Zurueckhaltung wird im Abruf wirklich gerufen', () => {
  const code = () => nurCode(quelle('../handlers/brain.ts'));

  it('brain.ts importiert das Modul UND ruft es auf', () => {
    const c = code();
    expect(c).toMatch(/from ['"]\.\.\/abstention\.js['"]/);
    expect(c, 'beurteileTreffer wird nie aufgerufen').toMatch(/beurteileTreffer\s*\(/);
    expect(c, 'der Satz wird nie ausgegeben').toMatch(/abstentionSatz\s*\(/);
  });

  it('uebergeben werden die ABSOLUTEN Belege, nicht die Rangzahl', () => {
    /*
     * Der Kern dieses Waechters. `hybridScore` ist min-max normiert:
     *
     *     const bm25Range = (Math.max(...) - bm25Min) || 1;
     *
     * Bei genau einem Treffer ist max === min, die Zahl also immer 0 — jeder
     * Ein-Treffer-Abruf wuerde schweigen. Der beste Treffer bekommt immer 1,
     * also wuerde eine Liste aus zehn unpassenden Lektionen nie schweigen.
     * Die Verwechslung faellt in keiner Modulprobe auf, weil das Modul die
     * Zahl nimmt, die es bekommt.
     */
    const c = code();
    const aufruf = c.slice(c.indexOf('beurteileTreffer('));
    const bis = aufruf.indexOf(');');
    const argumente = bis > 0 ? aufruf.slice(0, bis) : aufruf;

    expect(argumente, 'die Rangzahl darf nicht als Beleg durchgehen').not.toContain('hybridScore');
    expect(argumente).toContain('wortBelege');
    expect(argumente).toContain('semScore');
    expect(argumente).toContain('ckgScore');
  });

  it('der Wortbeleg entsteht in search.ts und wird nicht nebenan nachgebaut', () => {
    /*
     * Die Kernwoerter kennt nur search.ts (`tokenize` ist nicht ausgefuehrt).
     * Wer die Zahl anderswo nachrechnet, baut die Wortzerlegung nach — die
     * Fehlerklasse "Messstand und Auslieferstand sind zwei Systeme"
     * (20.08.2026, RRF gegen bewerteTopf).
     */
    const suche = nurCode(quelle('../search.ts'));
    expect(suche, 'search.ts liefert wortBelege nicht mehr').toMatch(/wortBelege\s*[,:]/);
    expect(code(), 'brain.ts rechnet den Beleg selbst nach').not.toMatch(/wortBelege\s*=\s*[^;]*kernToken/);
  });
});

describe('Verhalten: der Abruf sagt Nein, und er sagt es mit Zahlen', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () =>
    ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => {
    redis = new MockRedis();
  });

  const lerne = (topic: string, what: string) =>
    handleBrainTool(
      'learn_from_attempts',
      { instance_id: 'i1', topic, outcome: 'success', what_worked: what },
      getConn,
      noopApiFetch,
    );

  it('leerer Bestand: der Abruf sagt es offen, statt eine leere Liste zu zeigen', async () => {
    const out = String(
      await handleBrainTool(
        'smart_recall',
        { instance_id: 'i1', query: 'wie richte ich den Tunnel ein' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(out).toContain('Nichts Passendes im Bestand');
    expect(out).toContain('noch keine Lektion');
  });

  it('GEGENPROBE: ein passender Treffer wird geliefert, nicht verschwiegen', async () => {
    /*
     * Die wichtigste Probe der ganzen Karte. Eine Zurueckhaltung, die zu oft
     * greift, ist schlimmer als gar keine: sie nimmt Treffer weg, die geholfen
     * haetten, und der Nutzer sieht nur, dass nichts da war.
     *
     * "plugh timeout" ist EIN Treffer im Bestand. Genau daran fiel die erste
     * Fassung um.
     */
    await lerne('deploy:netz', 'Der plugh-Timeout liegt am Netz.');

    const out = String(
      await handleBrainTool(
        'smart_recall',
        { instance_id: 'i1', query: 'plugh timeout' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(out).toContain('liegt am Netz');
    expect(out).not.toContain('Nichts Passendes im Bestand');
  });

  it('GEGENPROBE: die lange Frage wird nicht bestraft', async () => {
    /*
     * Zweiter Fehlversuch vom 27.08.2026: ein ANTEIL statt einer Anzahl. Von
     * drei getippten Woertern steht hier nur das seltene "xyzzy" in der
     * Lektion — ein Drittel, und damit unter jeder brauchbaren Anteilsschwelle.
     * Der Treffer ist trotzdem genau der richtige.
     */
    await lerne('api:schluessel', 'use env vars for xyzzy tokens');

    const out = String(
      await handleBrainTool(
        'smart_recall',
        { instance_id: 'i1', query: 'xyzzy api key' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(out).toContain('xyzzy');
    expect(out).not.toContain('Nichts Passendes im Bestand');
  });
});
