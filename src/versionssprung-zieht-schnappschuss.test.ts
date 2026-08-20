import { existsSync, readFileSync } from 'node:fs';
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

  it('jedes Glied der Kette zeigt auf etwas, das es gibt', () => {
    /*
     * GEGENPROBE gegen einen Haken, der ins Leere greift: ein Skriptname mit
     * Tippfehler wuerde bei jedem Sprung still fehlschlagen.
     *
     * Erweitert am 20.08.2026. Vorher nahm diese Zeile an, der Haken sei
     * GENAU EIN `npm run <name>`. Dann kam `nummer-nachziehen` davor, und die
     * Probe fiel — richtigerweise, aber aus dem falschen Grund: die Kette war
     * in Ordnung, nur die Annahme nicht.
     *
     * Jetzt prueft sie, was sie immer meinte: jedes Glied der Kette zeigt auf
     * etwas Vorhandenes — ein npm-Skript oder eine Datei.
     */
    const s = paket().scripts ?? {};
    const glieder = (s.version ?? '').split('&&').map((g) => g.trim()).filter(Boolean);
    expect(glieder.length, 'der Haken ist leer').toBeGreaterThan(0);

    for (const glied of glieder) {
      if (glied.startsWith('npm run ')) {
        const name = glied.slice('npm run '.length).trim();
        expect(Object.keys(s), `der Haken ruft "npm run ${name}" — das Skript gibt es nicht`)
          .toContain(name);
      } else if (glied.startsWith('node ')) {
        const datei = glied.slice('node '.length).trim().split(/\s+/)[0];
        expect(
          existsSync(new URL(`../${datei}`, import.meta.url)),
          `der Haken ruft "node ${datei}" — die Datei gibt es nicht`,
        ).toBe(true);
      } else {
        // Ein Glied, das weder npm-Skript noch node-Aufruf ist, wird hier
        // nicht geprueft. Das still durchzuwinken waere derselbe Fehler noch
        // einmal, also faellt die Probe stattdessen laut.
        throw new Error(`unbekannte Form im Haken: "${glied}" — die Pruefung kennt sie nicht`);
      }
    }
  });

  it('die Waechter-Meldung nennt den Zusammenhang', () => {
    // Der Haken hilft nur, wer `npm version` benutzt. Wer die Nummer von Hand
    // aendert, braucht den Hinweis im Text.
    const text = readFileSync(new URL('../scripts/versionswaechter.mjs', import.meta.url), 'utf8');
    expect(text).toContain('tool-specs');
  });
});
