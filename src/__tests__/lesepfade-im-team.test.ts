/**
 * Jeder Lesepfad, ein Bestand, eine Regel (12.11.2026, MCP 0.10.250).
 *
 * "private" heisst laut Werkzeugbeschreibung "only via exact
 * recall_best_solution": nirgends gelistet, gesucht, zusammengefasst oder
 * vorhergesagt. Gruppen-Lektionen nur fuer belegte Mitglieder. Die Inventur vom
 * 11.11.2026 (.agent/cachly/INVENTUR-lesepfade-2026-11-11.md) fand ueber zwanzig
 * Pfade, die das nicht pruefen. Dieser Test ruft jeden geschlossenen Pfad mit
 * demselben Bestand auf:
 *
 *   - VERBOTEN: keine Marke einer privaten oder Gruppen-Lektion, kein Name `geheim:`.
 *   - POSITIVKONTROLLE: die teamweite Lektion kommt an. Sonst bewiese "nichts
 *     Verbotenes" nur, dass der Pfad gar nichts zeigt.
 *
 * Gegenprobe beim Bau: sichtbarFuer/istTeamweit auf "immer ja" -> rot.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { handleBrainTool } from '../handlers/brain.js';
import { handleAdvancedTool } from '../handlers/advanced.js';
import { handleSyndicateTool } from '../handlers/syndicate.js';
import { handleTeamTool } from '../handlers/team.js';
import { handleFedbrainTool } from '../handlers/fedbrain.js';
import { Einblendbestand } from '../einblendung-kern.js';
import { sitzungsKontext } from '../einblendung.js';

const INSTANZ = 'i1';
const VERBOTEN = /PRIVAT-MARKE|GRUPPE-MARKE|geheim:/;
const jetzt = Date.now();
const vor = (tage: number) => new Date(jetzt - tage * 86_400_000).toISOString();

const lektion = (topic: string, marke: string, extra: Record<string, unknown> = {}) => ({
  topic,
  outcome: 'success',
  what_worked: `alpha deploy ${marke} wirkt`,
  what_failed: `alpha deploy ${marke} brach`,
  severity: 'major',
  ts: vor(2),
  recall_count: 0,
  tags: ['alpha'],
  author: 'anna',
  file_paths: ['src/alpha.ts'],
  service: 'alpha-svc',
  ...extra,
});

const BESTAND = [
  lektion('team:alpha-offen', 'OFFEN-MARKE', { visibility: 'team' }),
  lektion('geheim:alpha-privat', 'PRIVAT-MARKE', { visibility: 'private', author: 'bert' }),
  lektion('geheim:alpha-gruppe', 'GRUPPE-MARKE', { group: 'backend', author: 'carl' }),
  lektion('team:alpha-ausfall', 'OFFEN-MARKE', { outcome: 'failure' }),
  lektion('geheim:alpha-ausfall', 'PRIVAT-MARKE', { outcome: 'failure', visibility: 'private', author: 'bert' }),
];

async function befuelle(redis: MockRedis): Promise<void> {
  for (const l of BESTAND) {
    await redis.set(`cachly:lesson:best:${l.topic}`, JSON.stringify(l));
    await redis.rpush(`cachly:lessons:${l.topic}`, JSON.stringify(l));
    await redis.set(`cachly:ckg:node:${l.topic}`, JSON.stringify({ id: l.topic, domain: 'alpha', type: 'problem', count: 1, ts: l.ts }));
  }
  // Zweiter teamweiter und ein privater Beitrag zum selben Thema (team_synthesize, recall_at).
  await redis.rpush('cachly:lessons:team:alpha-offen', JSON.stringify(lektion('team:alpha-offen', 'OFFEN-MARKE', { author: 'dora', ts: vor(1) })));
  await redis.rpush('cachly:lessons:team:alpha-offen', JSON.stringify(lektion('team:alpha-offen', 'PRIVAT-MARKE', { visibility: 'private', author: 'bert', ts: vor(1) })));
  await redis.rpush('cachly:lessons:team:alpha-offen', JSON.stringify(lektion('team:alpha-offen', 'GRUPPE-MARKE', { group: 'backend', author: 'carl', ts: vor(1) })));

  // Graph: Kanten auf teamweite UND geheime Ziele.
  const kante = async (von: string, nach: string, edgeType: string) => {
    const key = `cachly:ckg:edge:${von}->${nach}:${edgeType}`;
    await redis.set(key, JSON.stringify({ from: von, to: nach, edgeType, successes: 3, trials: 3, confidence: 0.9, last_updated: vor(1) }));
    await redis.sadd(`cachly:ckg:idx:from:${von}`, key);
    await redis.sadd(`cachly:ckg:idx:to:${nach}`, key);
  };
  await kante('team:alpha-offen', 'team:alpha-ausfall', 'causes');
  await kante('team:alpha-offen', 'geheim:alpha-privat', 'causes');
  await kante('team:alpha-offen', 'geheim:alpha-gruppe', 'co-occurs');
  await kante('geheim:alpha-privat', 'team:alpha-ausfall', 'fixes');

  // Konflikte, aktive Agenten, Abhaengigkeiten.
  for (const t of ['team:alpha-offen', 'geheim:alpha-privat']) {
    await redis.set(`cachly:ckg:conflict:${t}`, JSON.stringify({ topic: t, detected_at: vor(0.1), fix_confidence: 0.8, fix_trials: 3, failure_outcome: 'failure' }));
  }
  await redis.set('cachly:agents:active:bert', JSON.stringify({ author: 'bert', last_topic: 'geheim:alpha-privat', last_outcome: 'success', ts: vor(0.01) }));
  await redis.set('cachly:agents:active:anna', JSON.stringify({ author: 'anna', last_topic: 'team:alpha-offen', last_outcome: 'success', ts: vor(0.01) }));
  await redis.set('cachly:dep:redis', JSON.stringify(['team:alpha-offen', 'geheim:alpha-privat', 'geheim:alpha-gruppe']));

  // carl ist Mitglied der Gruppe backend.
  await redis.sadd(`cachly:team:groups:${INSTANZ}`, 'backend');
  await redis.sadd(`cachly:team:group:${INSTANZ}:backend`, 'carl');
}

type Handler = (name: string, args: Record<string, unknown>, g: never, a: never) => Promise<string | null>;
const H = {
  brain: handleBrainTool as unknown as Handler,
  advanced: handleAdvancedTool as unknown as Handler,
  syndicate: handleSyndicateTool as unknown as Handler,
  team: handleTeamTool as unknown as Handler,
  fedbrain: handleFedbrainTool as unknown as Handler,
};

interface Fall {
  werkzeug: string;
  handler: keyof typeof H;
  args: Record<string, unknown>;
  /** Was die teamweite Lektion in der Ausgabe belegt. */
  positiv: RegExp;
  /** Abweichend vom Standard (z. B. exakter Name: Privates erlaubt). */
  verboten?: RegExp;
  /** Ersatzweg erzwingen: die API wirft. */
  apiWirft?: boolean;
}

