/**
 * Karte tr5mwpcx544w (ARB-1) — kommt wirklich der VOLLE Inhalt beim Modell an?
 *
 * ── Der Beleg von außen (Artikel 3978937) ──────────────────────────────────
 *
 * Eine fremde RAG-Pipeline bestand JEDEN Unit-Test — richtiger Treffer,
 * Zitat vorhanden, Status 200 — während das Modell nur eine
 * 400-Zeichen-Vorschau sah. Erst der Ende-zu-Ende-Test mit einer Tatsache
 * an BEKANNTER POSITION deckte es auf (Güte 0,57 → 0,96).
 *
 * ── Unsere drei Kürzungsstellen, namentlich (Abnahme der Karte) ────────────
 *
 *   1. MAX_LESSON_TOKENS = 500        ambient-deps.ts (Gate + Summary-Kappe)
 *   2. truncateToTokens()             ambient-cli.ts (die Schere selbst)
 *   3. slice(0, 100) im Briefing      handlers/brain.ts (session_start:
 *      what_worked wird auf 100 Zeichen gekappt — deshalb die Hausregel
 *      "die entscheidende Tatsache in die ERSTEN 100 Zeichen")
 *   4. recallVorschau(…, 400)         handlers/brain.ts — GEFUNDEN VON DER
 *      GEGENPROBE DIESER KARTE (30.08.): smart_recall zeigt je Treffer eine
 *      ~400-Zeichen-Vorschau; die Schere schneidet also FRUEHER als die
 *      Ambient-Kappe. Bewusste Bauform (recall_best_solution ist der volle
 *      Weg) — aber exakt die 400-Zeichen-Falle aus dem fremden Artikel,
 *      deshalb steht sie hier mit Probe UND Fluchtweg.
 *
 * Diese Probe fährt den ECHTEN Ambient-Pfad (buildAmbientDeps um den echten
 * smart_recall-Handler) und prüft eine Tatsache an bekannter Position — und
 * die Gegenprobe beweist, dass der Test NEIN sagen kann.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildAmbientDeps } from '../ambient-deps.js';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte tr5mwpcx544w — der volle Inhalt kommt an', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const deps = () => buildAmbientDeps({
    instanceId: 'i1',
    smartRecall: (query: string) =>
      handleBrainTool('smart_recall', { instance_id: 'i1', query }, getConn, noopApiFetch) as Promise<string>,
    loadMemory: async () => ({}),
    saveMemory: async () => { /* leer */ },
    backoff: { shouldSkip: () => false, recordMiss: () => { /* leer */ }, recordHit: () => { /* leer */ } },
  } as never);

  beforeEach(() => { redis = new MockRedis(); });

  it('eine Tatsache bei Zeichen ~300 uebersteht den ganzen Pfad', async () => {
    // Die Tatsache liegt NACH dem Vorspann — genau der Ort, an dem die
    // 100-Zeichen-Briefing-Kappe (Kuerzungsstelle 3) sie verlieren wuerde.
    const vorspann = 'Der Deploy war lange instabil und wir haben vieles versucht. '.repeat(5);
    const tatsache = 'DIE-ADRESSE-IST-10-8-0-7';
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:plugh', outcome: 'success',
      what_worked: `${vorspann}${tatsache} und damit lief es.`,
    }, getConn, noopApiFetch);

    const kandidaten = await deps().recall('plugh deploy');
    expect(kandidaten.length).toBe(1);
    // Nicht "irgendetwas wurde eingeblendet" — DIESE Tatsache steht drin.
    expect(kandidaten[0].summary).toContain(tatsache);
  });

  it('GEGENPROBE: eine tiefe Tatsache faellt aus der Vorschau — der Test kann Nein sagen', async () => {
    // Die ERSTE Schere ist nicht die Ambient-Kappe (2000 Zeichen), sondern
    // recallVorschau mit ~400 Zeichen je Treffer (Kuerzungsstelle 4) —
    // genau das hat diese Gegenprobe beim ersten Lauf aufgedeckt: der
    // Summary war nur 780 Zeichen lang, die Tatsache fehlte laengst.
    const vorspann = 'Fuellwort '.repeat(400); // ~4000 Zeichen vor der Tatsache
    const tatsache = 'DIE-VERSTECKTE-ZAHL-42734';
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:plugh', outcome: 'success',
      what_worked: `${vorspann}${tatsache}`,
    }, getConn, noopApiFetch);

    const kandidaten = await deps().recall('plugh deploy');
    expect(kandidaten.length).toBe(1);
    expect(kandidaten[0].summary).not.toContain(tatsache);
  });

  it('DER FLUCHTWEG: recall_best_solution liefert die tiefe Tatsache VOLL', async () => {
    // Die Vorschau darf schneiden, WEIL es den vollen Weg gibt — diese
    // Probe haelt fest, dass er wirklich traegt. Faellt sie, ist die
    // 400-Zeichen-Falle aus Artikel 3978937 unsere.
    const vorspann = 'Fuellwort '.repeat(400);
    const tatsache = 'DIE-VERSTECKTE-ZAHL-42734';
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:plugh', outcome: 'success',
      what_worked: `${vorspann}${tatsache}`,
    }, getConn, noopApiFetch);

    const voll = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:plugh',
    }, getConn, noopApiFetch));
    expect(voll).toContain(tatsache);
  });
});
