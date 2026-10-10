/**
 * Commit-Art: wie cachly eine Commit-Betreffzeile einteilt.
 *
 * Eine Quelle fuer zwei Stellen, die vorher eigene Regeln hatten:
 *   - brain_from_git (handlers/fedbrain.ts) legt daraus Lektionen an,
 *   - der CLI-Befehl `demo` (index.ts) zeigt, was brain_from_git anlegen wuerde.
 *
 * Bis Oktober 2026 stand in `demo` eine eigene, aeltere Fassung mit dem
 * Kommentar "same logic as brain_from_git". Sie war es nicht: andere
 * Reihenfolge (perf vor refactor), keine Kategorie `test`, kein `fixes` und
 * kein `closes #12`. Die Vorschau zaehlte also anders als der Lauf, den sie
 * ankuendigte. Jetzt gibt es nur noch diese Regeln.
 *
 * Die Webseite (web/lib/repo-roentgen.ts) kann dieses Paket nicht importieren
 * und fuehrt eine Abschrift. Dass beide gleich bleiben, prueft
 * web/lib/__tests__/repo-roentgen-gleich-mcp.test.ts gegen DIESE Datei und die
 * gemeinsamen Faelle in src/__tests__/commit-art-faelle.json.
 */

export type CommitArt = 'fix' | 'feat' | 'refactor' | 'perf' | 'security' | 'deploy' | 'test' | 'chore';
export type CommitSchwere = 'critical' | 'major' | 'minor';

export interface CommitEinteilung {
  category: CommitArt;
  outcome: 'success' | 'failure' | 'partial';
  severity: CommitSchwere;
}

/** Teilt eine Betreffzeile ein. Reihenfolge der Regeln ist Teil der Regel. */
export function classifyCommit(subject: string): CommitEinteilung {
  const s = subject.toLowerCase();
  if (/\b(fix|fixed|fixes|bug|hotfix|patch|revert|resolve|closes? #\d+)\b/.test(s)) {
    const sev: CommitSchwere = /\b(critical|crash|security|auth|data loss|outage|prod|production)\b/.test(s)
      ? 'critical'
      : /\b(major|breaking|regression|hotfix)\b/.test(s)
        ? 'major'
        : 'minor';
    return { category: 'fix', outcome: 'success', severity: sev };
  }
  if (/\b(feat|feature|add|added|implement|new|introduce)\b/.test(s)) return { category: 'feat', outcome: 'success', severity: 'minor' };
  if (/\b(refactor|clean|cleanup|improve|simplify|extract|rename)\b/.test(s)) return { category: 'refactor', outcome: 'success', severity: 'minor' };
  if (/\b(perf|optimize|speed|cache|latency|memory|performance)\b/.test(s)) return { category: 'perf', outcome: 'success', severity: 'major' };
  if (/\b(security|cve|auth|csrf|xss|sql|injection|sanitize|escape|encrypt)\b/.test(s)) return { category: 'security', outcome: 'success', severity: 'critical' };
  if (/\b(deploy|ci|cd|build|docker|k8s|helm|infra|devops)\b/.test(s)) return { category: 'deploy', outcome: 'success', severity: 'major' };
  if (/\b(test|spec|coverage|assert|mock|unit|integration)\b/.test(s)) return { category: 'test', outcome: 'success', severity: 'minor' };
  return { category: 'chore', outcome: 'success', severity: 'minor' };
}

/** Nur die Kategorie — die Form, in der `demo` und die Webseite sie brauchen. */
export function commitArt(subject: string): CommitArt {
  return classifyCommit(subject).category;
}

/** Thema-Schluessel aus der Betreffzeile (die ersten drei Woerter mit mehr als drei Zeichen). */
export function extractDomain(subject: string): string {
  const s = subject.toLowerCase();
  const tokens = s
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !['that', 'this', 'with', 'from', 'when', 'into', 'also', 'some', 'were'].includes(t));
  return tokens.slice(0, 3).join('-') || 'general';
}

/** Der Topic, unter dem brain_from_git die Lektion ablegt: `kategorie:thema`. */
export function lektionsThema(subject: string): string {
  return `${commitArt(subject)}:${extractDomain(subject)}`;
}

/**
 * Wie viele Lektionen brain_from_git aus diesen Betreffzeilen in einem LEEREN
 * Brain anlegt. Der Handler schreibt je Topic nur einmal
 * (`cachly:lesson:best:<topic>` wird nur gesetzt, wenn es fehlt) und ueberspringt
 * leere Betreffzeilen. Gleiche Themen zaehlen also einmal.
 */
export function zaehleLektionen(subjects: readonly string[]): number {
  const themen = new Set<string>();
  for (const s of subjects) {
    if (!s) continue;
    themen.add(lektionsThema(s));
  }
  return themen.size;
}

/** Rueckbau: die Betreffzeile beginnt mit "Revert" (so schreibt sie `git revert`). */
export function istRueckbau(subject: string): boolean {
  return /^\s*["']?revert\b/i.test(subject);
}
