/**
 * Beinahe-Duplikate benennen, nicht aufloesen (01.09.2026).
 *
 * Die Ersetzungs-Mechanik (exa5ya3w2m0w) greift nur bei EXPLIZITEM Verweis.
 * Zwei fast gleiche Eintraege ohne Verweis — der haeufigste Fall, wenn ein
 * Fakt neu gelernt wird, ohne den alten zu kennen — standen bis heute
 * unkommentiert nebeneinander. Der Hinweis nennt beide mit Datum und WAEHLT
 * NICHT (Zeitstempel-Falle: neuer heisst nicht gueltiger).
 *
 * GEGENPROBE ist Pflicht: zwei bloss verwandte Eintraege (Naehe unter der
 * Schwelle) bekommen KEINEN Hinweis — sonst wuerde jede thematische
 * Nachbarschaft zum Duplikatsverdacht erklaert und der Hinweis stumpft ab.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { packe, VEKTOR_PRAEFIX } from '../bedeutung.js';

describe('Nahduplikat-Hinweis im Recall', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what,
    }, getConn, noopApiFetch);

  /** Ein Einheitsvektor mit leichter, steuerbarer Drehung. */
  const vektor = (drehung: number): number[] => {
    const v = new Array(32).fill(0);
    v[0] = Math.cos(drehung);
    v[1] = Math.sin(drehung);
    return v;
  };

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('zwei fast identische Vektoren ohne Verweis -> Hinweis mit beiden Themen', async () => {
    await lerne('deploy:staging-port-alt', 'Die Staging-Datenbank lauscht auf Port 5433.');
    await lerne('deploy:staging-port-neu', 'Die Staging-Datenbank lauscht seit dem Umzug auf Port 6543.');
    // Naehe cos(0.1) ~ 0.995 — klar ueber der Schwelle 0.9.
    await redis.set(`${VEKTOR_PRAEFIX}deploy:staging-port-alt`, packe(vektor(0)));
    await redis.set(`${VEKTOR_PRAEFIX}deploy:staging-port-neu`, packe(vektor(0.1)));

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'staging datenbank port',
    }, getConn, noopApiFetch));

    expect(out).toContain('sagen fast dasselbe');
    expect(out).toContain('deploy:staging-port-alt');
    expect(out).toContain('deploy:staging-port-neu');
    // Der Hinweis WAEHLT nicht: kein Text, der eine Fassung fuer gueltig erklaert.
    expect(out).toContain('die neuere ist nicht automatisch die richtige');
  });

  it('GEGENPROBE: verwandte, aber verschiedene Vektoren -> KEIN Hinweis', async () => {
    await lerne('deploy:staging-port-alt', 'Die Staging-Datenbank lauscht auf Port 5433.');
    await lerne('deploy:staging-backup', 'Die Staging-Datenbank wird naechtlich gesichert.');
    // Naehe cos(0.7) ~ 0.765 — unter der Schwelle 0.9.
    await redis.set(`${VEKTOR_PRAEFIX}deploy:staging-port-alt`, packe(vektor(0)));
    await redis.set(`${VEKTOR_PRAEFIX}deploy:staging-backup`, packe(vektor(0.7)));

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'staging datenbank',
    }, getConn, noopApiFetch));

    expect(out).not.toContain('sagen fast dasselbe');
  });

  it('GEGENPROBE: fehlende Vektoren -> stiller No-op, kein Absturz', async () => {
    await lerne('deploy:a', 'Text eins ueber die Staging-Datenbank.');
    await lerne('deploy:b', 'Text zwei ueber die Staging-Datenbank.');

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'staging datenbank',
    }, getConn, noopApiFetch));

    expect(out).not.toContain('sagen fast dasselbe');
  });
});
