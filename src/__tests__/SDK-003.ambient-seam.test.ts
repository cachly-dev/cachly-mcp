import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAmbientDeps } from '../ambient-deps.js';
import { emptyMemory, type RecallMemory } from '../ambient-recall.js';
import { runAmbient } from '../ambient-cli.js';

const PROMPT = JSON.stringify({
  hook_event_name: 'UserPromptSubmit',
  prompt: 'die migration auf prod schlaegt mit permission denied fehl, was tun?',
});

const ADVICE_A =
  'Ambient recall: migrations must run as kanzlei_admin — the app role lacks DDL; apply inline via docker exec, not psql pipe.';
const ADVICE_B =
  'Ambient recall: RLS drift — prod policy reads app.org_id which is never set; recreate the policy against app.current_org.';

/** Simulates one short-lived hook process: fresh deps, memory shared only via load/save. */
function turn(text: string, store: { mem: RecallMemory }) {
  const deps = buildAmbientDeps({
    instanceId: 'test-instance',
    smartRecall: async () => text,
    loadMemory: () => store.mem,
    saveMemory: (m: RecallMemory) => {
      store.mem = m;
    },
  });
  return runAmbient(PROMPT, deps);
}

describe('SDK-003: the production seam, proven across turns (regression for #240/#241)', () => {
  it('index.ts wires the SAME factory the tests exercise (no inline copy left)', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).toContain('buildAmbientDeps(');
    expect(src).not.toMatch(/id:\s*['"]ambient['"]/);
  });

  it('same advice twice: exactly the first turn injects', async () => {
    const store = { mem: emptyMemory() };
    expect(await turn(ADVICE_A, store)).not.toBe('');
    expect(await turn(ADVICE_A, store)).toBe('');
    expect(await turn(ADVICE_A, store)).toBe('');
  });

  it('different advice injects again after the min-silence turn', async () => {
    const store = { mem: emptyMemory() };
    expect(await turn(ADVICE_A, store)).not.toBe('');
    expect(await turn(ADVICE_B, store)).toBe('');
    expect(await turn(ADVICE_B, store)).not.toBe('');
  });

  it('#241 regression: distinct advice leaves DISTINCT ids in memory (no constant id)', async () => {
    const store = { mem: emptyMemory() };
    await turn(ADVICE_A, store);
    await turn(ADVICE_B, store);
    await turn(ADVICE_B, store);
    const ids = Object.keys(store.mem.lastInjectedTurn);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps the production miss-detection: a "no lessons" reply injects nothing', async () => {
    const store = { mem: emptyMemory() };
    const deps = buildAmbientDeps({
      instanceId: 'test-instance',
      smartRecall: async () => 'No lessons found',
      loadMemory: () => store.mem,
      saveMemory: (m: RecallMemory) => {
        store.mem = m;
      },
    });
    expect(await runAmbient(PROMPT, deps)).toBe('');
  });
});
