/**
 * Die Abruf-Grenze nach Ablauf der Minute (11.11.2026, bestand-frische.ts).
 *
 * Vorher wartete jeder smart_recall, der mehr als eine Minute nach dem letzten
 * kam, auf eine Abfrage an die API — rund 1,3 s ueber ein entferntes Netz.
 * Seitdem antwortet der gemerkte Wert sofort, die API wird daneben gefragt.
 * Im Messmodus wird weiter gewartet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecallGate } from '../handlers/brain.js';

/** Eine API, die zaehlt und deren Antwort sich umstellen laesst. */
function api(start: { used: number; limit: number }) {
  const stand = { ...start, rufe: 0 };
  const fetch = async <T,>(pfad: string): Promise<T> => {
    stand.rufe++;
    if (!pfad.endsWith('/memory')) throw new Error('unerwartet: ' + pfad);
    return { total_recall_count: stand.used, recall_limit: stand.limit } as T;
  };
  return { stand, fetch };
}

const naechsterTakt = () => new Promise((fertig) => setImmediate(fertig));

describe('Abruf-Grenze nach Ablauf der Minute', () => {
  afterEach(() => { vi.useRealTimers(); delete process.env.CACHLY_RECALL_NUR_LESEN; });

  it('innerhalb der Minute fragt sie die API nicht noch einmal', async () => {
    const { stand, fetch } = api({ used: 10, limit: 500 });
    await getRecallGate('grenze-a', fetch);
    await getRecallGate('grenze-a', fetch);
    expect(stand.rufe).toBe(1);
  });

  it('danach antwortet der gemerkte Wert sofort, der neue kommt im Hintergrund', async () => {
    const { stand, fetch } = api({ used: 10, limit: 500 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    expect((await getRecallGate('grenze-b', fetch)).reached).toBe(false);

    stand.used = 500; // jetzt an der Grenze
    vi.setSystemTime(Date.now() + 61_000);
    expect((await getRecallGate('grenze-b', fetch)).reached, 'die Frage hat auf die API gewartet').toBe(false);
    expect(stand.rufe).toBe(2);

    await naechsterTakt();
    expect((await getRecallGate('grenze-b', fetch)).reached, 'der neue Wert kam nie an').toBe(true);
    expect(stand.rufe).toBe(2);
  });

  it('im Messmodus wartet die Frage auf die API', async () => {
    process.env.CACHLY_RECALL_NUR_LESEN = '1';
    const { stand, fetch } = api({ used: 10, limit: 500 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await getRecallGate('grenze-c', fetch);
    stand.used = 500;
    vi.setSystemTime(Date.now() + 61_000);
    expect((await getRecallGate('grenze-c', fetch)).reached).toBe(true);
  });

  it('ohne gemerkten Wert wird gewartet, und zwei gleichzeitige Fragen teilen eine Abfrage', async () => {
    const { stand, fetch } = api({ used: 500, limit: 500 });
    const [a, b] = await Promise.all([getRecallGate('grenze-d', fetch), getRecallGate('grenze-d', fetch)]);
    expect(a.reached && b.reached).toBe(true);
    expect(stand.rufe).toBe(1);
  });
});
