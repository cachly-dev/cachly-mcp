import { describe, expect, it } from 'vitest';
import {
  spurSchluessel, taugtAlsSpur, behalte, spurLegen,
  SPUR_PRAEFIX, PFAD_PRAEFIX, PFAD_SCHWELLE, PFAD_KAPPE,
} from './spuren.js';

/** Ein Speicher, der die Hash-Befehle kann, die spurLegen benutzt. */
class MiniRedis {
  hashes = new Map<string, Record<string, string>>();

  private fach(k: string): Record<string, string> {
    const h = this.hashes.get(k) ?? {};
    this.hashes.set(k, h);
    return h;
  }

  async hexists(k: string, f: string): Promise<number> {
    return this.fach(k)[f] === undefined ? 0 : 1;
  }

  async hincrby(k: string, f: string, um: number): Promise<number> {
    const h = this.fach(k);
    const neu = Number(h[f] ?? 0) + um;
    h[f] = String(neu);
    return neu;
  }

  async hset(k: string, ...felder: string[]): Promise<number> {
    const h = this.fach(k);
    for (let i = 0; i < felder.length; i += 2) h[felder[i]] = felder[i + 1];
    return felder.length / 2;
  }

  async hkeys(k: string): Promise<string[]> { return Object.keys(this.fach(k)); }
  async hgetall(k: string): Promise<Record<string, string>> { return { ...this.fach(k) }; }

  async hdel(k: string, ...felder: string[]): Promise<number> {
    const h = this.fach(k);
    let n = 0;
    for (const f of felder) if (h[f] !== undefined) { delete h[f]; n++; }
    return n;
  }
}

const einbetten = async (): Promise<number[]> => [1, 0, 0];
const pfade = (r: MiniRedis, topic: string): string[] =>
  Object.keys(r.hashes.get(`${PFAD_PRAEFIX}${topic}`) ?? {});

describe('spurSchluessel — derselbe Weg trotz anderer Schreibweise', () => {
  it('macht aus Gross und Zeichensetzung dasselbe', () => {
    expect(spurSchluessel('Docker startet nicht!')).toBe(spurSchluessel('docker startet nicht'));
    expect(spurSchluessel('  Warum   haengt der Deploy?  ')).toBe('warum haengt der deploy');
  });

  it('laesst Umlaute und Zahlen stehen', () => {
    expect(spurSchluessel('Warum bricht Build 42 ab?')).toBe('warum bricht build 42 ab');
    expect(spurSchluessel('Größe der Platte')).toBe('größe der platte');
  });
});

describe('taugtAlsSpur — was gar nicht erst aufgezeichnet wird', () => {
  it('nimmt eine echte Frage', () => {
    expect(taugtAlsSpur('warum haengt der deploy')).toBe(true);
  });

  it('lehnt ein einzelnes Stichwort ab', () => {
    // Ein Wort wuerde jede Lektion an sich ziehen, die es enthaelt.
    expect(taugtAlsSpur('deployment')).toBe(false);
    expect(taugtAlsSpur('fail2ban')).toBe(false);
  });

  it('lehnt zu kurze Eingaben ab', () => {
    expect(taugtAlsSpur('a b')).toBe(false);
    expect(taugtAlsSpur('')).toBe(false);
  });
});

describe('behalte — welcher Pfad weicht', () => {
  it('der am seltensten begangene weicht', () => {
    const aus = behalte([
      { frage: 'oft', anzahl: 9 },
      { frage: 'selten', anzahl: 1 },
      { frage: 'mittel', anzahl: 4 },
    ], 2);
    expect(aus.map((x) => x.frage)).toEqual(['oft', 'mittel']);
  });

  it('bei Gleichstand gewinnt die kuerzere Frage', () => {
    // Die kuerzere ist die allgemeinere — sie faengt mehr Formulierungen.
    const aus = behalte([
      { frage: 'warum haengt der deploy beim bauen des images', anzahl: 3 },
      { frage: 'warum haengt der deploy', anzahl: 3 },
    ], 1);
    expect(aus[0].frage).toBe('warum haengt der deploy');
  });
});

