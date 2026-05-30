# cachly-mcp — Progress Tracker

> Lebendiges Dokument. Hält fest **was implementiert ist** und **was offen steht**.
> Komplementär zu [STRATEGY.md](./STRATEGY.md) (das *Warum*) und
> [VISION_10X.md](./VISION_10X.md) (das *Wohin*).
>
> **Stand:** v0.10.75 · 107 MCP-Tools · 499 Tests grün · 0 Lint-Warnings

---

## 0. Schnellüberblick

| Dimension | Status |
|---|---|
| Version | `0.10.75` (npm `latest`) |
| MCP-Tools | **107** |
| Tests | **499** passing, 10 Suites |
| Lint | **0 errors, 0 warnings** |
| Build | sauber (`tsc`, Entry `dist/src/index.js`) |
| Bench | Precision@1 **+22.2 %**, MRR **+10.9 %**, nDCG@5 **+8.1 %** vs. BM25 |

---

## 1. Erledigt ✅

### Phase 2 — Beweisbar bessere Recall-Qualität (der Moat-Beweis)

| Feature | Datei | Status |
|---|---|---|
| Quality-aware Reranking (5 Faktoren) | `src/rerank.ts` | ✅ live in `smart_recall` |
| Cachly-Bench (IR-Metriken, CI-Wächter) | `src/bench/`, `src/__tests__/rerank.test.ts` | ✅ |
| Hybrides Retrieval (BM25 + Semantik) | `src/handlers/brain.ts` | ✅ eine gerankte Liste |
| CKG-Traversierung als 3. Signal (Layer 3) | `src/handlers/brain.ts` | ✅ 🕸️-Badge |
| Contradiction-Resolution persistent | `cachly:contradictions:{topic}` | ✅ TTL'd, auditierbar |
| "Brain saved you here"-Banner | `src/handlers/brain.ts` | ✅ Zeitersparnis inline |
| Knowledge-Governance (`team_confirm`) | `src/handlers/team.ts` | ✅ 🛡️/✔️ Badges, 5. Rerank-Faktor |

**5-Faktor-Rerank-Signal:** outcome × confidence × proven-ness × severity × governance
(review-level × endorsements), geklammert auf [0.5, 2.5].

### Phase 3 — Team-/Org-weiter Wissensgraph (der uneinholbare Moat)

| Feature | Tool / Datei | Version | Status |
|---|---|---|---|
| Ambient Team-Propagation (author → team) | `learn_from_attempts` | 0.10.57 | ✅ default, nicht opt-in |
| **Person-Nodes** im CKG | `ckgUpsertPersonNode`, `src/ckg.ts` | 0.10.59 | ✅ auto aus `author` |
| **File-Nodes** im CKG | `ckgUpsertFileNode`, `src/ckg.ts` | 0.10.59 | ✅ auto aus `file_paths` |
| `brain_who_knows(topic)` | `src/handlers/brain.ts` | 0.10.59 | ✅ Experten-Ranking 🥇🥈🥉 |
| Author-Badge in `smart_recall` | `src/handlers/brain.ts` | 0.10.59 | ✅ 👤 inline |
| `brain_file_map(file_paths)` | `src/handlers/brain.ts` | 0.10.60 | ✅ Experten + Lessons je Datei |
| `team_expertise_map()` | `src/handlers/brain.ts` | 0.10.60 | ✅ Skills-Matrix als Tabelle |
| **Visibility-Scopes** (`private`/`team`/`public`) | `learn_from_attempts` | 0.10.60 | ✅ private leakt nie in smart_recall |
| `brain_from_git` → Person+File-Nodes | `src/handlers/fedbrain.ts` | 0.10.61 | ✅ Zero-Setup Graph retroaktiv |
| `skill_gaps()` | `src/handlers/brain.ts` | 0.10.61 | ✅ 🔴/🟡/🔵 Blind-Spot-Report |
| `brain_coverage()` | `src/handlers/brain.ts` | 0.10.61 | ✅ 0–100 Health-Score |

### Stabilität & Hygiene

