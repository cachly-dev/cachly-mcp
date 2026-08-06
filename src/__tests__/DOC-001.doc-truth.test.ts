import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const root = (p: string) => new URL(`../../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(root(p), 'utf8');

describe('DOC-001: root docs carry generated truth, and the guard watches them', () => {
  const caps = JSON.parse(read('CACHLY_CAPABILITIES.json')) as {
    mcp: { total_tools: number };
  };

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
