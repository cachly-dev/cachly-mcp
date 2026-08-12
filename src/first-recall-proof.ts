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
    `   Top hit: **${topic}** — ${snippet}`,
  ].join('\n');
}
