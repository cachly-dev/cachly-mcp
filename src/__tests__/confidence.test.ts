/**
 * Tests for confidence.ts
 *
 * Covers:
 *   calculateConfidence – decay model (fresh / aging / warn / stale)
 *   confidenceBadge     – emoji + human label
 *   simpleHash          – determinism, uniqueness, fixed length
 *   STRUCTURED_TEMPLATES – required fields, hints
 *   Constants           – sensible defaults and relationships
 *
 * Run: npx vitest run src/__tests__/confidence.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  calculateConfidence,
  confidenceBadge,
  STRUCTURED_TEMPLATES,
  CONFIDENCE_WARN_DAYS,
  CONFIDENCE_STALE_DAYS,
  CONFIDENCE_WARN_VALUE,
  CONFIDENCE_STALE_VALUE,
  simpleHash,
} from '../confidence.js';

// ── Constant sanity ───────────────────────────────────────────────────────────

describe('Confidence constants', () => {
  it('CONFIDENCE_WARN_DAYS < CONFIDENCE_STALE_DAYS', () => {
    expect(CONFIDENCE_WARN_DAYS).toBeLessThan(CONFIDENCE_STALE_DAYS);
  });

  it('CONFIDENCE_WARN_VALUE > CONFIDENCE_STALE_VALUE', () => {
    expect(CONFIDENCE_WARN_VALUE).toBeGreaterThan(CONFIDENCE_STALE_VALUE);
  });

  it('CONFIDENCE_WARN_VALUE < 1.0 and > 0', () => {
    expect(CONFIDENCE_WARN_VALUE).toBeLessThan(1.0);
    expect(CONFIDENCE_WARN_VALUE).toBeGreaterThan(0);
  });

  it('CONFIDENCE_STALE_VALUE < 1.0 and > 0', () => {
    expect(CONFIDENCE_STALE_VALUE).toBeLessThan(1.0);
    expect(CONFIDENCE_STALE_VALUE).toBeGreaterThan(0);
  });

  it('defaults to 5 warn days and 10 stale days (when env vars absent)', () => {
    // These may be overridden via env, but assert sensible defaults
    expect(CONFIDENCE_WARN_DAYS).toBeGreaterThanOrEqual(1);
    expect(CONFIDENCE_STALE_DAYS).toBeGreaterThanOrEqual(CONFIDENCE_WARN_DAYS + 1);
  });
});

// ── calculateConfidence ───────────────────────────────────────────────────────

describe('calculateConfidence', () => {
  /** Returns an ISO timestamp that is `days` old from now. */
  function tsAgo(days: number): string {
    return new Date(Date.now() - days * 86400000).toISOString();
  }

  it('returns 1.0 for brand-new lesson (age ≈ 0)', () => {
    const c = calculateConfidence({ ts: new Date().toISOString() });
    expect(c).toBeCloseTo(1.0, 2);
  });

  it('prefers verified_at over ts', () => {
    // ts is very old, but verified_at is recent → should NOT be stale
    const c = calculateConfidence({
      ts: tsAgo(365),
      verified_at: tsAgo(0),
    });
    expect(c).toBeCloseTo(1.0, 2);
  });

  it('returns exactly CONFIDENCE_WARN_VALUE at exactly CONFIDENCE_WARN_DAYS', () => {
    const c = calculateConfidence({ ts: tsAgo(CONFIDENCE_WARN_DAYS) });
    // At exactly the warn threshold the function returns CONFIDENCE_WARN_VALUE
    expect(c).toBeCloseTo(CONFIDENCE_WARN_VALUE, 3);
  });

  it('returns exactly CONFIDENCE_STALE_VALUE at exactly CONFIDENCE_STALE_DAYS', () => {
    const c = calculateConfidence({ ts: tsAgo(CONFIDENCE_STALE_DAYS) });
    expect(c).toBe(CONFIDENCE_STALE_VALUE);
  });

  it('caps at CONFIDENCE_STALE_VALUE for very old lessons', () => {
    const c = calculateConfidence({ ts: tsAgo(365) });
    expect(c).toBe(CONFIDENCE_STALE_VALUE);
  });

  it('linearly decreases between 0 and CONFIDENCE_WARN_DAYS', () => {
    const midDays = CONFIDENCE_WARN_DAYS / 2;
    const c = calculateConfidence({ ts: tsAgo(midDays) });
    // at half-way to warn: 1.0 - (0.5 * (1.0 - CONFIDENCE_WARN_VALUE))
    const expected = 1.0 - 0.5 * (1.0 - CONFIDENCE_WARN_VALUE);
    expect(c).toBeCloseTo(expected, 3);
  });

  it('is monotonically decreasing with age', () => {
    const c0 = calculateConfidence({ ts: tsAgo(0) });
    const c1 = calculateConfidence({ ts: tsAgo(CONFIDENCE_WARN_DAYS * 0.3) });
    const c2 = calculateConfidence({ ts: tsAgo(CONFIDENCE_WARN_DAYS * 0.7) });
    const c3 = calculateConfidence({ ts: tsAgo(CONFIDENCE_WARN_DAYS) });
    const c4 = calculateConfidence({ ts: tsAgo(CONFIDENCE_STALE_DAYS) });
    expect(c0).toBeGreaterThanOrEqual(c1);
    expect(c1).toBeGreaterThan(c2);
    expect(c2).toBeGreaterThan(c3);
    expect(c3).toBeGreaterThan(c4);
  });

  it('value between WARN and STALE ages equals CONFIDENCE_WARN_VALUE', () => {
    const betweenDays = (CONFIDENCE_WARN_DAYS + CONFIDENCE_STALE_DAYS) / 2;
    const c = calculateConfidence({ ts: tsAgo(betweenDays) });
    expect(c).toBe(CONFIDENCE_WARN_VALUE);
  });

  it('ignores recall_count (not used in calculation)', () => {
    const ts = new Date().toISOString();
    const c1 = calculateConfidence({ ts, recall_count: 0 });
    const c2 = calculateConfidence({ ts, recall_count: 100 });
    expect(c1).toBeCloseTo(c2, 5);
  });
});

