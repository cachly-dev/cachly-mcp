/**
 * The Aha-moment of the first minute (GROW-013): a new user must see the
 * Brain recall something real from their OWN repo, not just a lesson count.
 * Both functions are pure — no I/O, no network, no state — so setup/autopilot
 * can call them without risking the 3s onboarding budget.
 */

/**
 * Finds the "Proof — your first recall already works" block inside a
 * `brain_from_git` result text and returns it verbatim (the block runs from
 * the matching line up to the next blank line). Returns `null` when the text
 * carries no such block — never invents a proof.
 */
export function extractFirstRecallProof(text: string): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  const startIdx = lines.findIndex((line) => /first recall already works/i.test(line));
  if (startIdx === -1) return null;
  const block: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (i > startIdx && lines[i]!.trim() === '') break;
    block.push(lines[i]!);
  }
  const joined = block.join('\n').trim();
  return joined || null;
}

/**
 * Renders the first-recall proof for the seed path: a real recall hit
 * against the just-seeded starter corpus, shown as evidence instead of a
 * bare "seeded ✓".
 */
export function renderFirstRecallProof(topic: string, what: string): string {
  const snippet = what.trim();
  return [
    '🎯 Proof — your first recall already works.',
    `   Top hit: ${topic} — ${snippet}`,
  ].join('\n');
}

/**
 * Pulls topic + preview snippet out of a `smart_recall` result's top hit
 * (format: `**💡 <topic>** ... \n> <preview>`). Returns `null` on any
 * mismatch — the seed-path proof is a bonus, never invented.
 *
 * Die Vorschau wird ERST NACH dem Thema gesucht. Bis 0.10.225 nahm die Suche
 * die erste Zeile mit `> ` im ganzen Text — seit dem Belegsatz
 * (`> 📊 3 of 6 backed by evidence …`) steht der VOR dem ersten Treffer, und
 * `setup` druckte ihn als Inhalt der Lektion (gesehen 03.11.2026).
 */
export function extractTopHit(text: string): { topic: string; what: string } | null {
  if (!text) return null;
  const topicMatch = /\*\*💡\s+([^*]+)\*\*/.exec(text);
  if (!topicMatch) return null;
  const rest = text.slice(topicMatch.index + topicMatch[0].length);
  const whatMatch = /^>\s+(.+)$/m.exec(rest);
  if (!whatMatch) return null;
  const topic = topicMatch[1]!.trim();
  const what = whatMatch[1]!.trim();
  if (!topic || !what) return null;
  return { topic, what };
}

/**
 * Markdown fuer das Terminal entschaerfen: `**fett**` und `` `code` `` stehen
 * dort als nackte Sternchen und Striche. Die Werkzeugantworten sind fuer die
 * KI geschrieben (Markdown), `setup` zeigt sie einem Menschen im Terminal.
 */
export function fuersTerminal(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '');
}
