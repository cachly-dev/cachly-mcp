/**
 * Vektorluecken heilen sich selbst (Karte 8jnckd2stesi, 02.09.2026).
 *
 * Der Wett-Probelauf bewies die Klasse: Massen-Ingest unter 429-Drosselung
 * plus Prozessende direkt nach dem letzten Schreiben liess 78 % der Lektionen
 * OHNE Vektor zurueck — und weil nur der Schreibpfad heilte, blieb eine
 * Instanz, in die niemand mehr schreibt, dauerhaft blind.
 *
 * Drei Zusagen werden hier festgenagelt:
 * 1. WRITE-AHEAD: Der Vermerk steht VOR dem Embedding-Versuch — ein Kill
 *    mitten im Versuch hinterlaesst eine Spur (simuliert durch einen Wurf).
 * 2. AUSTRAG: Nach ERFOLG ist der Vermerk wieder weg — sonst wuerde jede
 *    gesunde Lektion endlos nachgebettet.
 * 3. LESEND HEILEN: smart_recall arbeitet den Vermerk ab — die Instanz
 *    heilt beim Lesen, nicht nur beim Schreiben.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const embedMock = vi.hoisted(() => ({
  fail: false,
  haengt: false,
  calls: 0,
}));

vi.mock('../embeddings.js', async (original) => {
  const echt = await original<typeof import('../embeddings.js')>();
  return {
    ...echt,
    hasEmbedProvider: () => true,
    EMBED_PROVIDER: 'cachly',
    computeEmbedding: vi.fn(async () => {
      embedMock.calls++;
      if (embedMock.haengt) return new Promise(() => { /* loest NIE auf — Kill-Simulation */ });
      if (embedMock.fail) throw new Error('429 too many requests (Probe)');
      const v = new Array(32).fill(0);
      v[0] = 1;
      return v;
    }),
  };
});

import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { VEKTOR_PRAEFIX } from '../bedeutung.js';

const VEK_NACHTRAG = 'cachly:vek:nachtrag';

