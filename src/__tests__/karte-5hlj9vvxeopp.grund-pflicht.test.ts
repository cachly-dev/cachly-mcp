/**
 * Karte 5hlj9vvxeopp — Jede Aktualisierung einer Lektion traegt ein Warum.
 *
 * Der Git-Import (brain_from_git) liest Commit-Botschaften, WEIL sie den
 * Ausloeser und die Begruendung tragen — und der eigene Update-Pfad warf
 * genau diese Information weg. Vorschlag pm25coder (21.08., Artikel 4417069):
 * "Require a one-line 'why' on every update, same as a commit message."
 *
 * Abnahmebedingung der Karte: Ein Update ohne Grund wird abgewiesen.
 * recall_best_solution zeigt die Warum-Zeilen der letzten Fassungen.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte 5hlj9vvxeopp — grund-Pflicht beim Update', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('erstes Anlegen braucht KEINEN grund', async () => {
    const out = await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success',
      what_worked: 'Der Deploy laeuft ueber das eigene Registry-Image.',
    }, getConn, noopApiFetch);
    expect(String(out)).toContain('stored');
    expect(await redis.get('cachly:lesson:best:deploy:probe')).toBeTruthy();
  });

  it('Update OHNE grund wird abgewiesen — und die Lektion bleibt unveraendert', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success',
      what_worked: 'Fassung eins.',
    }, getConn, noopApiFetch);
    const vorher = await redis.get('cachly:lesson:best:deploy:probe');

    const out = await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success',
      what_worked: 'Fassung zwei — ohne Begruendung.',
    }, getConn, noopApiFetch);

    expect(String(out)).toContain('Update abgewiesen');
    expect(String(out)).toContain('grund');
    // Das Artefakt schlaegt die Meldung: der Bestand traegt weiter Fassung eins.
    expect(await redis.get('cachly:lesson:best:deploy:probe')).toBe(vorher);
  });

  it('KONTROLLE: Update MIT grund geht durch, und der audit_trail traegt die Warum-Zeile', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success',
      what_worked: 'Fassung eins.',
    }, getConn, noopApiFetch);
    const out = await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success',
      what_worked: 'Fassung zwei.',
      grund: 'Fassung eins nannte den Runner, nicht das Image — der Runner wechselt.',
    }, getConn, noopApiFetch);
    expect(String(out)).toContain('updated');

    const stored = JSON.parse((await redis.get('cachly:lesson:best:deploy:probe'))!) as {
      what_worked: string;
      audit_trail: Array<{ action: string; grund?: string }>;
    };
    expect(stored.what_worked).toBe('Fassung zwei.');
    const letzter = stored.audit_trail[stored.audit_trail.length - 1];
    expect(letzter.grund).toContain('der Runner wechselt');
  });

  it('recall_best_solution zeigt die Warum-Zeilen der letzten Fassungen', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success',
      what_worked: 'Fassung eins.',
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success',
      what_worked: 'Fassung zwei.',
      grund: 'Die IP stimmte nicht mehr — Peer .7 statt .4.',
    }, getConn, noopApiFetch);

    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:probe',
    }, getConn, noopApiFetch));
    expect(out).toContain('Warum zuletzt geaendert');
    expect(out).toContain('Peer .7 statt .4');
  });
});
