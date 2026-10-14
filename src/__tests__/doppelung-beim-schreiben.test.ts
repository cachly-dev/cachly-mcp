/**
 * Der ganze Weg (Abhakliste 4.4, 14.10.2026): learn_from_attempts schreibt,
 * der Hintergrund vermerkt die moegliche Doppelung, session_start nennt sie,
 * memory_consolidate rechnet sie aus den Vektoren — statt der alten
 * Praefix-Zaehlung, die im eigenen Brain 81 "Gruppen" ohne eine Doppelung fand.
 *
 * GEGENPROBE: zwei bloss verwandte Lektionen (0,76) tauchen nirgends auf.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Kosinus zwischen zwei Lektionen = cos(Winkeldifferenz); der Winkel steht im Text. */
const WINKEL: Record<string, number> = {
  ALT: 0,
  DOPPEL: Math.acos(0.85),
  VERWANDT: -Math.acos(0.76),
  // Wie DOPPEL, aber der Einbettungsdienst braucht 2,5 s (laenger als DOPPEL_WARTE_MS).
  LANGSAM: Math.acos(0.85),
};
const vektorFuer = (text: string): number[] => {
  const marke = Object.keys(WINKEL).find((m) => text.includes(`[${m}]`)) ?? 'ALT';
  const v = new Array<number>(16).fill(0);
  v[0] = Math.cos(WINKEL[marke]!);
  v[1] = Math.sin(WINKEL[marke]!);
  return v;
};

/** Themen, deren Hintergrundpruefung fertig ist — sonst bewiese die Gegenprobe nur, dass sie noch nicht lief. */
const { geprueft } = vi.hoisted(() => ({ geprueft: [] as string[] }));
vi.mock('../doppel-kandidat.js', async (original) => {
  const echt = await original<typeof import('../doppel-kandidat.js')>();
  return {
    ...echt,
    pruefeDoppelung: async (...a: Parameters<typeof echt.pruefeDoppelung>) => {
      const k = await echt.pruefeDoppelung(...a);
      geprueft.push(a[1].topic);
      return k;
    },
  };
});

vi.mock('../embeddings.js', async (original) => {
  const echt = await original<typeof import('../embeddings.js')>();
  return {
    ...echt,
    hasEmbedProvider: () => true,
    EMBED_PROVIDER: 'cachly',
    computeEmbedding: vi.fn(async (t: string, opts?: { modell?: string }) => {
      if (opts?.modell) throw new Error('kein Zweitmodell in dieser Probe');
      if (t.includes('[LANGSAM]')) await new Promise((r) => setTimeout(r, 2500));
      return vektorFuer(t);
    }),
  };
});

