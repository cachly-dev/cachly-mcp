import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import { handleTeamTool } from '../handlers/team.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

/**
 * Karte pguy341m6u7s, zweiter Teil — der ANDERE Lesepfad.
 *
 * ── Rodrigo Diegos Satz, auf uns gewendet ─────────────────────────────────
 *
 * "Chat history is a second read path — persistence is not permission."
 * (25.08.2026)
 *
 * `smart_recall` prueft die Sichtbarkeit von HEUTE: private Lektionen fliegen
 * zur Lesezeit heraus, gruppen-beschraenkte auch (`lessonVisibleToScope` mit
 * frisch gelesenen Zuschnitten). Das ist geprueft und gilt.
 *
 * `recall_best_solution` ist der zweite Lesepfad. Er nimmt genau zwei
 * Argumente:
 *
 *     const { instance_id, topic } = args
 *
 * Kein Autor, keine Rolle, keine Gruppe. Er kann also gar nicht wissen, WER
 * fragt — und prueft folgerichtig nichts.
 *
 * ── Was daran Absicht ist und was nicht ───────────────────────────────────
 *
 * Fuer `private` ist es dokumentierte Absicht: die Werkzeugbeschreibung sagt
 * ausdruecklich "only accessible via exact recall_best_solution, never
 * surfaced in smart_recall or team_recall". Eine private Notiz soll ihr Autor
 * unter ihrem Namen wiederfinden.
 *
 * Fuer `group` steht das NIRGENDS. Der Gruppen-Zuschnitt ist als
 * Zugriffsgrenze gebaut — `team_grant_scope` vergibt ihn, `smart_recall`
 * setzt ihn durch. Dass derselbe Inhalt ueber den zweiten Weg ohne jede
 * Pruefung herauskommt, ist keine Entscheidung, sondern eine Luecke.
 *
 * Diese Datei schreibt den Befund als Proben fest — erst rot, dann gruen.
 */

