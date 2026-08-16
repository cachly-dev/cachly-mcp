/**
 * lesson-preview — one place that decides how a lesson is shown in a briefing.
 *
 * WHY THIS EXISTS (measured 2026-08-16, real incident):
 * A session briefing showed this lesson line:
 *
 *   ✅🔴 `node4:einrichtung-contabo-und-fallen` — node-4 (Contabo, 169.58.175.157,
 *   Lauterbourg FR, 12 Kerne / 48 GB / 400 GB, 25,29 EUR/Monat) eingeri
 *
 * The reader needed one thing from that lesson: the WireGuard address of the
 * machine. It sits at character 323 of `what_worked`. The preview cut at 100.
 * Worse, the lesson's `what_failed` field held the literal sentence "always read
 * `wg show wg0 allowed-ips`" — and no briefing surface renders `what_failed` for
 * a lesson whose outcome is "success". The lesson was displayed, at the right
 * moment, and the exact mistake it warns about happened anyway.
 *
 * The fix is not "show more prose". The two most actionable fields of that
 * lesson were already short and structured:
 *
 *   commands:   ["wg show wg0 allowed-ips", "ssh -i ~/.ssh/... -p 2222 root@..."]
 *   file_paths: ["/etc/wireguard/wg0.conf", ...]
 *
 * ~15 tokens that answer the question, thrown away in favour of 100 characters
 * of preamble. So a preview renders three things now: trimmed prose, a facts
 * tail drawn from the structured fields, and — for critical lessons — the
 * warning, regardless of outcome.
 *
 * This helps the EXISTING corpus. A writing rule ("put the fact first") only
 * improves lessons written after it; reading structured fields improves every
 * lesson ever stored.
 */

export interface PreviewLesson {
  topic: string;
  outcome?: string;
  severity?: string;
  what_worked?: string;
  what_failed?: string;
  commands?: string[];
  file_paths?: string[];
}

export interface PreviewOptions {
  /** Prose budget for what_worked. Default 100 — the historical briefing value. */
  maxChars?: number;
  /** Render the commands/paths tail. Default true. */
  facts?: boolean;
  /** Render the warning line for critical lessons. Default true. */
  warning?: boolean;
  /** How many commands + paths to show. Default 2 each. */
  maxFacts?: number;
  /** Per-fact character cap. Default 64. */
  factChars?: number;
  /** Character cap for the warning line. Default 110. */
  warningChars?: number;
  /** Indent for continuation lines. Default 5 spaces (matches briefing lists). */
  indent?: string;
}

const DEFAULTS = {
  maxChars: 100,
  facts: true,
  warning: true,
  maxFacts: 2,
  factChars: 64,
  warningChars: 110,
  indent: '     ',
} as const;

/** Collapse whitespace so a multi-line field cannot break list layout. */
function flat(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Cut to `max` characters, preferring a word boundary, and mark the cut.
 * The marker matters: without it a truncated line reads like a complete one,
 * and the reader never learns there is more to fetch.
 */
export function trimTo(text: string, max: number): string {
  const s = flat(text);
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const hard = s.slice(0, max);
  const space = hard.lastIndexOf(' ');
  // Only honour the word boundary if it does not throw away most of the budget.
  const body = space > max * 0.6 ? hard.slice(0, space) : hard;
  return `${body.replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * Facts worth showing even when the prose is cut: commands first (they are
 * directly runnable), then file paths. Deduplicated, order preserved.
 */
export function factsOf(l: PreviewLesson, maxFacts: number, factChars: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (raw: unknown, prefix: string, limit: number) => {
    let n = 0;
    for (const item of Array.isArray(raw) ? raw : []) {
      if (n >= limit) break;
      const v = flat(item);
      if (!v) continue;
      const key = `${prefix}${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${prefix}${trimTo(v, factChars)}`);
      n++;
    }
  };
  take(l.commands, '⌘ ', maxFacts);
  take(l.file_paths, '▸ ', maxFacts);
  return out;
}

/**
 * The warning is the single most fear-inducing, mistake-preventing part of a
 * lesson — and it was invisible whenever `outcome` was "success". Show it for
 * critical lessons no matter how the lesson ended.
 */
export function warningOf(l: PreviewLesson, max: number): string | null {
  const w = flat(l.what_failed);
  if (!w) return null;
  const isCritical = String(l.severity ?? '').toLowerCase() === 'critical';
  const failed = l.outcome === 'failure' || l.outcome === 'partial';
  if (!isCritical && !failed) return null;
  return trimTo(w, max);
}

/**
 * Render the body of one briefing entry: prose, then facts, then warning.
 * Returns lines WITHOUT the caller's bullet/emoji prefix — the caller owns the
 * first line's prefix, this owns everything after the em dash.
 */
export function lessonPreviewLines(l: PreviewLesson, opts: PreviewOptions = {}): string[] {
  const o = { ...DEFAULTS, ...opts };
  const lines: string[] = [];

  const prose = trimTo(l.what_worked ?? '', o.maxChars);
  if (prose) lines.push(prose);

  if (o.warning) {
    const w = warningOf(l, o.warningChars);
    if (w) lines.push(`${o.indent}⚠️ ${w}`);
  }

  if (o.facts) {
    const f = factsOf(l, o.maxFacts, o.factChars);
    // One line, not one per fact: a briefing lists many lessons, and a
    // four-line block per lesson would push the interesting ones off screen.
    if (f.length) lines.push(`${o.indent}${f.join('  ')}`);
  }

  return lines;
}

/** Convenience: the same content as a single newline-joined string. */
export function lessonPreview(l: PreviewLesson, opts: PreviewOptions = {}): string {
  return lessonPreviewLines(l, opts).join('\n');
}
