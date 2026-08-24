#!/usr/bin/env node
/**
 * push-fehlschlag-lektion.mjs — aus einem roten Lauf eine brauchbare Lektion
 * machen und ins cachly Brain schreiben. Fuer GitHub Actions UND GitLab CI.
 *
 * ══ Warum ein Skript fuer beide ═══════════════════════════════════════════
 *
 * Bis zum 23.08.2026 gab es die Regel zweimal, und beide Male falsch:
 *
 *   GitHub  topic = "ci:" + workflow_run.name      -> immer "ci:ci"
 *   GitLab  JOB_NAME = "$CI_PROJECT_NAME-pipeline" -> ein Topf je Projekt,
 *                                                    und gar keine Lektion
 *
 * Zwei Orte, dieselbe Frage, zwei verschiedene falsche Antworten. Genau die
 * Fehlerklasse, die dieses Haus schon kennt: wer eine Regel an zwei Stellen
 * schreibt, pflegt sie an einer.
 *
 * Deshalb: EIN Skript, EIN Modul mit der Regel (fehlschlag-lektion.mjs), und
 * je Plattform nur das, was sich wirklich unterscheidet — wie man an die
 * Jobliste kommt.
 *
 * ── Umgebungsvariablen ───────────────────────────────────────────────────
 *
 * Immer:
 *   CACHLY_API_KEY | CACHLY_JWT   Anmeldung (Schluessel bevorzugt)
 *   CACHLY_BRAIN_INSTANCE_ID      Kennung der Brain-Instanz
 *   CACHLY_API_URL                optional, Vorgabe https://api.cachly.dev
 *
 * GitHub Actions (vom Workflow gesetzt):
 *   GITHUB_ACTIONS=true, GH_TOKEN, GITHUB_REPOSITORY, RUN_ID,
 *   WORKFLOW_NAME, HEAD_BRANCH, RUN_URL
 *
 * GitLab CI (setzt GitLab selbst, ausser dem Token):
 *   GITLAB_CI=true, CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID,
 *   CI_PROJECT_NAME, CI_COMMIT_REF_NAME, CI_PIPELINE_URL
 *   CACHLY_GITLAB_TOKEN  Lesezugriff auf die Jobliste (read_api genuegt)
 *
 * Beendet sich IMMER mit 0. Eine Lektion darf keine Pipeline rot machen.
 */

import {
  lektionAusLauf,
  lektionAusGitlabPipeline,
} from "./fehlschlag-lektion.mjs";

const API_URL = process.env.CACHLY_API_URL ?? "https://api.cachly.dev";
const AUTH = process.env.CACHLY_API_KEY || process.env.CACHLY_JWT || "";
const INSTANCE_ID = process.env.CACHLY_BRAIN_INSTANCE_ID ?? "";

/** Nie werfen, nie rot machen. */
function ende(text) {
  console.log(`[cachly-ci] ${text}`);
  process.exit(0);
}

if (!AUTH || !INSTANCE_ID) {
  ende("Zugangsdaten fehlen — keine Lektion (nicht fatal).");
}

async function holen(url, headers) {
  const antwort = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!antwort.ok) throw new Error(`${antwort.status} ${antwort.statusText}`);
  return antwort.json();
}

async function ausGithub() {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const runId = process.env.RUN_ID ?? "";
  const token = process.env.GH_TOKEN ?? "";
  if (!repo || !runId || !token) return null;

  const daten = await holen(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  );
  return lektionAusLauf({
    jobs: daten.jobs ?? [],
    workflowName: process.env.WORKFLOW_NAME ?? "",
    branch: process.env.HEAD_BRANCH ?? "",
    runUrl: process.env.RUN_URL ?? "",
  });
}

async function ausGitlab() {
  const basis = process.env.CI_API_V4_URL ?? "";
  const projekt = process.env.CI_PROJECT_ID ?? "";
  const pipeline = process.env.CI_PIPELINE_ID ?? "";
  const token = process.env.CACHLY_GITLAB_TOKEN ?? "";
  if (!basis || !projekt || !pipeline || !token) return null;

  // GitLab liefert die Jobs seitenweise; 100 reichen fuer jede reale Pipeline
  // und begrenzen zugleich, was ein Fehlerfall an Daten zieht.
  const jobs = await holen(
    `${basis}/projects/${encodeURIComponent(projekt)}/pipelines/${pipeline}/jobs?per_page=100`,
    { "PRIVATE-TOKEN": token },
  );
  return lektionAusGitlabPipeline({
    jobs: Array.isArray(jobs) ? jobs : [],
    projectName: process.env.CI_PROJECT_NAME ?? "",
    branch: process.env.CI_COMMIT_REF_NAME ?? "",
    pipelineUrl: process.env.CI_PIPELINE_URL ?? "",
  });
}

let lektion = null;
try {
  if (process.env.GITLAB_CI === "true") lektion = await ausGitlab();
  else if (process.env.GITHUB_ACTIONS === "true") lektion = await ausGithub();
  else ende("Weder GitHub noch GitLab erkannt — nichts zu tun.");
} catch (fehler) {
  // Die Jobliste nicht zu bekommen ist keine Lektion wert und schon gar kein
  // Grund, den Lauf rot zu machen. Der Grund wird aber genannt: eine stille
  // Ausnahme hier hiesse, dass niemand je erfaehrt, warum nichts gelernt wird.
  ende(`Jobliste nicht abrufbar (${fehler.message}) — keine Lektion.`);
}

if (!lektion) ende("Nichts zu melden.");

try {
  const antwort = await fetch(
    `${API_URL}/api/v1/instances/${INSTANCE_ID}/learn`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(lektion),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!antwort.ok) ende(`Learn abgelehnt (${antwort.status}) — nicht fatal.`);
  ende(`Lektion gespeichert: ${lektion.topic}`);
} catch (fehler) {
  ende(`Learn nicht erreichbar (${fehler.message}) — nicht fatal.`);
}
