/**
 * Karte y48oajjojklf — Jede Lektion traegt ihren Urheber: source.agent und
 * source.principal.
 *
 * Anlass (Izgorodin, dev.to 02.09.2026): Zeitstempel sagen WANN, nicht WER.
 * Erst Identitaet speichern, dann (spaeter) Autoritaet — hier nur speichern.
 *
 * GEGENPROBE: der Schluessel selbst steht NIE im Datensatz; ohne Zugangsdaten
 * fehlt principal, ohne Agent steht "unbekannt" und der Abruf sagt es.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { ermittleQuelle, setzeClientKennung, quelleZeile } from '../herkunft.js';

describe('Karte y48oajjojklf — Herkunft einer Lektion', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const env = { ...process.env };

  beforeEach(() => { redis = new MockRedis(); setzeClientKennung(); });
  afterEach(() => { process.env = { ...env }; setzeClientKennung(); });

  it('ermittleQuelle: Agent aus CACHLY_AGENT, Konto als Fingerabdruck — nie der Schluessel', () => {
    const q = ermittleQuelle({ CACHLY_AGENT: 'probe-agent', CACHLY_JWT: 'cky_live_geheim123' } as NodeJS.ProcessEnv);
    expect(q.agent).toBe('probe-agent');
    expect(q.principal).toMatch(/^key:[0-9a-f]{12}$/);
    expect(JSON.stringify(q)).not.toContain('geheim');
    expect(q.via).toBe('mcp');
  });

  it('ermittleQuelle: JWT liefert sub, MCP-Client liefert den Agenten, sonst "unbekannt"', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'tenant-42' })).toString('base64url');
    const q = ermittleQuelle({ CACHLY_JWT: `h.${payload}.s` } as NodeJS.ProcessEnv);
    expect(q.principal).toBe('sub:tenant-42');
    expect(q.agent).toBe('unbekannt');
    setzeClientKennung('claude-code', '2.1.0');
    expect(ermittleQuelle({} as NodeJS.ProcessEnv).agent).toBe('claude-code/2.1.0');
  });

  it('die gespeicherte Lektion traegt source, und recall_best_solution zeigt die Zeile', async () => {
    process.env.CACHLY_AGENT = 'probe-agent';
    process.env.CACHLY_JWT = 'cky_live_geheim123';
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:port', outcome: 'success', what_worked: 'Port 6543.', author: 'alice',
    }, getConn, noopApiFetch);
    const raw = (await redis.get('cachly:lesson:best:deploy:port'))!;
    const l = JSON.parse(raw) as { source?: { agent: string; principal?: string; via: string } };
    expect(l.source?.agent).toBe('probe-agent');
    expect(l.source?.principal).toMatch(/^key:/);
    expect(raw).not.toContain('geheim');

    const out = String(await handleBrainTool('recall_best_solution', { instance_id: 'i1', topic: 'deploy:port' }, getConn, noopApiFetch));
    expect(out).toContain('**Source:** @alice · via probe-agent · key:');
  });

  it('GEGENPROBE: Altbestand ohne source und ohne Autor zeigt "Urheber unbekannt"', () => {
    expect(quelleZeile(undefined, undefined)).toContain('Urheber unbekannt');
    expect(quelleZeile('bob', { agent: 'unbekannt', via: 'mcp' })).toBe('👤 **Source:** @bob');
  });
});
