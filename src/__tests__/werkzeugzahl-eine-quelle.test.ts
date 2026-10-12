import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools.js';
import { KERNWERKZEUGE, VERTEILER, sichtbareWerkzeuge } from '../werkzeug-auswahl.js';
// @ts-expect-error — reines JS-Modul, absichtlich ohne Typen: der Waechter
// laeuft in der CI mit blossem node, ohne Bauschritt davor.
import { falscheWerkzeugZahlen, zaehleKatalogEintraege } from '../../scripts/werkzeug-zahlen.mjs';

/**
 * ABNAHME: die Werkzeugzahl hat eine Quelle, und sie ist ehrlich.
 *
 * ── Der Befund vom 12.10.2026 ───────────────────────────────────────────────
 *
 * Die Zahl stand je nach Ort als 63, 84, 120+, 122, 124 und 126 da: auf der
 * Glama-Seite, bei Smithery, in der GitHub-Beschreibung, in Blogposts und in
 * den Paket-Manifesten. Die Paket-Manifeste (server.json, package.json,
 * smithery.yaml) landen in Verzeichnissen, die ihren Text wochenlang
 * zwischenspeichern. Eine getippte Zahl dort ist beim naechsten Werkzeug
 * schon falsch, und niemand kann sie von aussen nachziehen.
 *
 * ── Was ehrlich ist ─────────────────────────────────────────────────────────
 *
 *     124   Werkzeuge kennt der Server (TOOLS in tools.ts)
 *      27   Eintraege listet tools/list standardmaessig:
 *           26 Kernwerkzeuge + der Verteiler `cachly_tool`
 *      98   laufen ueber den Verteiler
 *
 * "124" allein las sich wie ein Katalog, den kein Editor zeigt. "27" allein
 * verschweigt 98. Beide Saetze sind wahr; der Waechter
 * (scripts/verify-tool-counts.mjs) laesst deshalb beide Zahlen durch und
 * jede andere nicht.
 *
 * ── Was dieser Block festhaelt ──────────────────────────────────────────────
 *
 * 1. Die Zahl, die der Waechter aus der Kernliste LIEST, ist die Zahl, die der
 *    Server zur Laufzeit WIRKLICH auflistet.
 * 2. Eine falsche Zahl neben "tools" faellt auf, auch die knapp danebenliegende.
 * 3. Die Verzeichnis-Texte nennen GAR KEINE Zahl.
 */

const lies = (datei: string): string =>
  readFileSync(new URL(`../../${datei}`, import.meta.url), 'utf8');

const GESAMT = TOOLS.length;
const gelistet = (): number => zaehleKatalogEintraege() as number;

describe('Die zwei wahren Zahlen kommen aus dem Code', () => {
  it('der Waechter liest dieselbe Zahl, die der Server im Standard auflistet', () => {
    const { katalog, uebrige, unbekannteKernnamen } = sichtbareWerkzeuge(TOOLS, {});
    expect(unbekannteKernnamen, 'ein Kernname ohne Werkzeug stuende nirgends').toEqual([]);
    expect(katalog.length).toBe(gelistet());
    expect(katalog.map((w) => w.name)).toContain(VERTEILER);
    expect(katalog.length).toBe(KERNWERKZEUGE.length + 1);
    expect(uebrige.length).toBe(GESAMT - KERNWERKZEUGE.length);
  });

  it('die gelistete Zahl ist kleiner als die Gesamtzahl (sonst gaebe es keinen Verteiler)', () => {
    expect(gelistet()).toBeLessThan(GESAMT);
  });

  it('der Zaehler liest keine Namen aus Kommentaren', () => {
    const quelle = [
      "export const VERTEILER = 'cachly_tool';",
      'export const KERNWERKZEUGE: readonly string[] = [',
      "  'eins', // 'kein_werkzeug'",
      "  // 'auch_keins'",
      "  'zwei',",
      '];',
    ].join('\n');
    expect(zaehleKatalogEintraege(quelle)).toBe(3); // eins, zwei + Verteiler
  });

  it('der Zaehler wirft, statt null zu melden', () => {
    expect(() => zaehleKatalogEintraege('nichts davon')).toThrow(/KERNWERKZEUGE/);
    expect(() =>
      zaehleKatalogEintraege("export const KERNWERKZEUGE = [\n];\nexport const VERTEILER = 'cachly_tool';"),
    ).toThrow(/kein Name/);
  });
});

