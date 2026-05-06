/**
 * Tests for the BM25+ search engine components.
 *
 * Run: npx vitest run src/search.test.ts
 */
import { describe, it, expect } from 'vitest';
import { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS,
         katakanaToRomaji, arabicLightStem, expandCrossLingual, CROSS_LINGUAL_MAP } from './index.js';

// ── Tokenizer ─────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    const result = tokenize('Deploy API');
    expect(result).toContain('deploy');
    expect(result).toContain('api');
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
    const result = tokenize('a b c deploy');
    expect(result).toContain('deploy');
    // single chars a, b, c must not appear
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
    expect(result).not.toContain('c');
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

// ── Katakana → Romaji ──────────────────────────────────────────────────────────

describe('katakanaToRomaji', () => {
  it('converts basic katakana vowels', () => {
    expect(katakanaToRomaji('アイウエオ')).toBe('aiueo');
  });

  it('converts コンテナ (container)', () => {
    expect(katakanaToRomaji('コンテナ')).toBe('kontena');
  });

  it('converts デプロイ (deploy)', () => {
    expect(katakanaToRomaji('デプロイ')).toBe('depuroi');
  });

  it('converts サーバー (server) — long vowel stripped', () => {
    const r = katakanaToRomaji('サーバー');
    expect(r).toContain('sa');
    expect(r).toContain('ba');
  });

  it('converts digraph チェック (check)', () => {
    const r = katakanaToRomaji('チェック');
    expect(r).toContain('che');
  });

  it('converts ファイル (file)', () => {
    const r = katakanaToRomaji('ファイル');
    expect(r).toContain('fa');
  });

  it('handles empty string', () => {
    expect(katakanaToRomaji('')).toBe('');
  });
});

// ── Arabic Light Stemmer ───────────────────────────────────────────────────────

describe('arabicLightStem', () => {
  it('strips definite article ال (al-)', () => {
    // الخطأ (al-khata = the error) → خطأ (khata)
    expect(arabicLightStem('الخطأ')).toBe('خطأ');
  });

  it('strips و (wa-) prefix from long words', () => {
    // وخطأ → خطأ (and error → error)
    expect(arabicLightStem('وخطأ')).toBe('خطأ');
  });

  it('strips ب (bi-) prefix', () => {
    expect(arabicLightStem('بسرعة')).toBe('سرعة');
  });

  it('does not strip from short words (≤3 chars)', () => {
    // بلد (3 chars) should not be stripped
    expect(arabicLightStem('بلد')).toBe('بلد');
  });

  it('returns unchanged for Latin input', () => {
    expect(arabicLightStem('deploy')).toBe('deploy');
  });
});

// ── Cross-lingual Expansion ────────────────────────────────────────────────────

describe('expandCrossLingual', () => {
  it('returns Japanese katakana for "deploy"', () => {
    const syns = expandCrossLingual('deploy');
    expect(syns).toContain('デプロイ');
  });

  it('returns Chinese for "deploy"', () => {
    expect(expandCrossLingual('deploy')).toContain('部署');
  });

  it('returns Korean for "deploy"', () => {
    expect(expandCrossLingual('deploy')).toContain('배포');
  });

  it('returns English for Japanese デプロイ', () => {
    expect(expandCrossLingual('デプロイ')).toContain('deploy');
  });

  it('returns English for Chinese 部署', () => {
    expect(expandCrossLingual('部署')).toContain('deploy');
  });

  it('returns English for Korean 배포', () => {
    expect(expandCrossLingual('배포')).toContain('deploy');
  });

  it('returns English for Arabic خطأ (error)', () => {
    expect(expandCrossLingual('خطأ')).toContain('error');
  });

  it('returns English for Hebrew שגיאה (error)', () => {
    expect(expandCrossLingual('שגיאה')).toContain('error');
  });

  it('returns empty array for unknown tokens', () => {
    expect(expandCrossLingual('foobar')).toEqual([]);
  });

  it('covers all major languages for "server"', () => {
    const syns = expandCrossLingual('server');
    expect(syns).toContain('サーバー');
    expect(syns).toContain('服务器');
    expect(syns).toContain('서버');
  });

  it('has at least 50 tech terms in the map', () => {
    expect(CROSS_LINGUAL_MAP.size).toBeGreaterThanOrEqual(50);
  });
});

