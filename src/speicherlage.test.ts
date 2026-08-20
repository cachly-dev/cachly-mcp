import { describe, it, expect } from 'vitest';
import { beurteileSpeicher, anteil, zahlAusInfo } from './speicherlage.js';

const MB = 1024 * 1024;

describe('Speicherlage beurteilen', () => {
  it('meldet allkeys-lru als FEHLER, nicht als Hinweis', () => {
    // Der Anlass: genau diese Lage lag am 20.08.2026 in der Produktion vor.
    const u = beurteileSpeicher({ benutzt: 23.6 * MB, grenze: 25 * MB, richtlinie: 'allkeys-lru' });
    const raeumung = u[0];
    expect(raeumung.art).toBe('fehler');
    expect(raeumung.text).toContain('GELOESCHT');
    expect(raeumung.text).toContain('volatile-lru');
  });

  it('stellt die stille Loeschung VOR die Fuellung', () => {
    // Eine halbvolle Instanz, die still loescht, ist gefaehrlicher als eine
    // volle, die laut scheitert. Deshalb steht sie zuerst.
    const u = beurteileSpeicher({ benutzt: 5 * MB, grenze: 25 * MB, richtlinie: 'allkeys-lru' });
    expect(u[0].art).toBe('fehler');
    expect(u[1].art).toBe('gut'); // 20 % Fuellung ist in Ordnung
  });

  it('nimmt volatile-lru und noeviction ab', () => {
    for (const r of ['volatile-lru', 'noeviction']) {
      expect(beurteileSpeicher({ benutzt: MB, grenze: 25 * MB, richtlinie: r })[0].art).toBe('gut');
    }
  });

  it('sagt "nicht gemessen", wenn CONFIG GET gesperrt ist', () => {
    // Der Fehler, den es zu vermeiden gilt: Stille als gruen verbuchen.
    const u = beurteileSpeicher({ benutzt: MB, grenze: 25 * MB, richtlinie: null });
    expect(u[0].art).toBe('ungemessen');
    expect(u[0].art).not.toBe('gut');
  });

  it('warnt ab 90 Prozent und mahnt ab 75', () => {
    const voll = beurteileSpeicher({ benutzt: 23 * MB, grenze: 25 * MB, richtlinie: 'noeviction' });
    expect(voll[1].art).toBe('fehler');
    const eng = beurteileSpeicher({ benutzt: 20 * MB, grenze: 25 * MB, richtlinie: 'noeviction' });
    expect(eng[1].art).toBe('hinweis');
    const weit = beurteileSpeicher({ benutzt: 5 * MB, grenze: 25 * MB, richtlinie: 'noeviction' });
    expect(weit[1].art).toBe('gut');
  });

  it('GEGENPROBE: eine gesunde Lage erzeugt KEIN Fehlerurteil', () => {
    // Ohne sie waere jede Pruefung oben auch dann gruen, wenn beurteileSpeicher
    // immer "fehler" zurueckgaebe.
    const u = beurteileSpeicher({ benutzt: 3 * MB, grenze: 25 * MB, richtlinie: 'volatile-lru' });
    expect(u.some((x) => x.art === 'fehler')).toBe(false);
    expect(u.every((x) => x.art === 'gut')).toBe(true);
  });

  it('meldet eine fehlende Obergrenze als Hinweis', () => {
    const u = beurteileSpeicher({ benutzt: 3 * MB, grenze: 0, richtlinie: 'noeviction' });
    expect(u[1].art).toBe('hinweis');
    expect(u[1].text).toContain('keine Obergrenze');
  });

  it('rechnet den Anteil nur, wenn beides da ist', () => {
    expect(anteil({ benutzt: 5 * MB, grenze: 10 * MB, richtlinie: 'x' })).toBeCloseTo(0.5, 6);
    expect(anteil({ benutzt: null, grenze: 10 * MB, richtlinie: 'x' })).toBeNull();
    expect(anteil({ benutzt: 5 * MB, grenze: 0, richtlinie: 'x' })).toBeNull();
  });

  it('liest Zahlen aus einem INFO-Block und erfindet keine', () => {
    const info = 'used_memory:24743936\r\nused_memory_rss:30801920\r\nmaxmemory:26214400\r\n';
    expect(zahlAusInfo(info, 'used_memory')).toBe(24743936);
    expect(zahlAusInfo(info, 'maxmemory')).toBe(26214400);
    expect(zahlAusInfo(info, 'gibt_es_nicht')).toBeNull();
    // Nicht das Praefix eines anderen Feldes treffen.
    expect(zahlAusInfo(info, 'used_memory')).not.toBe(30801920);
  });
});
