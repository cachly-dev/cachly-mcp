export interface UpgradeNudgeInput {
  used: number;
  limit: number;
}

/**
 * Builds a plain-language upgrade nudge for a free-tier user who is close to
 * or over their monthly recall limit. Returns null when there is nothing to
 * say: an unlimited or unknown limit, or usage below 80 percent.
 *
 * Deliberately carries no price and no percentage — a number that lives in
 * two places drifts apart (see RES-017: a stale German price table quoted
 * 9/29 EUR while Stripe charged 19/49).
 *
 * And no saved time: until 03.11.2026 it added "You've already saved ~Xh",
 * an estimate (30-240 min per lesson), not a count. Users see counts only
 * since #914–#916.
 */
export function upgradeNudge({ used, limit }: UpgradeNudgeInput): string | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(used)) return null;
  const ratio = used / limit;
  if (ratio < 0.8) return null;

  const remaining = Math.max(0, limit - used);
  const unit = remaining === 1 ? 'recall' : 'recalls';
  return `📈 ${remaining} ${unit} left this month on the free plan — see cachly.dev/pricing to keep going.`;
}
