/**
 * Ende zu Ende ueber das echte Werkzeug: ein Schluessel in learn_from_attempts
 * erreicht den Speicher nicht, und die Antwort traegt einen Beleg.
 *
 * Gegenprobe: ersetzt man in brain.ts `geschwaerzt.felder` wieder durch `args`,
 * faellt "der Wert steht nirgends im Speicher".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Geheimnis im Schreibweg', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const SCHLUESSEL = 'ghp_' + 'Q'.repeat(36);

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('der Wert steht nirgends im Speicher, die Antwort nennt nur die Art', async () => {
    const aus = String(
      await handleBrainTool(
        'learn_from_attempts',
        {
          instance_id: 'i1',
          topic: 'ci:token-im-befehl',
          outcome: 'success',
          what_worked: `git push mit https://x:${SCHLUESSEL}@github.com/o/r`,
          commands: [`gh auth login --with-token ${SCHLUESSEL}`],
        },
        getConn,
        noopApiFetch,
      ),
    );

    // Alles, was die Attrappe haelt (Schluessel, Listen, Mengen, Hashes).
    const gespeichert = JSON.stringify(
      Object.values(redis as unknown as Record<string, unknown>)
        .filter((v): v is Map<string, unknown> => v instanceof Map)
        .map((m) => [...m.entries()].map(([k, v]) => [k, v instanceof Set ? [...v] : v])),
    );
    expect(gespeichert).not.toContain(SCHLUESSEL);
    expect(gespeichert).toContain('[GESCHWAERZT]');
    expect(aus).not.toContain(SCHLUESSEL);
    expect(aus).toContain('Geheimnis(se) geschwaerzt');
    expect(aus).toMatch(/Beleg: `[0-9a-f]{8}`/);
  });

  it('ohne Geheimnis: kein Hinweis, Beleg wie immer', async () => {
    const aus = String(
      await handleBrainTool(
        'learn_from_attempts',
        { instance_id: 'i1', topic: 'ci:sauber', outcome: 'success', what_worked: 'gh auth login mit $GH_TOKEN' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(aus).not.toContain('geschwaerzt');
    expect(aus).toMatch(/Beleg: `[0-9a-f]{8}`/);
  });
});