describe('Eine falsche Zahl neben "tools" faellt auf', () => {
  const wahr = (): number[] => [GESAMT, gelistet()];

  it('beide wahren Zahlen gehen durch', () => {
    const text = `Your editor lists ${gelistet()} tools. All ${GESAMT} MCP tools run through one of them.`;
    expect(falscheWerkzeugZahlen(text, wahr())).toEqual([]);
  });

  it('GEGENPROBE: die alten Zahlen aus dem Befund fallen auf', () => {
    for (const alt of [63, 84, 122, 126]) {
      expect(falscheWerkzeugZahlen(`${alt} MCP tools`, wahr()), String(alt)).toHaveLength(1);
    }
  });

  it('GEGENPROBE: auch die knapp danebenliegende Zahl faellt auf', () => {
    expect(falscheWerkzeugZahlen(`${gelistet() - 1} tools`, wahr())).toHaveLength(1);
    expect(falscheWerkzeugZahlen(`${GESAMT + 1} MCP tools`, wahr())).toHaveLength(1);
  });

  it('GEGENPROBE: Schreibweisen mit Unterstrich, Bindestrich und Klammer', () => {
    // Ein Satz darf von mehreren Mustern getroffen werden; es zaehlt, dass er auffaellt.
    for (const text of ['badge/126_MCP_tools-violet', 'a 126-tool MCP server', 'MCP Tools (126 total)']) {
      expect(falscheWerkzeugZahlen(text, wahr()).length, text).toBeGreaterThan(0);
    }
  });
});

describe('Verzeichnis-Texte nennen keine Werkzeugzahl', () => {
  const ZAHL = /\d+\+?[\s_-]+(?:MCP[\s_-]+)?(?:tools?|Werkzeuge?)\b/i;

  it('package.json (npm)', () => {
    const beschreibung = (JSON.parse(lies('package.json')) as { description: string }).description;
    expect(beschreibung).not.toMatch(ZAHL);
  });

  it('server.json (MCP-Registry, PulseMCP)', () => {
    const beschreibung = (JSON.parse(lies('server.json')) as { description: string }).description;
    expect(beschreibung).not.toMatch(ZAHL);
    // Die Registry lehnt Beschreibungen ueber 100 Zeichen ab.
    expect(beschreibung.length).toBeLessThanOrEqual(100);
  });

  it('smithery.yaml (Smithery)', () => {
    expect(lies('smithery.yaml')).not.toMatch(ZAHL);
  });

  it('GEGENPROBE: das Muster erkennt die alten Texte', () => {
    expect('Experience for coding agents, EU-hosted. 124 MCP tools.').toMatch(ZAHL);
    expect('124 MCP tools, among them causal root-cause analysis').toMatch(ZAHL);
    expect('120+ MCP tools').toMatch(ZAHL);
  });
});

describe('Die README nennt beide Zahlen und den Verteiler', () => {
  it('Gesamtzahl, Editor-Zahl und cachly_tool stehen im Text', () => {
    const readme = lies('README.md');
    expect(readme).toContain(String(GESAMT));
    expect(readme).toContain(String(gelistet()));
    expect(readme).toContain(VERTEILER);
  });

  it('das Profil "lean" zaehlt den Verteiler mit (8 Werkzeuge + cachly_tool)', () => {
    const { katalog } = sichtbareWerkzeuge(TOOLS, { CACHLY_PROFILE: 'lean' });
    expect(katalog.map((w) => w.name)).toContain(VERTEILER);
    const readme = lies('README.md');
    expect(readme).toMatch(/lean[^|\n]*plus[^|\n]*`cachly_tool`/i);
  });
});
