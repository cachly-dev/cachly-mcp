import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { candidateIdFor } from '../ambient-recall.js';

const SAMPLE_A =
  'Ambient recall: node-3 disk full — anonymous CI volumes (8.6 GB) from services:postgres; docker volume prune -f removes only anonymous ones.';
const SAMPLE_B =
  'Ambient recall: spedilink API returns 401 for every token — prod Keycloak realm lacks the audience mapper; API accepts azp==clientId as fallback.';

describe('SDK-001: candidate id derives from content (defuses the #241 dedupe trap)', () => {
  it('is deterministic: the same summary always yields the same id', () => {
    expect(candidateIdFor(SAMPLE_A)).toBe(candidateIdFor(SAMPLE_A));
  });

  it('distinguishes advice: different summaries yield different ids', () => {
    expect(candidateIdFor(SAMPLE_A)).not.toBe(candidateIdFor(SAMPLE_B));
  });

  it('yields a stable 16-char lowercase-hex key (memory/ledger key shape)', () => {
    expect(candidateIdFor(SAMPLE_A)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('index.ts no longer hard-codes the constant candidate id', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/id:\s*['"]ambient['"]/);
  });
});
