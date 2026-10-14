/**
 * session_start: kein Abschnitt ohne Bezug zur Aufgabe, jede Lektion hoechstens einmal.
 *
 * ── Warum (14.10.2026, Heinrich: „kürzeres Briefing, erst messen") ──────────
 *
 * Gemessen an 7 echten Briefings (MCP 0.10.199, eigenes Brain, 7 verschiedene Fokus-Saetze):
 * im Schnitt 11.122 Zeichen, rund 2.780 Token. Davon ohne Bezug zur Aufgabe:
 *   - "Blind spots" meldete fuer auth, alembic und login "no CKG knowledge", obwohl Lektionen
 *     dazu da waren (gefragt wurde der Begriffsgraph, nicht der Bestand).
 *   - "Predicted risks" zeigte je Fokus vier Zeilen "<lektion> co-occurs tag:<eigenes Schlagwort>".
 *   - "Knowledge Coverage", "Unresolved", "Stale lessons", "Most valuable", "Commons" waren in
 *     allen 7 Briefings gleich. "Most valuable" nannte dieselben Lektionen wie "Proven Laws".
 *   - "Recent", "Team this week", die Liste neuer Lektionen und "Last session decisions" nannten
 *     bis zu drei gleiche Themen.
 *
 * Gegenprobe: handlers/brain.ts von origin/main (c432b91c) als handlers/brain-alt.ts daneben legen
 * und den Import unten darauf zeigen lassen. Dann faellt jeder Test dieser Datei.
 *
 * Alle Lektionen sind erfunden.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { handleBrainTool } from '../handlers/brain.js';

type ApiFetch = Parameters<typeof handleBrainTool>[3];

// Antwortet wie die echte API: die Commons-Zahlen sind da, alles andere scheitert still.
const apiFetch = (async (pfad: string) => {
  if (pfad.includes('syndication/stats')) return { total_lessons: 65, total_confirms: 321, added_last_7_days: 0 };
  throw new Error('kein Netz im Test');
}) as unknown as ApiFetch;

const jetzt = Date.now();
const vor = (stunden: number) => new Date(jetzt - stunden * 3_600_000).toISOString();

async function lektion(redis: MockRedis, topic: string, opts: Record<string, unknown> = {}): Promise<void> {
  const ts = (opts.ts as string | undefined) ?? vor(0.5);
  await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({
    topic,
    outcome: 'success',
    what_worked: `Loesung fuer ${topic}, lang genug fuer eine Vorschau im Briefing.`,
    severity: 'minor',
    recall_count: 0,
    ts,
    verified_at: ts,
    confidence: 1,
    tags: [],
    ...opts,
  }));
}

/** Wie oft ein Thema im Briefing als `thema` genannt wird. */
const nennungen = (briefing: string, topic: string) => briefing.split(`\`${topic}\``).length - 1;

