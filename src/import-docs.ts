// import-docs — Markdown-Ordner als Firmenwissen einlesen (Stufe 2, Vorhaben B3).
//
//   npx @cachly-dev/mcp-server import-docs <ordner> --source <id> [--dry-run] [--confirm-removals]
//
// Der Client liest *.md und *.mdx, bildet je Datei einen Hash und fragt die API,
// welche Dateien sie schon kennt. Nur neue und geaenderte Dateien gehen hoch
// (PUT). Das Teilen in Abschnitte, das Schwaerzen von Schluesseln, der Vergleich
// je Abschnitt und der Rueckzug entfernter Dateien geschehen auf dem Server;
// hier steht nichts davon, damit es nur eine Fassung gibt.
//
// Die Quelle legt ein Mensch im Dashboard an (--source ist ihre ID). Der Befehl
// laeuft mit dem API-Schluessel eines Admins: Lauf beginnen, Dokumente hochladen,
// Lauf beenden. Eine neue Quelle kann er nicht eroeffnen.
//
// --dry-run fragt nur ab (GET) und zeigt neu / geaendert / gleich / entfernt.
// Er beginnt keinen Lauf und schreibt nichts.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/** Ordner, die nie gelesen werden. */
export const UEBERSPRUNGENE_ORDNER: readonly string[] = ['node_modules', 'dist', '.git'];
/** Hoechste Dateigroesse (Bytes); der Server lehnt mehr ab. */
export const MAX_DATEI_BYTES = 512 * 1024;

export interface Dokument {
  /** Pfad relativ zum Ordner, immer mit "/". */
  docKey: string;
  content: string;
  hash: string;
}

export interface Sammlung {
  dokumente: Dokument[];
  /** Dateien ueber 512 KB: werden nicht hochgeladen. */
  zuGross: string[];
}

/** sha256 (hex) ueber den Inhalt, so wie ihn der Server bildet (UTF-8 des Textes). */
export function dokumentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Liest alle *.md und *.mdx unter dir, sortiert nach Pfad. */
export async function sammleDokumente(dir: string): Promise<Sammlung> {
  const wurzel = resolve(dir);
  const dokumente: Dokument[] = [];
  const zuGross: string[] = [];
  async function gehe(ordner: string): Promise<void> {
    const eintraege = await readdir(ordner, { withFileTypes: true });
    for (const e of eintraege) {
      const voll = join(ordner, e.name);
      if (e.isDirectory()) {
        if (!UEBERSPRUNGENE_ORDNER.includes(e.name)) await gehe(voll);
        continue;
      }
      if (!e.isFile() || !/\.mdx?$/i.test(e.name)) continue;
      const docKey = relative(wurzel, voll).split(sep).join('/');
      const s = await stat(voll);
      if (s.size > MAX_DATEI_BYTES) {
        zuGross.push(docKey);
        continue;
      }
      const content = await readFile(voll, 'utf8');
      dokumente.push({ docKey, content, hash: dokumentHash(content) });
    }
  }
  await gehe(wurzel);
  dokumente.sort((a, b) => (a.docKey < b.docKey ? -1 : a.docKey > b.docKey ? 1 : 0));
  zuGross.sort();
  return { dokumente, zuGross };
}

export interface Vergleich {
  neu: Dokument[];
  geaendert: Dokument[];
  gleich: Dokument[];
  /** doc_keys, die der Server kennt, im Ordner aber fehlen. */
  entfernt: string[];
}

/** Vergleicht die Dateien mit dem, was der Server kennt (doc_key -> doc_hash). */
export function vergleiche(lokal: Dokument[], bekannt: Record<string, string>): Vergleich {
  const v: Vergleich = { neu: [], geaendert: [], gleich: [], entfernt: [] };
  const lokalKeys = new Set<string>();
  for (const d of lokal) {
    lokalKeys.add(d.docKey);
    const h = bekannt[d.docKey];
    if (h === undefined) v.neu.push(d);
    else if (h !== d.hash) v.geaendert.push(d);
    else v.gleich.push(d);
  }
  v.entfernt = Object.keys(bekannt).filter((k) => !lokalKeys.has(k)).sort();
  return v;
}

export interface ImportOptionen {
  dir: string;
  /** ID der Quelle (aus dem Dashboard). */
  source: string;
  dryRun?: boolean;
  /** Ein Lauf, der mehr als 30 % der Eintraege der Quelle zurueckzoege, braucht dies. */
  confirmRemovals?: boolean;
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  log?: (zeile: string) => void;
}

export interface ImportErgebnis {
  /** 0 = in Ordnung, 1 = Fehler. */
  exitCode: number;
  dryRun: boolean;
  dokumente: { neu: number; geaendert: number; gleich: number; entfernt: number };
  /** Zahlen des Servers je Abschnitt; nur nach einem echten Lauf. */
  abschnitte?: { neu: number; geaendert: number; gleich: number; entfernt: number };
  uploads: number;
  /** Zahl der Aufrufe, die etwas schreiben koennten (POST, PUT). Bei --dry-run immer 0. */
  schreibendeAufrufe: number;
  zuGross: string[];
  abgeschnitten: number;
}

class ApiFehler extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
    message: string,
  ) {
    super(message);
  }
}

