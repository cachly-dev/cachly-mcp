import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { MockRedis } from './__tests__/redis-mock.js';
import { Vektorbestand, packe, VEKTOR_PRAEFIX } from './bedeutung.js';
import {
  DOPPEL_SCHLUESSEL, DOPPEL_MINDEST_TEXT, doppelHinweis, doppelPaare, leseDoppelKandidaten, mitFrist, pruefeDoppelung,
  waehleDoppelKandidat, zaehltAlsDoppelung, type DoppelLektion,
} from './doppel-kandidat.js';
import { DOPPEL_SCHWELLE } from './rangfolge-stellschrauben.js';

/*
 * Abhakliste 4.4 (14.10.2026): Doppelungen nach Bedeutung. Am eigenen Brain
 * trafen ab 0,80 echte Doppelungen; darunter wird es Themen-Naehe, und leere
 * `ci:*`-Lektionen klangen gleich (0,95), weil ihr Vektor nur den Namen traegt.
 */

const TEXT = 'Keycloak liest den Hostnamen aus KC_HOSTNAME; seit 03.09. ist die Variable stillgelegt.';
const lek = (topic: string, extra: Partial<DoppelLektion> = {}): DoppelLektion => ({ topic, what_worked: TEXT, ...extra });

/** Ein Einheitsvektor in der Ebene: Kosinus zweier Vektoren = cos(Winkeldifferenz). */
const vektor = (winkel: number): number[] => {
  const v = new Array(16).fill(0);
  v[0] = Math.cos(winkel);
  v[1] = Math.sin(winkel);
  return v;
};
const fuerNaehe = (naehe: number) => vektor(Math.acos(naehe));

describe('zaehltAlsDoppelung', () => {
  it('ab der Schwelle ja, knapp darunter nein', () => {
    expect(DOPPEL_SCHWELLE).toBe(0.8);
    expect(zaehltAlsDoppelung(lek('a'), lek('b'), 0.8)).toBe(true);
    expect(zaehltAlsDoppelung(lek('a'), lek('b'), 0.799)).toBe(false);
  });

  it('dasselbe Thema ist ein Update, keine Doppelung', () => {
    expect(zaehltAlsDoppelung(lek('a'), lek('a'), 0.99)).toBe(false);
  });

  it('ohne Text zaehlt es nicht — so klangen ci:build-push-web und -api gleich (0,95)', () => {
    expect(zaehltAlsDoppelung(lek('ci:build-push-web', { what_worked: '' }), lek('ci:build-push-api', { what_worked: '' }), 0.95)).toBe(false);
    expect(zaehltAlsDoppelung(lek('a', { what_worked: 'x'.repeat(DOPPEL_MINDEST_TEXT - 1) }), lek('b'), 0.9)).toBe(false);
  });

  it('schon verknuepft (ersetzt / ersetzt_durch, beide Richtungen): kein Hinweis mehr', () => {
    expect(zaehltAlsDoppelung(lek('neu', { ersetzt: 'alt' }), lek('alt'), 0.9)).toBe(false);
    expect(zaehltAlsDoppelung(lek('neu'), lek('alt', { ersetzt_durch: 'neu' }), 0.9)).toBe(false);
    expect(zaehltAlsDoppelung(lek('alt', { ersetzt_durch: 'neu' }), lek('neu'), 0.9)).toBe(false);
  });
});

describe('waehleDoppelKandidat', () => {
  it('der naechste Nachbar, der zaehlt — nicht einfach der naechste', () => {
    const k = waehleDoppelKandidat(lek('neu'), [
      { lektion: lek('leer', { what_worked: '' }), naehe: 0.95 },
      { lektion: lek('alt-1'), naehe: 0.82 },
      { lektion: lek('alt-2'), naehe: 0.86 },
      { lektion: lek('nachbar'), naehe: 0.7 },
    ]);
    expect(k).toEqual({ topic: 'alt-2', naehe: 0.86 });
  });
});

