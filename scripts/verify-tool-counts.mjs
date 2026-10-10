#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolCatalog } from './tool-catalog.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const catalog = loadToolCatalog();
const expected = catalog.total_tools;

const trackedSurfaces = [
  'CACHLY_CAPABILITY_MATRIX.md',
  'README.md',
  'sdk/mcp/package.json',
  'sdk/mcp/server.json',
  'sdk/mcp/smithery.yaml',
  'sdk/mcp/README.md',
  'sdk/mcp/src/index.ts',
  'sdk/mcp/src/toolspecs.ts',
  'web/public/llms.txt',
  'web/app/layout.tsx',
  'web/app/sign-up/[[...sign-up]]/page.tsx',
  'web/app/(marketing)/layout.tsx',
  'web/app/(marketing)/features/layout.tsx',
  'web/app/docs/mcp/page.tsx',
  'web/app/docs/ai-memory/page.tsx',
  'web/e2e/marketing.spec.ts',
];

/**
 * Zweite Liste: Dateien und Ordner, in denen eine Werkzeugzahl stehen darf,
 * aber keine falsche. Hier gilt NUR die Frage "ist jede Zahl neben tools die
 * richtige?" — nicht die strengere Forderung von oben, die Zahl muesse als
 * "N MCP tools" vorkommen. Ein Blogartikel darf "124 tools" schreiben.
 *
 * Eingetragen am 08.10.2026: dort standen noch 122, 126, 137 und 140, in 27
 * Dateien, waehrend die Pruefung gruen war — sie sah nur die Liste oben.
 * Nicht aufgenommen sind Verlaufsprotokolle (CHANGELOG, docs/internal/dev,
 * docs/make_cachly_great_again.md, .agent) und die Landingpage-Dateien, die
 * ihre Zahl aus MCP_TOOL_COUNT ziehen.
 */
const zahlGeprueftDateien = [
  'api/internal/service/email_service.go',
  'docs/DISTRIBUTION_ROADMAP.md',
  'docs/internal/strategy/10X_VISION.md',
  'docs/internal/strategy/mcp-launch-texts.md',
  'docs/public/api/openapi.yaml',
  'docs/public/show-hn-post.md',
  'scripts/content-briefs/beispiel-editor-cursor.json',
  'sdk/agents/README.md',
  'sdk/init/README.md',
  'sdk/mcp/llms.txt',
  'sdk/openclaw/README.md',
  'web/public/llms-full.txt',
  'web/public/openapi.yaml',
];
const zahlGeprueftOrdner = [
  'docs/launch',
  'web/app/(marketing)/blog',
  'web/components/blog',
];

const broadScanRoots = ['sdk', 'web'];
const ignoredDirs = new Set([
  '.next',
  'bin',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'playwright-report',
  'test-results',
]);
const ignoredFiles = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'tsconfig.tsbuildinfo',
]);
const broadScanAllowList = new Set([
  'sdk/mcp/CHANGELOG.md',
  'sdk/mcp/src/handlers/brain.ts',
  // Der eingefrorene Messkorpus ist MESSGUT, keine Dokumentation.
  //
  // Er enthaelt 499 echte Lektionen, so wie sie geschrieben wurden. Eine davon
  // nennt einen alten Werkzeugstand, weil der damals stimmte. Diesen Text
  // nachzuziehen wuerde den Korpus faelschen: die Fragen sind gegen genau diese
  // Formulierungen
  // gestellt, und ein Messstand, dessen Inhalt sich mit dem Produkt aendert,
  // misst das Produkt nicht mehr.
  //
  // Eingetragen am 20.08.2026, als der Messstand von 17 auf 499 Lektionen
  // wuchs (PR #436).
  'sdk/mcp/src/bench/korpus/korpus.json',
  'sdk/mcp/src/bench/korpus/korpus-vektoren.json',
]);

