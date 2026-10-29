import { describe, it, expect } from 'vitest';
import { recallTiefe, verlangteTiefe, TIEFE_HOECHSTENS, TIEFE_UEBER_LIMIT, TIEFE_VOLL, TIEFE_VOLL_MEHRTHEMIG } from '../recall-tiefe';

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

describe('verlangteTiefe (smart_recall limit)', () => {
  it('ohne Wert gilt die Voreinstellung des Aufrufs', () => {
    expect(verlangteTiefe(undefined)).toBeUndefined();
    expect(verlangteTiefe(null)).toBeUndefined();
    expect(verlangteTiefe('')).toBeUndefined();
    expect(verlangteTiefe('viele')).toBeUndefined();
    expect(verlangteTiefe(Number.NaN)).toBeUndefined();
  });

  it('nimmt die verlangte Zahl, begrenzt auf 1 bis TIEFE_HOECHSTENS', () => {
    expect(verlangteTiefe(20)).toBe(20);
    expect(verlangteTiefe('12')).toBe(12);
    expect(verlangteTiefe(3.9)).toBe(3);
    expect(verlangteTiefe(0)).toBe(1);
    expect(verlangteTiefe(-4)).toBe(1);
    expect(verlangteTiefe(1000)).toBe(TIEFE_HOECHSTENS);
    expect(TIEFE_HOECHSTENS).toBe(20);
  });

  it('GEGENPROBE: das Frei-Limit schlaegt jede verlangte Tiefe', () => {
    const volleTiefe = verlangteTiefe(20) ?? TIEFE_VOLL;
    expect(recallTiefe({ ueberLimit: true, gesamt: 30, volleTiefe })).toEqual({ sichtbar: 1, zurueckgehalten: 29 });
    expect(recallTiefe({ ueberLimit: false, gesamt: 30, volleTiefe }).sichtbar).toBe(20);
  });
});
