export interface UpgradeNudgeInput {
  used: number;
  limit: number;
  savedMins: number;
}

/**
 * Builds a plain-language upgrade nudge for a free-tier user who is close to
 * or over their monthly recall limit. Returns null when there is nothing to
 * say: an unlimited or unknown limit, or usage below 80 percent.
 *
 * Deliberately carries no price and no percentage — a number that lives in
 * two places drifts apart (see RES-017: a stale German price table quoted
 * 9/29 EUR while Stripe charged 19/49).
 */
export function upgradeNudge({ used, limit, savedMins }: UpgradeNudgeInput): string | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(used)) return null;
  const ratio = used / limit;
  if (ratio < 0.8) return null;

  const remaining = Math.max(0, limit - used);
  const unit = remaining === 1 ? 'recall' : 'recalls';
  let text = `📈 ${remaining} ${unit} left this month on the free plan — see cachly.dev/pricing to keep going.`;

  if (Number.isFinite(savedMins) && savedMins >= 60) {
    const h = Math.floor(savedMins / 60);
    const m = Math.round(savedMins % 60);
    const timeStr = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
    text += ` You've already saved ~${timeStr} with Brain — keep that going.`;
  }

  return text;
}