const stalePatterns = [
  /\b115\s+MCP\s+tools\b/gi,
  /\b115-tool\s+MCP\s+server\b/gi,
  /\b115\s+tools\b/gi,
  /\b121\s+MCP\s+tools\b/gi,
  /\b121\s+tools\b/gi,
  /\b63\s+MCP\s+tools\b/gi,
  /\b51\s+MCP\s+tools\b/gi,
  /\b30-tool\s+MCP\s+server\b/gi,
  /\bAll\s+30\s+Brain\s+tools\b/gi,
  /\bAll\s+30\s+MCP\s+Tools\b/g,
  /\b140\s+tools\b/gi,
  /\b140\s+MCP\s+tools\b/gi,
];

/**
 * Die Liste oben ist eine Liste ALTER Zahlen — von Hand gepflegt, also selbst
 * eine zweite Wahrheit. Genau daran ist sie am 14.08.2026 gescheitert: 126
 * stand nicht drin, und deshalb trug sdk/mcp/README.md an zwei Stellen "126"
 * weiter, waehrend das Produkt 122 Werkzeuge hatte — sichtbar fuer jeden, der
 * das Paket auf npm aufmachte. Die Pruefung war gruen.
 *
 * Zwei Luecken zugleich: die Liste kannte 126 nicht, UND die Schreibweisen
 * "126_MCP_tools" (in einer Badge-URL) und "(126 total)" (in einer
 * Ueberschrift) trafen ohnehin keinen der Ausdruecke.
 *
 * Deshalb dreht die Pruefung hier die Frage um. Sie sucht nicht mehr bekannte
 * falsche Zahlen, sondern JEDE Zahl, die neben "tools" oder "total" steht —
 * und laesst nur die durch, die aus der generierten Wahrheit stammt. Eine
 * neue falsche Zahl ist damit automatisch mitgeprueft, ohne dass jemand die
 * Liste pflegt.
 */
const ZAHL_BEI_WERKZEUGEN = [
  // "126 MCP tools", "126 tools", "126_MCP_tools" (Badge-URL, Unterstriche)
  /\b(\d{2,4})[\s_-]+(?:MCP[\s_-]+)?tools?\b/gi,
  // "126-tool MCP server"
  /\b(\d{2,4})-tool\s+MCP\s+server\b/gi,
  // "MCP Tools (126 total)" und "MCP Tools (126 total, 27 in the default catalogue)"
  /\btools?\s*\((\d{2,4})\s+total\b/gi,
  // "126 native MCP tools", "126 AI Brain tools"
  /\b(\d{2,4})[\s_-]+(?:(?:native|AI|Brain)[\s_-]+)+(?:MCP[\s_-]+)?tools?\b/gi,
  // "124-Tool", "124 MCP-Tools", "124 Werkzeuge" (deutsche Texte)
  /\b(\d{2,4})[\s-]+(?:MCP-)?(?:Tools?|Werkzeuge?)\b/g,
  // "Tool-count aligned to 140", "tool count: 140" (08.10.2026: CACHLY_CAPABILITY_MATRIX.md nannte
  // in Zeile 15 die Zahl 124 und in Zeile 23 "aligned to 140"; die Pruefung blieb gruen)
  /\btool[- ]count\b[^|\n\d]{0,25}(\d{2,4})\b/gi,
];

/** Findet Zahlen neben "tools", die nicht die erwartete sind. */
function falscheWerkzeugZahlen(text, erwartet) {
  const treffer = [];
  for (const muster of ZAHL_BEI_WERKZEUGEN) {
    muster.lastIndex = 0;
    let m;
    while ((m = muster.exec(text)) !== null) {
      if (Number(m[1]) !== erwartet) treffer.push(m[0].trim());
    }
  }
  return [...new Set(treffer)];
}

const failures = [];

function* walkFiles(absDir) {
  for (const entry of readdirSync(absDir)) {
    const abs = join(absDir, entry);
    const rel = relativePath(abs);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      if (!ignoredDirs.has(entry)) yield* walkFiles(abs);
      continue;
    }
    if (stat.isFile() && !ignoredFiles.has(entry)) yield { abs, rel };
  }
}

