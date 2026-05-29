# cachly-mcp — Wie wir 10x schärfer werden

> Dieses Dokument baut auf [STRATEGY.md](./STRATEGY.md) (der ehrlichen
> Standortbestimmung) auf und übersetzt sie in **konkrete, schärfende Hebel**.
> STRATEGY.md sagt *warum* und *in welcher Reihenfolge*. Hier steht *wie genau* —
> und welche zehn Wetten den größten Unterschied machen.
>
> **Leitsatz (unverändert):** Erst stabil & reibungslos → dann beweisbar schlauer
> → dann team-weit uneinholbar → immer modell-neutral.

---

## 0. Der eine Satz

> **Anthropic gibt jedem Claude ein Gedächtnis. Wir geben jedem _Team_ ein
> gemeinsames, geprüftes, modell-neutrales Gehirn — und beweisen mit einer Zahl,
> dass es den richtigen Rat schneller findet.**

Alles unten dient diesem einen Satz. Was ihn nicht schärft, ist Ablenkung.

---

## 1. Die Asymmetrie, die wir ausnutzen

Anthropic kann strukturell **nicht**:
1. **Team-weit teilen** ohne das Per-User-Lock-in zu untergraben.
2. **Modell-neutral** sein — Memory in Anthropics Filesystem ist an Claude gebunden.
3. **Governance** liefern (Reviews, Rollen, Audit, DSGVO-Löschung im Kunden-VPC).
4. **Strukturiert kausal** denken statt flache Files linear zu lesen.

Jeder dieser vier Punkte ist bereits in cachly angelegt (CKG, `team_confirm`,
Visibility, Self-Hosting-Pfad). Die 10x-Arbeit ist **Tiefe, nicht Breite**.

---

## 2. Die zehn schärfenden Wetten (priorisiert)

### Wette 1 — Der unabhängige Beweis (höchste Priorität)
**Problem:** Unser Hauptargument ("strukturiert > flat files") ist intern bewiesen
(+22.2 % P@1), aber auf eigenem Korpus. Skeptiker glauben das nicht.
**10x-Hebel:**
- Externen, von Dritten gelabelten Korpus aus realen Agent-Traces bauen.
- **Head-to-head** gegen Anthropics Memory-Tool (flat files) auf *denselben* Tasks.
- Eine reproduzierbare Zahl, die jeder selbst nachfahren kann: `npx cachly bench --vs-flatfile`.
**Erfolg sieht so aus:** "In 100 echten Debugging-Sessions fand cachly die hilfreiche
Lesson 2.3x öfter im Top-1 als ein flat-file-Memory." — zitierbar, verteidigbar.

### Wette 2 — Time-to-first-recall < 60 s
**Problem:** Jede Onboarding-Stufe ist ein Drop-off. First-party hat 0 Setup.
**10x-Hebel:** `npx @cachly-dev/init` — auto-provision + device-flow + MCP-config-write
+ erster `brain_from_git`-Seed, idempotent, mit sichtbarem Fortschritt, <60 s.
**Metrik:** vom `npx`-Befehl bis zum ersten wertvollen Recall. Ziel: <2 min, dann <60 s.

### Wette 3 — Wert sichtbar machen (jede Session)
**Problem:** Anthropic-Memory ist unsichtbar-bequem; unseres war sichtbar-umständlich.
**10x-Hebel:** Das "Brain saved you ~Xm here"-Banner (bereits live) wird zur
**laufenden Bilanz**: pro Woche/Monat aggregierte Zeitersparnis, geteilte
Team-Reuse-Momente ("Bob's Lesson hat dir gerade 40 min erspart").
**Erfolg:** Der User *fühlt* den Wert, bevor er über Kündigung nachdenkt.

### Wette 4 — Personalisiertes, wer-was-wo-gewichtetes Recall
**Problem:** Recall ignoriert heute, *wer* fragt und *woran* gerade gearbeitet wird.
**10x-Hebel:** Die Phase-3-Graphen (Person/File/Konzept) ins Ranking ziehen:
- Lessons aus dem aktuellen File-Kontext höher.
- Lessons von Personen mit hoher Domain-Confidence höher.
- "Du arbeitest an `payments/`, Carol hat hier 3x erfolgreich gefixt" — proaktiv.

