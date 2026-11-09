import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import { handleTeamTool, teamweitLesbar } from '../handlers/team.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

/**
 * Karte pguy341m6u7s, dritter Teil — die Lesepfade, die niemand gezaehlt hatte.
 *
 * Am 09.11.2026 beim Zaehlen aller Wege, auf denen eine Lektion das Brain
 * verlaesst, gefunden: `team_recall`, `sync_file_changes`,
 * `memory_crystalize` und `team_crystallize` lasen JEDE Lektion unter
 * `cachly:lesson:best:*` und gaben ihren Text aus — private und
 * gruppen-beschraenkte eingeschlossen. Dazu nannte der Ersetzt-Banner einen
 * Nachfolger aus einer fremden Gruppe beim Namen (Inhalt zu, Name offen).
 *
 * Jede Probe hat eine Gegenprobe: eine Grenze, die alles verschluckt, waere
 * auch "dicht" (Unterscheidbarkeits-Probe, wie im zweiten Teil).
 */

const IID = 'i3';
let redis: MockRedis;
const getConn = async () => redis as unknown as Redis;
const noopApiFetch = async () =>
  ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

const team = (name: string, args: Record<string, unknown>) =>
  handleTeamTool(name, { instance_id: IID, ...args }, getConn, noopApiFetch);
const brain = (name: string, args: Record<string, unknown>) =>
  handleBrainTool(name, { instance_id: IID, ...args }, getConn, noopApiFetch);

/** Lektion direkt in den Speicher legen — wie sie dort liegt, ohne Schreibpfad. */
const lege = (topic: string, extra: Record<string, unknown>) =>
  redis.store.set(
    `cachly:lesson:best:${topic}`,
    JSON.stringify({
      topic,
      outcome: 'success',
      ts: new Date().toISOString(),
      author: 'alice',
      ...extra,
    }),
  );

beforeEach(() => {
  redis = new MockRedis();
});

describe('teamweitLesbar — die gemeinsame Grenze', () => {
  it('laesst team-weite Lektionen durch (Gegenprobe)', () => {
    expect(teamweitLesbar(JSON.stringify({ topic: 'a', what_worked: 'w' }))).not.toBeNull();
    expect(teamweitLesbar(JSON.stringify({ topic: 'a', what_worked: 'w', group: '' }))).not.toBeNull();
    expect(teamweitLesbar(JSON.stringify({ topic: 'a', what_worked: 'w', visibility: 'team' }))).not.toBeNull();
  });

  it('haelt private, gruppen-beschraenkte und unlesbare Lektionen draussen', () => {
    expect(teamweitLesbar(JSON.stringify({ topic: 'a', visibility: 'private' }))).toBeNull();
    expect(teamweitLesbar(JSON.stringify({ topic: 'a', group: 'security' }))).toBeNull();
    expect(teamweitLesbar('{kaputt')).toBeNull();
    expect(teamweitLesbar('3')).toBeNull();
    expect(teamweitLesbar(null)).toBeNull();
  });
});

describe('team_recall zieht dieselbe Grenze wie smart_recall', () => {
  beforeEach(() => {
    lege('deploy:teamweit', { what_worked: 'TEAMWEIT-sichtbar rollback ueber tag' });
    lege('notiz:privat', { what_worked: 'PRIVAT-geheim nur fuer alice', visibility: 'private' });
    lege('security:gruppe', { what_worked: 'GRUPPE-geheim schluessel drehen', group: 'security' });
  });

  it('zeigt weder private noch gruppen-beschraenkte Lektionen, team-weite schon', async () => {
    const out = String(await team('team_recall', {}));
    expect(out, 'Gegenprobe: die team-weite Lektion muss erscheinen').toContain('TEAMWEIT-sichtbar');
    expect(out).not.toContain('PRIVAT-geheim');
    expect(out).not.toContain('notiz:privat');
    expect(out).not.toContain('GRUPPE-geheim');
    expect(out).not.toContain('security:gruppe');
  });

  it('auch nicht, wenn man gezielt nach Thema oder Autor filtert', async () => {
    const nachThema = String(await team('team_recall', { topic: 'security' }));
    expect(nachThema).not.toContain('GRUPPE-geheim');
    const nachAutor = String(await team('team_recall', { author: 'alice' }));
    expect(nachAutor).toContain('TEAMWEIT-sichtbar');
    expect(nachAutor).not.toContain('PRIVAT-geheim');
    expect(nachAutor).not.toContain('GRUPPE-geheim');
  });

  it('eine unlesbare Lektion bringt team_recall nicht zu Fall und kommt nicht heraus', async () => {
    redis.store.set('cachly:lesson:best:kaputt:x', '{kaputt');
    const out = String(await team('team_recall', {}));
    expect(out).toContain('TEAMWEIT-sichtbar');
    expect(out).not.toContain('kaputt:x');
  });
});

