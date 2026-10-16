/**
 * Ein brain_watch-Block, wie ihn 0.10.205 und frueher mit `api_key` in
 * .git/hooks/post-commit schrieben — mit dem Schluessel im Klartext. Fester
 * Altbestand fuer Tests (Aufraeumen in brain_watch, Rueckbau in uninstall);
 * erzeugt aus dem alten buildBrainWatchHook('inst-alt', 'cky_live_geheim').
 */
export const ALTER_BRAIN_WATCH_BLOCK = String.raw`#!/bin/sh
# cachly brain_watch — Auto-Learn v1
# Silently teaches your Brain after every commit — no manual brain_from_git needed.
CACHLY_JWT="cky_live_geheim"
_BW_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
_BW_MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | cut -c1-200)
_BW_FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\n' '\t' | sed 's/\t$//')
(curl -s -o /dev/null -m 8 \
  -X POST "https://api.cachly.dev/api/v1/instances/inst-alt/learn" \
  -H "Authorization: Bearer ${'$'}{CACHLY_JWT}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"message\":\"x\",\"sha\":\"$_BW_SHA\",\"source\":\"brain_watch\"}" \
) 2>/dev/null &
exit 0`;