function relativePath(abs) {
  return abs.slice(repoRoot.length + 1).replaceAll('\\', '/');
}

/**
 * Kommentare ausblenden, Zeilennummern behalten.
 *
 * ══ Warum das noetig wurde (24.08.2026) ═══════════════════════════════════
 *
 * Beim Einbau des 123. Werkzeugs meldete dieser Waechter drei Treffer in
 * `sdk/mcp/src/index.ts` — alle drei in KOMMENTAREN, die die Geschichte
 * erzaehlen:
 *
 *   "Die Zahl kommt aus TOOLS statt aus einer getippten 122."
 *   "Auf der Landingpage standen bis heute 122 und 126 nebeneinander."
 *
 * Das sind Belege dafuer, dass die Zahl NICHT mehr getippt wird — und der
 * Waechter las sie als Behauptung, sie werde getippt. Er meldete also genau
 * die Erklaerung seiner eigenen Regel als Verstoss.
 *
 * Dieselbe Falle ist an einem einzigen Tag viermal in diesem Haus
 * zugeschnappt. Ein Waechter, der seine eigene Begruendung anzeigt, wird
 * nach zwei Tagen abgeschaltet.
 *
 * Markdown-Dateien bleiben unangetastet: dort ist `//` kein Kommentar,
 * sondern kommt in Adressen vor.
 */
function ohneKommentare(quelle, rel) {
  if (/\.(md|txt|json)$/i.test(rel)) return quelle;
  const blockKommentar = /\/\*[\s\S]*?\*\//g;
  const zeilenKommentar = /(^|[^:])\/\/[^\n]*/g;
  const nichtUmbruch = /[^\n]/g;
  return quelle
    .replace(blockKommentar, (t) => t.replace(nichtUmbruch, ' '))
    .replace(zeilenKommentar, (t, vor) => vor + ' '.repeat(t.length - vor.length));
}

