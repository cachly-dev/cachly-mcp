/**
 * Die Bestaende im Arbeitsspeicher gehoeren zu EINER Verbindung (28.10.2026).
 *
 * Bis dahin gab es Vektor-, Namens-, Zweit-, Eingangs- und Seltenheitsbestand
 * je Prozess einmal, 60 s frisch. Fragte ein Prozess erst Instanz A und gleich
 * danach Instanz B, suchte B mit den Themen und Vektoren von A — die es in B
 * nicht gibt. Der Bedeutungsteil fiel still aus. Im AML-Dienst (eine Datenbank
 * je Nutzer, OmniMemEval fragt Sprecher A und B nacheinander) war das die
 * Restschwankung F8: zwei gleiche Suchlaeufe, nur 25 % gleiche Kontexte.
 *
 * Die Probe: alle Lektionen teilen genau ein Wort mit der Frage ("Futterplan"),
 * die gesuchte ist die laengste und liegt nach Woertern hinten. Nur der Vektor
 * holt sie auf Platz 1. B allein schafft das; B direkt nach A muss es genauso.
 * (Ganz ohne gemeinsames Wort zeigt smart_recall nichts — die Zurueckhaltung
 * in abstention.ts verlangt einen Beleg, und der lokale Vektor ist keiner.)
 */

import { describe, it, expect, vi } from 'vitest';

/** Ein Vektor je Begriffsfeld — gleiche Richtung heisst gleiche Bedeutung. */
vi.mock('../embeddings.js', async (original) => {
  const echt = await original<typeof import('../embeddings.js')>();
  const richtung = (t: string): number => {
    const s = t.toLowerCase();
    if (s.includes('zebra') || s.includes('gestreift')) return 0;
    if (s.includes('giraffe') || s.includes('hochgewachsen')) return 1;
    return 2;
  };
  return {
    ...echt,
    hasEmbedProvider: () => true,
    EMBED_PROVIDER: 'cachly',
    computeEmbedding: vi.fn(async (t: string) => {
      const v = new Array(32).fill(0); v[richtung(t)] = 1; return v;
    }),
  };
});

import { handleBrainTool, bestaendeFuer } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
const warte = () => new Promise((r) => setTimeout(r, 80));

/** Zwei Instanzen mit eigener Verbindung, wie index.ts getConnection sie haelt. */
async function zweiInstanzen(kennung: string) {
  const verbindungen: Record<string, MockRedis> = { a: new MockRedis(), b: new MockRedis() };
  const getConn = async (id: string) => verbindungen[id.endsWith('-a') ? 'a' : 'b'] as unknown as Redis;
  const lerne = (instanz: string, topic: string, what: string) =>
    handleBrainTool('learn_from_attempts', { instance_id: instanz, topic, outcome: 'success', what_worked: what }, getConn, noopApiFetch);

  await lerne(`${kennung}-a`, `afrika:giraffe-${kennung}`, 'Futterplan: die Giraffe frisst Blaetter von hohen Akazien am Wasserloch.');
  for (let i = 1; i <= 3; i++) await lerne(`${kennung}-a`, `notiz:tee-${kennung}-${i}`, `Futterplan: Teesorte ${i} ist bestellt.`);
  await lerne(`${kennung}-b`, `savanne:zebra-${kennung}`, 'Futterplan: das Zebra lebt in Herden auf offener Savanne am Wasserloch.');
  for (let i = 1; i <= 3; i++) await lerne(`${kennung}-b`, `notiz:kaffee-${kennung}-${i}`, `Futterplan: Kaffeebohne ${i} ist geroestet.`);
  await warte();

  const frage = (instanz: string, query: string) =>
    handleBrainTool('smart_recall', { instance_id: instanz, query }, getConn, noopApiFetch).then(String);
  return { frage, verbindungen };
}

/** Das gesuchte Thema steht vor jeder Ablenkung (oder die Ablenkung fehlt ganz). */
function stehtVorn(ausgabe: string, gesucht: string, ablenkungen: string[]): boolean {
  const p = ausgabe.indexOf(gesucht);
  if (p < 0) return false;
  return ablenkungen.every((a) => { const q = ausgabe.indexOf(a); return q < 0 || p < q; });
}

describe('Bestaende je Verbindung — B direkt nach A sucht mit den eigenen Vektoren', () => {
  it('KONTROLLE: B allein holt die Lektion ueber die Bedeutung auf Platz 1', async () => {
    const { frage } = await zweiInstanzen('k1');
    const aus = await frage('k1-b', 'Futterplan gestreiftes Wesen');
    expect(stehtVorn(aus, 'savanne:zebra-k1', [1, 2, 3].map((i) => `notiz:kaffee-k1-${i}`))).toBe(true);
  });

  it('erst A, sofort danach B: B holt seine Lektion genauso auf Platz 1', async () => {
    const { frage } = await zweiInstanzen('k2');
    const ausA = await frage('k2-a', 'Futterplan hochgewachsenes Wesen');
    expect(stehtVorn(ausA, 'afrika:giraffe-k2', [1, 2, 3].map((i) => `notiz:tee-k2-${i}`))).toBe(true);
    const ausB = await frage('k2-b', 'Futterplan gestreiftes Wesen');
    expect(stehtVorn(ausB, 'savanne:zebra-k2', [1, 2, 3].map((i) => `notiz:kaffee-k2-${i}`))).toBe(true);
    expect(ausB).not.toContain('afrika:giraffe-k2');
  });

  it('jede Verbindung hat ihre eigenen Bestaende, dieselbe Verbindung behaelt sie', async () => {
    const { verbindungen } = await zweiInstanzen('k3');
    const a = verbindungen.a as unknown as Redis;
    const b = verbindungen.b as unknown as Redis;
    expect(bestaendeFuer(a)).toBe(bestaendeFuer(a));
    expect(bestaendeFuer(a).vektor).not.toBe(bestaendeFuer(b).vektor);
    await bestaendeFuer(a).vektor.aktualisiere(a);
    await bestaendeFuer(b).vektor.aktualisiere(b);
    expect(bestaendeFuer(a).vektor.themen()).toContain('afrika:giraffe-k3');
    expect(bestaendeFuer(b).vektor.themen()).not.toContain('afrika:giraffe-k3');
  });
});
