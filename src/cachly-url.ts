const CACHLY_ORIGIN = 'https://cachly.dev';

/**
 * Closed vocabulary for the `utm_source` tag on every cachly.dev link. A
 * value here must name the actual place the click starts, never a guessed
 * command — an entry point that is not on this list fails at the typecheck,
 * not months later in Plausible.
 */
export type UrlQuelle =
  /** `cachly setup` / `cachly autosetup` — the interactive onboarding wizard. */
  | 'setup'
  /** `cachly autopilot` — the same wizard, fully automatic, no prompts. */
  | 'autopilot'
  /** `cachly demo` — the zero-signup preview built from local git history. */
  | 'demo'
  /** `cachly health` — the quick inline credential/instance check. */
  | 'health'
  /** `cachly doctor` — the longer, step-by-step setup diagnosis. */
  | 'doctor'
  /** `cachly digest` — the weekly git-history summary. */
  | 'digest'
  /** `cachly invite` — the user's personal referral link. */
  | 'invite'
  /** `cachly join <token>` — redeeming a team invite. */
  | 'join'
  /** `cachly bench` — the recall-quality benchmark. */
  | 'bench'
  /** `cachly init` — manual config without the wizard. */
  | 'init'
  /** `cachly badge` — the embeddable README/lesson-count badge. */
  | 'badge'
  /** `cachly publish` — a public, importable Brain snapshot. */
  | 'publish'
  /** `cachly share` — the ASCII stats card + tweet text. */
  | 'share'
  /** A tier/feature-gate nudge — triggered by a limit, not by a command. */
  | 'upgrade'
  /** The `brain_briefing` tool's proactive risk warning. */
  | 'briefing'
  /** The `get_api_status` tool's inline diagnostic. */
  | 'api-status'
  /** Any tool call whose background instance turns out unreachable. */
  | 'instance-error'
  /** The silent device-flow sign-in a tool call starts when no JWT is set. */
  | 'ambient-signin'
  /** The shared, pure credential diagnosis in auth.ts, reused by many callers. */
  | 'auth-diagnosis'
  /** The zero-args welcome banner shown to a human with no credentials. */
  | 'first-run'
  /** The startup warning that an existing token is expired or expiring soon. */
  | 'jwt-expiry'
  /** The docs link inside the `cache_stats` tool's ROI report. */
  | 'cache-stats'
  /** The `brain_share` tool — publish a share-id snapshot. */
  | 'brain-share'
  /** The `brain_discover` tool — browse public Brains. */
  | 'brain-discover'
  /** The footer link in a generated README / editor-instructions file. */
  | 'team-readme';

/**
 * Builds a cachly.dev URL that carries a `utm_source` tag naming the place
 * the click came from, so Plausible can group clicks instead of showing
 * every visit as "direct".
 *
 * Pure: no network, no filesystem, no environment access. Existing query
 * parts in `path` are preserved; an existing `utm_source` is replaced, never
 * duplicated. `path` may include a path segment such as an instance ID —
 * `source` must never be anything but a value from {@link UrlQuelle}.
 */
export function cachlyUrl(path: string, source: UrlQuelle): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const questionMark = withSlash.indexOf('?');
  const pathPart = questionMark === -1 ? withSlash : withSlash.slice(0, questionMark);
  const queryPart = questionMark === -1 ? '' : withSlash.slice(questionMark + 1);
  const params = new URLSearchParams(queryPart);
  params.set('utm_source', source);
  return `${CACHLY_ORIGIN}${pathPart}?${params.toString()}`;
}