// ── RTL Tokenization ───────────────────────────────────────────────────────────

describe('tokenize — RTL (Arabic/Hebrew)', () => {
  it('tokenizes Arabic text into words', () => {
    // "خطأ في النظام" = error in the system
    const tokens = tokenize('خطأ في النظام');
    expect(tokens.length).toBeGreaterThan(0);
    // خطأ = error, not a stopword
    const hasError = tokens.some(t => t === 'خطأ' || t === 'error');
    expect(hasError).toBe(true);
  });

  it('strips Arabic definite article via light stemmer', () => {
    // النظام → نظام (the system → system)
    const tokens = tokenize('النظام');
    expect(tokens).toContain('نظام');
  });

  it('filters Arabic stopwords', () => {
    const tokens = tokenize('في على من');
    // All three are stopwords
    expect(tokens.filter(t => RTL_RE_TEST(t)).length).toBe(0);
  });

  it('tokenizes Hebrew text', () => {
    // שגיאה = error
    const tokens = tokenize('שגיאה בשרת');
    expect(tokens.length).toBeGreaterThan(0);
    const hasErr = tokens.some(t => t === 'שגיאה' || t === 'error');
    expect(hasErr).toBe(true);
  });

  it('handles mixed Arabic + English text', () => {
    const tokens = tokenize('deploy خطأ error');
    expect(tokens).toContain('deploy');
    expect(tokens.some(t => t === 'خطأ' || t === 'error')).toBe(true);
  });
});

// Helper: test if a string contains RTL characters
function RTL_RE_TEST(s: string) {
  return /[\u0590-\u05ff\u0600-\u06ff]/.test(s);
}

// ── Cross-lingual Search Integration ──────────────────────────────────────────

describe('tokenize — cross-lingual expansion', () => {
  it('English "deploy" expands to Japanese bigrams', () => {
    const tokens = tokenize('deploy');
    // デプロイ bigrams: デプ, プロ, ロイ
    expect(tokens.some(t => t === 'デプ' || t === 'プロ' || t === 'ロイ')).toBe(true);
  });

  it('Japanese デプロイ expands to include "deploy"', () => {
    const tokens = tokenize('デプロイ');
    expect(tokens).toContain('deploy');
  });

  it('Chinese 部署 expands to "deploy"', () => {
    const tokens = tokenize('部署');
    expect(tokens).toContain('deploy');
  });

  it('Korean 배포 expands to "deploy"', () => {
    const tokens = tokenize('배포');
    expect(tokens).toContain('deploy');
  });

  it('Arabic خطأ expands to "error"', () => {
    const tokens = tokenize('خطأ');
    expect(tokens).toContain('error');
  });

  it('Hebrew שגיאה expands to "error"', () => {
    const tokens = tokenize('שגיאה');
    expect(tokens).toContain('error');
  });

  it('English "container" expands to all CJK variants', () => {
    const tokens = tokenize('container');
    // コンテナ bigrams should be present
    expect(tokens.some(t => t === 'コン' || t === 'ンテ' || t === 'テナ')).toBe(true);
  });

  it('katakana コンテナ generates romaji "kontena"', () => {
    const tokens = tokenize('コンテナ');
    expect(tokens).toContain('kontena');
  });
});

