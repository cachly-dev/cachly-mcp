import { describe, it, expect } from 'vitest';
import { recallTiefe, TIEFE_UEBER_LIMIT, TIEFE_VOLL, TIEFE_VOLL_MEHRTHEMIG } from '../recall-tiefe';

/**
 * GROW-043 — Das Frei-Limit bremst, es mauert nicht.
 *
 * Vorher: `visibleCount = gateActive ? 0 : 8`. Ein Frei-Konto ueber seinem
 * Kontingent bekam die Ueberschrift "Results (23)" und darunter NICHTS.
 * Diese Datei haelt fest, dass der beste Treffer immer durchkommt.
 */
describe('recallTiefe', () => {
  it('zeigt ueber dem Limit genau einen Treffer und benennt den Rest', () => {
    const t = recallTiefe({ ueberLimit: true, gesamt: 23 });
    expect(t.sichtbar).toBe(TIEFE_UEBER_LIMIT);
    expect(t.sichtbar).toBe(1);
    expect(t.zurueckgehalten).toBe(22);
  });

  it('GEGENPROBE: null Treffer sind nie zurueckgehalten', () => {
    // Sonst verkauft die Meldung "3 lessons withheld" etwas, das es nicht gibt.
    expect(recallTiefe({ ueberLimit: true, gesamt: 0 })).toEqual({ sichtbar: 0, zurueckgehalten: 0 });
  });

  it('haelt unter dem Limit nichts zurueck', () => {
    const t = recallTiefe({ ueberLimit: false, gesamt: 23 });
    expect(t.sichtbar).toBe(TIEFE_VOLL);
    expect(t.zurueckgehalten).toBe(0);
  });

  it('zeigt nie mehr, als es gibt', () => {
    expect(recallTiefe({ ueberLimit: false, gesamt: 3 })).toEqual({ sichtbar: 3, zurueckgehalten: 0 });
    expect(recallTiefe({ ueberLimit: true, gesamt: 1 })).toEqual({ sichtbar: 1, zurueckgehalten: 0 });
  });

  it('mehrthemige Fragen bekommen mehr Platz — aber nur ohne Limit', () => {
    expect(recallTiefe({ ueberLimit: false, gesamt: 30, volleTiefe: TIEFE_VOLL_MEHRTHEMIG }).sichtbar).toBe(12);
    expect(recallTiefe({ ueberLimit: true, gesamt: 30, volleTiefe: TIEFE_VOLL_MEHRTHEMIG }).sichtbar).toBe(1);
  });

  it('unsinnige Zahlen ergeben nichts Sichtbares, nicht NaN', () => {
    expect(recallTiefe({ ueberLimit: true, gesamt: Number.NaN })).toEqual({ sichtbar: 0, zurueckgehalten: 0 });
    expect(recallTiefe({ ueberLimit: false, gesamt: -5 })).toEqual({ sichtbar: 0, zurueckgehalten: 0 });
  });
});
