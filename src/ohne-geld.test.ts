import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Die CLI-Kaesten (digest, share) haengen an process.argv und lassen sich nicht
// ohne Start des ganzen Servers aufrufen. Darum prueft dieser Test den Quelltext:
// keine Kostenzeile in den Kaesten, keine Spar-Dollar in cache_stats / cache_org_stats.
const lies = (rel: string) => readFileSync(join(__dirname, rel), 'utf-8');

describe('keine Geldbetraege in der MCP-Ausgabe', () => {
  it('CLI-Kaesten zeigen keine Kostenzeile', () => {
    const src = lies('index.ts');
    expect(src).not.toMatch(/Cost saved/i);
    expect(src).not.toContain('costSaved');
    expect(src).toContain('K (est.)');
  });

  it('cache_stats und cache_org_stats zeigen keine gesparten Dollar', () => {
    const src = lies('handlers/cache.ts');
    expect(src).not.toMatch(/Total saved|Projected\/month|Avg per hit|Typical savings/);
    expect(src).not.toContain('estimated_total_saved_usd)');
  });
});
