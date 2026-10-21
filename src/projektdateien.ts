/**
 * Marker um den Block, den `init`, `setup` und `autopilot` in die
 * Anweisungsdateien schreiben. Dieses Modul ist die eine Quelle fuer den
 * Schreiber (index.ts) und den Rueckbau (uninstall.ts): Marker, Pfade und
 * Erkennungsmuster stehen nur hier.
 */
export const CLAUDE_MD_MARKER_START = '<!-- cachly-brain-start -->';
export const CLAUDE_MD_MARKER_END   = '<!-- cachly-brain-end -->';

/**
 * Das Erkennungsmuster fuer einen Anweisungsblock: vom Start- bis zum
 * Endmarker, kleinster Treffer. `[\s\S]` muss seine Rueckstriche behalten, sonst
 * wird daraus im Template-Literal `[sS]` und das Ersetzen laeuft still ins Leere.
 */
export function blockMuster(flags = ''): RegExp {
  return new RegExp(`${CLAUDE_MD_MARKER_START}[\\s\\S]*?${CLAUDE_MD_MARKER_END}`, flags);
}

/**
 * Cursor loads rules from .cursor/rules/*.mdc with YAML frontmatter. alwaysApply
 * makes the block active in every request (the closest Cursor gets to a
 * SessionStart briefing). The frontmatter sits OUTSIDE the brain markers so
 * idempotent marker-replacement leaves it intact.
 */
export const CURSOR_MDC_FRONTMATTER =
  '---\n' +
  'description: Cachly AI Brain — persistent memory protocol (recall before tasks, learn after fixes)\n' +
  'alwaysApply: true\n' +
  '---\n\n';

/** Die MCP-Konfigurationsdatei je Editor, relativ zum Projekt. */
export const EDITOR_FILES: Record<string, string> = {
  claude:   '.mcp.json',
  cursor:   '.cursor/mcp.json',
  windsurf: '.windsurf/mcp.json',
  copilot:  '.vscode/mcp.json',
  continue: '.continue/config.json',
  cline:    '.vscode/mcp.json',              // Cline respects VS Code project MCP config
  zed:      '.zed/settings.json',            // Zed project-level context_servers
};

export interface AnweisungsDatei {
  /** Pfad im Projekt, in Teilen. */
  pfad: readonly string[];
  /** Wird nur geschrieben, wenn die Datei neu entsteht (Cursor .mdc braucht es). */
  prefix?: string;
  /** Nur in Projekten mit `.idea/`. */
  nurMitIdea?: boolean;
  /**
   * Nur schreiben, wenn einer dieser Ordner da ist: im Projekt (`projekt`)
   * oder im Heimordner (`heim`). So bekommt nicht jedes Projekt eine
   * GEMINI.md, nur eines, in dem Gemini CLI benutzt wird.
   */
  nurMit?: { projekt?: readonly string[]; heim?: readonly string[] };
}

export type BlockErgebnis = 'written' | 'updated' | 'appended';

/** Ergebnis je Datei: geschrieben oder ein gemeldeter Fehler samt Grund. */
export type SchreibErgebnis = BlockErgebnis | `failed:${string}`;

/** Soll diese Anweisungsdatei in diesem Projekt entstehen? */
export function sollSchreiben(d: AnweisungsDatei, projekt: string, heim: string, gibtEs: (pfad: string) => boolean, verbinde: (...teile: string[]) => string): boolean {
  if (d.nurMitIdea && !gibtEs(verbinde(projekt, '.idea'))) return false;
  if (d.nurMit) {
    const imProjekt = (d.nurMit.projekt ?? []).some((o) => gibtEs(verbinde(projekt, o)));
    const imHeim = (d.nurMit.heim ?? []).some((o) => gibtEs(verbinde(heim, o)));
    if (!imProjekt && !imHeim) return false;
  }
  return true;
}

/**
 * Setzt einen Anweisungsblock (mit Markern) in eine Datei, ohne fremden Text
 * anzufassen: vorhandenen Block ersetzen, sonst anhaengen, sonst Datei neu
 * anlegen (`prefix` nur dann, z. B. Cursor-Frontmatter).
 *
 * Eine Funktion fuer `init`/`setup`/`autopilot` (index.ts) UND das Werkzeug
 * `setup_ai_memory` (handlers/team.ts). Letzteres schrieb bis 0.10.203 die
 * Datei einfach neu — eine vorhandene CLAUDE.md war danach weg (16.10.2026).
 */
