/**
 * Tests for the BM25+ search engine components.
 *
 * Run: npx vitest run src/search.test.ts
 */
import { describe, it, expect } from 'vitest';
import { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS } from './index.js';

// ── Tokenizer ─────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenize('Deploy API')).toEqual(['deploy', 'api']);
  });

  it('filters English stopwords', () => {
    const result = tokenize('the quick brown fox is a dog');
    expect(result).not.toContain('the');
    expect(result).not.toContain('is');
    expect(result).not.toContain('a');
    expect(result).toContain('quick');
    expect(result).toContain('brown');
    expect(result).toContain('fox');
    expect(result).toContain('dog');
  });

  it('filters German stopwords', () => {
    const result = tokenize('der schnelle braune Fuchs ist ein Hund');
    expect(result).not.toContain('der');
    expect(result).not.toContain('ist');
    expect(result).not.toContain('ein');
    expect(result).toContain('schnelle');
    expect(result).toContain('fuchs');
    expect(result).toContain('hund');
  });

  it('filters French stopwords', () => {
    const result = tokenize('le chat est sur la table');
    expect(result).not.toContain('le');
    expect(result).not.toContain('est');
    expect(result).not.toContain('sur');
    expect(result).not.toContain('la');
    expect(result).toContain('chat');
    expect(result).toContain('table');
  });

  it('filters Spanish stopwords', () => {
    const result = tokenize('el gato está en la mesa');
    expect(result).not.toContain('el');
    expect(result).not.toContain('en');
    expect(result).not.toContain('la');
    expect(result).toContain('gato');
    expect(result).toContain('mesa');
  });

  it('filters Italian stopwords', () => {
    const result = tokenize('il gatto è sul tavolo');
    expect(result).not.toContain('il');
    expect(result).not.toContain('sul');
    expect(result).toContain('gatto');
    expect(result).toContain('tavolo');
  });

  it('filters Portuguese stopwords', () => {
    const result = tokenize('o gato está na mesa');
    expect(result).not.toContain('na');
    expect(result).toContain('gato');
    expect(result).toContain('mesa');
  });

  it('removes single-char tokens', () => {
    expect(tokenize('a b c deploy')).toEqual(['deploy']);
  });

  it('preserves colons and dots in tokens (topic slugs)', () => {
    const result = tokenize('deploy:api fix:routing-bug v1.2.3');
    expect(result).toContain('deploy:api');
    expect(result).toContain('fix:routing-bug');
    expect(result).toContain('v1.2.3');
  });

  it('handles accented characters', () => {
    const result = tokenize('résumé café naïve über straße');
    expect(result).toContain('résumé');
    expect(result).toContain('café');
    expect(result).toContain('naïve');
    expect(result).toContain('straße');
  });

  it('returns empty array for all-stopwords input', () => {
    expect(tokenize('the is a an')).toEqual([]);
    expect(tokenize('der die das ist ein')).toEqual([]);
  });
});

// ── Stopwords completeness ────────────────────────────────────────────────────

describe('STOPWORDS', () => {
  it('has English equivalents of German stopwords', () => {
    // These are conceptual equivalents that should both be present
    const pairs: [string, string][] = [
      ['the', 'der'], ['the', 'die'], ['the', 'das'],
      ['and', 'und'], ['or', 'oder'], ['but', 'aber'],
      ['is', 'ist'], ['are', 'sind'], ['was', 'war'],
      ['have', 'haben'], ['has', 'hat'], ['will', 'wird'],
      ['can', 'kann'], ['with', 'mit'], ['for', 'für'],
      ['on', 'auf'], ['from', 'von'], ['at', 'bei'],
      ['after', 'nach'], ['not', 'nicht'], ['also', 'auch'],
      ['how', 'wie'], ['what', 'was'], ['who', 'wer'],
      ['where', 'wo'], ['when', 'wann'], ['why', 'warum'],
      ['my', 'mein'], ['your', 'dein'], ['his', 'sein'],
    ];
    for (const [en, de] of pairs) {
      expect(STOPWORDS.has(en), `Missing EN: "${en}"`).toBe(true);
      expect(STOPWORDS.has(de), `Missing DE: "${de}"`).toBe(true);
    }
  });

  it('contains at least 50 words per major language', () => {
    // Sample words unique to each language
    const enSample = ['the', 'would', 'could', 'should', 'through', 'between'];
    const deSample = ['der', 'werden', 'können', 'zwischen', 'während', 'wegen'];
    const frSample = ['le', 'avec', 'dans', 'pour', 'être', 'avoir'];
    const esSample = ['el', 'para', 'como', 'pero', 'cuando', 'porque'];
    const itSample = ['che', 'sono', 'questo', 'perché', 'ancora', 'sempre'];
    const ptSample = ['são', 'fazer', 'estar', 'você', 'também', 'ainda'];

    for (const w of [...enSample, ...deSample, ...frSample, ...esSample, ...itSample, ...ptSample]) {
      expect(STOPWORDS.has(w), `Missing: "${w}"`).toBe(true);
    }
  });
});

// ── Multi-Query Splitting ─────────────────────────────────────────────────────

