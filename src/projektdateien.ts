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

export type BlockErgebnis = 'written' | 'updated' | 'appended';

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
];
