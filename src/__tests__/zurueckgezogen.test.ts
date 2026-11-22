/**
 * Zurueckgezogene Lektionen (22.11.2026): ein Mensch hat sie im Dashboard als
 * falsch markiert, die API hat sie nach cachly:withdrawn:* verschoben
 * (lektion_zurueckziehen_handler.go). Hier: was die KI danach bekommt.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';
import { ruecknahmeHinweis, leseZurueckgezogen } from '../zurueckgezogen.js';

const IID = 'zz1';
const THEMA = 'deploy:neustart-hilft';
const ALT = 'Bei Absturz einfach den Container neu starten';
const GRUND = 'Der Neustart war nie die Ursache, das Volume war voll';

let redis: MockRedis;
const getConn = async () => redis as unknown as Redis;
const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
const brain = (name: string, args: Record<string, unknown>) =>
  handleBrainTool(name, { instance_id: IID, ...args }, getConn, noopApiFetch).then(String);

const zurueckgezogen = (extra: Record<string, unknown> = {}) =>
  redis.store.set(
    `cachly:withdrawn:best:${THEMA}`,
    JSON.stringify({
      topic: THEMA, outcome: 'success', what_worked: ALT, ts: '2026-11-01T10:00:00Z', author: 'alice',
      zurueckgezogen_am: '2026-11-22T18:00:00Z', zurueckgezogen_grund: GRUND, ...extra,
    }),
  );
// Der Verlauf bleibt beim Zurueckziehen liegen (er ist Geschichte).
const verlauf = () =>
  redis.rpush(`cachly:lessons:${THEMA}`, JSON.stringify({ outcome: 'success', what_worked: ALT, ts: '2026-11-01T10:00:00Z' }));

beforeEach(() => {
  redis = new MockRedis();
});

describe('recall_best_solution auf ein zurueckgezogenes Thema', () => {
  it('Kontrolle: ohne Vermerk zeigt der Ersatzweg die alten Versuche (genau das waere das Leck)', async () => {
    await verlauf();
    const aus = await brain('recall_best_solution', { topic: THEMA });
    expect(aus).toContain('Last attempts');
    expect(aus).toContain(ALT.slice(0, 40));
  });

  it('meldet die Ruecknahme mit Grund statt der alten Versuche', async () => {
    await verlauf();
    await zurueckgezogen();
    const aus = await brain('recall_best_solution', { topic: THEMA });
    expect(aus).toContain('was withdrawn by a person on 2026-11-22');
    expect(aus).toContain(GRUND);
    expect(aus).toContain('Do not apply it.');
    expect(aus).not.toContain('Last attempts');
  });

  it('eine Gruppen-Lektion bleibt fuer Fremde "nicht gefunden"', async () => {
    await verlauf();
    await zurueckgezogen({ group: 'security' });
    const aus = await brain('recall_best_solution', { topic: THEMA, author: 'bob' });
    expect(aus).toContain('No lessons found');
    expect(aus).not.toContain(GRUND);
    expect(aus).not.toContain(ALT.slice(0, 40));
  });
});

describe('smart_recall findet sie nicht mehr', () => {
  it('nur die geltende Lektion kommt, die zurueckgezogene nicht', async () => {
    redis.store.set(
      'cachly:lesson:best:deploy:volume-voll',
      JSON.stringify({ topic: 'deploy:volume-voll', outcome: 'success', what_worked: 'Bei Absturz zuerst den Platz auf dem Volume pruefen', ts: new Date().toISOString(), author: 'alice' }),
    );
    await zurueckgezogen();
    const aus = await brain('smart_recall', { query: 'Absturz Container neu starten Volume' });
    expect(aus).toContain('deploy:volume-voll');
    expect(aus).not.toContain(THEMA);
    expect(aus).not.toContain(ALT);
  });
});

describe('learn_from_attempts unter demselben Namen', () => {
  it('zeigt den Grund der Ruecknahme', async () => {
    await zurueckgezogen();
    const aus = await brain('learn_from_attempts', { topic: THEMA, outcome: 'success', what_worked: 'Erst den Platz pruefen, dann neu starten' });
    expect(aus).toContain('withdrew an earlier lesson under this name on 2026-11-22');
    expect(aus).toContain(GRUND);
  });

  it('Gegenprobe: ohne Ruecknahme keine solche Zeile', async () => {
    const aus = await brain('learn_from_attempts', { topic: 'deploy:anderes', outcome: 'success', what_worked: 'Erst den Platz pruefen, dann neu starten' });
    expect(aus).not.toContain('withdrew');
  });
});

describe('Bausteine', () => {
  it('kappt den alten Text und kommt ohne Grund aus', () => {
    const aus = ruecknahmeHinweis('a:b', { what_worked: 'x'.repeat(400) });
    expect(aus).toContain('an unknown date.');
    expect(aus).toContain(' …');
    expect(aus.length).toBeLessThan(600);
  });
  it('unlesbarer Eintrag zaehlt als nicht vorhanden', async () => {
    redis.store.set(`cachly:withdrawn:best:${THEMA}`, '{kaputt');
    expect(await leseZurueckgezogen(redis as unknown as Redis, THEMA)).toBeNull();
  });
});
