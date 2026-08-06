import { describe, it, expect } from 'vitest';
import {
  promptRisk,
  gateForRisk,
  decideRecall,
  commitInjection,
  emptyMemory,
  DEFAULT_GATE,
  DEFAULT_TIMING,
  type LessonCandidate,
} from '../ambient-recall.js';

function cand(over: Partial<LessonCandidate> = {}): LessonCandidate {
  return {
    id: 'l1',
    summary: 'Backup-Env liegt in der rsync-Zone und wird beim Deploy geloescht',
    confidence: 0.9,
    score: 0.9,
    ...over,
  };
}
const PROMPT = 'deploy the api and run the migration on prod';
const NEUTRAL = 'rename the settings page to preferences in the web app';

describe('promptRisk', () => {
  it('erkennt irreversible Schritte als hoch', () => {
    expect(promptRisk('lass uns auf prod deployen')).toBe('high');
    expect(promptRisk('rm -rf /var/lib/data')).toBe('high');
    expect(promptRisk('drop table sessions')).toBe('high');
  });
  it('erkennt reine Fortsetzungen als niedrig', () => {
    for (const p of ['ok', 'weiter', 'ja', 'go', 'danke']) expect(promptRisk(p)).toBe('low');
  });
  it('alles andere ist normal', () => {
    expect(promptRisk(NEUTRAL)).toBe('normal');
  });
});

describe('gateForRisk', () => {
  it('senkt die Schwelle vor irreversiblen Schritten und hebt sie im Geplauder', () => {
    expect(gateForRisk('high').minScore).toBeLessThan(DEFAULT_GATE.minScore);
    expect(gateForRisk('low').minScore).toBeGreaterThan(DEFAULT_GATE.minScore);
    expect(gateForRisk('low').topK).toBe(1);
    expect(gateForRisk('normal')).toEqual(DEFAULT_GATE);
  });
  it('bleibt in gueltigen Grenzen', () => {
    const strict = gateForRisk('low', { ...DEFAULT_GATE, minScore: 0.97 });
    expect(strict.minScore).toBeLessThanOrEqual(1);
    const loose = gateForRisk('high', { ...DEFAULT_GATE, minScore: 0.02 });
    expect(loose.minScore).toBeGreaterThanOrEqual(0);
  });
});

describe('decideRecall — Dedupe', () => {
  it('wiederholt dieselbe Lektion nicht innerhalb der Abklingzeit', () => {
    let mem = emptyMemory();
    const first = decideRecall(PROMPT, [cand()], mem);
    expect(first.inject).toBe(true);
    mem = commitInjection(mem, first);
    mem = { ...mem, turn: mem.turn + 1 }; // Mindestruhe abwarten

    const second = decideRecall(PROMPT, [cand()], mem);
    expect(second.inject).toBe(false);
    expect(second.timingReason).toBe('all-duplicates');
    expect(second.suppressedDuplicates).toEqual(['l1']);
  });

  it('laesst dieselbe Lektion nach Ablauf der Abklingzeit wieder zu', () => {
    let mem = emptyMemory();
    mem = commitInjection(mem, decideRecall(PROMPT, [cand()], mem));
    mem = { ...mem, turn: mem.turn + DEFAULT_TIMING.repeatCooldownTurns };
    expect(decideRecall(PROMPT, [cand()], mem).inject).toBe(true);
  });

  it('waehlt eine andere Lektion, wenn die bekannte unterdrueckt wird', () => {
    let mem = emptyMemory();
    mem = commitInjection(mem, decideRecall(PROMPT, [cand()], mem));
    mem = { ...mem, turn: mem.turn + DEFAULT_TIMING.minSilenceTurns };
    const d = decideRecall(PROMPT, [cand(), cand({ id: 'l2' })], mem);
    expect(d.inject).toBe(true);
    expect(d.selected.map((c) => c.id)).toEqual(['l2']);
    expect(d.suppressedDuplicates).toEqual(['l1']);
  });
});

