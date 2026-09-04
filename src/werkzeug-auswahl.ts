// Welche Werkzeuge im Katalog stehen — und welche nur über den Verteiler
// erreichbar sind.
//
// ── Warum es das gibt (28.08.2026) ──────────────────────────────────────────
//
// Gemessen an docs/generated/tool-specs/cachly.anthropic.json, also an der
// Datei, die wirklich zum Modell geht:
//
//     123 Werkzeuge
//     111.014 Byte
//     ~27.750 Token  IN JEDER EINZELNEN ANFRAGE
//
// Bei einem 200k-Fenster sind das 14 %, die weg sind, bevor der Nutzer ein
// Wort gesagt hat — und sie werden bei jedem Zug neu bezahlt.
//
// Die Masse ist ein langer Schwanz, kein Ausreißer: die zwanzig größten
// Werkzeuge tragen nur 29 %. Kürzen hilft also nicht, es muss über die Zahl
// gehen.
//
// ── Warum NICHT alles auf zwölf zusammengelegt wurde ────────────────────────
//
// Ein Werkzeug namens `recall_best_solution` mit engem Schema wählt ein
// Modell zuverlässiger als `brain(action: "recall_best_solution")`. Die
// Ersparnis wäre echt, der Preis auch — und er fiele an genau der Stelle an,
// an der das Produkt sein Versprechen einlöst.
//
// Deshalb zwei Schichten: die täglich benutzten bleiben eigenständig, der
// lange Schwanz kommt hinter EINEN Verteiler.
//
// ── Was ausdrücklich NICHT passiert: ein Bruch ──────────────────────────────
//
// `handleTool(name, args)` verteilt nach Namen und schaut nie in TOOLS. Ein
// Werkzeug, das nicht mehr im Katalog steht, ist deshalb weiterhin
// AUFRUFBAR — jede bestehende CLAUDE.md, jeder Hook, jede Anleitung
// funktioniert unverändert. Es steht nur nicht mehr in jeder Anfrage.
//
// Wer den vollen Katalog will: CACHLY_ALLE_WERKZEUGE=1.

/** Ein Werkzeug, so wie es im Katalog steht. */
export interface Werkzeug {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Die Werkzeuge, die eigenständig im Katalog bleiben.
 *
 * Auswahl aus sechs Monaten Betrieb, nicht geraten — und aus dem, was unsere
 * eigene CLAUDE.md in jeder Sitzung vorschreibt. Die Roadmap-Werkzeuge stehen
 * auf ausdrücklichen Wunsch vollständig drin.
 *
 * Wer hier etwas dazunimmt, bezahlt es in JEDER Anfrage. Wer etwas
 * herausnimmt, macht es nicht unbrauchbar — nur unsichtbarer.
 */
export const KERNWERKZEUGE: readonly string[] = [
  // ── Gedächtnis, täglich ──────────────────────────────────────────────
  'session_start',
  'session_end',
  'smart_recall',
  'recall_best_solution',
  'learn_from_attempts',
  'remember_context',
  'recall_context',
  'forget_context',
  'list_remembered',
  'causal_trace',
  'brain_predict',
  'semantic_search',
  'brain_search',

  // ── Einrichtung und Diagnose ─────────────────────────────────────────
  'autopilot',
  'brain_doctor',
  'brain_from_git',
  'index_project',

  // ── Team ─────────────────────────────────────────────────────────────
  'team_recall',
  'team_learn',

  // ── Semantischer Cache ───────────────────────────────────────────────
  //
  // Der Cache ist das ZWEITE Produkt, nicht ein Nebenwerkzeug. Steht er nur
  // hinter dem Verteiler, findet ein Modell ihn erst auf Umweg — und ein
  // Umweg beim naheliegendsten Satz ("cache das") ist teuer erkauft.
  // Zusammen 1.877 Byte, also rund 470 Token je Anfrage. Bewusst bezahlt.
  'cache_get',
  'cache_set',

  // ── Roadmap (bleibt vollständig, ausdrücklich gewünscht) ─────────────
  'roadmap_add',
  'roadmap_list',
  'roadmap_next',
  'roadmap_update',

  // ── Übergabe ─────────────────────────────────────────────────────────
  'session_handoff',
];

/**
 * Das SCHLANK-Profil: die Werkzeuge, ohne die eine Gedächtnis-Sitzung
 * nicht auskommt — und sonst nichts.
 *
 * Anlass ist eine Messung von aussen (Bojan Tomic, dev.to 02.09.2026):
 * die 27 Kernwerkzeuge kosten 32.778 Byte ≈ 8.860 Token JE ANFRAGE — sein
 * Datei-Ansatz 579. Sein Schluss "a broad tool surface is a permanent tax"
 * ist richtig, und dieses Profil ist die Antwort: acht Werkzeuge,
 * ~12.000 Byte ≈ 3.200 Token. Alles andere bleibt über den Verteiler
 * aufrufbar — unsichtbarer, nicht unbrauchbar.
 *
 * Einschalten: CACHLY_PROFILE=lean (englisch, weil es in fremden
 * mcp.json-Dateien steht). Voller Katalog weiterhin: CACHLY_ALLE_WERKZEUGE=1.
 */
export const SCHLANK_WERKZEUGE: readonly string[] = [
  'session_start',
  'session_end',
  'smart_recall',
  'recall_best_solution',
  'learn_from_attempts',
  'remember_context',
  'causal_trace',
  'brain_doctor',
];

/**
 * Das RECALL-Profil: nur lesen. Fuer Sitzungen, die ein fertiges Gedaechtnis
 * befragen und nichts schreiben — Messlaeufe (agent-memory-bench: writes
 * withheld), Nur-Lese-Clients, Review-Bots. Drei Werkzeuge, kein Verteiler:
 * gemessen ~3.500 Byte ≈ 1.000 Token je Anfrage statt 8.860 (Kern) bzw.
 * 3.560 (lean). Anlass 02.09.2026: 133.000 der 210.000 Input-Token einer
 * Bench-Sitzung waren allein der Katalog, 15 Runden lang neu gesendet.
 *
 * Einschalten: CACHLY_PROFILE=recall.
 */
export const RECALL_WERKZEUGE: readonly string[] = [
  'smart_recall',
  'recall_best_solution',
  'causal_trace',
];

/** Der Name des Verteilers. Englisch, weil er im Produkt sichtbar ist. */
export const VERTEILER = 'cachly_tool';

/**
 * Baut die Beschreibung des Verteilers. Sie trägt die NAMEN der übrigen
 * Werkzeuge, aber keine Schemata — genau dort sitzt die Ersparnis.
 */
export function verteilerBeschreibung(uebrige: readonly string[]): string {
  return [
    "Run any of cachly's specialist tools by name.",
    '',
    'The most-used tools are listed separately above. This one reaches the',
    `other ${uebrige.length} without their schemas taking up room in every request.`,
    '',
    'Unsure about a tool\'s arguments? Call it with describe:true first — that',
    'returns its input schema instead of running it.',
    '',
    `Available: ${uebrige.join(', ')}`,
  ].join('\n');
}

/** Das Verteiler-Werkzeug selbst. */
export function verteilerWerkzeug(uebrige: readonly string[]): Werkzeug {
  return {
    name: VERTEILER,
    description: verteilerBeschreibung(uebrige),
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Name of the tool to run, e.g. "team_roster".',
        },
        arguments: {
          type: 'object',
          description: 'Arguments for that tool. Use describe:true if unsure.',
        },
        describe: {
          type: 'boolean',
          description: "Return the tool's input schema instead of running it.",
        },
      },
      required: ['tool'],
    },
  };
}