describe('sync_file_changes nennt nur team-weite Lektionen zu den Dateien', () => {
  it('private und gruppen-beschraenkte Lektionen zur Datei bleiben draussen', async () => {
    lege('deploy:teamweit', { what_worked: 'TEAMWEIT-datei', file_paths: ['src/deploy.ts'] });
    lege('deploy:privat', { what_worked: 'PRIVAT-datei', file_paths: ['src/deploy.ts'], visibility: 'private' });
    lege('deploy:gruppe', { what_worked: 'GRUPPE-datei', file_paths: ['src/deploy.ts'], group: 'ops' });

    const out = String(await team('sync_file_changes', { changed_files: ['src/deploy.ts'] }));
    expect(out, 'Gegenprobe: die team-weite Lektion zur Datei muss erscheinen').toContain('TEAMWEIT-datei');
    expect(out).not.toContain('PRIVAT-datei');
    expect(out).not.toContain('GRUPPE-datei');
  });
});

describe('Ersetzt-Banner nennt einen Gruppen-Nachfolger nur Mitgliedern', () => {
  beforeEach(async () => {
    lege('schluessel:alt', {
      what_worked: 'ALTE-fassung schluessel jaehrlich drehen',
      ersetzt_durch: 'schluessel:neu',
      ersetzt_am: '2026-11-09T10:00:00.000Z',
    });
    lege('schluessel:neu', { what_worked: 'NEUE-fassung quartalsweise drehen', group: 'security' });
    await team('team_grant_scope', { handle: 'carol', group: 'security' });
  });

  it('recall_best_solution: ein Nicht-Mitglied erfaehrt den Namen des Nachfolgers nicht', async () => {
    const out = String(await brain('recall_best_solution', { topic: 'schluessel:alt', author: 'bob' }));
    expect(out, 'die alte Fassung bleibt als Geschichte lesbar').toContain('ALTE-fassung');
    expect(out).toContain('THIS VERSION IS REPLACED');
    expect(out).not.toContain('schluessel:neu');
  });

  it('recall_best_solution ohne author: zu', async () => {
    const out = String(await brain('recall_best_solution', { topic: 'schluessel:alt' }));
    expect(out).not.toContain('schluessel:neu');
  });

  it('GEGENPROBE: das Gruppenmitglied bekommt den Wegweiser', async () => {
    const out = String(await brain('recall_best_solution', { topic: 'schluessel:alt', author: 'carol' }));
    expect(out).toContain('recall_best_solution(topic="schluessel:neu")');
  });
});

describe('smart_recall-Notiz nennt einen Gruppen-Nachfolger nur Mitgliedern', () => {
  beforeEach(async () => {
    await brain('learn_from_attempts', {
      topic: 'zebrafeld:alt',
      outcome: 'success',
      what_worked: 'ZEBRAFELD wird jaehrlich gemaeht, alte Regel',
      author: 'alice',
    });
    await brain('learn_from_attempts', {
      topic: 'wiese:neu',
      outcome: 'success',
      what_worked: 'Die Wiese wird quartalsweise gemaeht, neue Regel',
      author: 'alice',
      group: 'garten',
      ersetzt: 'zebrafeld:alt',
    });
    await team('team_grant_scope', { handle: 'carol', group: 'garten' });
  });

  it('ein Nicht-Mitglied sieht die alte Fassung, aber nicht den Namen der neuen', async () => {
    const out = String(await brain('smart_recall', { query: 'zebrafeld jaehrlich gemaeht regel', author: 'bob' }));
    expect(out, 'Gegenprobe: die alte Fassung wird gefunden').toContain('zebrafeld:alt');
    expect(out).not.toContain('wiese:neu');
  });

  it('GEGENPROBE: das Gruppenmitglied bekommt den Namen der neuen Fassung', async () => {
    const out = String(await brain('smart_recall', { query: 'zebrafeld jaehrlich gemaeht regel', author: 'carol' }));
    expect(out).toContain('wiese:neu');
  });
});
