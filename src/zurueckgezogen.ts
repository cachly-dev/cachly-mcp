/**
 * Zurueckgezogene Lektionen (22.11.2026).
 *
 * Ein Mensch markiert im Dashboard eine Lektion als falsch, mit Grund. Die API
 * verschiebt sie samt Vektoren und Eingaengen von `cachly:lesson:*` nach
 * `cachly:withdrawn:*` (api/internal/handler/lektion_zurueckziehen_handler.go).
 * Jeder Abrufweg liest `cachly:lesson:best:*`, also findet sie danach keiner
 * mehr, ohne dass einer davon einen eigenen Filter braucht.
 *
 * Zwei Stellen brauchen trotzdem eine Antwort:
 *
 * - `recall_best_solution(topic)`: Fragt eine KI GENAU nach dem Namen, erfaehrt
 *   sie, dass ein Mensch die Lektion zurueckgezogen hat und warum. Sonst sucht
 *   sie neu, findet denselben Irrtum und lernt ihn wieder. Ausserdem las dieser
 *   Weg den Verlauf (`cachly:lessons:<topic>`) als Ersatz, wenn best fehlt, und
 *   haette die zurueckgezogenen Versuche als "Last attempts" gezeigt.
 * - `learn_from_attempts(topic)`: Wer unter demselben Namen neu lernt, sieht den
 *   Grund der Ruecknahme, damit der Irrtum nicht still zurueckkommt.
 */

export const ZURUECKGEZOGEN_PRAEFIX = 'cachly:withdrawn:';

export interface Zurueckgezogen {
  topic?: string;
  what_worked?: string;
  outcome?: string;
  zurueckgezogen_am?: string;
  zurueckgezogen_grund?: string;
  visibility?: string;
  group?: unknown;
}

/** Liest die zurueckgezogene Fassung eines Themas, falls es eine gibt. */
export async function leseZurueckgezogen(
  redis: { get(k: string): Promise<string | null> },
  topic: string,
): Promise<Zurueckgezogen | null> {
  const roh = await redis.get(`${ZURUECKGEZOGEN_PRAEFIX}best:${topic}`).catch(() => null);
  if (!roh) return null;
  try {
    const z = JSON.parse(roh) as unknown;
    return z && typeof z === 'object' && !Array.isArray(z) ? (z as Zurueckgezogen) : null;
  } catch {
    return null;
  }
}

function tag(ts?: string): string {
  if (!ts) return 'an unknown date';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/** Antwort auf recall_best_solution(topic) fuer ein zurueckgezogenes Thema. */
export function ruecknahmeHinweis(topic: string, z: Zurueckgezogen): string {
  const grund = (z.zurueckgezogen_grund ?? '').trim();
  const alt = (z.what_worked ?? '').trim();
  const zeilen = [
    `⛔ \`${topic}\` was withdrawn by a person on ${tag(z.zurueckgezogen_am)}${grund ? `: "${grund}"` : '.'}`,
    '',
    'Do not apply it.',
  ];
  if (alt) zeilen.push(`It said (marked wrong): ${alt.slice(0, 300)}${alt.length > 300 ? ' …' : ''}`);
  zeilen.push('', `If you know what is right now: \`learn_from_attempts(topic="${topic}", …)\`.`);
  return zeilen.join('\n');
}

/** Zusatzzeile fuer learn_from_attempts unter einem zurueckgezogenen Namen. */
export function ruecknahmeWarnung(z: Zurueckgezogen): string {
  const grund = (z.zurueckgezogen_grund ?? '').trim();
  return `⚠️ A person withdrew an earlier lesson under this name on ${tag(z.zurueckgezogen_am)}${grund ? `: "${grund}"` : ''}. Make sure the new one doesn't repeat it.`;
}