describe('pruefeDoppelung: nach dem Schreiben vermerken', () => {
  let redis: MockRedis;
  const r = () => redis as unknown as Redis;
  const lege = async (topic: string, naehe: number, extra: Partial<DoppelLektion> = {}) => {
    await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({ ...lek(topic, extra), outcome: 'success' }));
    await redis.set(`${VEKTOR_PRAEFIX}${topic}`, packe(fuerNaehe(naehe)));
  };
  beforeEach(() => { redis = new MockRedis(); });

  it('0,85 zu einer aelteren Lektion: Vermerk mit Thema, Naehe und Datum', async () => {
    await lege('node1:keycloak-hostname-fest', 0.85);
    await lege('node1:fail2ban-ignoreip', 0.2);
    const k = await pruefeDoppelung(r(), lek('node1:kc-hostname-stillgelegt'), vektor(0), new Vektorbestand(0), new Date('2026-10-14T00:00:00Z'));
    expect(k).toMatchObject({ neu: 'node1:kc-hostname-stillgelegt', alt: 'node1:keycloak-hostname-fest', am: '2026-10-14T00:00:00.000Z' });
    expect(k!.naehe).toBeGreaterThan(0.84);
    expect(k!.naehe).toBeLessThan(0.86);
    const roh = await redis.hgetall(DOPPEL_SCHLUESSEL);
    expect(JSON.parse(roh['node1:kc-hostname-stillgelegt']!).alt).toBe('node1:keycloak-hostname-fest');
  });

  it('GEGENPROBE: bloss verwandt (0,76) -> kein Vermerk', async () => {
    await lege('node1:keycloak-realm', 0.76);
    expect(await pruefeDoppelung(r(), lek('node1:kc-hostname-stillgelegt'), vektor(0), new Vektorbestand(0))).toBeNull();
    expect(await redis.hgetall(DOPPEL_SCHLUESSEL)).toEqual({});
  });

  it('das Update mit ersetzt erledigt den alten Vermerk', async () => {
    await lege('alt', 0.9);
    const bestand = new Vektorbestand(0);
    expect(await pruefeDoppelung(r(), lek('neu'), vektor(0), bestand)).not.toBeNull();
    expect(await pruefeDoppelung(r(), lek('neu', { ersetzt: 'alt' }), vektor(0), bestand)).toBeNull();
    expect(await redis.hgetall(DOPPEL_SCHLUESSEL)).toEqual({});
  });

  it('Vermerke aelter als 30 Tage raeumt der naechste Schreibvorgang weg', async () => {
    await redis.hset(DOPPEL_SCHLUESSEL, 'uralt', JSON.stringify({ alt: 'x', naehe: 0.9, am: '2026-08-01T00:00:00Z' }));
    await redis.hset(DOPPEL_SCHLUESSEL, 'frisch', JSON.stringify({ alt: 'y', naehe: 0.9, am: '2026-10-10T00:00:00Z' }));
    await pruefeDoppelung(r(), lek('ohne-nachbarn'), vektor(0), new Vektorbestand(0), new Date('2026-10-14T00:00:00Z'));
    expect(Object.keys(await redis.hgetall(DOPPEL_SCHLUESSEL))).toEqual(['frisch']);
  });

  it('wirft nie: kaputte Verbindung -> null', async () => {
    const kaputt = { scan: async () => { throw new Error('weg'); } } as unknown as Redis;
    expect(await pruefeDoppelung(kaputt, lek('a'), vektor(0), new Vektorbestand(0))).toBeNull();
  });
});

describe('leseDoppelKandidaten: was das Briefing nennt', () => {
  let redis: MockRedis;
  const jetzt = new Date('2026-10-14T00:00:00Z');
  const vermerk = (neu: string, alt: string, naehe: number, am: string) =>
    redis.hset(DOPPEL_SCHLUESSEL, neu, JSON.stringify({ alt, naehe, am }));
  beforeEach(() => { redis = new MockRedis(); });

  it('frisch, beide da, nicht verknuepft — die naechsten zuerst', async () => {
    await vermerk('n1', 'a1', 0.81, '2026-10-13T00:00:00Z');
    await vermerk('n2', 'a2', 0.87, '2026-10-12T00:00:00Z');
    const k = await leseDoppelKandidaten(redis as unknown as Redis, [lek('n1'), lek('a1'), lek('n2'), lek('a2')], jetzt);
    expect(k.map((x) => x.neu)).toEqual(['n2', 'n1']);
  });

  it('nicht mehr genannt: geloescht, inzwischen verknuepft, aelter als 14 Tage', async () => {
    await vermerk('weg', 'a', 0.9, '2026-10-13T00:00:00Z');
    await vermerk('verknuepft', 'b', 0.9, '2026-10-13T00:00:00Z');
    await vermerk('alt', 'c', 0.9, '2026-09-20T00:00:00Z');
    const k = await leseDoppelKandidaten(redis as unknown as Redis,
      [lek('a'), lek('verknuepft', { ersetzt: 'b' }), lek('b'), lek('alt'), lek('c')], jetzt);
    expect(k).toEqual([]);
  });
});

describe('Weg a: Satz in der Antwort und Frist', () => {
  const k = { neu: 'neu', alt: 'node1:keycloak-hostname-fest', naehe: 0.852, am: '2026-10-14T00:00:00Z' };

  it('nennt Thema, Naehe und den Weg ersetzt', () => {
    const s = doppelHinweis(k);
    expect(s).toContain('`node1:keycloak-hostname-fest` (Bedeutung 0.85)');
    expect(s).toContain('ersetzt="node1:keycloak-hostname-fest"');
  });

  it('schweigt ohne Kandidat und wenn der Wort-Vorschlag dieselbe Lektion schon nennt', () => {
    expect(doppelHinweis(null)).toBe('');
    expect(doppelHinweis(k, '🔁 Das klingt wie eine Korrektur von `node1:keycloak-hostname-fest` …')).toBe('');
    expect(doppelHinweis(k, '🔁 Das klingt wie eine Korrektur von `node1:anderes` …')).not.toBe('');
  });

  it('mitFrist: Ergebnis vor der Frist, null danach', async () => {
    expect(await mitFrist(Promise.resolve(k), 50)).toBe(k);
    const spaet = new Promise<typeof k>((r) => setTimeout(() => r(k), 200));
    const start = Date.now();
    expect(await mitFrist(spaet, 50)).toBeNull();
    expect(Date.now() - start).toBeLessThan(180);
  });
});

describe('doppelPaare: alle Paare fuer memory_consolidate', () => {
  it('nennt die juengere als neu, laesst Nachbarn und Textlose weg', () => {
    const paare = doppelPaare([
      { lektion: lek('alt', { ts: '2026-09-01' }), vektor: vektor(0) },
      { lektion: lek('neu', { ts: '2026-10-01' }), vektor: fuerNaehe(0.83) },
      // Zu 'alt' 0, zu 'neu' rund 0,56: Nachbar, keine Doppelung.
      { lektion: lek('nachbar', { ts: '2026-10-02' }), vektor: vektor(Math.PI / 2) },
      { lektion: lek('leer', { ts: '2026-10-03', what_worked: '' }), vektor: vektor(0) },
    ]);
    expect(paare).toEqual([{ neu: 'neu', alt: 'alt', naehe: 0.83 }]);
  });
});
