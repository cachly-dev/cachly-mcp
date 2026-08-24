/**
 * fehlschlag-lektion.mjs — aus einem roten CI-Lauf eine BRAUCHBARE Lektion
 * machen.
 *
 * ══ Warum es das gibt (gemessen am eigenen Brain, 23.08.2026) ═════════════
 *
 * Die bisherige Fassung stand als Einzeiler im Workflow:
 *
 *     topic = 'ci:' + JOB_NAME.toLowerCase().replace(' ', '-')
 *
 * `JOB_NAME` war dabei `github.event.workflow_run.name` — der Name des
 * WORKFLOWS, nicht des Jobs. Unser Workflow heisst "CI". Jeder einzelne rote
 * Lauf landete damit in einem Topf namens **`ci:ci`**.
 *
 * Der Inhalt war:
 *
 *     what_failed = "CI failed on <zweig> - <url>"
 *     what_worked = ""
 *
 * Also: kein gescheiterter Job, kein gescheiterter Schritt, kein Fehlertext.
 * Ein Link. Nachgemessen im eigenen Brain: `recall_count: 0` — niemand hat
 * diese Lektion je abgerufen, und es gab auch nichts abzurufen.
 *
 * Das ist kein Schoenheitsfehler an unserer Einrichtung, sondern der
 * AUSGELIEFERTE Zustand: jede Kundin, die das GitHub-Plugin einschaltet,
 * bekommt denselben Nutzlos-Topf.
 *
 * ══ Was diese Fassung anders macht ════════════════════════════════════════
 *
 * 1. Das Thema kommt vom JOB, der gescheitert ist — nicht vom Workflow. Aus
 *    einem Topf `ci:ci` werden Themen wie `ci:web-next-js`. Erst damit ist
 *    `recall_best_solution(topic=…)` ueberhaupt eine sinnvolle Frage.
 * 2. Der SCHRITT steht dabei. "Web (Next.js)" sagt wenig; "Web (Next.js),
 *    Schritt: Prettier check" sagt alles.
 * 3. Die entscheidende Tatsache steht in den ersten 100 Zeichen. Das Briefing
 *    der naechsten Sitzung schneidet dort ab — was danach kommt, sieht
 *    niemand.
 * 4. Scheitern mehrere Jobs, wird der ERSTE genommen und die uebrigen
 *    gezaehlt. Ein Sammelthema aus fuenf Jobnamen waere wieder ein `ci:ci`.
 */

