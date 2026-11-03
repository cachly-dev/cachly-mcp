/**
 * Die erste Sitzung eines neuen Nutzers ist englisch und zeigt nur Gezaehltes
 * (03.11.2026).
 *
 * Befund aus dem Probelauf mit einem frischen Test-Brain (session_start,
 * learn_from_attempts, smart_recall, recall_best_solution, session_end):
 *   - acht deutsche Saetze, darunter "2 von 7 belegt", "Hat eine davon
 *     geholfen?", "Update abgewiesen" und "Gedaechtnis-Kosten";
 *   - "Brain saved you ~0min here" ueber einer Antwort OHNE Treffer, fuer eine
 *     Lektion, die gar nicht gezeigt wurde;
 *   - "Brain saved you ~6h 30m total" nach EINER Sitzung mit fuenf Lektionen;
 *   - der Aenderungsabdruck von index_project (cachly:idx:hash:<datei>,
 *     Inhalt "17:17:e535…") als eigener Treffer.
 *
 * GEGENPROBE: Nimmt man in search.ts den Filter auf cachly:idx:hash: heraus,
 * wird der letzte Test rot.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';
import { alterssatzFuerBelegte } from '../abstention.js';
import { knapperSiegSatz } from '../rangfolge.js';
import { kostenZeilen } from '../sitzungs-kosten.js';
import { vorspannHinweis } from '../vorspann.js';
import { entscheidungsZeile } from '../entscheidung-ableiten.js';
import { upgradeNudge } from '../upgrade-nudge.js';

/** Woerter, die in einem englischen Satz nicht vorkommen. */
const DEUTSCH = /[äöüß]|\b(nicht|keine?|davon|belegt|Lektion|Treffer|Grund|Fassung|abgewiesen|Zeichen|Sitzung|ersetzt)\b/;

describe('erste Sitzung: Ausgabesaetze sind englisch', () => {
  it('Hilfssaetze von smart_recall, learn_from_attempts und session_end', () => {
    const saetze = [
      alterssatzFuerBelegte([40]),
      alterssatzFuerBelegte([12, 40]),
      knapperSiegSatz(0.01),
      ...kostenZeilen({ recalls: 3, wiederholungen: 2, antwortZeichen: 4000 } as Parameters<typeof kostenZeilen>[0]),
      vorspannHinweis('the deploy was slow because the cache layer was rebuilt every time'),
      entscheidungsZeile({ gegen: 'GraphQL', grund: 'one source of truth' }),
    ];
    for (const s of saetze) {
      expect(s, 'ein Satz fehlt — die Probe prueft sonst nichts').toBeTruthy();
      expect(s as string).not.toMatch(DEUTSCH);
    }
  });

  it('der Upgrade-Hinweis nennt keine geschaetzte Zeit', () => {
    expect(upgradeNudge({ used: 450, limit: 500 })).not.toMatch(/saved/i);
  });
});

describe('erste Sitzung: Handler', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const ruf = async (name: string, args: Record<string, unknown>) =>
    String(await handleBrainTool(name, { instance_id: 'i1', ...args }, getConn, noopApiFetch));

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('smart_recall mit Treffern: englische Zeilen, kein "Brain saved you"', async () => {
    await ruf('learn_from_attempts', {
      topic: 'auth:oauth-redirect-loop', outcome: 'success',
      what_worked: 'SET SameSite=Lax ON THE SESSION COOKIE — the OAuth callback is a cross-site redirect',
    });
    // Zweimal abrufen: das Banner kam nur ab dem zweiten Abruf.
    await ruf('smart_recall', { query: 'login redirect loop after OAuth' });
    const aus = await ruf('smart_recall', { query: 'login redirect loop after OAuth' });
    expect(aus).toContain('auth:oauth-redirect-loop');
    expect(aus).toContain('Did one of these help?');
    expect(aus).not.toContain('Brain saved you');
    expect(aus).not.toContain('Hat eine davon geholfen');
  });

  it('Update ohne grund: englische Ablehnung', async () => {
    const lerne = () => ruf('learn_from_attempts', {
      topic: 'deploy:probe', outcome: 'success', what_worked: 'npm ci before COPY . keeps the layer cached',
    });
    await lerne();
    const aus = await lerne();
    expect(aus).toContain('Update rejected');
    expect(aus).not.toMatch(DEUTSCH);
  });

  it('session_start nennt keine geschaetzte Zeit, auch wenn der Zaehler steht', async () => {
    await redis.set('cachly:stats:time_saved_mins:i1', '390');
    const aus = await ruf('session_start', { focus: 'database migration' });
    expect(aus).toContain('Session Briefing');
    expect(aus).not.toContain('Brain saved you');
  });

  it('der Aenderungsabdruck von index_project ist kein Treffer', async () => {
    await redis.set('cachly:idx:src/auth/session.ts', 'File: src/auth/session.ts\nexport const oauthSession = 1');
    await redis.set('cachly:idx:hash:src/auth/session.ts', '17:17:e53501716ba9');
    const aus = await ruf('smart_recall', { query: 'oauth session file src auth' });
    expect(aus).toContain('src/auth/session.ts');
    expect(aus).not.toContain('hash:src');
    expect(aus).not.toContain('e53501716ba9');
  });
});
