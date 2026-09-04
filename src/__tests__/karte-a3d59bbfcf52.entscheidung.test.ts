/**
 * Karte a3d59bbfcf52 (WOW #2) — Gedaechtnis mit Begruendung.
 *
 * Die Entscheidung wird beim SCHREIBEN abgeleitet (nie geraten, enge
 * woertliche Muster) und im Recall als eigene Zeile gezeigt: "Bewusst
 * entschieden GEGEN X — Grund: Y. Nicht ohne NEUEN Grund aufweichen."
 * Die Gegenproben sichern, dass "gegen 18 Uhr" und beilaeufige Saetze
 * NIE zur Entscheidung werden — eine erfundene Entscheidungs-Zeile
 * wuerde kuenftige Arbeit mit falscher Autoritaet blockieren.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { leiteEntscheidungAb, entscheidungsZeile } from '../entscheidung-ableiten.js';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('leiteEntscheidungAb — die reine Ableitung', () => {
  it('FINDE: "entschieden gegen X, weil Y" -> gegen + Grund', () => {
    const e = leiteEntscheidungAb('Wir haben uns entschieden gegen GraphQL, weil 123 Werkzeuge an zwei Orten die zweite Wahrheit sind.');
    expect(e).toEqual({ gegen: 'GraphQL', grund: '123 Werkzeuge an zwei Orten die zweite Wahrheit sind' });
  });

  it('FINDE: "bewusst gegen X entschieden" ohne Grund -> Grund null', () => {
    const e = leiteEntscheidungAb('Am 12.08. bewusst gegen ein eigenes Placebo-Framework entschieden.');
    expect(e?.gegen).toBe('ein eigenes Placebo-Framework');
    expect(e?.grund).toBeNull();
  });

  it('FINDE: englische Form "decided against X because Y"', () => {
    const e = leiteEntscheidungAb('We decided against Clerk because Keycloak already carries the realm config.');
    expect(e?.gegen).toBe('Clerk');
    expect(e?.grund).toContain('Keycloak');
  });

  it('GEGENPROBE: "gegen 18 Uhr" ist eine Zeitangabe, keine Entscheidung', () => {
    expect(leiteEntscheidungAb('Der Lauf endete gegen 18 Uhr, entschieden gegen 18 Uhr war da nichts.')).toBeNull();
  });

  it('GEGENPROBE: beilaeufiges "dagegen hilft" wird nicht zur Entscheidung', () => {
    expect(leiteEntscheidungAb('Die Platte war voll; dagegen hilft nur journal vacuum und image prune.')).toBeNull();
  });

  it('GEGENPROBE: normaler Fix-Text ohne Entscheidungs-Wortlaut -> null', () => {
    expect(leiteEntscheidungAb('Der npm-Cache liegt an elf Stellen und wird zentral geleert.')).toBeNull();
  });

  it('entscheidungsZeile traegt die Warnung vor dem Aufweichen', () => {
    expect(entscheidungsZeile({ gegen: 'GraphQL', grund: 'zweite Wahrheit' }))
      .toBe('⚖️ **Bewusst entschieden GEGEN GraphQL** — Grund: zweite Wahrheit. Nicht ohne NEUEN Grund aufweichen.');
  });
});

describe('im Schreib- und Lesepfad', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => { redis = new MockRedis(); });

  it('learn leitet die Entscheidung ab, recall_best_solution zeigt die Zeile', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'architektur:kein-plugh-gateway', outcome: 'success',
      what_worked: 'Wir haben uns entschieden gegen ein plugh-Gateway, weil der Sammel-Endpunkt dieselbe Ersparnis ohne zweite Wahrheit bringt.',
    }, getConn, noopApiFetch);

    const roh = await redis.get('cachly:lesson:best:architektur:kein-plugh-gateway');
    expect(JSON.parse(roh as string).entscheidung).toEqual({
      gegen: 'ein plugh-Gateway',
      grund: 'der Sammel-Endpunkt dieselbe Ersparnis ohne zweite Wahrheit bringt',
    });

    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'architektur:kein-plugh-gateway',
    }, getConn, noopApiFetch));
    expect(out).toContain('Bewusst entschieden GEGEN ein plugh-Gateway');
    expect(out).toContain('Nicht ohne NEUEN Grund aufweichen');
  });

  it('GEGENPROBE: eine Lektion ohne Entscheidungs-Wortlaut bekommt KEINE Zeile', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:xyzzy-cache', outcome: 'success',
      what_worked: 'Der xyzzy-Cache wird zentral geleert.',
    }, getConn, noopApiFetch);
    const roh = await redis.get('cachly:lesson:best:deploy:xyzzy-cache');
    expect(JSON.parse(roh as string).entscheidung).toBeUndefined();
    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:xyzzy-cache',
    }, getConn, noopApiFetch));
    expect(out).not.toContain('Bewusst entschieden GEGEN');
  });
});