| Thema | Status |
|---|---|
| Broken npm Entry-Point (0.10.50–52) | ✅ gefixt (`dist/src/index.js`) |
| Version-Regression (52 < 56) | ✅ auf 0.10.57+ vorgezogen |
| Lint: 70 Warnings → 0 | ✅ systematisch bereinigt |
| Tool-Count-Konsistenz (80/89/95/96/98/100) | ✅ überall synchron |
| Input-Guards für Phase-3-Tools | ✅ 0.10.62 (kein Crash bei leerem topic / non-array) |
| `smart_recall` apiFetch null-guard | ✅ graceful degradation offline |
| Scan-Timeout + Cap (`scanKeys`) überall | ✅ 0.10.63 — kein Hang bei großem Keyspace |
| Git-Rename-Pfad-Normalisierung | ✅ 0.10.63 (`normalizeGitPath`) |
| `withTimeout`-Utility (graceful degradation) | ✅ 0.10.63 |
| **npm-Paket-Hygiene** | ✅ 0.10.66 — `files`-Whitelist + tsconfig-Exclude; keine Test-Mocks/Bench/fremde App mehr im Tarball (336→71 Dateien) |
| **Netzwerk-Timeouts überall** | ✅ 0.10.67 — alle fetches im Agent-Hotpath haben `AbortSignal.timeout` (Embeddings 8s, Vektor 8s, apiFetch 15s) |

### Die drei Metriken — instrumentiert (0.10.64)

| Metrik | Mechanismus | Status |
|---|---|---|
| **Time-to-first-recall** | `born_at` (erster Learn) → `first_recall_at` (erster proven Recall) | ✅ gemessen |
| **Recall-Lift** | Cachly-Bench Headline, CI-verteidigt | ✅ +22.2 % P@1 |
| **Team-Knowledge-Reuse** | Cross-Author-Recalls + distinct reuse-pairs | ✅ getrackt + inline sichtbar |
| `brain_metrics()`-Tool | zeigt alle drei in einer Ansicht | ✅ 101. Tool |

---

## 2. Offen 🔲

### Beweis (Phase-2-Rest) — der Glaubwürdigkeits-Beweis

- ✅ **Flat-File Head-to-Head im Bench** (0.10.65) — naiver, quality-blinder Ranker
  als ehrlicher Stellvertreter für "LLM liest Memory-Files". Cachly gewinnt auf den
  entscheidenden Metriken: **P@1 +10.0 %, MRR +4.4 % vs. flat-file** · CI-verteidigt.
- ✅ BENCH.md "Limitations" offen + ehrlich (warum flat-file bei P@3/Recall@3 vorn liegt).
- ✅ **Extern gelabelter Korpus (0.10.73)** — portables JSON-Format (`bench/external/`),
  `loadExternalCorpus` + `runExternalBenchmark`, `npm run bench:external`. Sample-Korpus zeigt
  **P@1 +20 %, MRR +7.7 % vs. flat-file** auf unabhängig geformtem Set. Dritte können eigene Labels einspielen.
- 🔲 Head-to-head auf **realen Agent-Traces** (nicht nur Fixture-Korpus)

### Team-Graph (Phase-3-Rest)

- ✅ **Rollen-Modell (0.10.72)** — `team_assign_role` / `team_whoami` / `team_roster`; `team_confirm` ist role-aware (admin/reviewer → senior; contributor → peer; keine Selbstbeförderung); `setup`-CLI prompts für Governance-Bootstrap (idempotent). 3 neue Tools → 105 gesamt.
- ✅ **Sichtbarkeits-Scopes auf Team-Ebene (0.10.73)** — Gruppen/Sub-Teams via
  `team_grant_scope` / `team_scopes`; `learn_from_attempts(group="...")` scopt eine Lektion;
  `smart_recall` zeigt group-scoped Lektionen nur Mitgliedern + Admins (orthogonal zu `private`).
- ✅ **Service-/System-Nodes im Graph (0.10.70)** — `learn_from_attempts(service="...", service_kind="system")`
  baut Service-Nodes; `person→operates`, `file→runs_in`, `concept→affects`-Kanten. Neues Tool
  `brain_service_map(service)` für Incident-Triage: wer betreibt X + alle bekannten Failures/Fixes (102. Tool).
