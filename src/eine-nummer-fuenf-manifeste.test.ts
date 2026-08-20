import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — reines JS-Modul, absichtlich ohne Typen: es laeuft am
// npm-Haken mit blossem node, ohne Bauschritt davor.
import { STELLEN, ersetzeInJson, ersetzeInYaml, zaehleStellen, ziehNach } from '../scripts/nummer-nachziehen.mjs';

/**
 * ABNAHME: eine Nummer, fuenf Dateien, ein Handgriff.
 *
 * ── Der Vorfall vom 20.08.2026 ──────────────────────────────────────────────
 *
 * Die Nummer wurde von 0.10.124 auf 0.10.125 gehoben. Merge gruen, alle
 * Pruefungen gruen — und die Veroeffentlichung fiel danach ZWEIMAL um:
 *
 *   Version drift — package.json=0.10.125 but server.json=0.10.124
 *   ... but server.json.packages[0]=0.10.124
 *   ... but glama.json=0.10.124
 *   ... but smithery.yaml=0.10.124
 *
 * Wirkung: die neue Fassung liegt nicht auf npm. Wer installiert, bekommt
 * weiter den alten Stand.
 *
 * Das Bittere daran: der Anlass fuer den Versionssprung war, dass ein alter
 * und ein neuer Build dieselbe Nummer trugen. Die Behebung hat den Zustand
 * verlaengert statt beendet — weil sie nur eine von fuenf Stellen kannte.
 *
 * Der Waechter hat richtig Nein gesagt. Gemerkt hat es niemand, weil die
 * Veroeffentlichung NACH dem Merge laeuft und keinen PR mehr rot faerbt.
 */

const lies = (datei: string): string =>
  readFileSync(new URL(`../${datei}`, import.meta.url), 'utf8');

const version = (): string =>
  (JSON.parse(lies('package.json')) as { version: string }).version;

describe('Alle Manifeste tragen dieselbe Nummer', () => {
  it.each(STELLEN as string[])('%s steht auf der Nummer aus package.json', (datei) => {
    const text = lies(datei);
    const soll = version();
    const treffer = datei.endsWith('.yaml')
      ? [...text.matchAll(/^version:\s*(\S+)/gm)].map((m) => m[1])
      : [...text.matchAll(/"version"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);

    expect(treffer.length, `${datei} hat kein Versionsfeld`).toBeGreaterThan(0);
    for (const gefunden of treffer) {
      expect(gefunden, `${datei} steht auf ${gefunden}, package.json auf ${soll}`).toBe(soll);
    }
  });

  it('server.json traegt die Nummer an ZWEI Stellen — beide zaehlen', () => {
    // Der Publish-Waechter meldet sie getrennt ("server.json" und
    // "server.json.packages[0]"). Wer nur die erste zieht, faellt trotzdem.
    expect(zaehleStellen(lies('server.json'), 'server.json')).toBe(2);
  });
});

describe('Der Haken zieht sie nach', () => {
  it('das npm-Skript "version" ruft das Nachziehen VOR den Schnappschuessen', () => {
    const s = (JSON.parse(lies('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(s.version).toContain('nummer-nachziehen');
    expect(s.version).toContain('tool-spec-snapshots');
  });
});

describe('ersetzeInJson / ersetzeInYaml', () => {
  it('trifft alle Vorkommen in einer JSON', () => {
    const vorher = '{"version": "1.0.0", "packages": [{"version": "1.0.0"}]}';
    expect(ersetzeInJson(vorher, '1.0.1')).toBe('{"version": "1.0.1", "packages": [{"version": "1.0.1"}]}');
  });

  it('laesst die Formatierung in Ruhe', () => {
    // JSON.parse + stringify wuerde Einrueckung und Reihenfolge neu schreiben
    // und jeden Unterschied unlesbar machen.
    const vorher = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    expect(ersetzeInJson(vorher, '2.0.0')).toBe('{\n  "name": "x",\n  "version": "2.0.0"\n}\n');
  });

  it('trifft in YAML nur die Zeile, die mit version: beginnt', () => {
    const vorher = 'name: x\nversion: 1.0.0\ndescription: >\n  hier steht version: 9.9.9 im Fliesstext\n';
    const nachher = ersetzeInYaml(vorher, '1.0.1');
    expect(nachher).toContain('version: 1.0.1');
    expect(nachher, 'der Fliesstext wurde mitveraendert').toContain('hier steht version: 9.9.9');
  });

  it('GEGENPROBE: eine Datei ohne Versionsfeld wird als 0 Stellen erkannt', () => {
    // Der Erzeuger bricht dann ab, statt still nichts zu tun. Ohne diese Probe
    // waere ein gruener Lauf kein Beweis — er koennte auch heissen, dass gar
    // nicht hingesehen wird.
    expect(zaehleStellen('{"name":"x"}', 'server.json')).toBe(0);
    expect(zaehleStellen('name: x\n', 'smithery.yaml')).toBe(0);
  });

  it('ziehNach waehlt das Verfahren nach der Endung', () => {
    expect(ziehNach('version: 1.0.0\n', 'smithery.yaml', '2.0.0')).toContain('version: 2.0.0');
    expect(ziehNach('{"version":"1.0.0"}', 'server.json', '2.0.0')).toContain('"version":"2.0.0"');
  });
});
