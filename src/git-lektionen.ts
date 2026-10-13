// Git-Lektionen — wie aus `git log` Lektionen werden.
//
// EINE Quelle fuer zwei Wege (14.10.2026):
//   - brain_from_git (handlers/fedbrain.ts) schreibt sie direkt ins Brain,
//   - der Start-Import des SessionStart-Hooks (startwissen-hook.ts) schickt sie
//     ueber POST /learn: das Hook-Buendel hat keine Valkey-Verbindung.
//
// Nur reine Funktionen ohne Paket-Abhaengigkeiten — das Hook-Buendel
// (scripts/plugin-hooks-schreiben.mjs) zieht diese Datei mit.

import { normalizeGitPath } from './utils.js';
import { classifyCommit, extractDomain, type CommitArt, type CommitSchwere } from './commit-art.js';
import { fuerEigenenSpeicher, markiert } from './schreibtor.js';

/** Hoechstens so viele Dateien je Commit landen in der Lektion. */
export const DATEIEN_JE_COMMIT = 12;

/** Die Argumente fuer `git log`, ohne Shell: revRange und since bleiben je EIN Argument. */
export function gitLogArgumente(revRange: string, maxCommits: number, since = ''): string[] {
  return [
    'log', revRange,
    ...(since ? [`--since=${since}`] : []),
    '--pretty=format:COMMIT|||%H|||%s|||%ad|||%an', '--date=short', '--no-merges', '--name-only',
    '-n', String(maxCommits),
  ];
}

export interface GitCommit {
  sha: string;
  subject: string;
  date: string;
  author: string;
  files: string[];
}

/** Liest die Ausgabe von `git log` (gitLogArgumente): je Commit eine Kopfzeile, dann die Dateien. */
export function leseCommits(ausgabe: string): GitCommit[] {
  const commits: GitCommit[] = [];
  let current: GitCommit | null = null;
  for (const raw of ausgabe.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('COMMIT|||')) {
      if (current) commits.push(current);
      const [, sha, subject, date, author] = line.split('|||');
      current = { sha: (sha ?? '').trim(), subject: (subject ?? '').trim(), date: (date ?? '').trim(), author: (author ?? '').trim(), files: [] };
    } else if (line && current) {
      const norm = normalizeGitPath(line);
      if (norm) current.files.push(norm);
    }
  }
  if (current) commits.push(current);
  return commits;
}

/** Die Felder einer Lektion aus einem Commit — ohne Speicher-Beiwerk (ts, confidence, audit_trail). */
export interface GitLektion {
  topic: string;
  category: CommitArt;
  outcome: 'success' | 'failure' | 'partial';
  severity: CommitSchwere;
  what_worked: string;
  what_failed: string;
  context: string;
  author: string | undefined;
  file_paths: string[];
  commands: string[];
  tags: string[];
}

export interface GitCommitGeprueft {
  /** Der Commit nach dem Schreibtor: Geheimnisse geschwaerzt, Dateien auf DATEIEN_JE_COMMIT gekuerzt. */
  commit: GitCommit;
  geschwaerzt: boolean;
  verdacht: boolean;
  /** null = leerer Betreff, keine Lektion. */
  lektion: GitLektion | null;
}

/**
 * Ein Commit als Lektion. Betreffs und Dateinamen stammen aus einem Repo, das
 * auch fremde Pull-Requests enthaelt: Geheimnisse schwaerzen, Verdacht
 * markieren (schreibtor.ts).
 */
export function commitAlsLektion(roh: GitCommit): GitCommitGeprueft {
  const tor = fuerEigenenSpeicher({ subject: roh.subject, author: roh.author, files: roh.files.slice(0, DATEIEN_JE_COMMIT) });
  const commit: GitCommit = { ...roh, ...tor.felder };
  const geprueft = { commit, geschwaerzt: tor.geschwaerzt.length > 0, verdacht: tor.verdacht.length > 0 };
  if (!commit.subject) return { ...geprueft, lektion: null };

  const { category, outcome, severity } = classifyCommit(commit.subject);
  const sha8 = commit.sha.slice(0, 8);
  return {
    ...geprueft,
    lektion: {
      topic: `${category}:${extractDomain(commit.subject)}`,
      category,
      outcome,
      severity,
      what_worked: commit.subject.slice(0, 200),
      what_failed: '',
      context: `git:${sha8} by ${commit.author} on ${commit.date}`,
      author: commit.author || undefined,
      file_paths: commit.files.filter((f) => f.length > 0).slice(0, DATEIEN_JE_COMMIT),
      commands: [`git show ${sha8}`],
      tags: markiert(['brain_from_git', category, 'git-history'], tor.verdacht),
    },
  };
}

/**
 * Je Thema eine Lektion, die neueste zuerst — so wie brain_from_git in ein
 * leeres Brain schreibt (`lesson:best:<topic>` nur, wenn es fehlt; `git log`
 * liefert den neuesten Commit zuerst).
 */
export function lektionenJeThema(commits: readonly GitCommit[]): GitLektion[] {
  const je = new Map<string, GitLektion>();
  for (const c of commits) {
    const { lektion } = commitAlsLektion(c);
    if (lektion && !je.has(lektion.topic)) je.set(lektion.topic, lektion);
  }
  return [...je.values()];
}