export async function setzeAnweisungsblock(datei: string, block: string, prefix?: string): Promise<BlockErgebnis> {
  const { writeFile, appendFile, readFile, mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  await mkdir(dirname(datei), { recursive: true });
  if (existsSync(datei)) {
    const vorhanden = await readFile(datei, 'utf-8');
    if (vorhanden.includes(CLAUDE_MD_MARKER_START)) {
      // Funktion als Ersatz: ein "$" im Block (z. B. "$PATH") bleibt woertlich.
      await writeFile(datei, vorhanden.replace(blockMuster(), () => block), 'utf-8');
      return 'updated';
    }
    await appendFile(datei, '\n' + block + '\n', 'utf-8');
    return 'appended';
  }
  await writeFile(datei, (prefix ?? '') + block + '\n', 'utf-8');
  return 'written';
}

/** Alle Dateien, in die der Anweisungsblock geschrieben wird. */
export const ANWEISUNGS_DATEIEN: readonly AnweisungsDatei[] = [
  { pfad: ['CLAUDE.md'] },
  { pfad: ['AGENTS.md'] },
  { pfad: ['.github', 'copilot-instructions.md'] },
  { pfad: ['.cursor', 'rules', 'cachly.mdc'], prefix: CURSOR_MDC_FRONTMATTER },
  { pfad: ['.windsurfrules'] },
  { pfad: ['.clinerules'] },
  { pfad: ['.aiassistant', 'rules', 'cachly.md'], nurMitIdea: true },
  // Gemini CLI liest GEMINI.md (nicht AGENTS.md); nur dort, wo Gemini benutzt wird.
  { pfad: ['GEMINI.md'], nurMit: { projekt: ['.gemini'], heim: ['.gemini'] } },
  // JetBrains Junie liest .junie/guidelines.md; nur wo das Plugin .junie/ angelegt hat.
  { pfad: ['.junie', 'guidelines.md'], nurMit: { projekt: ['.junie'] } },
];

/** Der Pflichtblock fuer alle Anweisungsdateien — die EINZIGE Quelle (init, autopilot, setup_ai_memory). */
export function buildClaudeMdBlock(instanceId: string): string {
  return `${CLAUDE_MD_MARKER_START}
## Cachly AI Brain — Always Active

The Brain MCP server runs automatically. Instance: \`${instanceId}\`

---

### AT THE START of every new conversation (mandatory — first thing, before anything else):
\`\`\`
session_start(instance_id="${instanceId}", workspace_path="<absolute path to this project>", focus="<first topic the user mentioned>")
\`\`\`
Show the full briefing output to the user. If the response says the brain is empty or has 0 lessons, immediately seed it:
\`\`\`
brain_from_git(instance_id="${instanceId}", repo_path="<workspace_path>", limit=100)
\`\`\`
Then tell the user: "Your brain just learned from your git history. You're now pre-briefed."

### BEFORE every task (mandatory — no exceptions):
\`\`\`
smart_recall(instance_id="${instanceId}", query="<what you are about to do>")
\`\`\`
If relevant lessons are found, say: "Your brain knows this pattern — [lesson]." Then proceed.

### BEFORE editing any file (mandatory):
\`\`\`
remember_context(instance_id="${instanceId}", key="wip:<filename>", content="EDITING: <file:line> — <goal>", ttl=86400)
\`\`\`
When done: update content to \`"DONE: <file> — <summary>"\`.

### AFTER every fix, deploy, or discovery (mandatory):
\`\`\`
learn_from_attempts(instance_id="${instanceId}", topic="<category:keyword>", outcome="success"|"failure",
  what_worked="...", what_failed="...", severity="critical"|"major"|"minor",
  file_paths=["..."], commands=["..."], tags=["..."])
\`\`\`

### AT THE END of every conversation (mandatory):
\`\`\`
session_end(instance_id="${instanceId}", summary="<one sentence: what was done>", files_changed=["..."])
\`\`\`

### WHEN debugging any error (mandatory before grepping/reading files):
\`\`\`
causal_trace(instance_id="${instanceId}", problem="<exact error or symptom>")
\`\`\`
If a known fix exists in the Brain, use it directly. Skip research if Brain has the answer.

### BEFORE any risky operation (deploy, migration, dependency upgrade):
\`\`\`
brain_predict(instance_id="${instanceId}", context="<what you are about to do>")
\`\`\`
Report predicted failure risks to the user before proceeding.

### Half-finished code rule:
Never commit code that does not compile. Run \`tsc --noEmit\` / \`go build ./...\` before every commit.
${CLAUDE_MD_MARKER_END}`;
}
