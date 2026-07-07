import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  isTrivialPrompt,
  selectInjectable,
  netBalance,
  shouldBackoff,
  DEFAULT_GATE,
  type LessonCandidate,
} from '../ambient-recall.js';

function cand(over: Partial<LessonCandidate> = {}): LessonCandidate {
  return { id: 'l1', summary: 'Use RS256 rotation-aware config for auth', confidence: 0.9, score: 0.9, ...over };
}

describe('estimateTokens', () => {
  it('is ~chars/4', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('   trimmed   ')).toBe(2);
  });
});

describe('isTrivialPrompt', () => {
  it('skips very short prompts', () => {
    expect(isTrivialPrompt('hi')).toBe(true);
    expect(isTrivialPrompt('ok thanks')).toBe(true);
  });
  it('skips greetings and non-code chit-chat', () => {
    expect(isTrivialPrompt('hello there friend')).toBe(true);
    expect(isTrivialPrompt('what a nice day it is today')).toBe(true);
  });
  it('keeps code/ops prompts', () => {
    expect(isTrivialPrompt('why does the auth deploy fail on tuesdays')).toBe(false);
    expect(isTrivialPrompt('fix the migration race in db schema')).toBe(false);
  });
});

describe('selectInjectable', () => {
  const prompt = 'why does the auth token refresh keep failing on deploy';

  it('skips trivial prompts entirely', () => {
    const d = selectInjectable('hi', [cand()]);
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('trivial-skip');
    expect(d.tokens).toBe(0);
  });

  it('drops candidates below the confidence or score floor', () => {
    const d = selectInjectable(prompt, [
      cand({ id: 'lowconf', confidence: 0.4, score: 0.95 }),
      cand({ id: 'lowscore', confidence: 0.95, score: 0.5 }),
    ]);
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('no-candidate-passed-gate');
  });

  it('injects the strongest candidates, score first', () => {
    const d = selectInjectable(prompt, [
      cand({ id: 'a', score: 0.75, confidence: 0.7 }),
      cand({ id: 'b', score: 0.92, confidence: 0.7 }),
    ]);
    expect(d.inject).toBe(true);
    expect(d.selected.map((c) => c.id)).toEqual(['b', 'a']);
    expect(d.tokens).toBeGreaterThan(0);
  });

  it('caps at topK', () => {
    const many = Array.from({ length: 6 }, (_, i) => cand({ id: `c${i}`, summary: 'x'.repeat(20) }));
    const d = selectInjectable(prompt, many, { topK: 2 });
    expect(d.selected).toHaveLength(2);
  });

  it('never overshoots the hard token cap', () => {
    const big = Array.from({ length: 5 }, (_, i) => cand({ id: `c${i}`, summary: 'x'.repeat(400) })); // ~100 tok each
    const d = selectInjectable(prompt, big, { maxTokens: 240, topK: 5 });
    expect(d.tokens).toBeLessThanOrEqual(240);
    expect(d.selected.length).toBeLessThan(5);
  });

  it('uses conservative defaults', () => {
    expect(DEFAULT_GATE.topK).toBe(3);
    expect(DEFAULT_GATE.minScore).toBeGreaterThanOrEqual(0.7);
  });
});

describe('net accounting', () => {
  it('computes net = prevented - injected', () => {
    const b = netBalance([
      { injected: 200, prevented: 0 },
      { injected: 180, prevented: 5000 },
    ]);
    expect(b).toEqual({ injected: 380, prevented: 5000, net: 4620 });
  });

  it('does not back off before minimum signal', () => {
    const few = Array.from({ length: 5 }, () => ({ injected: 200, prevented: 0 }));
    expect(shouldBackoff(few)).toBe(false); // net-negative but too few turns
  });

  it('backs off when the recent window is net-negative', () => {
    const wasteful = Array.from({ length: 12 }, () => ({ injected: 200, prevented: 0 }));
    expect(shouldBackoff(wasteful)).toBe(true);
  });

  it('does not back off when injections are paying off', () => {
    const paying = Array.from({ length: 12 }, () => ({ injected: 200, prevented: 900 }));
    expect(shouldBackoff(paying)).toBe(false);
  });
});