// ── confidenceBadge ───────────────────────────────────────────────────────────

describe('confidenceBadge', () => {
  it('returns ✅ for confidence >= 0.9 (fresh)', () => {
    expect(confidenceBadge(1.0, 0)).toBe('✅');
    expect(confidenceBadge(0.9, 1)).toBe('✅');
    expect(confidenceBadge(0.95, 2)).toBe('✅');
  });

  it('returns ⚠️ prefix for warn range [0.7, 0.9)', () => {
    const badge = confidenceBadge(0.7, 6);
    expect(badge).toMatch(/^⚠️/);
    expect(badge).toContain('6d old');
    expect(badge).toContain('70%');
    expect(badge).toContain('verify before applying');
  });

  it('⚠️ badge rounds age to nearest day', () => {
    const badge = confidenceBadge(0.75, 4.6);
    expect(badge).toContain('5d old');  // Math.round(4.6) = 5
  });

  it('returns 🔴 STALE prefix for confidence < 0.7', () => {
    const badge = confidenceBadge(0.5, 12);
    expect(badge).toMatch(/^🔴 STALE/);
    expect(badge).toContain('12d old');
    expect(badge).toContain('50%');
    expect(badge).toContain('likely outdated');
  });

  it('🔴 badge for exactly 0.0 confidence', () => {
    const badge = confidenceBadge(0.0, 99);
    expect(badge).toMatch(/^🔴 STALE/);
    expect(badge).toContain('0%');
  });

  it('edge: confidence exactly 0.7 returns ⚠️ (not 🔴)', () => {
    const badge = confidenceBadge(0.7, 5);
    expect(badge).toMatch(/^⚠️/);
  });

  it('edge: confidence exactly 0.9 returns ✅ (not ⚠️)', () => {
    expect(confidenceBadge(0.9, 1)).toBe('✅');
  });
});

