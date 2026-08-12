import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KOSTPROBEN_JE_WERKZEUG,
  kostprobenVerbraucht,
  kostprobeUebrig,
  kostprobeVerbrauchen,
  kostprobeHinweis,
  schrankeNachKostproben,
} from '../kostprobe.js';

// Die Kostprobe entscheidet, ob ein Gratis-Nutzer ein gesperrtes Werkzeug
// ueberhaupt je erlebt. Anlass: premium_gate_hit ist 36-mal gefeuert, von
// einer einzigen Person, ohne eine einzige Aufruestung.

let verzeichnis: string;
let pfad: string;

beforeEach(() => {
  verzeichnis = mkdtempSync(join(tmpdir(), 'kostprobe-'));
  pfad = join(verzeichnis, 'kostproben.json');
});
afterEach(() => rmSync(verzeichnis, { recursive: true, force: true }));

describe('Kostproben zaehlen', () => {
  it('beginnt bei null und laesst die ersten Laeufe durch', () => {
    expect(kostprobenVerbraucht('causal_trace', pfad)).toBe(0);
    expect(kostprobeUebrig('causal_trace', pfad)).toBe(true);
  });

  it('sperrt erst NACH der letzten Kostprobe, nicht davor', () => {
    for (let i = 1; i <= KOSTPROBEN_JE_WERKZEUG; i++) {
      expect(kostprobeUebrig('causal_trace', pfad)).toBe(true);
      expect(kostprobeVerbrauchen('causal_trace', pfad)).toBe(i);
    }
    expect(kostprobeUebrig('causal_trace', pfad)).toBe(false);
  });

  it('zaehlt je Werkzeug getrennt — ein Topf waere beim ersten leer', () => {
    for (let i = 0; i < KOSTPROBEN_JE_WERKZEUG; i++) kostprobeVerbrauchen('causal_trace', pfad);
    expect(kostprobeUebrig('causal_trace', pfad)).toBe(false);
    expect(kostprobeUebrig('brain_predict', pfad)).toBe(true);
  });

  it('ueberlebt einen Neustart, weil der Zaehler auf der Platte liegt', () => {
    kostprobeVerbrauchen('team_recall', pfad);
    kostprobeVerbrauchen('team_recall', pfad);
    // Frischer Lesevorgang, kein Zwischenspeicher.
    expect(kostprobenVerbraucht('team_recall', pfad)).toBe(2);
  });

  it('behandelt eine beschaedigte Datei wie eine leere, statt zu werfen', () => {
    writeFileSync(pfad, '{kaputt', 'utf-8');
    expect(() => kostprobenVerbraucht('causal_trace', pfad)).not.toThrow();
    expect(kostprobenVerbraucht('causal_trace', pfad)).toBe(0);
  });

  it('ignoriert unsinnige Werte in der Datei', () => {
    writeFileSync(pfad, JSON.stringify({ causal_trace: 'viele', brain_predict: -5 }), 'utf-8');
    expect(kostprobenVerbraucht('causal_trace', pfad)).toBe(0);
    expect(kostprobenVerbraucht('brain_predict', pfad)).toBe(0);
  });
});

describe('Was der Nutzer liest', () => {
  it('nennt bei jeder Kostprobe, wie viele noch bleiben', () => {
    const text = kostprobeHinweis('causal_trace', 1, 'https://x/billing');
    expect(text).toContain('causal_trace');
    expect(text).toContain(String(KOSTPROBEN_JE_WERKZEUG - 1));
  });

  it('sagt bei der letzten Kostprobe, dass es die letzte war', () => {
    const text = kostprobeHinweis('causal_trace', KOSTPROBEN_JE_WERKZEUG, 'https://x/billing');
    expect(text).toContain('letzte');
    expect(text).toContain('https://x/billing');
  });

  it('argumentiert an der Schranke mit einer Zahl, nicht mit einem Versprechen', () => {
    const text = schrankeNachKostproben('causal_trace', 'Ursachensuche.', 'https://x/billing');
    // Die Zahl ist der Kern: "so oft hat es dir schon geholfen".
    expect(text).toContain(String(KOSTPROBEN_JE_WERKZEUG));
    expect(text).toContain('causal_trace');
    expect(text).toContain('https://x/billing');
    // Und es muss dabeistehen, dass der Gratis-Kern bleibt — sonst liest es
    // sich wie eine Wegnahme.
    expect(text.toLowerCase()).toContain('gratis');
  });
});
