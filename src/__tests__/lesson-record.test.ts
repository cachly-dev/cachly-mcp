/**
 * Vertrag zwischen MCP-Server und den Adaptern fuer den Datensatz einer Lektion
 * (GROW-028, docs/spec/lesson-record.json).
 *
 * Der MCP-Server und die Adapter sdk/agents (Python) und sdk/openclaw (TS) lesen
 * und schreiben DENSELBEN Schluessel cachly:lesson:best:<topic> direkt in Valkey.
 * Bisher prueften nur die beiden Adapter gegeneinander (confidence-vectors) —
 * ob sie den Datensatz des MCP-Servers lesen koennen, pruefte niemand.
 *
 * Der Python-Zwilling: sdk/agents/tests/test_lesson_record.py.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';
import { IM_MONOREPO } from './im-monorepo.js';
import { REPO_ROOT, loadBrainModule, speicherVon } from './openclaw-brain.js';

interface Vertrag {
  adapter_lesen: Record<string, 'string' | 'number' | 'array'>;
  fluechtig: string[];
  mcp_eingabe: Record<string, unknown> & { topic: string; what_worked: string };
  mcp_datensatz: Record<string, unknown>;
}

const apiFetch = (async () => ({})) as unknown as Parameters<typeof handleBrainTool>[3];

async function mcpLernt(eingabe: Record<string, unknown>): Promise<{ redis: MockRedis; datensatz: Record<string, unknown> }> {
  const redis = new MockRedis();
  await handleBrainTool('learn_from_attempts', { instance_id: 'i1', ...eingabe }, async () => redis as unknown as Redis, apiFetch);
  const roh = await redis.get(`cachly:lesson:best:${eingabe.topic as string}`);
  expect(roh, 'MCP hat keinen Datensatz geschrieben').toBeTruthy();
  return { redis, datensatz: JSON.parse(roh!) as Record<string, unknown> };
}

describe('Lektions-Datensatz: MCP-Server und Adapter (docs/spec/lesson-record.json)', () => {
  // Nur im Monorepo: Vertrag und Adapter liegen ausserhalb dieses Pakets.
  if (!IM_MONOREPO) {
    it.skip('ausserhalb des Monorepos uebersprungen', () => {});
    return;
  }
  const v = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/spec/lesson-record.json'), 'utf8')) as Vertrag;
  const brainModule = loadBrainModule();
  const schluessel = `cachly:lesson:best:${v.mcp_eingabe.topic}`;

  it('MCP schreibt jedes Feld, das die Adapter lesen, mit dem erwarteten Typ', async () => {
    const { datensatz } = await mcpLernt(v.mcp_eingabe);
    for (const [feld, typ] of Object.entries(v.adapter_lesen)) {
      const wert = datensatz[feld];
      const ist = Array.isArray(wert) ? 'array' : typeof wert;
      expect(ist, `Feld "${feld}"`).toBe(typ);
    }
  });

  it('MCP schreibt genau den Datensatz aus der Vorlage (neues Feld = Adapter ansehen, dann Vorlage nachziehen)', async () => {
    const { datensatz } = await mcpLernt(v.mcp_eingabe);
    const ohneFluechtiges = Object.fromEntries(
      Object.entries(datensatz).map(([k, w]) => [k, v.fluechtig.includes(k) ? '<fluechtig>' : w]),
    );
    expect(ohneFluechtiges).toEqual(v.mcp_datensatz);
  });

  it('openclaw liest den MCP-Datensatz: Abruf findet ihn, Briefing nennt was half, alle Felder bleiben', async () => {
    const { datensatz } = await mcpLernt(v.mcp_eingabe);
    const brain = brainModule.createCachlyBrain({ url: 'redis://fake:6379' });
    speicherVon(brain).set(schluessel, JSON.stringify(datensatz));

    const treffer = await brain.recall('docker compose deploy');
    expect(treffer.map((t) => t.lesson.topic)).toEqual([v.mcp_eingabe.topic]);
    expect(brain.formatBriefing(treffer)).toContain(v.mcp_eingabe.what_worked);

    const nachher = JSON.parse(speicherVon(brain).get(schluessel)!) as Record<string, unknown>;
    expect(Object.keys(nachher).sort()).toEqual(Object.keys(datensatz).sort());
    expect(nachher.recall_count).toBe(1);
  });

  it('MCP liest einen Datensatz, den openclaw geschrieben hat', async () => {
    const brain = brainModule.createCachlyBrain({ url: 'redis://fake:6379' });
    await brain.learn({ topic: 'ci:cache', outcome: 'success', whatWorked: 'restore keys mit Zweigname', tags: ['ci'] });
    const redis = new MockRedis();
    await redis.set('cachly:lesson:best:ci:cache', speicherVon(brain).get('cachly:lesson:best:ci:cache')!);

    const antwort = String(await handleBrainTool('recall_best_solution', { instance_id: 'i1', topic: 'ci:cache' }, async () => redis as unknown as Redis, apiFetch));
    expect(antwort).toContain('restore keys mit Zweigname');
  });

  it('openclaw learn() auf einen MCP-Datensatz behaelt alle Felder und schreibt die Pruefspur weiter', async () => {
    const { datensatz } = await mcpLernt(v.mcp_eingabe);
    const brain = brainModule.createCachlyBrain({ url: 'redis://fake:6379' });
    speicherVon(brain).set(schluessel, JSON.stringify(datensatz));
    await brain.learn({ topic: v.mcp_eingabe.topic, outcome: 'success' });
    const nachher = JSON.parse(speicherVon(brain).get(schluessel)!) as Record<string, unknown>;
    for (const feld of Object.keys(datensatz)) expect(nachher, `Feld "${feld}"`).toHaveProperty(feld);
    expect(nachher.context).toBe(datensatz.context);
    expect(nachher.visibility).toBe('team');
    const spur = nachher.audit_trail as Array<Record<string, unknown>>;
    expect(spur).toHaveLength((datensatz.audit_trail as unknown[]).length + 1);
    expect(spur.at(-1)).toMatchObject({ action: 'updated', via: '@cachly-dev/openclaw' });
  });

  it('openclaw zeigt private und gruppengebundene Lektionen nicht (wie smart_recall)', async () => {
    const { datensatz } = await mcpLernt(v.mcp_eingabe);
    const brain = brainModule.createCachlyBrain({ url: 'redis://fake:6379' });
    speicherVon(brain).set('cachly:lesson:best:deploy:privat', JSON.stringify({ ...datensatz, topic: 'deploy:privat', visibility: 'private' }));
    speicherVon(brain).set('cachly:lesson:best:deploy:gruppe', JSON.stringify({ ...datensatz, topic: 'deploy:gruppe', group: 'backend' }));
    const treffer = await brain.recall('docker compose deploy');
    expect(treffer).toEqual([]);
  });

  it('openclaw: eine ersetzte Lektion weicht ihrer Nachfolgerin; ohne Nachfolgerin heisst sie veraltet', async () => {
    const { datensatz } = await mcpLernt(v.mcp_eingabe);
    const brain = brainModule.createCachlyBrain({ url: 'redis://fake:6379' });
    const alt = { ...datensatz, topic: 'deploy:api-alt', ersetzt_durch: 'deploy:api', gilt_bis: '2026-01-02T00:00:00.000Z' };
    speicherVon(brain).set('cachly:lesson:best:deploy:api-alt', JSON.stringify(alt));
    speicherVon(brain).set(schluessel, JSON.stringify(datensatz));
    expect((await brain.recall('docker compose deploy')).map((t) => t.lesson.topic)).toEqual([v.mcp_eingabe.topic]);

    speicherVon(brain).delete(schluessel);
    const nurAlt = await brain.recall('docker compose deploy');
    expect(nurAlt.map((t) => t.lesson.topic)).toEqual(['deploy:api-alt']);
    expect(brain.formatBriefing(nurAlt)).toContain('deploy:api-alt (outdated since 2026-01-02, replaced by deploy:api)');
  });
});