/**
 * Was im Katalog steht: die Kernwerkzeuge plus der Verteiler.
 *
 * Ein Kernwerkzeug, das es gar nicht gibt, wird STILL übergangen — dann
 * stünde es nirgends, weder eigenständig noch im Verteiler. Deshalb meldet
 * die Funktion solche Namen zurück, statt sie zu verschlucken.
 */
export function sichtbareWerkzeuge(
  alle: readonly Werkzeug[],
  env: Record<string, string | undefined> = process.env,
): { katalog: Werkzeug[]; uebrige: string[]; unbekannteKernnamen: string[] } {
  const vorhanden = new Set(alle.map((w) => w.name));
  const unbekannteKernnamen = KERNWERKZEUGE.filter((n) => !vorhanden.has(n));

  if (env.CACHLY_ALLE_WERKZEUGE === '1') {
    return { katalog: [...alle], uebrige: [], unbekannteKernnamen };
  }

  // Profil 'recall': drei Lese-Werkzeuge, KEIN Verteiler — wer nur liest,
  // braucht keinen Weg zu den 120 anderen; jedes Byte ist Katalogmiete.
  if (env.CACHLY_PROFILE === 'recall') {
    const lese = new Set(RECALL_WERKZEUGE);
    const katalog = alle.filter((w) => lese.has(w.name));
    return { katalog, uebrige: alle.filter((w) => !lese.has(w.name)).map((w) => w.name), unbekannteKernnamen };
  }

  // Profil 'lean': acht Werkzeuge statt 27 — ~3.200 statt ~8.860 Token je
  // Anfrage. Der Verteiler traegt den Rest, aufrufbar bleibt alles.
  const auswahl = env.CACHLY_PROFILE === 'lean' ? SCHLANK_WERKZEUGE : KERNWERKZEUGE;
  const kern = new Set(auswahl);
  const katalog = alle.filter((w) => kern.has(w.name));
  const uebrige = alle.filter((w) => !kern.has(w.name)).map((w) => w.name);

  // Gäbe es nichts zu verstecken, wäre der Verteiler nur Ballast.
  if (uebrige.length > 0) katalog.push(verteilerWerkzeug(uebrige));

  return { katalog, uebrige, unbekannteKernnamen };
}
