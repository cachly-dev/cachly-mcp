/**
 * Aufrufer an die API weiterreichen (19.11.2026).
 *
 * Alle Aufrufe von mcp.cachly.dev kamen bei der API von einer Adresse an und
 * teilten sich deren Grenze von 120/min. Jetzt traegt jeder Aufruf an die API
 * das gemeinsame Geheimnis und die Adresse des Nutzers. Wichtigste Regel: das
 * Geheimnis geht NIE an einen anderen Host als die API.
 */
import { describe, expect, it } from 'vitest';
import {
  apiKoepfeFuer,
  aktuellerAufrufer,
  imAufrufer,
  installiereApiKoepfe,
  MCP_AUFRUFER_KOPF,
  MCP_GEHEIMNIS_KOPF,
} from '../remote-zugang.js';

const API = 'http://cachly-api-intern:3001';
const GEHEIM = 'f'.repeat(64);

describe('apiKoepfeFuer', () => {
  it('setzt beide Koepfe fuer Aufrufe an die API', () => {
    expect(apiKoepfeFuer(`${API}/api/v1/instances`, API, GEHEIM, '203.0.113.7')).toEqual({
      [MCP_GEHEIMNIS_KOPF]: GEHEIM,
      [MCP_AUFRUFER_KOPF]: '203.0.113.7',
    });
  });

  it('schickt das Geheimnis nie an einen anderen Host', () => {
    for (const fremd of [
      'https://api.cachly.dev/v1/sem/abc',
      'http://cachly-api-intern:3002/api/v1/instances',
      'https://cachly-api-intern:3001/api/v1/instances',
      'http://cachly-api-intern.evil.example:3001/x',
      'http://evil.example/?u=http://cachly-api-intern:3001',
      'kein url',
    ]) {
      expect(apiKoepfeFuer(fremd, API, GEHEIM, '203.0.113.7'), fremd).toBeUndefined();
    }
  });

  it('bleibt aus ohne Geheimnis, mit zu kurzem Geheimnis oder ohne echte IP', () => {
    const url = `${API}/health`;
    expect(apiKoepfeFuer(url, API, undefined, '203.0.113.7')).toBeUndefined();
    expect(apiKoepfeFuer(url, API, 'x'.repeat(31), '203.0.113.7')).toBeUndefined();
    expect(apiKoepfeFuer(url, API, GEHEIM, undefined)).toBeUndefined();
    expect(apiKoepfeFuer(url, API, GEHEIM, 'unbekannt')).toBeUndefined();
  });
});

describe('installiereApiKoepfe', () => {
  function attrappe() {
    const gesehen: Array<{ url: string; koepfe: Headers }> = [];
    const ziel = {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        gesehen.push({ url, koepfe: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
        return new Response('{}');
      }) as typeof fetch,
    };
    return { ziel, gesehen };
  }

  it('haengt die Koepfe nur innerhalb einer Anfrage an und behaelt vorhandene Koepfe', async () => {
    const { ziel, gesehen } = attrappe();
    expect(installiereApiKoepfe(API, GEHEIM, ziel)).toBe(true);

    await ziel.fetch(`${API}/api/v1/instances`, { headers: { Authorization: 'Bearer cky_test' } });
    await imAufrufer('203.0.113.7', async () => {
      await ziel.fetch(`${API}/api/v1/instances`, { headers: { Authorization: 'Bearer cky_test' } });
      await ziel.fetch('https://api.cachly.dev/v1/sem/abc');
      await ziel.fetch(new Request(`${API}/api/v1/brain/x`, { headers: { Accept: 'application/json' } }));
    });

    const [ausserhalb, innen, fremd, mitRequest] = gesehen;
    expect(ausserhalb.koepfe.get(MCP_GEHEIMNIS_KOPF)).toBeNull();
    expect(innen.koepfe.get(MCP_GEHEIMNIS_KOPF)).toBe(GEHEIM);
    expect(innen.koepfe.get(MCP_AUFRUFER_KOPF)).toBe('203.0.113.7');
    expect(innen.koepfe.get('authorization')).toBe('Bearer cky_test');
    expect(fremd.koepfe.get(MCP_GEHEIMNIS_KOPF)).toBeNull();
    expect(mitRequest.koepfe.get(MCP_AUFRUFER_KOPF)).toBe('203.0.113.7');
    expect(mitRequest.koepfe.get('accept')).toBe('application/json');
  });

  it('installiert nichts ohne Geheimnis', () => {
    const { ziel } = attrappe();
    const vorher = ziel.fetch;
    expect(installiereApiKoepfe(API, '', ziel)).toBe(false);
    expect(ziel.fetch).toBe(vorher);
  });

  it('haelt gleichzeitige Anfragen auseinander', async () => {
    const { ziel, gesehen } = attrappe();
    installiereApiKoepfe(API, GEHEIM, ziel);
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.all([
      imAufrufer('203.0.113.1', async () => { await pause(5); await ziel.fetch(`${API}/a`); }),
      imAufrufer('203.0.113.2', async () => { await ziel.fetch(`${API}/b`); }),
    ]);
    const nachUrl = Object.fromEntries(gesehen.map((g) => [new URL(g.url).pathname, g.koepfe.get(MCP_AUFRUFER_KOPF)]));
    expect(nachUrl).toEqual({ '/a': '203.0.113.1', '/b': '203.0.113.2' });
    expect(aktuellerAufrufer()).toBeUndefined();
  });
});