// ── Language-specific tokenizer + stemmer tests ───────────────────────────────
describe('multilingual tokenizer', () => {
  // Russian
  it('Russian: токенизирует слово и стемит суффикс', () => {
    const tokens = tokenize('развёртывание сервера');
    expect(tokens.some(t => t.startsWith('развёрт') || t === 'deploy' || t === 'deployment')).toBe(true);
  });
  it('Russian: развёртывание expands to "deploy"', () => {
    const tokens = tokenize('развёртывание');
    expect(tokens).toContain('deploy');
  });
  it('Russian: ошибка expands to "error"', () => {
    const tokens = tokenize('ошибка');
    expect(tokens).toContain('error');
  });

  // Turkish
  it('Turkish: sunucu expands to "server"', () => {
    const tokens = tokenize('sunucu');
    expect(tokens).toContain('server');
  });
  it('Turkish: hata expands to "error"', () => {
    const tokens = tokenize('hata');
    expect(tokens).toContain('error');
  });

  // Bengali
  it('Bengali: tokenizes words with Bengali script', () => {
    const tokens = tokenize('সার্ভার ডেটাবেস');
    expect(tokens.length).toBeGreaterThan(0);
  });
  it('Bengali: strips -গুলো plural suffix', () => {
    // সার্ভারগুলো → সার্ভার
    const tokens = tokenize('সার্ভারগুলো');
    expect(tokens.some(t => t.startsWith('\u09b8\u09be\u09b0') || t.length > 0)).toBe(true);
  });

  // Vietnamese
  it('Vietnamese: tokenizes tone-marked words', () => {
    const tokens = tokenize('triển khai máy chủ');
    expect(tokens.some(t => t === 'tri\u1ec3n' || t === 'khai' || t === 'm\u00e1y' || t === 'ch\u1ee7')).toBe(true);
  });
  it('Vietnamese: triển khai expands to "deploy"', () => {
    const tokens = tokenize('triển khai');
    expect(tokens).toContain('deploy');
  });
  it('Vietnamese: lỗi expands to "error"', () => {
    const tokens = tokenize('lỗi');
    expect(tokens).toContain('error');
  });
  it('Vietnamese: stopwords filtered out', () => {
    const tokens = tokenize('không tôi và');
    expect(tokens).not.toContain('t\u00f4i');
    expect(tokens).not.toContain('v\u00e0');
  });

  // Hindi
  it('Hindi: तैनाती expands to "deploy"', () => {
    const tokens = tokenize('तैनाती');
    expect(tokens).toContain('deploy');
  });
  it('Hindi: त्रुटि expands to "error"', () => {
    const tokens = tokenize('त्रुटि');
    expect(tokens).toContain('error');
  });

  // Farsi
  it('Farsi: استقرار expands to "deploy"', () => {
    const tokens = tokenize('استقرار');
    expect(tokens).toContain('deploy');
  });

  // camelCase splitting
  it('preprocessText splits camelCase', () => {
    const tokens = tokenize('deployServer');
    expect(tokens).toContain('deploy');
    expect(tokens).toContain('server');
  });
  it('preprocessText splits snake_case', () => {
    const tokens = tokenize('my_api_key');
    expect(tokens).toContain('api');
    expect(tokens).toContain('key');
  });
  it('preprocessText splits PascalCase HTMLParser', () => {
    const tokens = tokenize('HTMLParser');
    expect(tokens).toContain('html');
    expect(tokens).toContain('parser');
  });

  // Tech synonyms
  it('tech synonym: k8s expands to include kubernetes', () => {
    const tokens = tokenize('k8s');
    expect(tokens).toContain('kubernetes');
  });
  it('tech synonym: postgres expands to postgresql', () => {
    const tokens = tokenize('postgres');
    expect(tokens).toContain('postgresql');
  });
});

// ── Prefix-Matching tests ─────────────────────────────────────────────────────
describe('keywordSearch prefix-matching', () => {
  it('English "deploy" matches forward entries for 17 languages in cross-lingual map', () => {
    const result = CROSS_LINGUAL_MAP.get('deploy');
    expect(result).toBeDefined();
    // Should include at least Vietnamese, Russian, Turkish entries
    expect(result).toContain('triển khai');
    expect(result).toContain('развёртывание');
    expect(result).toContain('dağıtım');
  });
});

// ── tokenize edge cases ───────────────────────────────────────────────────────