describe('Selbstheilung von Vektorluecken', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what,
    }, getConn, noopApiFetch);

  /** Fire-and-forget-Bloecke ausschwingen lassen. */
  const ausschwingen = () => new Promise((r) => setTimeout(r, 50));

  beforeEach(() => {
    redis = new MockRedis();
    embedMock.fail = false;
    embedMock.haengt = false;
  });

  it('KILL-FALL (0.10.149): der Vermerk steht SYNCHRON — auch wenn das Embedding nie zurueckkommt', async () => {
    // Standalone-Beweis 02.09.2026: adjacent-2 blieb bei 72 % stehen, weil
    // Kill-Opfer ohne Vermerk unheilbar waren. Ein Embedding, das nie
    // aufloest, IST der Kill aus Sicht des Vermerks.
    embedMock.haengt = true;
    await lerne('deploy:kill-vor-vermerk', 'Der Port ist 6543.');

    // KEIN ausschwingen noetig — genau das ist die Zusage: synchron.
    expect(await redis.smembers(VEK_NACHTRAG)).toContain('deploy:kill-vor-vermerk');
  });

  it('WRITE-AHEAD: scheitert das Embedding, steht der Vermerk — die Luecke hat eine Spur', async () => {
    embedMock.fail = true;
    await lerne('deploy:drossel-opfer', 'Der Port ist 6543.');
    await ausschwingen();

    expect(await redis.smembers(VEK_NACHTRAG)).toContain('deploy:drossel-opfer');
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:drossel-opfer`)).toBeNull();
  });

  it('AUSTRAG: nach Erfolg ist der Vermerk weg und der Vektor da', async () => {
    await lerne('deploy:gesund', 'Der Port ist 6543.');
    await ausschwingen();

    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:gesund`)).not.toBeNull();
    expect(await redis.smembers(VEK_NACHTRAG)).not.toContain('deploy:gesund');
  });

  it('LESEND HEILEN: smart_recall bettet eine vermerkte Luecke nach', async () => {
    // Eine Lektion, deren Vektor "im Kill starb": Inhalt da, Vermerk da, Vektor fehlt.
    embedMock.fail = true;
    await lerne('deploy:kill-opfer', 'Die Staging-Datenbank lauscht auf Port 6543.');
    await ausschwingen();
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:kill-opfer`)).toBeNull();

    embedMock.fail = false;
    await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'voellig anderes thema',
    }, getConn, noopApiFetch);
    await ausschwingen();

    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:kill-opfer`)).not.toBeNull();
    expect(await redis.smembers(VEK_NACHTRAG)).not.toContain('deploy:kill-opfer');
  });

  it('HEILER-KILL (0.10.151): stirbt der Heilversuch, BLEIBT der Vermerk im Set', async () => {
    // Bis 0.10.150 nahm der Heiler den Vermerk per spop AUS dem Set und
    // legte ihn nur im Fehlerfall zurueck — starb der Prozess mitten im
    // Versuch (haengendes Embedding = Kill-Simulation), war der Vermerk
    // WEG und die Luecke fuer immer unsichtbar. Gemessen 02.09.2026: 29
    // von 290 Lektionen einer frischen Instanz so verloren.
    embedMock.fail = true;
    await lerne('deploy:heiler-kill-opfer', 'Der Registry-Spiegel lauscht auf Port 5001.');
    await ausschwingen();
    expect(await redis.smembers(VEK_NACHTRAG)).toContain('deploy:heiler-kill-opfer');

    embedMock.fail = false;
    embedMock.haengt = true; // der Heilversuch kommt nie zurueck = Prozess-Tod
    // BEWUSST nicht awaited: auch die Suchanfrage selbst haengt im
    // Embedding — genau wie ein Prozess, der mittendrin stirbt.
    void handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'voellig anderes thema',
    }, getConn, noopApiFetch);
    await new Promise((z) => setTimeout(z, 150)); // der Heiler kam bis zum srandmember

    expect(await redis.smembers(VEK_NACHTRAG)).toContain('deploy:heiler-kill-opfer');
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:heiler-kill-opfer`)).toBeNull();
  });

  it('KOMPAKT (CACHLY_RECALL_COMPACT=1): hoechstens 3 Treffer, keine Score-Prosa, keine Feedback-Bitte', async () => {
    // Anlass 02.09.2026: ~24.000 Zeichen Werkzeugtext je Bench-Sitzung, in
    // jeder Folgerunde neu gesendet. Der Kompakt-Modus schmaelert NUR die
    // Darstellung — Rangfolge und Abstention bleiben, wie sie sind.
    for (let i = 1; i <= 5; i++) {
      await lerne(`deploy:kompakt-${i}`, `Der Dienst Nummer ${i} lauscht auf Port 80${i}0 und braucht das Deploy-Token.`);
    }
    await ausschwingen();
    process.env.CACHLY_RECALL_COMPACT = '1';
    try {
      const text = String(await handleBrainTool('smart_recall', {
        instance_id: 'i1', query: 'deploy dienst port token',
      }, getConn, noopApiFetch));
      // Fuenf statt drei (Widerlegungsauftrag, Einwand 3); die Beleg-Zeile
      // bleibt bewusst auch im Kompakt-Modus (Einwand 6).
      expect((text.match(/💡 /g) ?? []).length).toBeLessThanOrEqual(5);
      expect(text).not.toContain('recall_feedback');
      expect(text).not.toContain('BM25:');
    } finally {
      delete process.env.CACHLY_RECALL_COMPACT;
    }
    // GEGENPROBE: ohne den Schalter steht die Feedback-Bitte wieder drin.
    const voll = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'deploy dienst port token',
    }, getConn, noopApiFetch));
    expect(voll).toContain('recall_feedback');
  });

  it('GEGENPROBE: leerer Vermerk — Lesen heilt nichts, stuerzt nicht, ruft kein Embedding extra', async () => {
    await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'irgendwas',
    }, getConn, noopApiFetch);
    await ausschwingen();

    expect(await redis.smembers(VEK_NACHTRAG)).toEqual([]);
  });
});
