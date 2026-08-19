import { describe, it, expect } from 'vitest';
import { nutzungInWorten, nutzungsSchluessel, verdichte } from '../werkzeug-nutzung';

/**
 * GROW-046 — Erst messen, dann zusammenlegen.
 *
 * Die Glama-Bewertung sagt, cachly habe zu viele Werkzeuge (122) und viele
 * liessen sich zusammenlegen. Der Einwand ist plausibel — nur konnte ihm
 * niemand mit Zahlen begegnen: es gab KEINE Messung, welches Werkzeug wie oft
 * gerufen wird.
 *
 * Ohne diese Zahl ist jedes Zusammenlegen geraten. Man streicht dann das, was
 * man selbst selten benutzt, und das ist selten dasselbe wie das, was die
 * Nutzer selten benutzen.
 */
describe('verdichte', () => {
  it('sortiert absteigend und rechnet Anteile', () => {
    const b = verdichte({ smart_recall: 40, learn_from_attempts: 10 });
    expect(b.gesamt).toBe(50);
    expect(b.benutzte).toBe(2);
    expect(b.spitze[0].name).toBe('smart_recall');
    expect(b.spitze[0].anteil).toBeCloseTo(0.8);
  });

  it('Redis liefert Strings — die zaehlen genauso', () => {
    const b = verdichte({ smart_recall: '7', session_start: '3' });
    expect(b.gesamt).toBe(10);
  });

  it('bei Gleichstand entscheidet der Name, damit die Reihenfolge stabil bleibt', () => {
    // Sonst sieht dieselbe Messung bei jedem Aufruf anders aus.
    const b = verdichte({ zeta: 5, alpha: 5 });
    expect(b.spitze.map((z) => z.name)).toEqual(['alpha', 'zeta']);
  });

  it('GEGENPROBE: kaputte Zaehler vergiften die Auswertung nicht', () => {
    const b = verdichte({ gut: 5, leer: '', unsinn: 'viele', negativ: -3, null_: 0 });
    expect(b.gesamt).toBe(5);
    expect(b.benutzte).toBe(1);
    expect(Number.isFinite(b.anteilSpitze)).toBe(true);
  });

  it('GEGENPROBE: gar nichts gemessen ergibt keine NaN', () => {
    const b = verdichte({});
    expect(b).toEqual({ gesamt: 0, benutzte: 0, spitze: [], anteilSpitze: 0 });
  });

  it('die Spitze wird gekappt, der Anteil bezieht sich auf ALLE Aufrufe', () => {
    const roh: Record<string, number> = {};
    for (let i = 0; i < 30; i++) roh[`t${String(i).padStart(2, '0')}`] = 30 - i;
    const b = verdichte(roh, 5);
    expect(b.spitze.length).toBe(5);
    expect(b.benutzte).toBe(30);
    // 30+29+28+27+26 = 140 von 465
    expect(b.gesamt).toBe(465);
    expect(b.anteilSpitze).toBeCloseTo(140 / 465);
  });
});

describe('nutzungInWorten — der Satz, der die Glama-Frage beantwortet', () => {
  it('nennt die nie gerufenen Werkzeuge — die unbequeme Zahl', () => {
    const b = verdichte({ smart_recall: 90, learn_from_attempts: 10 });
    const satz = nutzungInWorten(b, 122);
    expect(satz).toContain('2 von 122');
    expect(satz).toContain('120 nie');
    expect(satz).toContain('100 %');
  });

  it('GEGENPROBE: ohne einen einzigen Aufruf wird NICHTS behauptet', () => {
    // "0 von 122 benutzt" waere eine Aussage ueber die Messung, nicht ueber das
    // Produkt. Eine frische Instanz darf nicht als Beleg gegen die Werkzeuge
    // herhalten.
    const satz = nutzungInWorten(verdichte({}), 122);
    expect(satz).toMatch(/Noch keine/);
    expect(satz).not.toContain('122');
  });

  it('GEGENPROBE: mehr benutzte als bekannte Werkzeuge ergeben keine negative Zahl', () => {
    // Kann passieren, wenn ein alter Zaehler ein inzwischen entferntes
    // Werkzeug traegt.
    const b = verdichte({ a: 1, b: 1, c: 1 });
    expect(nutzungInWorten(b, 2)).toContain('0 nie');
  });
});

describe('nutzungsSchluessel', () => {
  it('haengt am Brain, nicht global — jede Kanzlei zaehlt ihre eigene Nutzung', () => {
    expect(nutzungsSchluessel('abc')).toBe('cachly:stats:tool_calls:abc');
    expect(nutzungsSchluessel('x')).not.toBe(nutzungsSchluessel('y'));
  });
});