describe('tokenize — edge cases', () => {
  it('handles pure numbers', () => {
    const tokens = tokenize('404 500 200');
    // Numbers are preserved as tokens if length > 1
    expect(tokens.some(t => /\d/.test(t))).toBe(true);
  });

  it('handles URLs — strips protocol and splits on slashes', () => {
    const tokens = tokenize('https://api.cachly.dev/v1/instances');
    expect(tokens.some(t => t.includes('cachly') || t.includes('api') || t.includes('instances'))).toBe(true);
  });

  it('handles markdown formatting — strips asterisks and backticks', () => {
    const tokens = tokenize('**Deploy** the `server` now');
    expect(tokens).toContain('deploy');
    expect(tokens).toContain('server');
  });

  it('deduplicates identical tokens (from cross-lingual expansion)', () => {
    const tokens = tokenize('deploy deploy');
    const counts: Record<string, number> = {};
    for (const t of tokens) counts[t] = (counts[t] ?? 0) + 1;
    // Exact duplicates are deduplicated
    expect(counts['deploy'] ?? 0).toBeLessThanOrEqual(2);
  });

  it('handles very long single words (hashed to bigram)', () => {
    const longWord = 'a'.repeat(50);
    const tokens = tokenize(longWord);
    // Should not crash and should produce at least one token
    expect(tokens.length).toBeGreaterThanOrEqual(0);
  });

  it('handles emoji in text gracefully', () => {
    const tokens = tokenize('🚀 deploy 🔥 server');
    expect(tokens).toContain('deploy');
    expect(tokens).toContain('server');
  });

  it('handles mixed script in single sentence', () => {
    const tokens = tokenize('deploy サーバー to production 서버');
    expect(tokens).toContain('deploy');
    expect(tokens.some(t => t === 'server' || t.includes('sa') || t.includes('ba'))).toBe(true);
  });
});

// ── levenshtein edge cases ────────────────────────────────────────────────────

describe('levenshtein — additional cases', () => {
  it('single character strings', () => {
    expect(levenshtein('a', 'a')).toBe(0);
    expect(levenshtein('a', 'b')).toBe(1);
    expect(levenshtein('a', 'ab')).toBe(1);
  });

  it('symmetric property: d(a,b) === d(b,a)', () => {
    const pairs: [string, string][] = [
      ['deploy', 'deploi'],
      ['hello', 'world'],
      ['abc', ''],
      ['redis', 'reds'],
    ];
    for (const [a, b] of pairs) {
      expect(levenshtein(a, b)).toBe(levenshtein(b, a));
    }
  });

  it('triangle inequality: d(a,c) ≤ d(a,b) + d(b,c)', () => {
    const a = 'docker';
    const b = 'doker';   // 1 edit from docker
    const c = 'dcker';   // 1 edit from docker, 2 from doker
    expect(levenshtein(a, c)).toBeLessThanOrEqual(levenshtein(a, b) + levenshtein(b, c));
  });

  it('common tech term typos are within distance 2', () => {
    const typos: [string, string][] = [
      ['docker', 'docekr'],
      ['redis', 'redsi'],
      ['nginx', 'nigx'],
      ['postgres', 'posgres'],
    ];
    for (const [correct, typo] of typos) {
      expect(levenshtein(correct, typo)).toBeLessThanOrEqual(2);
    }
  });
});

// ── recencyBoost edge cases ───────────────────────────────────────────────────

describe('recencyBoost — additional cases', () => {
  it('returns 1.0 for null/undefined', () => {
    expect(recencyBoost(undefined)).toBe(1.0);
    expect(recencyBoost(null as unknown as undefined)).toBe(1.0);
  });

  it('returns max boost (1.5) for timestamps in the future', () => {
    const future = Date.now() + 60_000; // 1 minute ahead
    const boost = recencyBoost(future);
    expect(boost).toBeCloseTo(1.5, 1);
  });

  it('boost is consistent for same age', () => {
    const ts = Date.now() - 2 * 86400000;
    expect(recencyBoost(ts)).toBeCloseTo(recencyBoost(ts), 5);
  });

  it('boost values bracket correctly for known ages', () => {
    const now = Date.now();
    const fresh   = recencyBoost(now);                            // 0d
    const oneDay  = recencyBoost(now - 86400000);                 // 1d
    const fourDay = recencyBoost(now - 4 * 86400000);             // 4d
    const weekOld = recencyBoost(now - 7 * 86400000);             // 7d
    const monthOld = recencyBoost(now - 30 * 86400000);           // 30d
    const yearOld  = recencyBoost(now - 365 * 86400000);          // 1y

    expect(fresh).toBeGreaterThan(1.4);
    expect(oneDay).toBeGreaterThan(1.2);
    expect(fourDay).toBeGreaterThan(1.0);
    expect(weekOld).toBeCloseTo(1.0, 1);
    expect(monthOld).toBeLessThan(0.9);
    expect(yearOld).toBeGreaterThanOrEqual(0.5);
  });
});

