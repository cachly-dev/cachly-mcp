/**
 * Warten auf eine startende Instanz (instanz-warten.ts).
 *
 * Die Uhr ist ausgedacht: `schlafen` rueckt sie vor, statt zu warten. So misst
 * der Test den Takt und haengt nicht an der Last der Maschine.
 *
 * GEGENPROBE (11.10.2026, von Hand): mit PROVISION_TAKT_MS = 3000 ist die
 * erste Probe rot — die Instanz laeuft nach 6,5 s, gemeldet wird sie erst
 * nach 9 s statt nach 7 s.
 */

import { describe, it, expect, vi } from 'vitest';
import { warteAufLaufendeInstanz, gemeinsamerAufbau, PROVISION_TAKT_MS } from './instanz-warten.js';

/** Eine Instanz, die nach `laeuftAbMs` (ausgedachte Zeit) `running` meldet. */
function ausgedachteInstanz(laeuftAbMs: number) {
  let jetzt = 0;
  const schlaefe: number[] = [];
  return {
    jetzt: () => jetzt,
    schlafen: async (ms: number) => { schlaefe.push(ms); jetzt += ms; },
    abfragen: async () => ({ status: jetzt >= laeuftAbMs ? 'running' : 'provisioning' }),
    schlaefe,
  };
}

describe('warteAufLaufendeInstanz', () => {
  it('fragt im 1-s-Takt nach: eine Instanz, die nach 6,5 s laeuft, ist nach 7 s gemeldet', async () => {
    const i = ausgedachteInstanz(6500);
    const stand = await warteAufLaufendeInstanz({ status: 'provisioning' }, i.abfragen, {
      fristMs: 90_000, jetzt: i.jetzt, schlafen: i.schlafen,
    });
    expect(PROVISION_TAKT_MS).toBe(1000);
    expect(stand.status).toBe('running');
    expect(i.jetzt()).toBe(7000);
    expect(i.schlaefe.every((ms) => ms === 1000)).toBe(true);
  });

  it('fragt gar nicht erst, wenn die Instanz schon laeuft', async () => {
    const i = ausgedachteInstanz(0);
    const abfragen = vi.fn(i.abfragen);
    const stand = await warteAufLaufendeInstanz({ status: 'running' }, abfragen, {
      fristMs: 90_000, jetzt: i.jetzt, schlafen: i.schlafen,
    });
    expect(stand.status).toBe('running');
    expect(abfragen).not.toHaveBeenCalled();
  });

  it('gibt nach der Frist den letzten Stand zurueck', async () => {
    const i = ausgedachteInstanz(Number.POSITIVE_INFINITY);
    const stand = await warteAufLaufendeInstanz({ status: 'provisioning' }, i.abfragen, {
      fristMs: 5000, jetzt: i.jetzt, schlafen: i.schlafen,
    });
    expect(stand.status).toBe('provisioning');
    expect(i.jetzt()).toBe(5000);
  });

  it('meldet jeden neuen Stand (fuer die Zeitmessung)', async () => {
    const i = ausgedachteInstanz(2000);
    const gemeldet: string[] = [];
    await warteAufLaufendeInstanz({ status: 'provisioning' }, i.abfragen, {
      fristMs: 90_000, jetzt: i.jetzt, schlafen: i.schlafen, melde: (s) => gemeldet.push(String(s.status)),
    });
    expect(gemeldet).toEqual(['provisioning', 'running']);
  });
});

describe('gemeinsamerAufbau', () => {
  it('zwei gleichzeitige Aufrufer teilen sich EINEN Aufbau', async () => {
    const laufend = new Map<string, Promise<string>>();
    let fertig: (v: string) => void = () => {};
    const bauen = vi.fn(() => new Promise<string>((r) => { fertig = r; }));
    const a = gemeinsamerAufbau(laufend, 'inst', bauen);
    const b = gemeinsamerAufbau(laufend, 'inst', bauen);
    fertig('verbindung');
    expect(await a).toBe('verbindung');
    expect(await b).toBe('verbindung');
    expect(bauen).toHaveBeenCalledTimes(1);
    expect(laufend.size).toBe(0);
  });

  it('nach einem Fehlschlag baut der naechste Aufruf neu', async () => {
    const laufend = new Map<string, Promise<string>>();
    const bauen = vi.fn()
      .mockRejectedValueOnce(new Error('weg'))
      .mockResolvedValueOnce('verbindung');
    await expect(gemeinsamerAufbau(laufend, 'inst', bauen)).rejects.toThrow('weg');
    expect(await gemeinsamerAufbau(laufend, 'inst', bauen)).toBe('verbindung');
    expect(bauen).toHaveBeenCalledTimes(2);
  });

  it('verschiedene Instanzen bauen getrennt', async () => {
    const laufend = new Map<string, Promise<string>>();
    const bauen = vi.fn(async () => 'v');
    await Promise.all([gemeinsamerAufbau(laufend, 'a', bauen), gemeinsamerAufbau(laufend, 'b', bauen)]);
    expect(bauen).toHaveBeenCalledTimes(2);
  });
});
