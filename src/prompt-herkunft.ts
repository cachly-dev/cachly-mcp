/**
 * Was in einer Eingabe vom Menschen stammt — und was der Editor selbst einschiebt.
 *
 * ── Anlass (18.11.2026) ─────────────────────────────────────────────────────
 *
 * Claude Code legt die Meldung einer fertigen Hintergrundaufgabe als eigene
 * Eingabe ab (`origin.kind: task-notification`) und ruft dafuer den Hook
 * UserPromptSubmit. Der Text ist reines Markup:
 *
 *     <task-notification>
 *     <task-id>biqjh9p72</task-id> ... <status>completed</status>
 *     <summary>Background command "..." completed (exit code 0)</summary>
 *     </task-notification>
 *
 * Die Einblendung suchte damit Lektionen. In einer Sitzung am 18.11.2026 kamen
 * so bei jeder Meldung drei Lektionen ohne Bezug in den Kontext (Kanzlei-Zugang,
 * Teamrechte, Git-Absender), mit Trefferwert bis 0,89. Das kostet je Meldung
 * rund 120 Token, lenkt das Modell ab und verfaelscht Lernarm und Zaehler.
 *
 * ── Die Regel ───────────────────────────────────────────────────────────────
 *
 * Vollstaendige Bloecke der Editor-Markups unten fallen weg. Bleibt Text
 * uebrig, ist er die Frage. Bleibt nichts, gibt es nichts zu suchen.
 *
 * Bewusst NICHT entfernt:
 *   - Schraegstrich-Befehle (`<command-name>`, `<command-args>`): Die Argumente
 *     tippt der Mensch, sie beschreiben die Aufgabe.
 *   - Ein Tag ohne schliessendes Gegenstueck: Dann schreibt jemand UEBER das
 *     Markup, und der Satz bleibt stehen.
 */

const EDITOR_BLOECKE = [
  'task-notification',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'system-reminder',
] as const;

const BLOCK_RE = new RegExp(
  `<(${EDITOR_BLOECKE.join('|')})>[\\s\\S]*?</\\1>`,
  'g',
);

/** Die Frage hinter einer Eingabe: ohne Editor-Bloecke, getrimmt; '' wenn nichts bleibt. */
export function frageAusPrompt(prompt: string): string {
  return String(prompt ?? '').replace(BLOCK_RE, ' ').trim();
}