import { handleBrainTool } from '../handlers/brain.js';
import { handleAdvancedTool } from '../handlers/advanced.js';
import { DOPPEL_SCHLUESSEL, DOPPEL_WARTE_MS } from '../doppel-kandidat.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Doppelung beim Schreiben: vermerken, im Briefing nennen, nie zusammenlegen', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async <T>(): Promise<T> => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as T;
  const lerne = (topic: string, what: string) =>
    handleBrainTool('learn_from_attempts', { instance_id: 'i1', topic, outcome: 'success', what_worked: what }, getConn, noopApiFetch);
  /** Der Vektor und die Pruefung laufen im Hintergrund; warten, bis sie fuer dieses Thema durch ist. */
  const warteAufPruefung = (topic: string) => vi.waitFor(() => { expect(geprueft).toContain(topic); }, { timeout: 3000 });

  beforeEach(async () => {
    redis = new MockRedis();
    geprueft.length = 0;
    await lerne('node1:keycloak-hostname-fest', '[ALT] Keycloak nimmt den Hostnamen fest aus KC_HOSTNAME=auth.cachly.dev, je Produkt geht nicht.');
    await warteAufPruefung('node1:keycloak-hostname-fest');
  });

  it('0,85: Vermerk, Briefing nennt beide, memory_consolidate auch — Lektionen bleiben alle', async () => {
    await lerne('node1:kc-hostname-stillgelegt', '[DOPPEL] KC_HOSTNAME ist seit 03.09. stillgelegt, Keycloak 26 nimmt den Host aus der Anfrage.');
    await warteAufPruefung('node1:kc-hostname-stillgelegt');
    await vi.waitFor(async () => {
      expect(Object.keys(await redis.hgetall(DOPPEL_SCHLUESSEL))).toEqual(['node1:kc-hostname-stillgelegt']);
    });

    const briefing = String(await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(briefing).toContain('Possible duplicates');
    expect(briefing).toMatch(/`node1:kc-hostname-stillgelegt` ≈ `node1:keycloak-hostname-fest` \(0\.8[45]\)/);
    expect(briefing).toContain('ersetzt=');

    const bericht = String(await handleAdvancedTool('memory_consolidate', { instance_id: 'i1', dry_run: true }, getConn, noopApiFetch));
    expect(bericht).toContain('Possible duplicates — same meaning, different topic');
    expect(bericht).toContain('`node1:kc-hostname-stillgelegt` ≈ `node1:keycloak-hostname-fest`');
    expect(bericht).not.toContain('Duplicate clusters');

    // Nichts zusammengelegt, nichts geloescht.
    expect(await redis.get('cachly:lesson:best:node1:keycloak-hostname-fest')).not.toBeNull();
    expect(await redis.get('cachly:lesson:best:node1:kc-hostname-stillgelegt')).not.toBeNull();
  });

  it('Weg a: die Antwort von learn_from_attempts nennt die Doppelung sofort, mit dem Weg ersetzt', async () => {
    const antwort = String(await lerne('node1:kc-hostname-stillgelegt', '[DOPPEL] KC_HOSTNAME ist seit 03.09. stillgelegt, Keycloak 26 nimmt den Host aus der Anfrage.'));
    expect(antwort).toMatch(/Sagt fast dasselbe wie `node1:keycloak-hostname-fest` \(Bedeutung 0\.8[45]\)/);
    expect(antwort).toContain('ersetzt="node1:keycloak-hostname-fest"');
  });

  it('Weg a, langsamer Dienst: die Antwort wartet hoechstens DOPPEL_WARTE_MS, der Vermerk kommt trotzdem', async () => {
    const start = Date.now();
    const antwort = String(await lerne('node1:kc-langsam', '[LANGSAM] KC_HOSTNAME ist seit 03.09. stillgelegt, Keycloak 26 nimmt den Host aus der Anfrage.'));
    const dauer = Date.now() - start;
    expect(dauer).toBeGreaterThanOrEqual(DOPPEL_WARTE_MS - 50);
    expect(dauer).toBeLessThan(DOPPEL_WARTE_MS + 800);
    expect(antwort).toContain('Lesson stored');
    expect(antwort).not.toContain('Sagt fast dasselbe');
    await vi.waitFor(async () => {
      expect(Object.keys(await redis.hgetall(DOPPEL_SCHLUESSEL))).toContain('node1:kc-langsam');
    }, { timeout: 5000 });
  }, 10_000);

  it('GEGENPROBE: bloss verwandt (0,76) -> kein Vermerk, kein Briefing-Abschnitt, 0 Paare', async () => {
    const antwort = String(await lerne('node1:keycloak-realm-export', '[VERWANDT] Der Keycloak-Realm wird als JSON exportiert und im Repo keycloak-deploy gepflegt.'));
    await warteAufPruefung('node1:keycloak-realm-export');

    expect(antwort).not.toContain('Sagt fast dasselbe');
    expect(await redis.hgetall(DOPPEL_SCHLUESSEL)).toEqual({});
    const briefing = String(await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(briefing).not.toContain('Possible duplicates');
    const bericht = String(await handleAdvancedTool('memory_consolidate', { instance_id: 'i1', dry_run: true }, getConn, noopApiFetch));
    expect(bericht).toMatch(/Possible duplicates — same meaning, different topic \(cosine ≥ 0\.80, never merged\):\*\* 0/);
  });
});