describe('decideRecall — Ruhe-Budget', () => {
  it('schweigt unmittelbar nach einem Einwurf', () => {
    let mem = emptyMemory();
    mem = commitInjection(mem, decideRecall(PROMPT, [cand()], mem));
    // turn ist jetzt 1, letzter Einwurf war Turn 0 -> Mindestruhe greift
    const d = decideRecall(PROMPT, [cand({ id: 'neu' })], { ...mem, turn: 0 });
    expect(d.inject).toBe(false);
    expect(d.timingReason).toBe('silence-window');
  });

  it('haelt das Fensterbudget ein', () => {
    let mem = emptyMemory();
    for (let i = 0; i < DEFAULT_TIMING.maxInjectionsPerWindow; i++) {
      const d = decideRecall(PROMPT, [cand({ id: `l${i}` })], mem);
      expect(d.inject).toBe(true);
      mem = commitInjection(mem, d);
      mem = { ...mem, turn: mem.turn + 1 }; // Mindestruhe abwarten
    }
    const blocked = decideRecall(PROMPT, [cand({ id: 'weiterer' })], mem);
    expect(blocked.inject).toBe(false);
    expect(blocked.timingReason).toBe('quiet-budget');
  });

  it('gibt das Budget nach dem Fenster wieder frei', () => {
    let mem = emptyMemory();
    for (let i = 0; i < DEFAULT_TIMING.maxInjectionsPerWindow; i++) {
      mem = commitInjection(mem, decideRecall(PROMPT, [cand({ id: `l${i}` })], mem));
      mem = { ...mem, turn: mem.turn + 1 };
    }
    mem = { ...mem, turn: mem.turn + DEFAULT_TIMING.windowTurns };
    expect(decideRecall(PROMPT, [cand({ id: 'spaeter' })], mem).inject).toBe(true);
  });
});

describe('decideRecall — Auslösemoment', () => {
  it('ueberspringt triviale Prompts weiterhin', () => {
    const d = decideRecall('ok', [cand()], emptyMemory());
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('trivial-skip');
  });

  it('laesst vor riskanten Schritten auch knappere Treffer durch', () => {
    const knapp = cand({ score: DEFAULT_GATE.minScore - 0.05 });
    expect(decideRecall(NEUTRAL, [knapp], emptyMemory()).inject).toBe(false);
    expect(decideRecall(PROMPT, [knapp], emptyMemory()).inject).toBe(true);
  });

  it('meldet das erkannte Risiko mit', () => {
    expect(decideRecall(PROMPT, [cand()], emptyMemory()).risk).toBe('high');
    expect(decideRecall(NEUTRAL, [cand()], emptyMemory()).risk).toBe('normal');
  });
});

describe('commitInjection', () => {
  it('zaehlt den Turn auch ohne Einwurf hoch', () => {
    const mem = emptyMemory();
    const next = commitInjection(mem, decideRecall('ok', [cand()], mem));
    expect(next.turn).toBe(1);
    expect(next.injectionTurns).toEqual([]);
  });
  it('veraendert das uebergebene Gedaechtnis nicht', () => {
    const mem = emptyMemory();
    commitInjection(mem, decideRecall(PROMPT, [cand()], mem));
    expect(mem.turn).toBe(0);
    expect(mem.injectionTurns).toEqual([]);
  });
});

describe('commitInjection — Gedaechtnis bleibt begrenzt', () => {
  it('vergisst Eintraege ausserhalb der Fenster', () => {
    let mem = emptyMemory();
    mem = commitInjection(mem, decideRecall(PROMPT, [cand({ id: 'alt' })], mem));
    expect(mem.lastInjectedTurn.alt).toBe(0);

    // Weit in die Zukunft springen und einen Turn abschliessen
    mem = { ...mem, turn: 1000 };
    mem = commitInjection(mem, decideRecall('ok', [cand()], mem));
    expect(mem.lastInjectedTurn.alt).toBeUndefined();
    expect(mem.injectionTurns).toEqual([]);
  });
});