const FAELLE: Fall[] = [
  { werkzeug: 'session_start', handler: 'brain', args: { focus: 'alpha deploy' }, positiv: /team:alpha-offen/ },
  { werkzeug: 'session_start_summary', handler: 'brain', args: { focus: 'alpha deploy' }, positiv: /team:alpha-offen/ },
  { werkzeug: 'recall_best_solution (Teiltreffer)', handler: 'brain', args: { topic: 'alpha' }, positiv: /team:alpha-offen/ },
  { werkzeug: 'brain_changelog', handler: 'brain', args: { days: 30 }, positiv: /team:alpha/ },
  { werkzeug: 'skill_gaps', handler: 'brain', args: {}, positiv: /excluded from gap analysis/ },
  { werkzeug: 'brain_file_map', handler: 'brain', args: { file_paths: ['src/alpha.ts'] }, positiv: /team:alpha/ },
  { werkzeug: 'brain_service_map', handler: 'brain', args: { service: 'alpha-svc' }, positiv: /team:alpha/ },
  { werkzeug: 'brain_search', handler: 'syndicate', args: { query: 'alpha deploy' }, positiv: /OFFEN-MARKE/ },
  { werkzeug: 'brain_predict', handler: 'syndicate', args: { context: 'alpha deploy' }, positiv: /team:alpha/ },
  { werkzeug: 'brain_plan', handler: 'syndicate', args: { task: 'alpha deploy' }, positiv: /team:alpha/ },
  { werkzeug: 'brain_conflicts', handler: 'syndicate', args: {}, positiv: /team:alpha-offen/ },
  { werkzeug: 'team_synthesize', handler: 'team', args: { topic: 'team:alpha-offen' }, positiv: /OFFEN-MARKE/ },
  // Exakter Name: Privates darf stehen, fremde Gruppe nicht.
  { werkzeug: 'recall_at', handler: 'team', args: { topic: 'team:alpha-offen', date: '2099-01-01' }, positiv: /OFFEN-MARKE/, verboten: /GRUPPE-MARKE/ },
  { werkzeug: 'trace_dependency', handler: 'team', args: { dependency: 'redis' }, positiv: /team:alpha-offen/ },
  { werkzeug: 'memory_consolidate', handler: 'advanced', args: { dry_run: true }, positiv: /Memory Consolidation Report/ },
  { werkzeug: 'brain_diff', handler: 'advanced', args: { since: '30d' }, positiv: /team:alpha/ },
  { werkzeug: 'knowledge_decay', handler: 'advanced', args: {}, positiv: /team:alpha/ },
  { werkzeug: 'fedbrain_search (Ersatzweg)', handler: 'fedbrain', args: { query: 'alpha deploy' }, positiv: /team:alpha/, apiWirft: true },
  { werkzeug: 'compact_recover', handler: 'fedbrain', args: { focus: 'alpha' }, positiv: /team:alpha/ },
  { werkzeug: 'brain_predict_failures', handler: 'fedbrain', args: { context: 'alpha deploy' }, positiv: /team:alpha/ },
];

