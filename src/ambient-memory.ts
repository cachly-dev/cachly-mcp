import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emptyMemory, type RecallMemory } from './ambient-recall.js';

const MEMORY_FILE_NAME = 'ambient-memory.json';
const MAX_MEMORY_BYTES = 64 * 1024;

function defaultAmbientMemoryDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return resolve(home, '.cachly');
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (n) => typeof n === 'number' && Number.isFinite(n),
  );
}

function isValidMemory(value: unknown): value is RecallMemory {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.turn !== 'number' || !Number.isFinite(m.turn)) return false;
  if (!isFiniteNumberRecord(m.lastInjectedTurn)) return false;
  if (!Array.isArray(m.injectionTurns)) return false;
  if (!m.injectionTurns.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  return true;
}

/**
 * Loads the persisted {@link RecallMemory} from `<dir>/ambient-memory.json`.
 * Falls back to {@link emptyMemory} when the file is missing, corrupt, larger
 * than 64KB, or structurally invalid. Never throws.
 */
export function loadAmbientMemory(dir: string = defaultAmbientMemoryDir()): RecallMemory {
  try {
    const raw = readFileSync(resolve(dir, MEMORY_FILE_NAME), 'utf-8');
    if (Buffer.byteLength(raw, 'utf-8') > MAX_MEMORY_BYTES) return emptyMemory();
    const parsed: unknown = JSON.parse(raw);
    if (!isValidMemory(parsed)) return emptyMemory();
    return {
      turn: parsed.turn,
      lastInjectedTurn: { ...parsed.lastInjectedTurn },
      injectionTurns: [...parsed.injectionTurns],
    };
  } catch {
    return emptyMemory();
  }
}

/**
 * Persists `memory` to `<dir>/ambient-memory.json` via write-then-rename so a
 * crash mid-write never corrupts the file for the next read. Never throws.
 */
export function saveAmbientMemory(memory: RecallMemory, dir: string = defaultAmbientMemoryDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, MEMORY_FILE_NAME);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(memory), 'utf-8');
    renameSync(tmp, path);
  } catch {
  }
}
