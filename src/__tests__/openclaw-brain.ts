/**
 * Laedt den ECHTEN Adapter sdk/openclaw/src/brain.ts fuer Tests in diesem Paket.
 *
 * Die Datei liegt ausserhalb der vite-Wurzel, und vite-node kann ihren
 * `ioredis`-Import von dort nicht auslagern. Darum: mit der TypeScript-API
 * uebersetzen und mit einem Ersatz-ioredis im Speicher ausfuehren (get/set/mget/
 * scan — mehr braucht der Adapter nicht). Jede Aenderung an brain.ts wirkt so
 * bei jedem Lauf. Genutzt von confidence-vectors.test.ts und lesson-record.test.ts.
 * Nur im Monorepo aufrufen (IM_MONOREPO), sonst fehlt die Datei.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../../..');
const BRAIN_TS_PATH = path.join(REPO_ROOT, 'sdk/openclaw/src/brain.ts');

export class FakeRedis {
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

export interface OpenclawBrain {
  learn(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  recall(query: string, opts?: { topK?: number; threshold?: number }): Promise<Array<{ lesson: Record<string, unknown>; score: number }>>;
  formatBriefing(results: Array<{ lesson: Record<string, unknown>; score: number }>): string;
}

export interface BrainModule {
  createCachlyBrain(opts: { url: string; prefix?: string }): OpenclawBrain;
}

export function loadBrainModule(): BrainModule {
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
    throw new Error(`openclaw-brain: unexpected require("${id}") in brain.ts`);
  };
  new Function('require', 'module', 'exports', outputText)(
    requireShim,
    moduleShim,
    moduleShim.exports,
  );
  return moduleShim.exports as unknown as BrainModule;
}

/** Der Speicher hinter einer Adapter-Instanz (Map Schluessel -> JSON-Text). */
export function speicherVon(brain: OpenclawBrain): Map<string, string> {
  return (brain as unknown as { redis: FakeRedis }).redis.data;
}