describe('Lesepfade im Team: nur Teamweites, mit Positivkontrolle je Pfad', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const api503 = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const apiWirft = async () => { throw new Error('API nicht erreichbar'); };

  beforeEach(async () => {
    redis = new MockRedis();
    await befuelle(redis);
  });

  for (const f of FAELLE) {
    it(`${f.werkzeug}: teamweite Lektion da, private und Gruppen-Lektion nicht`, async () => {
      const aus = String(await H[f.handler](
        f.werkzeug.split(' ')[0]!,
        { instance_id: INSTANZ, ...f.args },
        getConn as never,
        (f.apiWirft ? apiWirft : api503) as never,
      ));
      expect(aus, `Positivkontrolle fehlt in ${f.werkzeug}:\n${aus}`).toMatch(f.positiv);
      expect(aus, `${f.werkzeug} nennt Nicht-Teamweites:\n${aus}`).not.toMatch(f.verboten ?? VERBOTEN);
    });
  }

  it('session_start fuer ein Gruppenmitglied: die Gruppen-Lektion ja, die private nie', async () => {
    const aus = String(await handleBrainTool('session_start', { instance_id: INSTANZ, focus: 'alpha deploy', author: 'carl' }, getConn, api503 as never));
    expect(aus).toMatch(/geheim:alpha-gruppe/);
    expect(aus).not.toMatch(/PRIVAT-MARKE|geheim:alpha-privat/);
  });

  it('der exakte Name holt die private Lektion weiter (Bedeutung von "private")', async () => {
    const aus = String(await handleBrainTool('recall_best_solution', { instance_id: INSTANZ, topic: 'geheim:alpha-privat' }, getConn, api503 as never));
    expect(aus).toContain('PRIVAT-MARKE');
  });
});

describe('Einblendungs-Hook: nur Teamweites kommt von selbst in den Prompt', () => {
  it('Einblendbestand sortiert nur Teamweites', () => {
    const sortiert = new Einblendbestand(BESTAND).sortiere('alpha deploy wirkt');
    const themen = sortiert.map((x) => String(x.lektion.topic));
    expect(themen).toContain('team:alpha-offen');
    expect(themen.join(' ')).not.toMatch(/geheim:/);
  });

  it('sitzungsKontext nennt nur Teamweites', () => {
    const aus = sitzungsKontext(BESTAND);
    expect(aus).toMatch(/team:alpha/);
    expect(aus).not.toMatch(VERBOTEN);
  });
});
