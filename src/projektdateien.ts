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
];