function fehlerText(status: number, code: string, body: Record<string, unknown>): string {
  switch (code) {
    case 'not_admin':
      return 'Only the owner of this Brain or an admin of the organisation can import documents.';
    case 'not_found':
      return 'Source not found. Check --source (the ID from the dashboard) and that your key belongs to this team.';
    case 'run_closed':
      return 'This run was closed by a newer run. Start again.';
    case 'knowledge_limit':
      return `The knowledge limit of this level is reached (${String(body.max ?? '?')} entries). Withdraw entries or delete a source first.`;
    case 'document_limit':
      return `A source holds at most ${String(body.max ?? 2000)} documents.`;
    case 'too_large':
      return 'A document is larger than 512 KB.';
  }
  if (status === 401) return 'The API key is not valid. Run: npx @cachly-dev/mcp-server@latest autopilot';
  const msg = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
  return code ? `${msg} (${code})` : msg;
}

export async function importiereDokumente(o: ImportOptionen): Promise<ImportErgebnis> {
  const log = o.log ?? ((z: string) => console.log(z));
  const f = o.fetchImpl ?? fetch;
  const basis = `${o.apiUrl.replace(/\/+$/, '')}/api/v1/knowledge/sources/${encodeURIComponent(o.source)}`;
  const ergebnis: ImportErgebnis = {
    exitCode: 0, dryRun: !!o.dryRun, dokumente: { neu: 0, geaendert: 0, gleich: 0, entfernt: 0 },
    uploads: 0, schreibendeAufrufe: 0, zuGross: [], abgeschnitten: 0,
  };

  async function api(methode: string, pfad: string, body?: unknown): Promise<Record<string, unknown>> {
    if (methode !== 'GET') ergebnis.schreibendeAufrufe++;
    const res = await f(`${basis}${pfad}`, {
      method: methode,
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* leer */ }
    if (!res.ok) {
      const code = typeof json.code === 'string' ? json.code : '';
      throw new ApiFehler(res.status, code, json, fehlerText(res.status, code, json));
    }
    return json;
  }

  try {
    const sammlung = await sammleDokumente(o.dir);
    ergebnis.zuGross = sammlung.zuGross;
    for (const k of sammlung.zuGross) log(`  skipped (over 512 KB): ${k}`);
    if (sammlung.dokumente.length === 0 && sammlung.zuGross.length === 0) {
      log(`\nNo .md or .mdx files found in ${resolve(o.dir)}.\n`);
      ergebnis.exitCode = 1;
      return ergebnis;
    }

    let runId = '';
    let bekannt: Record<string, string>;
    if (o.dryRun) {
      bekannt = ((await api('GET', '/known')).known ?? {}) as Record<string, string>;
    } else {
      const start = await api('POST', '/runs');
      runId = String(start.run_id ?? '');
      bekannt = (start.known ?? {}) as Record<string, string>;
    }

    const v = vergleiche(sammlung.dokumente, bekannt);
    ergebnis.dokumente = { neu: v.neu.length, geaendert: v.geaendert.length, gleich: v.gleich.length, entfernt: v.entfernt.length };

    if (o.dryRun) {
      for (const d of v.neu) log(`  new       ${d.docKey}`);
      for (const d of v.geaendert) log(`  changed   ${d.docKey}`);
      for (const k of v.entfernt) log(`  removed   ${k}`);
      log(`\nDry run, nothing was written: ${zusammen(ergebnis.dokumente)}\n`);
      return ergebnis;
    }

    for (const d of [...v.neu, ...v.geaendert]) {
      const r = await api('PUT', `/runs/${encodeURIComponent(runId)}/documents`, {
        doc_key: d.docKey, format: 'markdown', content: d.content,
      });
      ergebnis.uploads++;
      const abg = Number(r.truncated ?? 0);
      if (abg > 0) {
        ergebnis.abgeschnitten += abg;
        log(`  warning: ${d.docKey} has more than 200 sections, ${abg} were left out`);
      }
      log(`  ${v.neu.includes(d) ? 'new    ' : 'changed'}  ${d.docKey} (${String(r.sections ?? 0)} sections)`);
    }

    try {
      const fin = await api('POST', `/runs/${encodeURIComponent(runId)}/finish`, {
        seen: v.gleich.map((d) => d.docKey),
        confirm_removals: !!o.confirmRemovals,
      });
      ergebnis.abschnitte = {
        neu: Number(fin.new ?? 0), geaendert: Number(fin.changed ?? 0),
        gleich: Number(fin.same ?? 0), entfernt: Number(fin.removed ?? 0),
      };
    } catch (e) {
      if (e instanceof ApiFehler && e.code === 'confirm_removals_required') {
        log(`\n  Stopped: this run would withdraw ${String(e.body.count ?? '?')} of ${String(e.body.active ?? '?')} active entries (more than ${String(e.body.percent ?? 30)} %).`);
        log('  Wrong folder? If the removal is intended, run the command again with --confirm-removals.\n');
        ergebnis.exitCode = 1;
        return ergebnis;
      }
      throw e;
    }

    for (const k of v.entfernt) log(`  removed   ${k}`);
    log(`\nDocuments: ${zusammen(ergebnis.dokumente)}`);
    const a = ergebnis.abschnitte;
    log(`Sections:  ${zusammen(a)}`);
    log('New and changed sections are searchable by meaning within a few minutes; until then the word search finds them.\n');
    return ergebnis;
  } catch (e) {
    log(`\n❌ ${e instanceof Error ? e.message : String(e)}\n`);
    ergebnis.exitCode = 1;
    return ergebnis;
  }
}

function zusammen(z: { neu: number; geaendert: number; gleich: number; entfernt: number }): string {
  return `${z.neu} new, ${z.geaendert} changed, ${z.gleich} same, ${z.entfernt} removed`;
}