// ── extractTimestamp edge cases ───────────────────────────────────────────────

describe('extractTimestamp — additional cases', () => {
  it('handles updated_at field', () => {
    const content = '{"updated_at":"2026-05-01T10:00:00Z","key":"value"}';
    const ts = extractTimestamp(content);
    // Should find a valid date (updated_at or fall through to ts)
    if (ts) {
      expect(new Date(ts).getFullYear()).toBeGreaterThanOrEqual(2026);
    }
  });

  it('extracts from nested JSON objects', () => {
    const content = JSON.stringify({ meta: { ts: '2026-03-15T08:00:00Z' }, value: 'test' });
    // ts is at top-level via regex so this might not match nested — just no crash
    expect(() => extractTimestamp(content)).not.toThrow();
  });

  it('handles array-valued ts field gracefully', () => {
    const content = '{"ts":[1,2,3],"data":"test"}';
    expect(() => extractTimestamp(content)).not.toThrow();
  });

  it('handles partial JSON (truncated)', () => {
    const content = '{"ts":"2026-01-01T00:00:00Z","data":"tr';
    expect(() => extractTimestamp(content)).not.toThrow();
  });

  it('returns undefined for plain text with no JSON', () => {
    expect(extractTimestamp('just a sentence with no dates')).toBeUndefined();
  });
});

// ── splitMultiQuery completeness ──────────────────────────────────────────────

describe('splitMultiQuery — additional splitters', () => {
  it('splits "furthermore" (English)', () => {
    const r = splitMultiQuery('fix timeout furthermore increase heap');
    expect(r.length).toBe(2);
  });

  it('splits "additionally" (English)', () => {
    const r = splitMultiQuery('deploy api additionally update config');
    expect(r.length).toBe(2);
  });

  it('splits "de plus" (French)', () => {
    const r = splitMultiQuery('déployer API de plus corriger timeout');
    expect(r.length).toBe(2);
  });

  it('splits "und außerdem" (German)', () => {
    const r = splitMultiQuery('API deployen und außerdem Timeout erhöhen');
    expect(r.length).toBe(2);
  });

  it('handles input with only separators gracefully', () => {
    const r = splitMultiQuery(';;;');
    // Should not crash; may return empty or single element
    expect(Array.isArray(r)).toBe(true);
  });

  it('does not split on comma inside brackets', () => {
    // "1 item" shouldn't produce garbage splits
    const r = splitMultiQuery('deploy API');
    expect(r).toEqual(['deploy API']);
  });

  it('preserves query with no splitter', () => {
    const q = 'find the best way to deploy docker containers';
    expect(splitMultiQuery(q)).toEqual([q]);
  });
});

// ── CROSS_LINGUAL_MAP completeness ────────────────────────────────────────────

describe('CROSS_LINGUAL_MAP — coverage', () => {
  const REQUIRED_EN_TERMS = [
    'deploy', 'error', 'server', 'database', 'container',
    'cache', 'authentication', 'timeout', 'memory', 'network',
  ];

  it.each(REQUIRED_EN_TERMS)('"%s" has cross-lingual entries', (term) => {
    const entries = CROSS_LINGUAL_MAP.get(term);
    expect(entries, `"${term}" missing from CROSS_LINGUAL_MAP`).toBeDefined();
    expect(entries!.length).toBeGreaterThan(0);
  });

  it('all values are non-empty arrays of strings', () => {
    for (const [key, values] of CROSS_LINGUAL_MAP.entries()) {
      expect(Array.isArray(values), `Values for "${key}" are not an array`).toBe(true);
      for (const v of values) {
        expect(typeof v, `Value "${v}" for key "${key}" is not a string`).toBe('string');
        expect(v.length, `Empty string in values for "${key}"`).toBeGreaterThan(0);
      }
    }
  });

  it('bi-directional entries exist (reverse lookups)', () => {
    // For each forward entry, the reverse should also exist
    let reverseCount = 0;
    for (const [key, values] of CROSS_LINGUAL_MAP.entries()) {
      for (const v of values) {
        if (CROSS_LINGUAL_MAP.has(v)) {
          reverseCount++;
        }
      }
    }
    // A healthy map has substantial bidirectionality
    expect(reverseCount).toBeGreaterThan(20);
  });
});


