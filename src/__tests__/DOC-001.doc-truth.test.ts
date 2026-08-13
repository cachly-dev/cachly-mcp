import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const root = (p: string) => new URL(`../../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(root(p), 'utf8');

// Four levels up is the MONOREPO root. In the npm mirror (cachly-mcp) the
// package itself is the repo root, so this URL points OUTSIDE the checkout
// and every read() ENOENTs — that broke `npm test` in the mirror's publish
// workflow five times in a row on 2026-08-12/13. The docs under test are
// monorepo-only, so the whole suite is skipped where that root is absent.
const inMonorepo = existsSync(root('CACHLY_CAPABILITIES.json'));

describe.skipIf(!inMonorepo)('DOC-001: root docs carry generated truth, and the guard watches them', () => {
  // Guarded: describe callbacks run at collection time even when skipped,
  // so an unconditional read() here would still ENOENT in the mirror.
  const caps = inMonorepo
    ? (JSON.parse(read('CACHLY_CAPABILITIES.json')) as {
        mcp: { total_tools: number };
      })
    : { mcp: { total_tools: 0 } };

  it('capability matrix states the generated tool count, not a stale one', () => {
    const matrix = read('CACHLY_CAPABILITY_MATRIX.md');
    expect(matrix).toContain(`${caps.mcp.total_tools} MCP tools`);
    expect(matrix).not.toMatch(/\b140 (MCP )?tools\b/);
  });

  it('README no longer carries the stale SDK count claim', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('15 official SDKs');
  });

  it('the drift guard now watches root markdown (matrix + README)', () => {
    const guard = read('sdk/mcp/scripts/verify-tool-counts.mjs');
    expect(guard).toContain('CACHLY_CAPABILITY_MATRIX.md');
    expect(guard).toContain('README.md');
  });

  it('the guard treats 140 as a stale pattern so this class cannot return', () => {
    const guard = read('sdk/mcp/scripts/verify-tool-counts.mjs');
    expect(guard).toMatch(/140/);
  });
});
