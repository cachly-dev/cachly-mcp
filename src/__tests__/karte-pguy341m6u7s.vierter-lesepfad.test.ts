import { describe, it, expect, beforeEach } from 'vitest';
import { handleTeamTool, teamweiteNamen } from '../handlers/team.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

/**
 * Karte pguy341m6u7s, vierter Teil — die Namenslisten in brain_doctor und
 * brain_hygiene.
 *
 * Nach dem dritten Teil (PR #1011) blieben zwei Werkzeuge, die jede Lektion
 * unter `cachly:lesson:best:*` lesen: `brain_doctor` und `brain_hygiene`.
 * Sie geben keinen Lektionstext aus, nannten aber Themen beim Namen —
 * private und gruppen-beschraenkte eingeschlossen. `recall_best_solution`
 * verschweigt sogar, OB es eine solche Lektion gibt.
 *
 * Zaehlen und Pflegen muss weiter den ganzen Bestand sehen. Jede Probe hat
 * deshalb eine Gegenprobe: die team-weite Lektion wird genannt, und die
 * private wird trotzdem gezaehlt und gepflegt.
 */

const IID = 'i4';
let redis: MockRedis;
const getConn = async () => redis as unknown as Redis;
const noopApiFetch = async () =>
  ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

const team = (name: string, args: Record<string, unknown>) =>
  handleTeamTool(name, { instance_id: IID, ...args }, getConn, noopApiFetch);

const vorTagen = (tage: number) => new Date(Date.now() - tage * 86400000).toISOString();

/** Alte Lektion direkt in den Speicher legen: nie abgerufen, 40 Tage alt. */
const lege = (topic: string, outcome: string, extra: Record<string, unknown> = {}) =>
  redis.store.set(
    `cachly:lesson:best:${topic}`,
    JSON.stringify({
      topic,
      outcome,
      what_worked: outcome === 'success' ? `inhalt von ${topic}` : '',
      what_failed: outcome === 'failure' ? `fehler von ${topic}` : '',
      ts: vorTagen(40),
      verified_at: vorTagen(40),
      recall_count: 0,
      state: 'active',
      audit_trail: [],
      author: 'alice',
      ...extra,
    }),
  );

beforeEach(() => {
  redis = new MockRedis();
  lege('fehl:teamweit', 'failure');
  lege('fehl:privat', 'failure', { visibility: 'private' });
  lege('fehl:gruppe', 'failure', { group: 'security' });
  lege('alt:teamweit', 'success');
  lege('alt:privat', 'success', { visibility: 'private' });
});

describe('teamweiteNamen — die Regel fuer Namenslisten', () => {
  it('nennt nur Nennbares, zaehlt den Rest und sagt, wie viele davon verborgen sind', () => {
    const r = teamweiteNamen(['a', 'b', 'c', 'd'], new Set(['b']), 2);
    expect(r.namen).toEqual(['a', 'c']);
    expect(r.rest).toBe(2);
    expect(r.davonVerborgen).toBe(1);
  });

  it('Gegenprobe: ohne Verborgene bleibt die Liste wie vorher', () => {
    const r = teamweiteNamen(['a', 'b', 'c'], new Set(), 5);
    expect(r).toEqual({ namen: ['a', 'b', 'c'], rest: 0, davonVerborgen: 0 });
  });
});

describe('brain_doctor nennt nur team-weite Themen', () => {
  it('zaehlt alle offenen Fehlschlaege, nennt aber nur den team-weiten', async () => {
    const out = String(await team('brain_doctor', {}));
    expect(out, 'Gegenprobe: der team-weite Name muss erscheinen').toContain('fehl:teamweit');
    expect(out, 'gezaehlt wird weiter alles').toContain('3 unresolved failures');
    expect(out).toContain('2 private or group-only, not named');
    expect(out).not.toContain('fehl:privat');
    expect(out).not.toContain('fehl:gruppe');
  });

  it('nennt veraltete Lektionen nur, wenn sie team-weit sind', async () => {
    const out = String(await team('brain_doctor', {}));
    expect(out, 'Gegenprobe').toContain('alt:teamweit');
    expect(out).not.toContain('alt:privat');
  });
});

describe('brain_hygiene pflegt alles, nennt nur team-weite Themen', () => {
  it('Probelauf: keine privaten oder Gruppen-Namen in der Ausgabe', async () => {
    const out = String(await team('brain_hygiene', { dry_run: true, archive_days: 30 }));
    expect(out, 'Gegenprobe').toContain('fehl:teamweit');
    expect(out, 'Gegenprobe').toContain('alt:teamweit');
    expect(out).not.toContain('fehl:privat');
    expect(out).not.toContain('fehl:gruppe');
    expect(out).not.toContain('alt:privat');
    expect(out).toContain('2 of them private or group-only, not named');
  });

  it('Gegenprobe: die private Lektion wird trotzdem gepflegt', async () => {
    await team('brain_hygiene', { dry_run: false, archive_days: 30 });
    const privat = JSON.parse(redis.store.get('cachly:lesson:best:fehl:privat') as string);
    expect(privat.state).toBe('archived');
    expect(privat.visibility, 'die Sichtbarkeit bleibt beim Pflegen erhalten').toBe('private');
  });
});