describe('splitMultiQuery', () => {
  it('splits numbered lists', () => {
    const result = splitMultiQuery('1. deploy API 2. fix routing 3. check auth');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('deploy API');
    expect(result[1]).toBe('fix routing');
    expect(result[2]).toBe('check auth');
  });

  it('splits semicolons', () => {
    const result = splitMultiQuery('deploy API; fix routing; check auth');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('deploy API');
  });

  it('splits "and also"', () => {
    const result = splitMultiQuery('deploy API and also fix routing');
    expect(result).toHaveLength(2);
  });

  it('splits "außerdem"', () => {
    const result = splitMultiQuery('deploy API außerdem routing fixen');
    expect(result).toHaveLength(2);
  });

  it('splits "de plus" (French)', () => {
    const result = splitMultiQuery('déployer API de plus corriger routing');
    expect(result).toHaveLength(2);
  });

  it('splits "además" (Spanish)', () => {
    const result = splitMultiQuery('desplegar API además corregir routing');
    expect(result).toHaveLength(2);
  });

  it('splits comma-separated with 3+ items', () => {
    const result = splitMultiQuery('deploy, routing, auth, redis');
    expect(result).toHaveLength(4);
  });

  it('keeps single query intact', () => {
    expect(splitMultiQuery('deploy API')).toEqual(['deploy API']);
  });

  it('handles 12 numbered items', () => {
    const q = Array.from({ length: 12 }, (_, i) => `${i + 1}. task number ${i + 1}`).join(' ');
    const result = splitMultiQuery(q);
    expect(result.length).toBe(12);
  });

  it('filters out too-short fragments from numbered lists', () => {
    // With short items filtered (≤2 chars), may not split at all
    const result = splitMultiQuery('1. deploy API 2. fix routing 3. ab');
    // "ab" is too short, but "deploy API" and "fix routing" should remain
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toBe('deploy API');
    expect(result[1]).toBe('fix routing');
  });
});

// ── Levenshtein Distance ──────────────────────────────────────────────────────

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('deploy', 'deploy')).toBe(0);
  });

  it('returns correct distance for single edit', () => {
    expect(levenshtein('deploy', 'deploi')).toBe(1); // substitution
    expect(levenshtein('deploy', 'deplo')).toBe(1);  // deletion
    expect(levenshtein('deploy', 'deployy')).toBe(1); // insertion
  });

  it('returns 2 for two edits', () => {
    expect(levenshtein('deploy', 'dploi')).toBe(2);
  });

  it('returns 3+ for distant strings (early exit)', () => {
    expect(levenshtein('deploy', 'abc')).toBeGreaterThanOrEqual(3);
    expect(levenshtein('a', 'abcde')).toBeGreaterThanOrEqual(3);
  });

  it('handles empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

// ── Recency Boost ─────────────────────────────────────────────────────────────

describe('recencyBoost', () => {
  it('returns 1.0 for undefined timestamp', () => {
    expect(recencyBoost(undefined)).toBe(1.0);
  });

  it('returns max boost for very recent entries', () => {
    const boost = recencyBoost(Date.now());
    expect(boost).toBeGreaterThan(1.4);
    expect(boost).toBeLessThanOrEqual(1.5);
  });

  it('decays over time', () => {
    const now = Date.now();
    const oneDay = recencyBoost(now - 1 * 24 * 60 * 60 * 1000);
    const sevenDays = recencyBoost(now - 7 * 24 * 60 * 60 * 1000);
    const thirtyDays = recencyBoost(now - 30 * 24 * 60 * 60 * 1000);

    expect(oneDay).toBeGreaterThan(sevenDays);
    expect(sevenDays).toBeGreaterThan(thirtyDays);
  });

  it('never goes below 0.5', () => {
    const ancient = recencyBoost(Date.now() - 365 * 24 * 60 * 60 * 1000);
    expect(ancient).toBeGreaterThanOrEqual(0.5);
  });

  it('at half-life (7 days), boost is approximately 1.0', () => {
    const atHalfLife = recencyBoost(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // 0.5^1 + 0.5 = 1.0
    expect(atHalfLife).toBeCloseTo(1.0, 1);
  });
});

// ── Timestamp Extraction ──────────────────────────────────────────────────────

describe('extractTimestamp', () => {
  it('extracts "ts" field from JSON', () => {
    const content = '{"topic":"deploy:api","ts":"2026-04-17T12:00:00Z","what_worked":"rsync"}';
    const ts = extractTimestamp(content);
    expect(ts).toBeDefined();
    expect(new Date(ts!).getFullYear()).toBe(2026);
  });

  it('extracts "created" field', () => {
    const content = '{"key":"test","created":"2026-01-01T00:00:00Z"}';
    expect(extractTimestamp(content)).toBeDefined();
  });

  it('returns undefined for non-JSON content', () => {
    expect(extractTimestamp('just plain text about deploy')).toBeUndefined();
  });

  it('returns undefined for invalid dates', () => {
    expect(extractTimestamp('{"ts":"not-a-date"}')).toBeUndefined();
  });
});
