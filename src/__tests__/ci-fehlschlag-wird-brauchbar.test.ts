import { describe, expect, it } from "vitest";

// @ts-expect-error — reines JS-Modul ohne Typdatei, bewusst wie push-ci-outcome.mjs
import {
  lektionAusLauf,
  lektionAusGitlabPipeline,
  themenTeil,
} from "../ci-integration/fehlschlag-lektion.mjs";

/**
 * ══ Der CI-Fehlschlag wird eine brauchbare Lektion ═════════════════════════
 *
 * ── Der Anlass, gemessen am eigenen Brain (23.08.2026) ────────────────────
 *
 * Das GitHub-Plugin schrieb bei jedem roten Lauf eine Lektion. Der Topf hiess:
 *
 *     topic = "ci:" + JOB_NAME.toLowerCase().replace(" ", "-")
 *
 * `JOB_NAME` war `github.event.workflow_run.name` — der Name des WORKFLOWS,
 * nicht des Jobs. Unser Workflow heisst "CI". Jeder rote Lauf landete damit
 * in EINEM Topf namens `ci:ci`.
 *
 * Der Inhalt war ein Satz und ein Link:
 *
 *     what_failed = "CI failed on <zweig> - <url>"
 *     what_worked = ""
 *
 * Kein gescheiterter Job, kein Schritt, kein Fehlertext. Nachgemessen im
 * eigenen Brain: `recall_count: 0`. Niemand hat sie je abgerufen, und es gab
 * auch nichts abzurufen.
 *
 * Das war der AUSGELIEFERTE Zustand — jede Kundin, die das Plugin einschaltet,
 * bekommt denselben Nutzlos-Topf.
 *
 * ── Was diese Probe haelt ────────────────────────────────────────────────
 *
 * Dass das Thema vom gescheiterten JOB kommt, dass der SCHRITT dabeisteht und
 * dass die entscheidende Tatsache in den ersten 100 Zeichen steht — dort
 * schneidet das Briefing der naechsten Sitzung ab.
 */

const LAUF = {
  workflowName: "CI",
  branch: "fix/etwas",
  runUrl: "https://github.com/cachly-dev/cachly/actions/runs/1",
};

const job = (name: string, conclusion: string, schritte: Array<[string, string]> = []) => ({
  name,
  conclusion,
  steps: schritte.map(([n, c]) => ({ name: n, conclusion: c })),
});

describe("Das Thema kommt vom Job, nicht vom Workflow", () => {
  it("aus ci:ci wird ci:web-next-js", () => {
    const l = lektionAusLauf({
      ...LAUF,
      jobs: [
        job("Disk Cleanup", "success"),
        job("Web (Next.js)", "failure", [["Prettier check", "failure"]]),
      ],
    });
    expect(l.topic).toBe("ci:web-next-js");
    expect(l.topic, "der Workflow-Name ist wieder das Thema").not.toBe("ci:ci");
  });

  it("Sonderzeichen werden zu Bindestrichen, ohne Rand", () => {
    expect(themenTeil("API – golangci-lint")).toBe("api-golangci-lint");
    expect(themenTeil("SDK (Java/Kotlin)")).toBe("sdk-java-kotlin");
    expect(themenTeil("  ")).toBe("");
  });

  it("ein sehr langer Jobname wird gekuerzt, nicht abgelehnt", () => {
    const lang = "X".repeat(200);
    expect(themenTeil(lang).length).toBeLessThanOrEqual(48);
  });
});

describe("Der gescheiterte Schritt steht dabei", () => {
  it("Job UND Schritt in den ersten 100 Zeichen", () => {
    const l = lektionAusLauf({
      ...LAUF,
      jobs: [job("Web (Next.js)", "failure", [["Prettier check", "failure"]])],
    });
    const kopf = l.what_failed.slice(0, 100);
    expect(kopf, "der Jobname fehlt im sichtbaren Teil").toContain("Web (Next.js)");
    expect(kopf, "der Schritt fehlt im sichtbaren Teil").toContain("Prettier check");
  });

  it("ohne roten Schritt bleibt wenigstens der Job stehen", () => {
    const l = lektionAusLauf({
      ...LAUF,
      jobs: [job("E2E (Playwright)", "failure")],
    });
    expect(l.what_failed.slice(0, 100)).toContain("E2E (Playwright)");
    expect(l.topic).toBe("ci:e2e-playwright");
  });

  it("der erste Satz ist zu Ende, bevor das Briefing abschneidet", () => {
    // Ein Vorspann, der mitten im Wort endet, zeigt eine Zahl ohne Bedeutung.
    const l = lektionAusLauf({
      ...LAUF,
      jobs: [job("API (Go)", "failure", [["go vet", "failure"]])],
    });
    const punkt = l.what_failed.indexOf(".");
    expect(punkt, "kein abgeschlossener Satz gefunden").toBeGreaterThan(0);
    expect(punkt, `erster Satz endet erst bei Zeichen ${punkt}`).toBeLessThanOrEqual(100);
  });
});

