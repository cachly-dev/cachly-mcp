import { describe, expect, it } from 'vitest';
// @ts-expect-error — reines JS-Modul, absichtlich ohne Typen: es laeuft in der
// CI mit blossem node, ohne Bauschritt davor.
import { verlangenSprung, vergleicheVersionen, pruefe, versionAus } from '../scripts/versionswaechter.mjs';

/**
 * ABNAHME zur Karte ick9jzt7zwt8 — "Zwei Bauten, eine Nummer".
 *
 * Der Waechter selbst muss beweisen, dass er Nein sagen kann. Ein Waechter
 * ohne Gegenprobe ist nicht von einem abgeschalteten zu unterscheiden.
 */

describe('verlangenSprung — was im Paket landet und was nicht', () => {
  it('eine Quelldatei verlangt einen Sprung', () => {
    expect(verlangenSprung(['sdk/mcp/src/handlers/brain.ts'])).toEqual(['sdk/mcp/src/handlers/brain.ts']);
  });

  it('ein Test verlangt keinen — er landet nicht im Paket', () => {
    expect(verlangenSprung(['sdk/mcp/src/spuren.test.ts'])).toEqual([]);
    expect(verlangenSprung(['sdk/mcp/src/handlers/brain.spec.ts'])).toEqual([]);
  });

  it('Dateien ausserhalb von sdk/mcp/src zaehlen nicht', () => {
    expect(verlangenSprung([
      'api/internal/handler/instance_handler.go',
      'web/app/page.tsx',
      'sdk/mcp/README.md',
      'sdk/js/src/index.ts',
    ])).toEqual([]);
  });

  it('aus einer gemischten Liste bleiben nur die Quelldateien uebrig', () => {
    const aus = verlangenSprung([
      'sdk/mcp/src/eingaenge.ts',
      'sdk/mcp/src/eingaenge.test.ts',
      'docs/x.md',
      'sdk/mcp/src/handlers/team.ts',
    ]);
    expect(aus).toEqual(['sdk/mcp/src/eingaenge.ts', 'sdk/mcp/src/handlers/team.ts']);
  });
});

describe('vergleicheVersionen', () => {
  it('erkennt hoeher, gleich und niedriger', () => {
    expect(vergleicheVersionen('0.10.125', '0.10.124')).toBeGreaterThan(0);
    expect(vergleicheVersionen('0.10.124', '0.10.124')).toBe(0);
    expect(vergleicheVersionen('0.10.123', '0.10.124')).toBeLessThan(0);
  });

  it('zaehlt nicht als Zeichenkette — 0.10.9 ist kleiner als 0.10.124', () => {
    // Als Text verglichen waere "0.10.9" groesser. Genau daran scheitern
    // handgeschriebene Vergleiche, und zwar still.
    expect(vergleicheVersionen('0.10.9', '0.10.124')).toBeLessThan(0);
  });

  it('schneidet Vorabkennungen ab', () => {
    expect(vergleicheVersionen('0.11.0-rc1', '0.10.124')).toBeGreaterThan(0);
  });
});

describe('pruefe — das Urteil', () => {
  it('GEGENPROBE: Quelldatei geaendert, Nummer gleich -> NEIN', () => {
    const u = pruefe({
      basisVersion: '0.10.124',
      neueVersion: '0.10.124',
      dateien: ['sdk/mcp/src/handlers/instances.ts'],
    });
    expect(u.ok, 'der Waechter hat den Fall vom 20.08.2026 durchgelassen').toBe(false);
    expect(u.meldung).toContain('npm version patch');
    expect(u.meldung).toContain('sdk/mcp/src/handlers/instances.ts');
  });

  it('Quelldatei geaendert, Nummer gestiegen -> JA', () => {
    const u = pruefe({
      basisVersion: '0.10.124',
      neueVersion: '0.10.125',
      dateien: ['sdk/mcp/src/handlers/instances.ts'],
    });
    expect(u.ok).toBe(true);
  });

  it('nur ein Test geaendert, Nummer gleich -> JA', () => {
    // Sonst wuerde der Waechter umgangen statt befolgt: wer fuer jede
    // Testzeile die Nummer heben muss, hebt sie irgendwann blind.
    const u = pruefe({
      basisVersion: '0.10.124',
      neueVersion: '0.10.124',
      dateien: ['sdk/mcp/src/spuren.test.ts', 'README.md'],
    });
    expect(u.ok).toBe(true);
  });

  it('gesunkene Nummer wird ausdruecklich als solche benannt', () => {
    const u = pruefe({
      basisVersion: '0.10.124',
      neueVersion: '0.9.0',
      dateien: ['sdk/mcp/src/bedeutung.ts'],
    });
    expect(u.ok).toBe(false);
    expect(u.meldung).toContain('GESUNKEN');
  });

  it('die Meldung nennt beide Nummern, nicht nur "failed"', () => {
    const u = pruefe({
      basisVersion: '0.10.124',
      neueVersion: '0.10.124',
      dateien: ['sdk/mcp/src/search.ts'],
    });
    expect(u.meldung).toContain('0.10.124');
  });
});

describe('versionAus — kaputte Eingaben fallen auf, statt still zu gelten', () => {
  it('liest die Version', () => {
    expect(versionAus('{"version":"1.2.3"}', 'Probe')).toBe('1.2.3');
  });

  it('wirft bei ungueltiger JSON', () => {
    expect(() => versionAus('{kaputt', 'Probe')).toThrow(/gueltige JSON/);
  });

  it('wirft, wenn das Feld fehlt', () => {
    // Ein fehlendes Feld darf NICHT als "0" durchgehen — dann waere jeder
    // Vergleich ein Sprung nach oben und der Waechter waere blind.
    expect(() => versionAus('{"name":"x"}', 'Probe')).toThrow(/version/);
  });
});
