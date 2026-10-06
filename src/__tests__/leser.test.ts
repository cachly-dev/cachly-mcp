import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leserAktiv, leserPunkte, leserSperreLoeschen, mischeMitLeser } from '../leser.js';
import { embedConfig } from '../embeddings.js';

const antwort = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

describe('mischeMitLeser — die gemessene Mischung (Arm L4)', () => {
  it('spreizt Haus und Leser je auf 0..1 und addiert 1:1', () => {
    // Haus: A vorn, Leser: C vorn. A: 1+0=1, B: 0,5+0,5=1, C: 0+1=1 -> Gleichstand, Index entscheidet.
    expect(mischeMitLeser([3, 2, 1], [0, 0.5, 1])).toEqual([0, 1, 2]);
    // Leser hebt C klar: A 1+0, B 0,5+0,2, C 0+1,8 (gewicht 1,8)
    expect(mischeMitLeser([3, 2, 1], [0, 0.1, 1], 1.8)).toEqual([2, 0, 1]);
  });
  it('laesst die Hausordnung stehen, wenn alle Leserpunkte gleich sind', () => {
    expect(mischeMitLeser([1, 5, 3], [0.4, 0.4, 0.4])).toEqual([1, 2, 0]);
  });
  it('Gewicht 0 = reine Hausordnung', () => {
    expect(mischeMitLeser([1, 5, 3], [9, 0, 0], 0)).toEqual([1, 2, 0]);
  });
});

describe('leserPunkte — der Anruf beim Dienst', () => {
  const jwtVorher = embedConfig.jwt;
  beforeEach(() => { embedConfig.jwt = 'test-jwt'; delete process.env.CACHLY_LESER; leserSperreLoeschen(); });
  afterEach(() => { embedConfig.jwt = jwtVorher; delete process.env.CACHLY_LESER; leserSperreLoeschen(); });

  it('liefert die Punkte in Anfragereihenfolge', async () => {
    const p = await leserPunkte('frage', ['a', 'b'], { fetchFn: antwort(200, { scores: [0.2, 0.9] }) });
    expect(p).toEqual([0.2, 0.9]);
  });
  it('liefert null bei falscher Laenge, Fehlern und Zeitueberschreitung — wirft nie', async () => {
    expect(await leserPunkte('f', ['a', 'b'], { fetchFn: antwort(200, { scores: [0.2] }) })).toBeNull();
    expect(await leserPunkte('f', ['a'], { fetchFn: antwort(500, { error: 'kaputt' }) })).toBeNull();
    const haengt: typeof fetch = ((_u: unknown, init?: RequestInit) => new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('abgebrochen')));
    })) as unknown as typeof fetch;
    expect(await leserPunkte('f', ['a'], { fetchFn: haengt, zeitlimitMs: 20 })).toBeNull();
  });
  it('merkt sich ein 503 und fragt zehn Minuten nicht mehr', async () => {
    expect(leserAktiv()).toBe(true);
    expect(await leserPunkte('f', ['a'], { fetchFn: antwort(503, { error: 'rerank not configured' }) })).toBeNull();
    expect(leserAktiv()).toBe(false);
    leserSperreLoeschen();
    expect(leserAktiv()).toBe(true);
  });
  it('CACHLY_LESER=0 schaltet ab, ohne Schluessel ebenso', async () => {
    process.env.CACHLY_LESER = '0';
    expect(leserAktiv()).toBe(false);
    delete process.env.CACHLY_LESER;
    embedConfig.jwt = '';
    expect(leserAktiv()).toBe(false);
  });
});
