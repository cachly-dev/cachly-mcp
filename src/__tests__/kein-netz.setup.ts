/**
 * Setup jeder Testdatei: die Netzsperre einschalten und nach JEDEM Test pruefen,
 * ob etwas nach aussen wollte. Hintergrund und Wirkung: scripts/kein-netz-vorlauf.cjs.
 *
 * Der Produktcode schluckt Netzfehler absichtlich ("bestes Bemuehen"). Deshalb
 * reicht es nicht, die Verbindung zu verweigern — ohne diese Pruefung bliebe ein
 * Test gruen, der still die Produktion treffen wollte.
 */
import { afterEach, expect } from 'vitest';
import { createRequire } from 'node:module';

interface Verstoss { host: string; port: number | null; erwartet: boolean; test: string; gemeldet?: boolean }
interface Netzsperre {
  verstoesse: Verstoss[];
  testName: (() => string) | null;
  erwarte<T>(fn: () => Promise<T> | T): Promise<T>;
}

createRequire(import.meta.url)('../../scripts/kein-netz-vorlauf.cjs');
const sperre = (globalThis as Record<symbol, unknown>)[Symbol.for('cachly.netzsperre')] as Netzsperre | undefined;

if (sperre) {
  sperre.testName = () => expect.getState().currentTestName ?? '';
  afterEach(() => {
    const neu = sperre.verstoesse.filter((v) => !v.erwartet && !v.gemeldet);
    for (const v of neu) v.gemeldet = true;
    if (neu.length > 0) {
      const ziele = [...new Set(neu.map((v) => `${v.host}:${v.port}`))].join(', ');
      throw new Error(
        `Dieser Test wollte ins Netz: ${neu.length} Verbindungsversuch(e) nach ${ziele}. ` +
        'Tests duerfen nie die Produktion erreichen (Netzsperre, scripts/kein-netz-vorlauf.cjs). ' +
        'Einen Attrappen-Server auf 127.0.0.1 benutzen und CACHLY_API_URL darauf zeigen lassen.',
      );
    }
  });
}