- ✅ **Kollaborations-Graph (Person↔Person)** (0.10.68) — `collaborates`-Kanten aus
  geteilten Dateien; `brain_who_knows` zeigt häufige Kollaborateure des Top-Experten
  (`ckgRecordCollaboration`, gebaut in `learn_from_attempts` + `brain_from_git`)
- ✅ **Personalisiertes Recall (0.10.69)** — `smart_recall` akzeptiert `context_files`; Lektionen, die in Kontext dieser Dateien gelernt wurden, erhalten +15 % Score-Boost + `📁 context match`-Badge. 6. Rerank-Signal.

### Onboarding / Null-Reibung (Phase-1-Eintrittskarte)

- ✅ **Ein-Befehl-Setup idempotent (0.10.73)** — `init` ist jetzt zero-arg-fähig (liest gespeicherte
  Creds aus `~/.claude/mcp.json`), schreibt nur was sich ändert, meldet Laufzeit (<60s).
  `setup` bleibt der Device-Flow-Erstkontakt; `init` der schnelle idempotente Re-Config-Befehl.
- ✅ Timeouts überall im Agent-Hotpath (0.10.67): `apiFetch` (15s), alle 6
  Embedding-Provider-fetches (8s), Semantic-Search + alle Vektor-fetches in
  `cache.ts`/`context.ts`/`brain.ts`/`tco.ts` (8s). Tool blockiert den Agent-Call
  nie mehr durch hängende Netzwerk-Calls; Embedding degradiert zu keyword-only.
- ✅ **Self-Healing-Auth (0.10.71)** — `diagnoseAuth` + `planAuthHeal` (rein, getestet); near-expiry-Token
  werden automatisch in einen langlebigen API-Key getauscht (solange noch gültig); ein abgelehnter
  401-Call self-healt einmal + retried; bei totem Credential sagen `session_start` + `get_api_status`
  klar warum + wie zu fixen. Kein stilles "0 Recalls" mehr.
- ✅ Time-to-first-recall **messen** (0.10.64); auf <2 min *drücken* bleibt Onboarding-Arbeit 🔲

### Enterprise / Reichweite (Phase-3/4)

- 🔲 Self-Hosted-Tier mit SOC-2/ISO, BYOK by default
- 🔲 Öffentliche/teilbare Brains (Domänen-Wissensbasen als Marktplatz)
- 🔲 First-class-Support-Matrix je MCP-Client dokumentiert

### Bekannte kleine Schulden

- ✅ `brain_from_git`: Git-Rename-Pfade normalisiert (`normalizeGitPath`, 0.10.63).
- ✅ README Tool-Count-Drift behoben (jetzt 101, überall synchron).
- ✅ Scan-basierte Tools gegen großen Keyspace gehärtet (`scanKeys`, 0.10.63).
- 🔲 `team_expertise_map`: Tabellen-Rendering bei *sehr* vielen Domains noch
  nicht mit großem Datensatz lasttestbar (MockRedis deckt Funktionalität ab).

---

## 3. Die drei Metriken, die alles entscheiden (aus STRATEGY.md §6)

| Metrik | Ziel | Heute |
|---|---|---|
| **Time-to-first-recall** | <2 min | ✅ gemessen via `brain_metrics` (born_at → first_recall_at) |
| **Recall-Lift** (vs. BM25) | messbar >0, dann skalieren | ✅ +22.2 % P@1 (intern), in `brain_metrics` |
| **Team-Knowledge-Reuse** | Lesson von A wird von B recallt | ✅ getrackt + inline + in `brain_metrics`; externes Dashboard 🔲 |

> Alle drei sind jetzt in **einem Tool** sichtbar: `brain_metrics(instance_id)`.
> Offen bleibt nur das *externe* Dashboard (server-side) und der *externe* Bench-Beweis (W1).

---

## 4. Changelog-Verweis

Vollständige Release-Notes pro Version: [CHANGELOG.md](./CHANGELOG.md).
Letzte Releases: 0.10.59 (Phase 3A) · 0.10.60 (Phase 3B) · 0.10.61 (Phase 3C, 100 Tools) · 0.10.62 (Härtung).
