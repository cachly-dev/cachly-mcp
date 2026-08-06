import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAmbientMemory, saveAmbientMemory } from '../ambient-memory.js';
import { candidateIdFor, emptyMemory, type RecallMemory } from '../ambient-recall.js';
import { runAmbient, type LessonCandidate } from '../ambient-cli.js';

const freshDir = () => mkdtempSync(join(tmpdir(), 'cachly-ambient-mem-'));

const PROMPT = JSON.stringify({
  hook_event_name: 'UserPromptSubmit',
  prompt: 'der deploy auf prod wirft 502 hinter nginx, woran liegt das?',
});

const ADVICE_A =
  'Ambient recall: 502 behind nginx after deploy — stale upstream socket; restart the api container, then nginx -s reload.';
const ADVICE_B =
  'Ambient recall: Cloudflare grey-cloud on the api record — origin only allows CF ranges, public requests time out.';

function depsFor(dir: string, advice: () => string) {
  return {
    timeoutMs: 3000,
    gate: { topK: 1, maxTokens: 500 },
    recall: async (): Promise<LessonCandidate[]> => {
      const text = advice();
      return [{ id: candidateIdFor(text), summary: text, confidence: 0.9, score: 0.9 }];
    },
    loadMemory: () => loadAmbientMemory(dir),
    saveMemory: (m: RecallMemory) => saveAmbientMemory(m, dir),
  };
}

describe('SDK-002: RecallMemory survives process boundaries via file store', () => {
  it('roundtrips: save then load returns the identical memory', () => {
    const dir = freshDir();
    const m: RecallMemory = { turn: 7, lastInjectedTurn: { abc123: 5 }, injectionTurns: [2, 5] };
    saveAmbientMemory(m, dir);
    expect(loadAmbientMemory(dir)).toEqual(m);
  });

  it('missing file yields emptyMemory and never throws', () => {
    expect(loadAmbientMemory(freshDir())).toEqual(emptyMemory());
  });

  it('corrupt file yields emptyMemory and never throws', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'ambient-memory.json'), '{"turn": 5, "lastInj', 'utf8');
    expect(loadAmbientMemory(dir)).toEqual(emptyMemory());
  });

  it('oversized file (>64KB) is treated as corrupt: emptyMemory, no throw', () => {
    const dir = freshDir();
    const huge = JSON.stringify({ turn: 1, lastInjectedTurn: {}, injectionTurns: [], junk: 'x'.repeat(70_000) });
    writeFileSync(join(dir, 'ambient-memory.json'), huge, 'utf8');
    expect(loadAmbientMemory(dir)).toEqual(emptyMemory());
  });

  it('a failing save is swallowed (memory is comfort, not a must)', () => {
    const dir = freshDir();
    const fileAsDir = join(dir, 'ambient-memory.json');
    writeFileSync(fileAsDir, '{}', 'utf8');
    expect(() => saveAmbientMemory(emptyMemory(), join(fileAsDir, 'not-a-dir'))).not.toThrow();
  });

  it('suppresses a repeat of the SAME advice across separate invocations (memory only via file)', async () => {
    const dir = freshDir();
    const first = await runAmbient(PROMPT, depsFor(dir, () => ADVICE_A));
    const second = await runAmbient(PROMPT, depsFor(dir, () => ADVICE_A));
    const third = await runAmbient(PROMPT, depsFor(dir, () => ADVICE_A));
    expect(first).not.toBe('');
    expect(second).toBe('');
    expect(third).toBe('');
  });

  it('lets DIFFERENT advice through once the min-silence turn has passed', async () => {
    const dir = freshDir();
    const first = await runAmbient(PROMPT, depsFor(dir, () => ADVICE_A));
    const silence = await runAmbient(PROMPT, depsFor(dir, () => ADVICE_B));
    const third = await runAmbient(PROMPT, depsFor(dir, () => ADVICE_B));
    expect(first).not.toBe('');
    expect(silence).toBe('');
    expect(third).not.toBe('');
  });
});
