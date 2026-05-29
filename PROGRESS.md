# cachly-mcp — Progress Tracker

> Lebendiges Dokument. Hält fest **was implementiert ist** und **was offen steht**.
> Komplementär zu [STRATEGY.md](./STRATEGY.md) (das *Warum*) und
> [VISION_10X.md](./VISION_10X.md) (das *Wohin*).
>
> **Stand:** v0.10.62 · 100 MCP-Tools · 405 Tests grün · 0 Lint-Warnings

---

## 0. Schnellüberblick

| Dimension | Status |
|---|---|
| Version | `0.10.62` (npm `latest`) |
| MCP-Tools | **100** |
| Tests | **405** passing, 7 Suites |
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

---

## 2. Offen 🔲

### Beweis (Phase-2-Rest) — der Glaubwürdigkeits-Beweis

- 🔲 **Extern gelabelter Korpus** statt selbstgebautem Bench-Set
- 🔲 **Head-to-head gegen echtes Flat-File-Memory** auf realen Agent-Traces
- 🔲 BENCH.md "Limitations" offen ansprechen → unabhängig reproduzierbar machen

### Team-Graph (Phase-3-Rest)

- 🔲 **Rollen-Modell** (admin / reviewer / contributor / viewer)
- 🔲 **Sichtbarkeits-Scopes auf Team-Ebene** (heute nur lesson-level `private`)
- 🔲 Service-/System-Nodes im Graph (heute: Konzept, Person, File)
- 🔲 `brain_who_knows` über CKG-Kanten *zwischen* Personen (Kollaborations-Graph)
- 🔲 Recall, das *wer-was-wo* gewichtet (personalisiertes Ranking)

### Onboarding / Null-Reibung (Phase-1-Eintrittskarte)

- 🔲 `npx @cachly-dev/init` Ein-Befehl-Setup <60 s, idempotent
- 🔲 Circuit-Breaker / Timeouts überall (Tool darf Agent-Call nie blockieren)
- 🔲 Self-Healing-Auth (kein "0 Recalls weil RAM-only")
- 🔲 Time-to-first-recall messen und auf <2 min drücken

### Enterprise / Reichweite (Phase-3/4)

- 🔲 Self-Hosted-Tier mit SOC-2/ISO, BYOK by default
- 🔲 Öffentliche/teilbare Brains (Domänen-Wissensbasen als Marktplatz)
- 🔲 First-class-Support-Matrix je MCP-Client dokumentiert

### Bekannte kleine Schulden

- 🔲 `brain_from_git`: Git-Rename-Pfade (`{old => new}/file.ts`) werden als ein
  File-Node behandelt — kosmetisch, kein Crash. Normalisieren.
- 🔲 README "MCP Tools (80 total)" Abschnitt-Heading war stale → in StoryBrand-
  Rewrite ersetzt; sicherstellen dass keine weitere Zahl driftet.
- 🔲 `team_expertise_map`: Domain-String-Berechnung war ursprünglich verschachtelt;
  bereinigt, aber Tabellen-Rendering bei sehr vielen Domains testen.

---

## 3. Die drei Metriken, die alles entscheiden (aus STRATEGY.md §6)

| Metrik | Ziel | Heute |
|---|---|---|
| **Time-to-first-recall** | <2 min | nicht gemessen 🔲 |
| **Recall-Lift** (vs. BM25) | messbar >0, dann skalieren | +22.2 % P@1 ✅ (intern) |
| **Team-Knowledge-Reuse** | Lesson von A wird von B recallt | trackbar, noch nicht dashboard'd 🔲 |

---

## 4. Changelog-Verweis

Vollständige Release-Notes pro Version: [CHANGELOG.md](./CHANGELOG.md).
Letzte Releases: 0.10.59 (Phase 3A) · 0.10.60 (Phase 3B) · 0.10.61 (Phase 3C, 100 Tools) · 0.10.62 (Härtung).
