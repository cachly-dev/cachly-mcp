import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { handleBrainTool } from '../handlers/brain.js';
import { handleFedbrainTool } from '../handlers/fedbrain.js';

/**
 * Befund 13.11.2026 (Sitzung cachly-e4): learn_from_attempts meldete
 * "Auto-shared with team" auch bei visibility "private" und legte eine
 * Team-Kopie ohne Sichtbarkeitsfeld in die Themenliste.
 *
 * Beim Nachsehen kam eine zweite Luecke dazu: Ein Update ohne `visibility`
 * schrieb den Standard "team" — eine private Lektion wurde still teamweit,
 * eine Gruppen-Grenze fiel weg. Ohne Angabe gilt jetzt die gespeicherte Fassung.
 */

const noopApiFetch = (async () => null) as unknown as Parameters<typeof handleBrainTool>[3];

describe('learn_from_attempts: Sichtbarkeit', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(() => { redis = new MockRedis(); });

  const lerne = (extra: Record<string, unknown>) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'cv:pdf-aus-html', outcome: 'success',
      what_worked: 'Edge headless druckt das HTML als PDF', author: 'heinrich', ...extra,
    }, getConn, noopApiFetch).then(String);

  const gespeichert = async () =>
    JSON.parse((await redis.get('cachly:lesson:best:cv:pdf-aus-html'))!) as { visibility?: string; group?: string };

  const teamKopien = async () =>
    (await redis.lrange('cachly:lessons:cv:pdf-aus-html', 0, -1))
      .map(r => JSON.parse(r) as { auto_propagated?: boolean })
      .filter(l => l.auto_propagated).length;

  it('privat: keine Team-Zeile, keine Team-Kopie, dafuer der Hinweis "Private"', async () => {
    const out = await lerne({ visibility: 'private' });
    expect(out).not.toContain('Auto-shared with team');
    expect(out).toContain('🔒 Private');
    expect(await teamKopien()).toBe(0);
    expect((await gespeichert()).visibility).toBe('private');
  });

  it('team (Standard): Team-Zeile und Team-Kopie wie bisher', async () => {
    const out = await lerne({});
    expect(out).toContain('Auto-shared with team');
    expect(await teamKopien()).toBe(1);
    expect((await gespeichert()).visibility).toBe('team');
  });

  it('Gruppe: keine Team-Zeile, sondern der Gruppenhinweis', async () => {
    const out = await lerne({ group: 'backend' });
    expect(out).not.toContain('Auto-shared with team');
    expect(out).toContain('Group `backend` only');
    expect(await teamKopien()).toBe(0);
  });

  it('Update ohne visibility laesst eine private Lektion privat', async () => {
    await lerne({ visibility: 'private' });
    const out = await lerne({ what_worked: 'Edge headless mit --no-pdf-header-footer', grund: 'Kopfzeile stoerte' });
    expect((await gespeichert()).visibility).toBe('private');
    expect(out).not.toContain('Auto-shared with team');
    expect(out).toContain('🔒 Private');
  });

  it('Update ohne group behaelt die Gruppe', async () => {
    await lerne({ group: 'backend' });
    await lerne({ what_worked: 'zweite Fassung', grund: 'genauer' });
    expect((await gespeichert()).group).toBe('backend');
  });

  it('ausdruecklich oeffnen geht weiterhin', async () => {
    await lerne({ visibility: 'private' });
    const out = await lerne({ visibility: 'team', grund: 'fuer alle freigegeben' });
    expect((await gespeichert()).visibility).toBe('team');
    expect(out).toContain('Auto-shared with team');
  });
});

/**
 * Nachtrag derselben Sitzung (13.11.2026): madc_deliberate las den Verlauf
 * `cachly:lessons:<topic>` ohne Sichtbarkeitspruefung und zeigte what_worked.
 * Wer den Themennamen kannte, las so eine private Lektion.
 */
describe('madc_deliberate: Sichtbarkeit', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(() => { redis = new MockRedis(); });

  const GEHEIM = 'GEHEIMER-INHALT-123';
  const lerne = (outcome: string, extra: Record<string, unknown>) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:geheim', outcome, author: 'heinrich',
      what_worked: `${GEHEIM} ${outcome}`, what_failed: `${GEHEIM} fehlschlag`, ...extra,
    }, getConn, noopApiFetch);
  const berate = () => handleFedbrainTool('madc_deliberate', { instance_id: 'i1', topic: 'deploy:geheim' },
    getConn as never, (async () => null) as never).then(String);

  it('privat: keine Beratung, kein Inhalt, Absage wie ohne Verlauf', async () => {
    await lerne('success', { visibility: 'private' });
    await lerne('failure', { grund: 'Rueckfall' }); // Update ohne visibility bleibt privat
    const out = await berate();
    expect(out).not.toContain(GEHEIM);
    expect(out).toContain('found 0');
  });

  it('Gruppe: ebenso keine Beratung', async () => {
    await lerne('success', { group: 'backend' });
    await lerne('failure', { grund: 'Rueckfall' });
    const out = await berate();
    expect(out).not.toContain(GEHEIM);
    // Nicht nur "Inhalt fehlt zufaellig": die Beratung findet gar nicht statt.
    expect(out).toContain('found 0');
  });

  it('alte Team-Kopie einer privaten Lektion (bis 0.10.251) wird nicht gezeigt', async () => {
    await lerne('success', { visibility: 'private' });
    // So legte 0.10.251 die Kopie ab: ohne visibility, mit Tag "team".
    await redis.rpush('cachly:lessons:deploy:geheim', JSON.stringify({
      topic: 'deploy:geheim', outcome: 'failure', what_worked: `${GEHEIM} alt`, tags: ['team'], auto_propagated: true,
    }));
    const out = await berate();
    expect(out).not.toContain(GEHEIM);
    expect(out).toContain('found 0');
  });

  it('teamweit: Beratung wie bisher', async () => {
    await lerne('success', {});
    await lerne('failure', { grund: 'Rueckfall' });
    const out = await berate();
    expect(out).not.toContain('found 0');
    expect(out).toContain('MADC');
  });
});
