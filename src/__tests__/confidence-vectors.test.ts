/**
 * Golden-vector parity tests for the Brain confidence-calibration algorithm (P0-21).
 *
 * The calibration math — reinforce (+0.1, cap 0.99) on a matching outcome, erode
 * (−0.15, floor 0.05) on a flipped one, initial 0.6 — is hand-implemented twice:
 *
 *   * TypeScript (canonical): sdk/openclaw/src/brain.ts   → CachlyBrain.learn()
 *   * Python     (mirror):    sdk/agents/cachly_agents/brain.py → CachlyBrain.learn()
 *
 * Both suites execute the SAME language-neutral vectors from
 * docs/spec/confidence-vectors.json, so any divergence fails CI in whichever
 * language drifted. See the "_readme" field in the JSON for the update protocol.
 *
 * (sdk/mcp/src/confidence.ts holds the separate time-decay confidence model,
 * covered by confidence.test.ts — not this reinforce/erode calibration.)
 *
 * Loading note: this suite runs the REAL sdk/openclaw/src/brain.ts source. It is
 * outside this package's vite root, and vite-node cannot externalize its `ioredis`
 * import from there, so we transpile the source with the TypeScript compiler API
 * and evaluate it with an in-memory ioredis stand-in (get/set only — all learn()
 * needs). Any behavioral change to brain.ts is therefore picked up on every run.
 *
 * Run: npx vitest run src/__tests__/confidence-vectors.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

// ── Vector schema (mirrors docs/spec/confidence-vectors.json) ─────────────────

interface VectorStep {
  learn: Record<string, unknown> & { outcome: 'success' | 'failure' };
  expected: Record<string, unknown>;
}

interface Vector {
  description: string;
  topic: string;
  initial: Record<string, unknown> | null;
  steps: VectorStep[];
}

interface VectorFile {
  source_of_truth: string;
  epsilon: number;
  vectors: Vector[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const VECTORS_PATH = path.join(REPO_ROOT, 'docs/spec/confidence-vectors.json');
const BRAIN_TS_PATH = path.join(REPO_ROOT, 'sdk/openclaw/src/brain.ts');

// This is a MONOREPO-only cross-package parity suite: it reads the shared vector
// spec and the canonical brain.ts, both of which live outside this package. When
// sdk/mcp is published standalone to npm (the @cachly-dev/mcp-server mirror), those
// paths don't exist — detect that and skip instead of throwing ENOENT at import,
// which was failing the mirror's publish job.
const IS_MONOREPO = existsSync(VECTORS_PATH) && existsSync(BRAIN_TS_PATH);

const vectorFile = IS_MONOREPO
  ? (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as VectorFile)
  : null;

// ── Load the real brain.ts with an in-memory ioredis ──────────────────────────

class FakeRedis {
  data = new Map<string, string>();
  constructor(_url?: string) {}
  async get(key: string): Promise<string | null> {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.data.set(key, value);
    return 'OK';
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => (this.data.has(k) ? this.data.get(k)! : null));
  }
  async scan(_cursor: string, _m: string, pattern: string): Promise<[string, string[]]> {
    const re = new RegExp(
      '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );
    return ['0', [...this.data.keys()].filter((k) => re.test(k))];
  }
  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

interface BrainModule {
  createCachlyBrain(opts: { url: string; prefix?: string }): {
    learn(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}

function loadBrainModule(): BrainModule {
  const source = readFileSync(BRAIN_TS_PATH, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: 'brain.ts',
  });
  const moduleShim = { exports: {} as Record<string, unknown> };
  const requireShim = (id: string) => {
    if (id === 'ioredis') return { Redis: FakeRedis };
    throw new Error(`confidence-vectors: unexpected require("${id}") in brain.ts`);
  };
  new Function('require', 'module', 'exports', outputText)(
    requireShim,
    moduleShim,
    moduleShim.exports,
  );
  return moduleShim.exports as unknown as BrainModule;
}

const brainModule = IS_MONOREPO ? loadBrainModule() : null;

// snake_case learn payload (vector JSON) → camelCase LearnInput (brain.ts API)
function toLearnInput(topic: string, learn: Record<string, unknown>): Record<string, unknown> {
  return {
    topic,
    outcome: learn.outcome,
    whatWorked: learn.what_worked,
    whatFailed: learn.what_failed,
    severity: learn.severity,
    filePaths: learn.file_paths,
    commands: learn.commands,
    tags: learn.tags,
  };
}

// ── Run every vector through the real learn() ─────────────────────────────────

describe.skipIf(!IS_MONOREPO)('confidence calibration golden vectors (docs/spec/confidence-vectors.json)', () => {
  const { epsilon, vectors } = vectorFile!;

  it('has a sane vector file', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
    expect(epsilon).toBeGreaterThan(0);
    expect(epsilon).toBeLessThan(1e-3);
    // Topics must be unique so vectors cannot interfere.
    expect(new Set(vectors.map((v) => v.topic)).size).toBe(vectors.length);
  });

  for (const vector of vectors) {
    it(vector.description, async () => {
      const brain = brainModule!.createCachlyBrain({ url: 'redis://fake:6379' });
      const store = (brain as unknown as { redis: FakeRedis }).redis.data;
      const key = `cachly:lesson:best:${vector.topic}`;

      if (vector.initial) {
        store.set(key, JSON.stringify({ topic: vector.topic, ...vector.initial }));
      }

      for (const [i, step] of vector.steps.entries()) {
        await brain.learn(toLearnInput(vector.topic, step.learn));
        const raw = store.get(key);
        expect(raw, `step ${i + 1}: lesson missing from store`).toBeDefined();
        const stored = JSON.parse(raw!) as Record<string, unknown>;

        for (const [field, expected] of Object.entries(step.expected)) {
          const actual = stored[field];
          const label = `step ${i + 1}, field "${field}"`;
          if (expected === null) {
            // null expectation = field must be absent (or null) in the stored JSON
            expect(actual, label).toBeUndefined();
          } else if (field === 'confidence') {
            expect(typeof actual, label).toBe('number');
            expect(Math.abs((actual as number) - (expected as number)), label).toBeLessThanOrEqual(
              epsilon,
            );
          } else {
            expect(actual, label).toEqual(expected);
          }
        }
      }
    });
  }
});