describe("Mehrere rote Jobs werden nicht zu einem Sammeltopf", () => {
  it("der erste bestimmt das Thema, die uebrigen werden gezaehlt", () => {
    const l = lektionAusLauf({
      ...LAUF,
      jobs: [
        job("Web (Next.js)", "failure", [["Vitest unit tests", "failure"]]),
        job("API (Go)", "failure"),
        job("SDK (Rust)", "failure"),
      ],
    });
    expect(l.topic).toBe("ci:web-next-js");
    expect(l.what_failed).toContain("2 weitere Jobs");
    expect(l.what_failed).toContain("API (Go)");
    expect(l.what_failed).toContain("SDK (Rust)");
  });

  it("bei genau einem weiteren heisst es Job, nicht Jobs", () => {
    const l = lektionAusLauf({
      ...LAUF,
      jobs: [job("A", "failure"), job("B", "failure")],
    });
    expect(l.what_failed).toContain("1 weiterer Job");
  });
});

describe("Ein Lauf ohne roten Job ist eine Tatsache, keine Luecke", () => {
  it("Zeitgrenze oder Abbruch werden als solche gemeldet", () => {
    // Genau dieser Fall traf cachly und Kanzlei-Kompass am 22./23.08.2026
    // mehrfach: der Lauf lief in seine Zeitgrenze, GitHub meldete "cancelled",
    // und kein einzelner Job war rot.
    const l = lektionAusLauf({ ...LAUF, jobs: [job("Disk Cleanup", "success")] });
    expect(l.topic).toBe("ci:ci-ohne-roten-job");
    expect(l.what_failed).toMatch(/Zeitgrenze|Abbruch|Runner/);
  });

  it("ohne Workflow-Namen wird gar nichts geschrieben", () => {
    // Lieber keine Lektion als eine ohne Absender.
    expect(
      lektionAusLauf({ jobs: [], workflowName: "", branch: "x", runUrl: "y" }),
    ).toBeNull();
  });
});

/**
 * ══ GitLab ════════════════════════════════════════════════════════════════
 *
 * Dieselbe Krankheit, eine Stufe schlimmer. Die ausgelieferte Vorlage setzte
 *
 *     JOB_NAME: "$CI_PROJECT_NAME-pipeline"
 *
 * also EIN Thema je Projekt — und schrieb ueberhaupt keine
 * Fehlschlag-Lektion. Auf GitLab lernte das Brain aus einem roten Lauf nichts
 * ausser der Tatsache, dass er rot war.
 */
const GL = {
  projectName: "meine-app",
  branch: "main",
  pipelineUrl: "https://gitlab.example/-/pipelines/7",
};

const glJob = (name: string, status: string, extra: Record<string, string> = {}) => ({
  name,
  status,
  ...extra,
});