describe('spurLegen — aus Wiederholung wird ein Pfad', () => {
  it('beim ERSTEN Mal entsteht noch kein Pfad', async () => {
    const r = new MiniRedis();
    const n = await spurLegen(r as never, 'warum haengt der deploy', ['ci:platte'], einbetten);
    expect(n).toBe(0);
    expect(pfade(r, 'ci:platte')).toHaveLength(0);
  });

  it('beim ZWEITEN Mal schon', async () => {
    const r = new MiniRedis();
    await spurLegen(r as never, 'warum haengt der deploy', ['ci:platte'], einbetten);
    const n = await spurLegen(r as never, 'Warum haengt der Deploy?', ['ci:platte'], einbetten);
    expect(n, 'die zweite Begehung hat keinen Pfad ergeben').toBe(1);
    expect(pfade(r, 'ci:platte')).toEqual(['warum haengt der deploy']);
  });

  it('zaehlt weiter, ohne noch einmal einzubetten', async () => {
    const r = new MiniRedis();
    let aufrufe = 0;
    const zaehlend = async (): Promise<number[]> => { aufrufe++; return [1, 0, 0]; };
    for (let i = 0; i < 5; i++) {
      await spurLegen(r as never, 'warum haengt der deploy', ['ci:platte'], zaehlend);
    }
    expect(aufrufe, 'wurde mehr als einmal eingebettet').toBe(1);
    expect(r.hashes.get(`${SPUR_PRAEFIX}ci:platte`)?.['warum haengt der deploy']).toBe('5');
  });

  it('legt die Spur an ALLEN gefundenen Lektionen an', async () => {
    const r = new MiniRedis();
    const themen = ['ci:platte', 'ci:runner', 'deploy:kanal'];
    await spurLegen(r as never, 'warum haengt der deploy', themen, einbetten);
    const n = await spurLegen(r as never, 'warum haengt der deploy', themen, einbetten);
    expect(n).toBe(3);
    for (const t of themen) expect(pfade(r, t)).toHaveLength(1);
  });

  it('haelt die Kappe ein und wirft den seltensten weg', async () => {
    const r = new MiniRedis();
    // Neun verschiedene Fragen, jede zweimal — die erste bekommt zusaetzliche
    // Begehungen und muss deshalb ueberleben.
    for (let i = 0; i < PFAD_KAPPE + 1; i++) {
      const f = `frage nummer ${i} zum selben thema`;
      for (let k = 0; k < PFAD_SCHWELLE; k++) {
        await spurLegen(r as never, f, ['ci:platte'], einbetten);
      }
    }
    for (let k = 0; k < 5; k++) {
      await spurLegen(r as never, 'frage nummer 0 zum selben thema', ['ci:platte'], einbetten);
    }
    const uebrig = pfade(r, 'ci:platte');
    expect(uebrig.length).toBeLessThanOrEqual(PFAD_KAPPE);
    expect(uebrig, 'der oft begangene Pfad wurde weggeworfen')
      .toContain('frage nummer 0 zum selben thema');
  });

  it('zeichnet gar nichts auf, wenn die Frage nicht taugt', async () => {
    const r = new MiniRedis();
    await spurLegen(r as never, 'docker', ['ci:platte'], einbetten);
    await spurLegen(r as never, 'docker', ['ci:platte'], einbetten);
    expect(r.hashes.size, 'ein Stichwort wurde als Pfad gespeichert').toBe(0);
  });

  it('GEGENPROBE: ohne Einbettung entsteht kein Pfad', async () => {
    const r = new MiniRedis();
    await spurLegen(r as never, 'warum haengt der deploy', ['ci:platte'], async () => null);
    const n = await spurLegen(r as never, 'warum haengt der deploy', ['ci:platte'], async () => null);
    expect(n).toBe(0);
    expect(pfade(r, 'ci:platte')).toHaveLength(0);
  });
});