### Wette 5 — Kollaborations-Graph (Personen ↔ Personen)
**Problem:** Wir kennen Person→Konzept und Person→File, aber nicht Person↔Person.
**10x-Hebel:** Kanten zwischen Menschen, die an denselben Dateien/Konzepten arbeiten
→ "Frag X *und* Y, die haben das zusammen gelöst." Onboarding-Gold, Bus-Faktor-Schutz.

### Wette 6 — Rollen & Team-Scopes (Enterprise-Eintrittskarte)
**Problem:** Heute nur lesson-level `private`. Enterprises brauchen Rollen.
**10x-Hebel:** admin / reviewer / contributor / viewer; Scopes auf Team-Ebene;
nur reviewer dürfen `team_confirm`. Macht den Self-Hosted-Tier verkaufbar.

### Wette 7 — Stabilität auf First-Party-Niveau
**Problem:** Gegen ein eingebautes Feature ist Vertrauen asymmetrisch — ein Crash kostet mehr.
**10x-Hebel:** Circuit-Breaker + Timeouts überall (✅ erste Guards in 0.10.62);
jede Tool-Antwort hat einen Vertragstest (405 Tests, weiter ausbauen);
Graceful Degradation: Tool blockiert **nie** den Agent-Call.

### Wette 8 — "Dreaming"-Konter: Team-Crystallize
**Problem:** Anthropics "Dreaming" extrahiert Muster pro User — bedroht unser Crystallize.
**10x-Hebel:** Wir crystallizen **team-weit** und **kausal**: nicht nur "was passierte",
sondern "welche Fixes haben strukturell ähnliche Probleme über *mehrere Personen* gelöst".
Das kann ein per-User-Background-Prozess nicht.

### Wette 9 — Modell-Neutralität als Feature, nicht Fußnote
**Hebel:** "Bring your own model, keep your brain." First-class über jeden MCP-Client.
Ein sichtbarer Beweis: dasselbe Brain in Claude *und* einem anderen MCP-Client live zeigen.

### Wette 10 — Teilbare Domänen-Brains (Ökosystem/Virality)
**Hebel:** Kuratierte öffentliche Brains ("Kubernetes-Incident-Brain",
"React-Best-Practices-Brain") als Marktplatz. Je mehr Org-Wissen, desto höher die
Wechselkosten *weg* von cachly — aber **null** Lock-in beim Modell.

---

## 3. Was 10x **nicht** ist (Anti-Roadmap)

- ❌ Mehr Tools stapeln. Wir sind bei 100 — **Tiefe vor Breite**.
- ❌ Anthropics Single-User-Memory feature-für-feature schlagen. Das verlieren wir.
- ❌ Modell-Lock-in aufbauen. Das ist unser einziger glaubwürdiger Vorteil.
- ❌ Beweis durch Marketing ersetzen. Ohne Zahl keine Story.

---

## 4. Wie wir Fortschritt messen

| Hebel | Leitmetrik | Schwelle für "10x erreicht" |
|---|---|---|
| Beweis (W1) | Recall-Lift vs. flat-file auf externem Korpus | reproduzierbar, Dritte bestätigen |
| Onboarding (W2) | Time-to-first-recall | <60 s im Median |
| Wertsichtbarkeit (W3) | Wöchentlich angezeigte Zeitersparnis | User nennt sie unaufgefordert |
| Team-Reuse (W4/W5) | Recalls einer Lesson durch *andere* Person | >30 % der wertvollen Recalls |
| Stabilität (W7) | Tool-Fehlerquote, die den Agent-Call bricht | ~0 |

---

## 5. Die Reihenfolge (nicht verhandelbar)

```
1. STABIL & REIBUNGSLOS   → W2, W7        (sonst ist alles wertlos)
2. BEWEISBAR SCHLAUER      → W1, W3, W4    (jetzt verdienen wir den Wettbewerb)
3. TEAM-WEIT UNEINHOLBAR   → W5, W6, W8, W10 (hier ist Anthropic strukturell raus)
4. NEUTRALER LAYER         → W9            (die Positionierung, die nie veraltet)
```

> Wir gewinnen nicht, indem wir Anthropic kopieren. Wir gewinnen, indem wir das
> werden, was Anthropic strukturell **nicht sein darf**: der neutrale, team-weite,
> beweisbar-bessere Wissens-Layer über allen Modellen.
