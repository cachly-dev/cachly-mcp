import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ABNAHME: ein Versionssprung darf den Drift Guard nicht rot machen.
 *
 * ── Der Vorfall ─────────────────────────────────────────────────────────────
 *
 * Am 20.08.2026 kam der Versionswaechter (PR #423) dazu: wer `sdk/mcp/src`
 * aendert, muss die Nummer heben. Der erste PR, der das befolgte, wurde
 * prompt rot — der Drift Guard meldete
 *
 *   Stale docs/generated/tool-specs/cachly.openapi.json
 *
 * Grund: die Schnappschuesse tragen die Versionsnummer mit. Ein Waechter
 * verlangte etwas, das einen zweiten Waechter ausloeste.
 *
 * ── Warum ein Haken und nicht ein Merksatz ──────────────────────────────────
 *
 * Man haette in eine Anleitung schreiben koennen "denk dran, die
 * Schnappschuesse mitzuziehen". Anleitungen werden nicht gelesen, wenn man
 * eilig ist — und eilig ist man beim Versionssprung immer.
 *
 * Der npm-Haken `version` laeuft bei jedem `npm version` von selbst. Damit
 * ist der Zusammenhang keine Regel mehr, die jemand kennen muss, sondern
 * einer, der von allein gilt.
 */

const paket = (): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('Versionssprung zieht die Schnappschuesse mit', () => {
  it('der npm-Haken "version" ist gesetzt', () => {
    expect(paket().scripts?.version, 'ohne diesen Haken wird der naechste Sprung rot')
      .toBeDefined();
  });

  it('er ruft wirklich die Schnappschuesse und nicht irgendetwas', () => {
    expect(paket().scripts?.version).toContain('tool-spec-snapshots');
  });

  it('das Ziel des Hakens existiert als eigenes Skript', () => {
    // GEGENPROBE gegen einen Haken, der ins Leere greift: ein Skriptname mit
    // Tippfehler wuerde bei jedem Sprung still fehlschlagen.
    const s = paket().scripts ?? {};
    const gerufen = (s.version ?? '').replace(/^npm run /, '').trim();
    expect(Object.keys(s), `der Haken ruft "${gerufen}" — das gibt es nicht`)
      .toContain(gerufen);
  });

  it('die Waechter-Meldung nennt den Zusammenhang', () => {
    // Der Haken hilft nur, wer `npm version` benutzt. Wer die Nummer von Hand
    // aendert, braucht den Hinweis im Text.
    const text = readFileSync(new URL('../scripts/versionswaechter.mjs', import.meta.url), 'utf8');
    expect(text).toContain('tool-specs');
  });
});