for (const rel of trackedSurfaces) {
  const abs = join(repoRoot, rel);
  let text = '';
  try {
    text = ohneKommentare(readFileSync(abs, 'utf8'), rel);
  } catch {
    failures.push(`${rel}: tracked surface is missing`);
    continue;
  }

  for (const pattern of stalePatterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) failures.push(`${rel}: stale count phrase "${match[0]}"`);
  }

  for (const treffer of falscheWerkzeugZahlen(text, expected)) {
    failures.push(`${rel}: sagt "${treffer}", die generierte Wahrheit sind ${expected} Werkzeuge`);
  }

  const expectedPhrase = `${expected} MCP tools`;
  const expectedRe = new RegExp(`\\b${expected}\\s+MCP\\s+tools\\b`, 'i');
  /**
   * Eine ABGELEITETE Zahl zaehlt als erfuellt — sie ist besser als die
   * getippte, nicht schlechter.
   *
   * Am 23.08.2026 fiel diese Pruefung an sdk/mcp/src/index.ts, weil dort
   * `${TOOLS.length} MCP tools` steht statt `122 MCP tools`. Die Meldung
   * lautete "mentions MCP tools but not 122 MCP tools" — und sie haette dazu
   * gezwungen, eine ableitbare Zahl wieder von Hand einzutippen.
   *
   * Das waere gegen den eigenen Zweck gelaufen. Der Kommentar oben sagt es:
   * die Liste alter Zahlen war "selbst eine zweite Wahrheit", und genau daran
   * ist die Pruefung am 14.08. gescheitert. Wer aus derselben Quelle liest,
   * aus der auch `expected` kommt, kann per Bauart nicht auseinanderlaufen.
   *
   * Anerkannt werden die zwei Ausdruecke, die im Haus dafuer benutzt werden:
   * TOOLS.length (das MCP-Paket) und MCP_TOOL_COUNT (die Web-Seiten). Eine
   * beliebige andere Variable zaehlt NICHT — sonst waere jede Zahl mit einem
   * Platzhalter zu verstecken.
   */
  /*
   * Zwei Schreibweisen, dieselbe Ableitung. Ergaenzt am 24.08.2026:
   *
   *   `${MCP_TOOL_COUNT} MCP tools`   Vorlagen-Zeichenkette
   *   {MCP_TOOL_COUNT} MCP Tools      JSX, ohne Dollarzeichen
   *
   * Der Ausdruck kannte nur die erste und zwang damit die JSX-Seite zurueck
   * auf eine getippte Zahl — gegen den eigenen Zweck dieser Pruefung. Das
   * `\s+` deckt auch einen Zeilenumbruch ab; in JSX steht die Zahl oft am
   * Zeilenende.
   */
  const abgeleitetRe = /\$?\{(?:TOOLS\.length|MCP_TOOL_COUNT)\}\s+MCP\s+tools\b/i;
  /*
   * ── Eine ERWAEHNUNG ist keine BEHAUPTUNG (24.08.2026) ────────────────────
   *
   * Die Pruefung feuerte auf `sdk/mcp/src/toolspecs.ts`, weil dort steht:
   *
   *     const SERVER_TITLE = 'cachly AI Brain — MCP tools';
   *
   * Das ist ein Titel. Er nennt keine Zahl, also kann er auch keine falsche
   * nennen. Die Forderung "schreib die richtige Zahl hinein" haette eine
   * Zahl in einen Produktnamen gezwungen.
   *
   * Verlangt wird die richtige Zahl deshalb nur dort, wo UEBERHAUPT eine
   * Zahl bei den Werkzeugen steht — sei es getippt oder abgeleitet.
   */
  /*
   * Eng gefasst, und das ist Absicht. Ein erster Entwurf erlaubte eine
   * beliebige geschweifte Klammer vor "tools" — damit traf schon jedes
   * `{ tools: … }` in einem Objekt, und der Fehlalarm blieb.
   *
   * Es zaehlt genau zweierlei: eine getippte Zahl, oder einer der beiden
   * Ausdruecke, aus denen im Haus abgeleitet wird.
   */
  const nenntEineZahl =
    /(?:\d+|\$?\{(?:TOOLS\.length|MCP_TOOL_COUNT)\})\s*(?:MCP\s+)?tools?\b/i.test(text);
  if (
    /MCP tools/i.test(text) &&
    nenntEineZahl &&
    !expectedRe.test(text) &&
    !abgeleitetRe.test(text) &&
    !text.includes(`${expected}\\ MCP tools`)
  ) {
    failures.push(
      `${rel}: mentions MCP tools but neither "${expectedPhrase}" nor a derived count (\${TOOLS.length} / \${MCP_TOOL_COUNT})`,
    );
  }
}

function pruefeNurZahl(rel) {
  let text = '';
  try {
    text = ohneKommentare(readFileSync(join(repoRoot, rel), 'utf8'), rel);
  } catch {
    failures.push(`${rel}: Datei fehlt (steht in zahlGeprueftDateien)`);
    return;
  }
  for (const treffer of falscheWerkzeugZahlen(text, expected)) {
    failures.push(`${rel}: sagt "${treffer}", die generierte Wahrheit sind ${expected} Werkzeuge`);
  }
}
for (const rel of zahlGeprueftDateien) pruefeNurZahl(rel);
for (const ordner of zahlGeprueftOrdner) {
  for (const { rel } of walkFiles(join(repoRoot, ordner))) {
    if (/\.(tsx?|md|txt|json|ya?ml)$/i.test(rel)) pruefeNurZahl(rel);
  }
}

for (const root of broadScanRoots) {
  for (const { abs, rel } of walkFiles(join(repoRoot, root))) {
    if (broadScanAllowList.has(rel)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const pattern of stalePatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) failures.push(`${rel}: stale count phrase "${match[0]}"`);
    }
  }
}

if (failures.length > 0) {
  console.error('Tool-count verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Tool-count verification passed for ${trackedSurfaces.length} surfaces (${expected} MCP tools).`);
