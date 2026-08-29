import { describe, expect, it } from 'vitest';
import {
  ZULASSUNG,
  findePaare,
  naehe,
  themenWoerter,
  urteile,
  zugelassen,
} from '../zulassung-und-urteil';

/**
 * Proben für Zulassung und Urteil (Karte evlt71j533vk).
 *
 * Die tragende Aussage der Datei: die alte Regel prüfte IDENTITÄT und fand
 * deshalb in 499 Lektionen null Widersprüche. Diese Proben halten fest, dass
 * die neue Trennung genau die Fälle sieht, die ihr entgingen — und dass sie
 * nicht in die andere Richtung überzieht.
 */

const L = (topic: string, extra: Record<string, string> = {}) => ({ topic, ...extra });

describe('Zulassung — Ähnlichkeit ist die Eintrittskarte', () => {
  it('zwei Zeichen zählen mit, sonst verschwindet v2', () => {
    /*
     * Der Fall, der das ganze Modul begründet. Bei einer Grenze von drei
     * Zeichen fällt `v2` heraus, und `deploy:api` gilt als buchstabengleich
     * zu `deploy:api-v2` — genau die Verwechslung, gegen die es gebaut ist.
     */
    expect(themenWoerter('deploy:api-v2').has('v2')).toBe(true);
    expect(naehe('deploy:api', 'deploy:api-v2')).toBeLessThan(1);
    expect(naehe('deploy:api', 'deploy:api-v2')).toBeGreaterThan(0);
  });

  it('der reale Fall aus dem Bestand wird zugelassen', () => {
    // Ganz oben in der Arbeitsliste vom 29.08.2026 — für die alte Regel
    // zwei völlig fremde Themen.
    const a = L('kanzlei:board-batch-2-2026-07-18');
    const b = L('kanzlei:board-batch-2026-07-18');
    expect(zugelassen(a, b)).toBe(true);
    expect(naehe(a.topic, b.topic)).toBeGreaterThanOrEqual(ZULASSUNG);
  });

  it('fremde Themen bleiben draussen', () => {
    expect(zugelassen(L('deploy:api'), L('redis:eviction'))).toBe(false);
  });

  it('leere Themen lassen nichts zu', () => {
    expect(naehe('', 'deploy:api')).toBe(0);
    expect(zugelassen(L(''), L(''))).toBe(false);
  });
});

describe('Urteil — mehr als zwei Werte', () => {
  it('gleicher Text ist eine Doppelung', () => {
    const u = urteile(L('a', { what_worked: 'Port 3000' }), L('a-2', { what_worked: 'Port 3000' }));
    expect(u.beziehung).toBe('doppelung');
  });

  /*
   * Die wichtigste Unterscheidung des Moduls: eine Ersetzung ist KEIN
   * Widerspruch. „läuft nicht mehr auf Port 3000" ist die Nachfolge von
   * „läuft auf Port 3000", nicht sein Gegner. Wer das verwechselt, macht aus
   * jeder Weiterentwicklung einen Streit.
   */
  it('"nicht mehr" ist Ersetzung, nicht Widerspruch', () => {
    const u = urteile(
      L('deploy:api', { what_worked: 'laeuft auf Port 3000' }),
      L('deploy:api-v2', { what_worked: 'laeuft nicht mehr auf Port 3000, seit dem Umbau 3001' }),
    );
    expect(u.beziehung).toBe('ersetzung');
    expect(u.grund).toContain('Nachfolge');
  });

  it('eine einseitige Verneinung ist ein Widerspruch', () => {
    const u = urteile(
      L('deploy:api', { what_worked: 'laeuft auf Port 3000' }),
      L('deploy:api-v2', { what_worked: 'laeuft nicht auf Port 3000' }),
    );
    expect(u.beziehung).toBe('widerspruch');
  });

  it('verschiedener Ausgang beim selben Subjekt ist ein Widerspruch', () => {
    const u = urteile(
      L('deploy:api', { outcome: 'success', what_worked: 'ging durch' }),
      L('deploy:api-neu', { outcome: 'failure', what_worked: 'brach ab' }),
    );
    expect(u.beziehung).toBe('widerspruch');
    expect(u.grund).toContain('success gegen failure');
  });

  it('gleicher Ausgang ist Stuetzung', () => {
    const u = urteile(
      L('a', { outcome: 'success', what_worked: 'x' }),
      L('a-2', { outcome: 'success', what_worked: 'y' }),
    );
    expect(u.beziehung).toBe('stuetzung');
  });

  /*
   * Und die Gegenprobe zur ganzen Idee: ein Paar darf ZUGELASSEN und
   * trotzdem als unverwandt zurückgewiesen werden. Ohne diesen Ausgang wäre
   * die Zulassung eine Verurteilung.
   */
  it('zugelassen und trotzdem unverwandt ist ein gueltiger Ausgang', () => {
    const u = urteile(L('a', { what_worked: 'x' }), L('a-2', { what_worked: 'y' }));
    expect(u.beziehung).toBe('unverwandt');
  });

  it('jedes Urteil traegt eine Begruendung', () => {
    const faelle = [
      urteile(L('a', { what_worked: 'p' }), L('a-2', { what_worked: 'p' })),
      urteile(L('a', { what_worked: 'x' }), L('a-2', { what_worked: 'nicht x' })),
      urteile(L('a', { what_worked: 'x' }), L('a-2', { what_worked: 'y' })),
    ];
    expect(faelle.every((f) => f.grund.length > 10)).toBe(true);
  });
});

describe('Beide Stufen zusammen', () => {
  it('findet den Fall, den die alte Regel nicht sah', () => {
    /*
     * Die alte Regel: buchstabengleiches Thema UND verschiedenes outcome.
     * Hier ist das Thema NICHT buchstabengleich — sie fand also nichts.
     */
    const paare = findePaare([
      L('deploy:api', { outcome: 'success', what_worked: 'laeuft auf Port 3000' }),
      L('deploy:api-v2', { outcome: 'failure', what_worked: 'laeuft nicht auf Port 3000' }),
    ]);
    expect(paare.length).toBe(1);
    expect(paare[0].beziehung).toBe('widerspruch');
  });

  it('und laesst Fremdes in Ruhe', () => {
    expect(
      findePaare([L('deploy:api'), L('redis:eviction'), L('telegram:bericht')]).length,
    ).toBe(0);
  });

  it('ein einzelner Eintrag ergibt kein Paar', () => {
    expect(findePaare([L('deploy:api')]).length).toBe(0);
    expect(findePaare([]).length).toBe(0);
  });
});
