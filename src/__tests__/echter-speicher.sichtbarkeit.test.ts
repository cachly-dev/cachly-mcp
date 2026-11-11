/**
 * Positive Kontrolle gegen einen ECHTEN Speicher (Valkey), nicht gegen die Attrappe.
 *
 * Anlass: Rodrigo Diego auf dev.to (11.11.2026): "The mock tells you the gate
 * asked the right question. Only the database tells you the answer."
 *
 * Belegt bei #1011: Unsere Positivkontrolle fiel an der Attrappe selbst um.
 * MockRedis kannte keine Set-Mitgliedschaft, also fand die Gruppenpruefung nie
 * ein Mitglied. Ein Test, der nur "zu" prueft, waere mit dieser Attrappe immer
 * gruen gewesen, auch wenn die Grenze im echten Speicher offen steht oder
 * jeden aussperrt.
 *
 * Derselbe Fall wie in karte-pguy341m6u7s.*-lesepfad.test.ts, gegen Valkey:
 *   - Gruppenmitglied liest die Gruppen-Lektion: sichtbar.
 *   - Fremder liest sie: Antwort wie "nicht gefunden".
 *   - Unbekannter Name: "nicht gefunden".
 *   - Team-weite Lektion: fuer jeden sichtbar (Gegenprobe).
 *
 * Lauf:
 *   - CACHLY_TEST_VALKEY_URL=redis://127.0.0.1:6379/0 npx vitest run <diese Datei>
 *   - Ohne Adresse wird uebersprungen und das gemeldet.
 *   - Mit CACHLY_ECHTER_SPEICHER_PFLICHT=1 (CI-Job "MCP Server") ist die Adresse
 *     Pflicht: fehlt sie, wird der Test ROT statt still uebersprungen.
 *   - Er laeuft nur gegen einen LEEREN Speicher und raeumt danach alles ab.
 *     Ein voller Speicher ist ein Abbruch, kein Aufraeumen.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { handleTeamTool } from '../handlers/team.js';

const ADRESSE = process.env.CACHLY_TEST_VALKEY_URL ?? '';
const PFLICHT = process.env.CACHLY_ECHTER_SPEICHER_PFLICHT === '1';
const IID = 'echt-sichtbarkeit';

const noopApiFetch = (async () =>
  ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as unknown as Parameters<typeof handleBrainTool>[3];

describe('echter Speicher: Pflicht, wo verlangt', () => {
  it.runIf(PFLICHT)('die Adresse des echten Speichers ist gesetzt', () => {
    expect(ADRESSE, 'CACHLY_TEST_VALKEY_URL fehlt; in der CI ist der echte Speicher Pflicht').not.toBe('');
  });
  it.runIf(!ADRESSE && !PFLICHT)('uebersprungen: kein echter Speicher (CACHLY_TEST_VALKEY_URL nicht gesetzt)', () => {
    console.warn('[echter-speicher] uebersprungen: CACHLY_TEST_VALKEY_URL nicht gesetzt. In der CI laeuft er gegen Valkey.');
  });
});

describe.runIf(ADRESSE)('Sichtbarkeit gegen echten Valkey', () => {
  let redis: Redis;
  const getConn = async () => redis;
  const brain = (name: string, args: Record<string, unknown>) =>
    handleBrainTool(name, { instance_id: IID, ...args }, getConn, noopApiFetch).then(String);
  const team = (name: string, args: Record<string, unknown>) =>
    handleTeamTool(name, { instance_id: IID, ...args }, getConn, noopApiFetch).then(String);

  const lege = (topic: string, extra: Record<string, unknown>) =>
    redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({
      topic, outcome: 'success', severity: 'major', ts: new Date().toISOString(),
      verified_at: new Date().toISOString(), author: 'alice', what_failed: '', tags: ['ops'], ...extra,
    }));

  beforeAll(async () => {
    redis = new Redis(ADRESSE, { maxRetriesPerRequest: 2, connectTimeout: 5000 });
    const vorher = await redis.dbsize();
    if (vorher !== 0) {
      await redis.quit();
      throw new Error(`Der Speicher unter CACHLY_TEST_VALKEY_URL ist nicht leer (${vorher} Schluessel). `
        + 'Dieser Test laeuft nur gegen einen leeren Speicher, weil er danach alles abraeumt.');
    }
    await lege('security:gruppe', { what_worked: 'GRUPPE-geheim schluessel drehen', group: 'security' });
    await lege('deploy:teamweit', { what_worked: 'TEAMWEIT-sichtbar rollback ueber tag' });
    const ausgabe = await team('team_grant_scope', { handle: 'carol', group: 'security' });
    expect(ausgabe).not.toMatch(/⚠️|error/i);
  });

  afterAll(async () => {
    if (!redis) return;
    if (redis.status === 'ready') await redis.flushdb();
    await redis.quit().catch(() => undefined);
  });

  it('der Speicher kennt die Mitgliedschaft wirklich (das fehlte der Attrappe)', async () => {
    const mengen = await redis.keys('*');
    const gruppenMenge = mengen.filter((k) => k.includes('security') && !k.startsWith('cachly:lesson:'));
    expect(gruppenMenge.length, `keine Gruppenmenge gefunden; Schluessel: ${mengen.join(', ')}`).toBeGreaterThan(0);
    const mitglied = await Promise.all(gruppenMenge.map(async (k) =>
      (await redis.type(k)) === 'set' ? redis.sismember(k, 'carol') : 0));
    expect(mitglied).toContain(1);
  });

  it('POSITIVE KONTROLLE: das Gruppenmitglied liest die Gruppen-Lektion', async () => {
    const aus = await brain('recall_best_solution', { topic: 'security:gruppe', author: 'carol' });
    expect(aus).toContain('GRUPPE-geheim');
  });

  it('der Fremde bekommt "nicht gefunden", nicht "verweigert"', async () => {
    const aus = await brain('recall_best_solution', { topic: 'security:gruppe', author: 'bob' });
    expect(aus).not.toContain('GRUPPE-geheim');
    expect(aus).toContain('No lessons found');
  });

  it('ohne author bleibt die Gruppen-Lektion zu', async () => {
    const aus = await brain('recall_best_solution', { topic: 'security:gruppe' });
    expect(aus).not.toContain('GRUPPE-geheim');
  });

  it('ein unbekannter Name antwortet genauso wie die Absage', async () => {
    const unbekannt = await brain('recall_best_solution', { topic: 'gibt:es-nicht', author: 'bob' });
    const abgesagt = await brain('recall_best_solution', { topic: 'security:gruppe', author: 'bob' });
    expect(unbekannt).toContain('No lessons found');
    // Verweigerung = Abwesenheit: bis auf den Namen dieselbe Antwort.
    expect(abgesagt.replace('security:gruppe', 'X')).toBe(unbekannt.replace('gibt:es-nicht', 'X'));
  });

  it('GEGENPROBE: die team-weite Lektion liest jeder', async () => {
    const aus = await brain('recall_best_solution', { topic: 'deploy:teamweit', author: 'bob' });
    expect(aus).toContain('TEAMWEIT-sichtbar');
  });
});