describe("GitLab: das Thema kommt vom Job, nicht vom Projekt", () => {
  it("aus ci:meine-app-pipeline wird ci:test-integration", () => {
    const l = lektionAusGitlabPipeline({
      ...GL,
      jobs: [
        glJob("build:image", "success"),
        glJob("test:integration", "failed", {
          stage: "test",
          failure_reason: "script_failure",
        }),
      ],
    });
    expect(l.topic).toBe("ci:test-integration");
    expect(l.source).toBe("gitlab_ci");
  });

  it("GitLabs Grund steht in Klartext dabei", () => {
    const l = lektionAusGitlabPipeline({
      ...GL,
      jobs: [
        glJob("test:integration", "failed", {
          stage: "test",
          failure_reason: "job_execution_timeout",
        }),
      ],
    });
    // Genau dieser Fall traf uns am 22./23.08.2026 sechsmal. GitHub meldet
    // ihn nur als "cancelled", ohne Anlass — GitLab nennt ihn.
    expect(l.what_failed).toContain("Zeitgrenze des Jobs war erreicht");
    expect(l.what_failed.slice(0, 100)).toContain("test:integration");
  });

  it("ein unbekannter Grund wird durchgereicht statt verschluckt", () => {
    // Wenn GitLab morgen einen neuen Grund erfindet, soll er sichtbar sein.
    const l = lektionAusGitlabPipeline({
      ...GL,
      jobs: [glJob("x", "failed", { failure_reason: "neuer_grund_2027" })],
    });
    expect(l.what_failed).toContain("neuer_grund_2027");
  });

  it("die Stufe steht dabei, aber nicht vor der Hauptsache", () => {
    const l = lektionAusGitlabPipeline({
      ...GL,
      jobs: [glJob("deploy:prod", "failed", { stage: "deploy", failure_reason: "api_failure" })],
    });
    expect(l.what_failed).toContain("Stufe: deploy");
    const punkt = l.what_failed.indexOf(".");
    expect(punkt).toBeGreaterThan(0);
    expect(punkt, "erster Satz endet nach Zeichen 100").toBeLessThanOrEqual(100);
    expect(l.what_failed.slice(0, punkt)).not.toContain("Stufe");
  });

  it("mehrere rote Jobs werden gezaehlt, nicht vermischt", () => {
    const l = lektionAusGitlabPipeline({
      ...GL,
      jobs: [
        glJob("a", "failed", { failure_reason: "script_failure" }),
        glJob("b", "failed"),
        glJob("c", "failed"),
      ],
    });
    expect(l.topic).toBe("ci:a");
    expect(l.what_failed).toContain("2 weitere Jobs rot");
  });

  it("eine Pipeline ohne roten Job wird als solche gemeldet", () => {
    const l = lektionAusGitlabPipeline({ ...GL, jobs: [glJob("a", "success")] });
    expect(l.topic).toBe("ci:meine-app-ohne-roten-job");
    expect(l.what_failed).toMatch(/Abbruch|Zeitgrenze|Runner/);
  });

  it("ohne Projektnamen wird gar nichts geschrieben", () => {
    expect(
      lektionAusGitlabPipeline({ jobs: [], projectName: "", branch: "", pipelineUrl: "" }),
    ).toBeNull();
  });

  it("GEGENPROBE: GitLab meldet 'failed', nicht 'failure'", () => {
    // Ein Tippfehler hier hiesse: kein Job gilt je als rot, und JEDE Pipeline
    // bekaeme die Sammel-Lektion "ohne roten Job". Das saehe wie Betrieb aus.
    const alsGithub = lektionAusGitlabPipeline({
      ...GL,
      jobs: [glJob("a", "failure")],
    });
    expect(alsGithub.topic).toBe("ci:meine-app-ohne-roten-job");
    const richtig = lektionAusGitlabPipeline({ ...GL, jobs: [glJob("a", "failed")] });
    expect(richtig.topic).toBe("ci:a");
  });
});

describe("Beide Plattformen folgen derselben Regel", () => {
  it("gleicher Aufbau, nur andere Quelle", () => {
    // Die Regel steht EINMAL. Wer sie an einer Stelle aendert, muss es an
    // beiden merken — deshalb werden hier beide Nutzlasten verglichen.
    const gh = lektionAusLauf({
      ...LAUF,
      jobs: [job("A", "failure", [["S", "failure"]])],
    });
    const gl = lektionAusGitlabPipeline({
      ...GL,
      jobs: [{ name: "A", status: "failed", stage: "s", failure_reason: "script_failure" }],
    });
    expect(Object.keys(gh).sort()).toEqual(Object.keys(gl).sort());
    expect(gh.topic).toBe(gl.topic);
    expect(gh.outcome).toBe("failure");
    expect(gl.outcome).toBe("failure");
    expect(gh.source).not.toBe(gl.source);
  });
});

describe("GEGENPROBEN", () => {
  it("die alte Bauform faellt durch die Pruefungen oben", () => {
    // Ohne diese Zeile koennte die Probe gruen sein, ohne dass sich etwas
    // geaendert hat. Der alte Einzeiler erzeugte woertlich das hier:
    const alt = {
      topic: "ci:" + "CI".toLowerCase().replace(" ", "-"),
      what_failed: "CI failed on fix/etwas - https://…",
    };
    expect(alt.topic).toBe("ci:ci");
    expect(alt.what_failed.slice(0, 100)).not.toContain("Prettier check");
  });

  it("die Nutzlast traegt alle Felder, die /learn erwartet", () => {
    const l = lektionAusLauf({ ...LAUF, jobs: [job("A", "failure")] });
    for (const feld of ["topic", "outcome", "what_worked", "what_failed", "severity", "tags", "source"]) {
      expect(Object.keys(l), `Feld ${feld} fehlt`).toContain(feld);
    }
    expect(l.outcome).toBe("failure");
    expect(l.source).toBe("github_actions");
  });
});