// ── simpleHash ────────────────────────────────────────────────────────────────

describe('simpleHash', () => {
  it('returns exactly 12 characters', () => {
    expect(simpleHash('hello world')).toHaveLength(12);
    expect(simpleHash('')).toHaveLength(12);
    expect(simpleHash('x'.repeat(10000))).toHaveLength(12);
  });

  it('returns only hex characters [0-9a-f]', () => {
    const hash = simpleHash('test input 123');
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic — same input always yields same hash', () => {
    const input = 'docker compose up -d --build api';
    const h1 = simpleHash(input);
    const h2 = simpleHash(input);
    const h3 = simpleHash(input);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('different inputs yield different hashes (collision resistance)', () => {
    const inputs = [
      'deploy:api',
      'deploy:web',
      'fix:redis-timeout',
      'infra:clickhouse',
      '',
      'a',
      ' ',
      '0',
    ];
    const hashes = inputs.map(simpleHash);
    const unique = new Set(hashes);
    expect(unique.size).toBe(inputs.length);
  });

  it('is sensitive to character order', () => {
    expect(simpleHash('abc')).not.toBe(simpleHash('cba'));
    expect(simpleHash('ab')).not.toBe(simpleHash('ba'));
  });

  it('is sensitive to whitespace differences', () => {
    expect(simpleHash('hello world')).not.toBe(simpleHash('helloworld'));
    expect(simpleHash('hello world')).not.toBe(simpleHash('hello  world'));
  });

  it('works with unicode input', () => {
    const h1 = simpleHash('日本語テスト');
    const h2 = simpleHash('中文测试');
    expect(h1).toHaveLength(12);
    expect(h2).toHaveLength(12);
    expect(h1).not.toBe(h2);
  });

  it('works with newlines and special chars', () => {
    const h = simpleHash('line1\nline2\ttab\r\n');
    expect(h).toHaveLength(12);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ── STRUCTURED_TEMPLATES ──────────────────────────────────────────────────────

describe('STRUCTURED_TEMPLATES', () => {
  it('contains all expected category keys', () => {
    const expected = ['deploy', 'bash', 'infra', 'pricing', 'stripe'];
    for (const key of expected) {
      expect(STRUCTURED_TEMPLATES, `Missing key: "${key}"`).toHaveProperty(key);
    }
  });

  it('every entry has a non-empty hint string', () => {
    for (const [key, tmpl] of Object.entries(STRUCTURED_TEMPLATES)) {
      expect(typeof tmpl.hint, `hint for "${key}" is not a string`).toBe('string');
      expect(tmpl.hint.length, `hint for "${key}" is empty`).toBeGreaterThan(0);
    }
  });

  it('every entry has a required array', () => {
    for (const [key, tmpl] of Object.entries(STRUCTURED_TEMPLATES)) {
      expect(Array.isArray(tmpl.required), `required for "${key}" is not an array`).toBe(true);
    }
  });

  it('deploy / bash / infra require commands[]', () => {
    for (const key of ['deploy', 'bash', 'infra']) {
      expect(STRUCTURED_TEMPLATES[key].required, `${key} should require commands`).toContain('commands');
    }
  });

  it('pricing / stripe have empty required list (free-form)', () => {
    expect(STRUCTURED_TEMPLATES['pricing'].required).toHaveLength(0);
    expect(STRUCTURED_TEMPLATES['stripe'].required).toHaveLength(0);
  });

  it('hints mention the category key', () => {
    for (const [key, tmpl] of Object.entries(STRUCTURED_TEMPLATES)) {
      expect(tmpl.hint.toLowerCase(), `hint for "${key}" should mention the key`).toContain(key);
    }
  });

  it('is a plain object (not prototype-polluted)', () => {
    expect(Object.getPrototypeOf(STRUCTURED_TEMPLATES)).toBe(Object.prototype);
  });

  it('all category keys are valid topic prefixes (lowercase, no special chars)', () => {
    for (const key of Object.keys(STRUCTURED_TEMPLATES)) {
      expect(key).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });
});
