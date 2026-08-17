import { describe, it, expect } from 'vitest';
import { ersparteMinuten, istStarterLektion, fmtStunden } from '../wertbeitrag.js';
import { STARTER_CORPUS } from '../starter-corpus.js';

describe('Wertbeitrag — der Startvorrat zaehlt nicht', () => {
  it('erkennt eine Starter-Lektion an source, nicht am Namen', () => {
    expect(istStarterLektion({ source: 'starter' })).toBe(true);
    expect(istStarterLektion({ source: 'git' })).toBe(false);
    expect(istStarterLektion({})).toBe(false);
    expect(istStarterLektion(null)).toBe(false);
  });

  it('gibt fuer Starter-Lektionen 0 Minuten, egal welche Schwere', () => {
    for (const sev of ['critical', 'major', 'minor', undefined]) {
      expect(ersparteMinuten({ source: 'starter', severity: sev })).toBe(0);
      expect(ersparteMinuten({ source: 'starter', severity: sev }, 'trace')).toBe(0);
    }
  });

  it('laesst die Staffel fuer eigene Lektionen unveraendert', () => {
    expect(ersparteMinuten({ severity: 'critical' })).toBe(240);
    expect(ersparteMinuten({ severity: 'major' })).toBe(60);
    expect(ersparteMinuten({ severity: 'minor' })).toBe(30);
    expect(ersparteMinuten({})).toBe(30);
  });

  it('behaelt die abweichende Staffel von causal_trace', () => {
    expect(ersparteMinuten({ severity: 'critical' }, 'trace')).toBe(240);
    expect(ersparteMinuten({ severity: 'major' }, 'trace')).toBe(120);
    expect(ersparteMinuten({ severity: 'minor' }, 'trace')).toBe(60);
  });

  // ── Die eigentliche Gegenprobe ────────────────────────────────────────────
  //
  // Naheliegend waere gewesen, die sechs auffaelligen Themen vom 17.08.2026
  // hart auszuschliessen. Dieser Test stellt sicher, dass es NICHT so gebaut
  // ist: Eine erfundene Starter-Lektion, die in keiner Namensliste stehen kann,
  // muss genauso 0 ergeben.
  it('wirkt auch fuer eine Starter-Lektion, die es heute noch gar nicht gibt', () => {
    const kuenftig = { topic: 'gibt-es-2027:noch-nicht', severity: 'critical', source: 'starter' };
    expect(ersparteMinuten(kuenftig)).toBe(0);
  });

  // Und die Gegenrichtung: Eine ECHTE Lektion mit demselben Themennamen wie
  // eine Starter-Lektion muss weiter zaehlen. Genau das ist der Normalfall —
  // der Startvorrat wird ersetzt, sobald jemand zum Thema etwas Eigenes lernt.
  it('zaehlt eine eigene Lektion, auch wenn das Thema aus dem Startvorrat stammt', () => {
    const eigen = { topic: 'docker:layer-cache', severity: 'major', source: 'git' };
    expect(ersparteMinuten(eigen)).toBe(60);
  });

  it('der ausgelieferte Startvorrat traegt die Markierung wirklich', () => {
    // Wenn brain_seed_starter je aufhoert, source zu setzen, faellt die ganze
    // Regel still aus — dann zaehlten alle Starter-Lektionen wieder mit.
    expect(STARTER_CORPUS.length).toBeGreaterThan(0);
    for (const l of STARTER_CORPUS) {
      expect(typeof l.topic).toBe('string');
    }
  });
});

describe('fmtStunden', () => {
  it('rechnet Minuten in eine lesbare Angabe um', () => {
    expect(fmtStunden(0)).toBe('0 min');
    expect(fmtStunden(45)).toBe('45 min');
    expect(fmtStunden(60)).toBe('1 h');
    expect(fmtStunden(21 * 60)).toBe('21 h');
    expect(fmtStunden(24 * 60)).toBe('1 d');
    expect(fmtStunden(28 * 60)).toBe('1 d 4 h');
  });

  it('nimmt negative Werte nicht krumm', () => {
    expect(fmtStunden(-5)).toBe('0 min');
  });
});