/** Aus einem Jobnamen ein Thema machen: "Web (Next.js)" -> "web-next-js". */
export function themenTeil(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Baut die Lektion aus der Jobliste eines Laufs.
 *
 * @param {object} eingabe
 * @param {Array}  eingabe.jobs         Antwort von /actions/runs/:id/jobs (.jobs)
 * @param {string} eingabe.workflowName Name des Workflows (Rueckfallebene)
 * @param {string} eingabe.branch       Zweig
 * @param {string} eingabe.runUrl       Adresse des Laufs
 * @returns {object|null} Nutzlast fuer /learn, oder null wenn nichts zu melden ist
 */
export function lektionAusLauf({ jobs, workflowName, branch, runUrl }) {
  const rot = (jobs ?? []).filter((j) => j?.conclusion === "failure");

  // Kein gescheiterter Job: dann ist der Lauf an etwas gescheitert, das die
  // Job-Ebene nicht sieht (Zeitgrenze des Laufs, Abbruch, fehlende Runner).
  // Das ist eine Tatsache, keine Luecke — sie wird als solche gemeldet.
  if (rot.length === 0) {
    if (!workflowName) return null;
    return {
      topic: `ci:${themenTeil(workflowName)}-ohne-roten-job`,
      outcome: "failure",
      what_worked: "",
      what_failed:
        `${workflowName} scheiterte auf ${branch || "?"}, ohne dass ein Job rot war. ` +
        `Das deutet auf Zeitgrenze, Abbruch oder fehlende Runner. ${runUrl || ""}`.trim(),
      severity: "major",
      tags: ["ci", "auto-learn", "kein-roter-job"],
      source: "github_actions",
    };
  }

  const erster = rot[0];
  const schritt = (erster.steps ?? []).find((s) => s?.conclusion === "failure");
  const weitere = rot.length - 1;

  // Die entscheidende Tatsache zuerst: Job, Schritt, Zweig. Das Briefing der
  // naechsten Sitzung zeigt rund 100 Zeichen — Vorgeschichte gehoert ans Ende.
  const kopf = schritt
    ? `${erster.name} scheiterte an Schritt "${schritt.name}" auf ${branch || "?"}.`
    : `${erster.name} scheiterte auf ${branch || "?"}.`;

  const rest = [
    weitere > 0
      ? `${weitere} weitere${weitere === 1 ? "r Job" : " Jobs"} im selben Lauf rot: ` +
        rot
          .slice(1)
          .map((j) => j.name)
          .join(", ")
      : "",
    runUrl || "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    topic: `ci:${themenTeil(erster.name)}`,
    outcome: "failure",
    what_worked: "",
    what_failed: rest ? `${kopf} ${rest}` : kopf,
    severity: "major",
    tags: ["ci", "auto-learn", themenTeil(erster.name)],
    source: "github_actions",
  };
}

/**
 * ══ GitLab ════════════════════════════════════════════════════════════════
 *
 * Dieselbe Krankheit, eine Stufe schlimmer. Die ausgelieferte Vorlage
 * brain-from-ci-gitlab.yml setzte:
 *
 *     JOB_NAME: "$CI_PROJECT_NAME-pipeline"
 *
 * Also EIN Topf je Projekt — und eine Fehlschlag-Lektion wurde ueberhaupt
 * nicht geschrieben. Auf GitLab lernte das Brain aus einem roten Lauf also
 * gar nichts, sondern nur, dass er rot war.
 *
 * ── Was auf GitLab anders ist ────────────────────────────────────────────
 *
 * Ein GitLab-Job hat keine Schritte — er ist ein Skript. Dafuer liefert
 * GitLab etwas, das GitHub nicht hat: `failure_reason`. Die Werte sind eine
 * geschlossene Liste, und einer davon ist `job_execution_timeout` — genau der
 * Fall, der uns am 22. und 23.08.2026 sechsmal getroffen hat und den GitHub
 * nur als "cancelled" meldet, ohne Grund.
 *
 * Deshalb tritt hier `failure_reason` an die Stelle des Schritts, und die
 * Stufe (`stage`) an die Stelle des Jobnamens im Kontext.
 */

/** Die Gruende, die GitLab kennt, in Klartext. */
const GITLAB_GRUENDE = {
  script_failure: "das Skript ist gescheitert",
  api_failure: "die Schnittstelle antwortete nicht",
  stuck_or_timeout_failure: "kein Runner frei oder Zeit abgelaufen",
  runner_system_failure: "der Runner selbst ist ausgefallen",
  job_execution_timeout: "die Zeitgrenze des Jobs war erreicht",
  runner_unsupported: "kein passender Runner",
  missing_dependency_failure: "eine Vorstufe fehlte",
  archived_failure: "der Lauf war bereits archiviert",
  scheduler_failure: "die Zuteilung ist gescheitert",
  data_integrity_failure: "GitLab meldet einen Datenfehler",
};

/**
 * Baut die Lektion aus den Jobs einer GitLab-Pipeline.
 *
 * @param {object} eingabe
 * @param {Array}  eingabe.jobs         Antwort von /pipelines/:id/jobs
 * @param {string} eingabe.projectName  Projektname (Rueckfallebene)
 * @param {string} eingabe.branch       Zweig
 * @param {string} eingabe.pipelineUrl  Adresse der Pipeline
 */
export function lektionAusGitlabPipeline({ jobs, projectName, branch, pipelineUrl }) {
  const rot = (jobs ?? []).filter((j) => j?.status === "failed");

  if (rot.length === 0) {
    if (!projectName) return null;
    return {
      topic: `ci:${themenTeil(projectName)}-ohne-roten-job`,
      outcome: "failure",
      what_worked: "",
      what_failed:
        `Die Pipeline von ${projectName} scheiterte auf ${branch || "?"}, ohne dass ein Job rot war. ` +
        `Das deutet auf Abbruch, Zeitgrenze der Pipeline oder fehlende Runner. ${pipelineUrl || ""}`.trim(),
      severity: "major",
      tags: ["ci", "auto-learn", "kein-roter-job"],
      source: "gitlab_ci",
    };
  }

  const erster = rot[0];
  const grund = GITLAB_GRUENDE[erster.failure_reason] ?? erster.failure_reason ?? "";
  const weitere = rot.length - 1;

  // Entscheidende Tatsache zuerst, erster Satz vor Zeichen 100 zu Ende.
  const kopf = grund
    ? `${erster.name} scheiterte auf ${branch || "?"}: ${grund}.`
    : `${erster.name} scheiterte auf ${branch || "?"}.`;

  const rest = [
    erster.stage ? `Stufe: ${erster.stage}.` : "",
    weitere > 0
      ? `${weitere} weitere${weitere === 1 ? "r Job" : " Jobs"} rot: ` +
        rot
          .slice(1)
          .map((j) => j.name)
          .join(", ")
      : "",
    pipelineUrl || "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    topic: `ci:${themenTeil(erster.name)}`,
    outcome: "failure",
    what_worked: "",
    what_failed: rest ? `${kopf} ${rest}` : kopf,
    severity: "major",
    tags: ["ci", "auto-learn", themenTeil(erster.name)],
    source: "gitlab_ci",
  };
}
