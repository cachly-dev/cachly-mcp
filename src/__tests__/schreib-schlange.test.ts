/**
 * Schreibpfad-Einbettungen warten beim Absender, nicht beim Dienst (05.11.2026).
 *
 * Beleg BEAM-Einlesen auf node-4: 263 Lektionen schickten ihre Einbettungen
 * gleichzeitig los. Beim Dienst standen sie in der Schlange, und das
 * Zeitlimit lief schon waehrend des Wartens. Wer zu lange wartete, gab auf;
 * der Dienst rechnete trotzdem, der Nachtrag schickte denselben Text noch
 * einmal. Nachgestellt (150 Lektionen, Dienst mit 2 Plaetzen, Limit 30 s):
 * 747 Anfragen statt 450, 305 davon fuer niemanden gerechnet.
 *
 * Festgenagelt wird hier:
 *  - hoechstens 4 Schreib-Einbettungen je Modell sind gleichzeitig beim Dienst;
 *  - wer wartet, hat noch KEINEN Netzaufruf (also auch keine laufende Uhr);
 *  - eine Suche ('kurz') ueberholt die Schlange;
 *  - ein anderes Modell hat seine eigene Schlange;
 *  - ein Fehlschlag gibt seinen Platz frei.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.CACHLY_EMBED_PROVIDER = 'cachly';
process.env.CACHLY_JWT ||= 'test-jwt';
delete process.env.CACHLY_EMBED_SCHREIB_PARALLEL;
const { computeEmbedding, schreibSchlange, vergissEinbettungen } = await import('../embeddings.js');

const ZWEIT = 'qwen3-embedding:0.6b';
const ruhe = () => new Promise((r) => setTimeout(r, 5));
const ok = () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  text: async () => '', json: async () => ({ embedding: [0.1, 0.2], dimensions: 2 }),
}) as unknown as Response;
const abgelehnt = () => ({
  ok: false, status: 401, headers: { get: () => null }, text: async () => 'nein',
}) as unknown as Response;

/** fetch, der erst antwortet, wenn der Test loslaesst; zaehlt gleichzeitige Aufrufe je Modell. */
function haltendesFetch() {
  const gehalten: Array<{ modell: string; antworte: (r: Response) => void }> = [];
  const stat = { rufe: 0, jetzt: {} as Record<string, number>, max: {} as Record<string, number> };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const modell = String(JSON.parse(String(init?.body ?? '{}')).model ?? '');
    stat.rufe++;
    stat.jetzt[modell] = (stat.jetzt[modell] ?? 0) + 1;
    stat.max[modell] = Math.max(stat.max[modell] ?? 0, stat.jetzt[modell]);
    const r = await new Promise<Response>((antworte) => gehalten.push({ modell, antworte }));
    stat.jetzt[modell]--;
    return r;
  }) as typeof fetch;
  const loslassen = (antwort: () => Response = ok) => { for (const g of gehalten.splice(0)) g.antworte(antwort()); };
  return { stat, gehalten, loslassen };
}

describe('Schreib-Einbettungen: hoechstens 4 je Modell beim Dienst', () => {
  const echteFetch = globalThis.fetch;
  beforeEach(() => { vergissEinbettungen(); });
  afterEach(() => { globalThis.fetch = echteFetch; });

  it('zehn Lektionen zugleich: 4 beim Dienst, 6 warten ohne Netzaufruf, alle kommen an', async () => {
    const { stat, loslassen } = haltendesFetch();
    const alle = Promise.all(Array.from({ length: 10 }, (_, i) => computeEmbedding(`lektion ${i}`, { geduld: 'lang' })));
    await ruhe();
    expect(stat.rufe, 'nur vier gehen hinaus').toBe(4);
    expect(schreibSchlange()).toEqual({ laufend: 4, wartend: 6 });
    for (let runde = 0; runde < 5 && stat.rufe < 10; runde++) { loslassen(); await ruhe(); }
    loslassen();
    const vektoren = await alle;
    expect(vektoren).toHaveLength(10);
    expect(stat.rufe, 'jeder Text genau einmal').toBe(10);
    expect(stat.max[''], 'nie mehr als vier gleichzeitig').toBe(4);
    expect(schreibSchlange()).toEqual({ laufend: 0, wartend: 0 });
  });

  it('eine Suche ueberholt die volle Schlange', async () => {
    const { stat, loslassen } = haltendesFetch();
    const schreiben = Promise.all(Array.from({ length: 6 }, (_, i) => computeEmbedding(`schreiben ${i}`, { geduld: 'lang' })));
    await ruhe();
    expect(stat.rufe).toBe(4);
    const suche = computeEmbedding('wie rotiere ich den schluessel');
    await ruhe();
    expect(stat.rufe, 'die Suche geht sofort hinaus').toBe(5);
    expect(schreibSchlange().wartend, 'die Schreibenden warten weiter').toBe(2);
    while (stat.rufe < 7) { loslassen(); await ruhe(); }
    loslassen();
    await Promise.all([schreiben, suche]);
  });

  it('das Zweitmodell hat eine eigene Schlange', async () => {
    const { stat, loslassen } = haltendesFetch();
    const erst = Promise.all(Array.from({ length: 5 }, (_, i) => computeEmbedding(`erst ${i}`, { geduld: 'lang' })));
    await ruhe();
    const zweit = computeEmbedding('erst 0', { geduld: 'lang', modell: ZWEIT });
    await ruhe();
    expect(stat.jetzt[ZWEIT], 'vec2 wartet nicht hinter vec').toBe(1);
    expect(schreibSchlange(ZWEIT)).toEqual({ laufend: 1, wartend: 0 });
    while (stat.rufe < 6) { loslassen(); await ruhe(); }
    loslassen();
    await Promise.all([erst, zweit]);
  });

  it('ein Fehlschlag gibt seinen Platz frei', async () => {
    const { stat, loslassen } = haltendesFetch();
    const fuenf = Array.from({ length: 5 }, (_, i) => computeEmbedding(`fehlt ${i}`, { geduld: 'lang' }).catch((e: Error) => e));
    await ruhe();
    expect(stat.rufe).toBe(4);
    loslassen(abgelehnt); // 401 wird nicht wiederholt
    await ruhe();
    expect(stat.rufe, 'der fuenfte rueckt nach').toBe(5);
    loslassen();
    const ergebnisse = await Promise.all(fuenf);
    expect(ergebnisse.filter((x) => x instanceof Error)).toHaveLength(4);
    expect(schreibSchlange()).toEqual({ laufend: 0, wartend: 0 });
  });
});
