/**
 * Eine Warnung ohne Handlung wird weggeklickt.
 *
 * Der Vertrauens-Badge sagte bis zum 04.09.2026 "verify before applying" und
 * nannte nie, WIE. Am selben Tag gemessen: die Frage, ob
 * `OLLAMA_KEEP_ALIVE` auf `-1` oder `30m` steht, war durch Textanalyse nicht
 * zu beantworten — Wertkollision fand 0 von 735 echten Überholungen, ein
 * NLI-Vergleicher kam auf 62 % Genauigkeit. Ein einziger Aufruf hat sie
 * beantwortet.
 *
 * Deshalb trägt der Badge jetzt den ersten gespeicherten Befehl der Lektion
 * mit. Er wird gezeigt, nicht ausgeführt: ein Server, der gespeicherte
 * Befehle selbst startet, ist eine Hintertür in jedem geteilten Brain.
 */

import { describe, it, expect } from 'vitest';
import { confidenceBadge } from '../confidence.js';

describe('Der Badge nennt den Pruefbefehl', () => {
  it('haengt den Befehl an die Warnung', () => {
    const b = confidenceBadge(0.75, 7, 'docker inspect cachly-ollama-1');
    expect(b).toContain('verify before applying');
    expect(b).toContain('docker inspect cachly-ollama-1');
  });

  it('haengt ihn auch an die rote Marke', () => {
    const b = confidenceBadge(0.5, 21, 'curl -s http://10.8.0.7:3095/health');
    expect(b).toContain('STALE');
    expect(b).toContain('curl -s http://10.8.0.7:3095/health');
  });

  it('GEGENPROBE: ohne Befehl bleibt der Text wie bisher', () => {
    expect(confidenceBadge(0.75, 7)).toBe(
      '⚠️ (7d old, confidence 75% — verify before applying)');
    expect(confidenceBadge(0.5, 21)).toBe(
      '🔴 STALE (21d old, confidence 50% — likely outdated!)');
  });

  it('GEGENPROBE: die gruene Marke bleibt ein Haken, mit oder ohne Befehl', () => {
    expect(confidenceBadge(0.95, 1)).toBe('✅');
    expect(confidenceBadge(0.95, 1, 'irgendein befehl')).toBe('✅');
  });

  it('ein mehrzeiliger Block ist kein Pruefbefehl, sondern ein Rezept', () => {
    const b = confidenceBadge(0.5, 21, 'cd /opt\ndocker compose up -d');
    expect(b).not.toContain('docker compose');
    expect(b).toBe('🔴 STALE (21d old, confidence 50% — likely outdated!)');
  });

  it('ein sehr langer Befehl macht die Zeile unlesbar und bleibt draussen', () => {
    const lang = 'ssh -i ~/.ssh/key -p 2222 root@10.8.0.1 ' + 'x'.repeat(120);
    expect(confidenceBadge(0.5, 21, lang)).not.toContain('ssh -i');
  });

  it('Leerraum zaehlt nicht als Befehl', () => {
    expect(confidenceBadge(0.5, 21, '   ')).toBe(
      '🔴 STALE (21d old, confidence 50% — likely outdated!)');
  });
});