describe('Karte pguy341m6u7s — der zweite Lesepfad prueft nicht', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () =>
    ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => {
    redis = new MockRedis();
  });

  const lerne = (topic: string, was: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool(
      'learn_from_attempts',
      { instance_id: 'i1', topic, outcome: 'success', what_worked: was, ...extra },
      getConn,
      noopApiFetch,
    );

  const gruppeMit = (gruppe: string, wer: string) =>
    handleTeamTool(
      'team_grant_scope',
      { instance_id: 'i1', handle: wer, group: gruppe },
      getConn,
      noopApiFetch,
    );

  // ── Der belegte Zustand: smart_recall haelt dicht ───────────────────────

  it('smart_recall verweigert eine gruppen-beschraenkte Lektion einem Fremden', async () => {
    await lerne('security:schluessel-drehen', 'Der xyzzy-Schluessel wird quartalsweise gedreht.', {
      group: 'security',
      author: 'alice',
    });

    const fremd = String(
      await handleBrainTool(
        'smart_recall',
        { instance_id: 'i1', query: 'xyzzy schluessel', author: 'bob' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(fremd, 'Bob ist nicht in der Gruppe security').not.toContain('quartalsweise');
  });

  it('GEGENPROBE: ein Gruppenmitglied bekommt sie sehr wohl', async () => {
    /*
     * Ohne diese Zeile bewiese die Probe darueber nichts: sie waere auch dann
     * gruen, wenn die Lektion aus einem anderen Grund gar nicht gefunden wird
     * (Unterscheidbarkeits-Probe).
     */
    await lerne('security:schluessel-drehen', 'Der xyzzy-Schluessel wird quartalsweise gedreht.', {
      group: 'security',
      author: 'alice',
    });
    await gruppeMit('security', 'carol');

    const drin = String(
      await handleBrainTool(
        'smart_recall',
        { instance_id: 'i1', query: 'xyzzy schluessel', author: 'carol' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(drin, 'Carol IST in der Gruppe — sie muss die Lektion sehen').toContain('quartalsweise');
  });

  // ── Der Befund: recall_best_solution haelt NICHT dicht ──────────────────

  it('recall_best_solution gibt eine gruppen-beschraenkte Lektion an jeden heraus', async () => {
    /*
     * Der Kern dieser Karte. Wer den Namen kennt — und der steht in jeder
     * Trefferliste, in jedem Verweis, in jedem Ersetzt-Banner — liest den
     * vollen Inhalt, ohne in der Gruppe zu sein.
     */
    await lerne('security:schluessel-drehen', 'Der xyzzy-Schluessel wird quartalsweise gedreht.', {
      group: 'security',
      author: 'alice',
    });

    const out = String(
      await handleBrainTool(
        'recall_best_solution',
        { instance_id: 'i1', topic: 'security:schluessel-drehen', author: 'bob' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(
      out,
      'Bob ist nicht in der Gruppe security — der zweite Lesepfad muss dieselbe ' +
        'Grenze ziehen wie smart_recall.',
    ).not.toContain('quartalsweise');
  });

  it('GEGENPROBE: das Gruppenmitglied bekommt sie ueber denselben Weg', async () => {
    await lerne('security:schluessel-drehen', 'Der xyzzy-Schluessel wird quartalsweise gedreht.', {
      group: 'security',
      author: 'alice',
    });
    await gruppeMit('security', 'carol');

    const out = String(
      await handleBrainTool(
        'recall_best_solution',
        { instance_id: 'i1', topic: 'security:schluessel-drehen', author: 'carol' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(out, 'Carol IST in der Gruppe').toContain('quartalsweise');
  });

  it('ohne Autor bleibt eine gruppen-beschraenkte Lektion zu — die vorsichtige Richtung', async () => {
    /*
     * Ein Aufruf ohne `author` kann nicht beweisen, dass er darf. Die sichere
     * Antwort ist dann Nein.
     *
     * Das ist eine Verschaerfung gegenueber heute und bewusst so: bei einer
     * Zugriffsgrenze ist "im Zweifel oeffnen" die falsche Richtung. Team-weite
     * Lektionen (ohne Gruppe) sind davon NICHT betroffen — sie bleiben ohne
     * Autor lesbar, siehe die Gegenprobe darunter.
     */
    await lerne('security:schluessel-drehen', 'Der xyzzy-Schluessel wird quartalsweise gedreht.', {
      group: 'security',
    });

    const out = String(
      await handleBrainTool(
        'recall_best_solution',
        { instance_id: 'i1', topic: 'security:schluessel-drehen' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(out).not.toContain('quartalsweise');
  });

  it('GEGENPROBE: eine team-weite Lektion bleibt ohne Autor lesbar', async () => {
    /*
     * Die Verschaerfung darf nicht den Normalfall treffen. Der weitaus
     * groesste Teil des Bestands hat gar keine Gruppe; wuerde der auch
     * zugehen, waere das Gedaechtnis fuer die meisten Aufrufe tot.
     */
    await lerne('deploy:cache-nutzen', 'Die plugh-Ebenen werden zwischengespeichert.');

    const out = String(
      await handleBrainTool(
        'recall_best_solution',
        { instance_id: 'i1', topic: 'deploy:cache-nutzen' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(out).toContain('zwischengespeichert');
  });

  it('eine PRIVATE Lektion bleibt ueber den exakten Namen erreichbar — das ist Absicht', async () => {
    /*
     * Bewusst KEINE Verschaerfung. Die Werkzeugbeschreibung sagt es zu:
     * "private = only accessible via exact recall_best_solution". Wer seine
     * eigene Notiz unter ihrem Namen sucht, soll sie finden.
     *
     * Diese Probe steht hier, damit die Verschaerfung fuer Gruppen nicht
     * unbemerkt auf private Lektionen ueberschwappt — das waere eine
     * Verhaltensaenderung, die niemand angekuendigt hat.
     */
    await lerne('notiz:mein-kram', 'Der plugh-Weg ist mein eigener.', { visibility: 'private' });

    const out = String(
      await handleBrainTool(
        'recall_best_solution',
        { instance_id: 'i1', topic: 'notiz:mein-kram' },
        getConn,
        noopApiFetch,
      ),
    );
    expect(out).toContain('mein eigener');
  });
});