describe('session_start ohne Rauschen', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;

  beforeEach(async () => {
    redis = new MockRedis();
    // Letzte Sitzung vor 2 h, mit Entscheidungsprotokoll.
    await redis.set('cachly:session:last', JSON.stringify({
      summary: 'Zahlungen gebaut',
      ts: vor(2),
      files_changed: ['api/zahlung/webhook.go'],
      decision_log: [
        { topic: 'team:frische-lektion', outcome: 'success', what_worked: 'x' },
        { topic: 'team:frische-lektion', outcome: 'success', what_worked: 'x' },
      ],
    }));
    // Bewaehrt: waere frueher in "Proven Laws" UND "Most valuable" gestanden.
    await lektion(redis, 'deploy:bewaehrt', { recall_count: 40, ts: vor(24 * 30), verified_at: vor(1) });
    // Von einem Teammitglied, frisch: frueher in "Recent", "Team", Liste neuer Lektionen und "decisions".
    await lektion(redis, 'team:frische-lektion', { author: 'bob' });
    // Ein Fehlschlag ohne Bezug zum Fokus: frueher in "Unresolved".
    await lektion(redis, 'altlast:offen', { outcome: 'failure', what_failed: 'nie geloest', ts: vor(24 * 20) });
    // Seit 40 Tagen nicht bestaetigt: frueher in "Stale lessons".
    await lektion(redis, 'alt:verstaubt', { ts: vor(24 * 40), verified_at: vor(24 * 40), confidence: 0.5 });
    // Passt zum Fokus.
    await lektion(redis, 'zahlung:webhook-idempotenz', { tags: ['zahlung'] });
    // Begriffsgraph: ein Knoten mit co-occurs-Kante zum eigenen Schlagwort (frueher "Predicted risks").
    await redis.set('cachly:ckg:node:zahlung', JSON.stringify({ id: 'zahlung', type: 'concept' }));
    await redis.set('cachly:ckg:edge:zahlung:tag:zahlung', JSON.stringify({ from: 'zahlung', to: 'tag:zahlung', edgeType: 'co-occurs', confidence: 0.67 }));
    await redis.sadd('cachly:ckg:idx:from:zahlung', 'cachly:ckg:edge:zahlung:tag:zahlung');
  });

  const briefing = async () => String(await handleBrainTool(
    'session_start',
    { instance_id: 'i1', author: 'alice', focus: 'zahlung alembic' },
    getConn,
    apiFetch,
  ));

  it('zeigt keinen der gemessenen Rausch-Abschnitte', async () => {
    const b = await briefing();
    for (const titel of ['Blind spots', 'Predicted risks', 'Knowledge Coverage', 'Most valuable', 'Unresolved', 'Stale lessons', 'Commons:']) {
      expect(b, titel).not.toContain(titel);
    }
  });

  it('behaelt Fokus-Treffer, Gesetze und die letzte Sitzung', async () => {
    const b = await briefing();
    expect(b).toContain('Relevant for "zahlung alembic"');
    expect(b).toContain('`zahlung:webhook-idempotenz`');
    expect(b).toContain('Proven Laws');
    expect(b).toContain('`deploy:bewaehrt`');
    expect(b).toContain('Last session');
  });

  it('nennt jede Lektion hoechstens einmal', async () => {
    const b = await briefing();
    for (const topic of ['deploy:bewaehrt', 'team:frische-lektion', 'zahlung:webhook-idempotenz', 'alt:verstaubt']) {
      expect(nennungen(b, topic), topic).toBe(1);
    }
  });

  it('blosse Kategorie-Themen (code:, zahlung:) stehen nirgends, auch nicht als Gesetz oder Fokus-Treffer', async () => {
    // Ueberschriebene Reste der VS-Code-Erweiterung: viele Abrufe, Inhalt ein Code-Stueck.
    // Gegenprobe: den istBlossesThema-Filter beim Laden in brain.ts entfernen -> rot.
    await lektion(redis, 'code:', { recall_count: 300, what_worked: '// Cold-start guard: const snapshot = ...' });
    await lektion(redis, 'zahlung:', { recall_count: 50, what_worked: 'if (x) { return y; }' });
    for (const werkzeug of ['session_start', 'session_start_summary']) {
      const b = String(await handleBrainTool(werkzeug, { instance_id: 'i1', author: 'alice', focus: 'zahlung alembic' }, getConn, apiFetch));
      expect(nennungen(b, 'code:'), `${werkzeug}: code:`).toBe(0);
      expect(nennungen(b, 'zahlung:'), `${werkzeug}: zahlung:`).toBe(0);
      expect(b, werkzeug).not.toContain('Cold-start guard');
    }
    // Die echten Lektionen bleiben.
    const b = await briefing();
    expect(b).toContain('`deploy:bewaehrt`');
    expect(b).toContain('`zahlung:webhook-idempotenz`');
  });

  it('die Zahlen von Fehlschlaegen und veralteten Lektionen stehen im brain_doctor-Hinweis', async () => {
    const b = await briefing();
    expect(b).toContain('Run `brain_doctor` to fix: 1 open failure, 1 stale lesson.');
  });
});
