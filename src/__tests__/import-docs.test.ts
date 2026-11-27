// import-docs (Stufe 2, PR 5, Abnahme 5.4): ein Ordner mit 5 Dateien gegen eine
// gestellte API. Erster Lauf: 5 Uploads. Zweiter Lauf ohne Aenderung: 0 Uploads.
// --dry-run: 0 schreibende Aufrufe. Die API ist eine Attrappe im Speicher; sie
// bildet den Hash wie der Server (sha256 ueber den Inhalt).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dokumentHash, importiereDokumente, sammleDokumente, vergleiche, type ImportOptionen } from '../import-docs.js';

interface Aufruf { methode: string; pfad: string; body?: Record<string, unknown> }

/** Eine Attrappe des Servers: merkt sich Dokumente und beantwortet die vier Wege. */
function falscheApi(opts: { entfernenBraucht?: number } = {}) {
  const dokumente = new Map<string, string>(); // doc_key -> doc_hash
  const aufrufe: Aufruf[] = [];
  let gesehenImLauf = new Set<string>();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const pfad = new URL(url).pathname.replace('/api/v1/knowledge/sources/Q1', '');
    const methode = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    aufrufe.push({ methode, pfad, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (methode === 'GET' && pfad === '/known') return json(200, { known: Object.fromEntries(dokumente) });
    if (methode === 'POST' && pfad === '/runs') {
      gesehenImLauf = new Set();
      return json(201, { run_id: 'R1', known: Object.fromEntries(dokumente) });
    }
    if (methode === 'PUT' && pfad === '/runs/R1/documents') {
      const key = String(body?.doc_key);
      dokumente.set(key, dokumentHash(String(body?.content)));
      gesehenImLauf.add(key);
      return json(200, { sections: 2, new: 2, changed: 0, same: 0 });
    }
    if (methode === 'POST' && pfad === '/runs/R1/finish') {
      for (const k of (body?.seen as string[]) ?? []) gesehenImLauf.add(k);
      const weg = [...dokumente.keys()].filter((k) => !gesehenImLauf.has(k));
      if (opts.entfernenBraucht && weg.length >= opts.entfernenBraucht && !body?.confirm_removals) {
        return json(409, { error: 'confirm', code: 'confirm_removals_required', count: weg.length * 4, active: 10, percent: 30 });
      }
      for (const k of weg) dokumente.delete(k);
      return json(200, { new: 0, changed: 0, same: (body?.seen as string[]).length * 2, removed: weg.length * 2 });
    }
    return json(404, { error: 'not found', code: 'not_found' });
  }) as unknown as typeof fetch;
  return { fetchImpl, aufrufe, dokumente };
}

let ordner: string;
const zeilen: string[] = [];

function optionen(api: ReturnType<typeof falscheApi>, extra: Partial<ImportOptionen> = {}): ImportOptionen {
  return { dir: ordner, source: 'Q1', apiUrl: 'https://api.test', apiKey: 'cky_test', fetchImpl: api.fetchImpl, log: (z) => zeilen.push(z), ...extra };
}

beforeEach(() => {
  zeilen.length = 0;
  ordner = mkdtempSync(join(tmpdir(), 'import-docs-'));
  mkdirSync(join(ordner, 'sub'));
  mkdirSync(join(ordner, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(ordner, 'dist'));
  mkdirSync(join(ordner, '.git'));
  writeFileSync(join(ordner, 'a.md'), '# Alpha\n\n## Teil\n\nText.\n');
  writeFileSync(join(ordner, 'b.md'), '# Beta\n\nText.\n');
  writeFileSync(join(ordner, 'sub', 'c.mdx'), '# Gamma\n\nText.\n');
  writeFileSync(join(ordner, 'sub', 'd.md'), '# Delta\n\nText.\n');
  writeFileSync(join(ordner, 'e.md'), '# Epsilon\n\nText.\n');
  // Wird nie gelesen:
  writeFileSync(join(ordner, 'notizen.txt'), 'kein Markdown');
  writeFileSync(join(ordner, 'node_modules', 'x', 'README.md'), '# fremd');
  writeFileSync(join(ordner, 'dist', 'x.md'), '# gebaut');
  writeFileSync(join(ordner, '.git', 'y.md'), '# intern');
  writeFileSync(join(ordner, 'riesig.md'), '# Riesig\n\n' + 'x'.repeat(512 * 1024 + 1));
});
afterEach(() => rmSync(ordner, { recursive: true, force: true }));

describe('import-docs: Dateien sammeln', () => {
  it('liest *.md und *.mdx, springt node_modules, dist, .git und Dateien ueber 512 KB', async () => {
    const s = await sammleDokumente(ordner);
    expect(s.dokumente.map((d) => d.docKey)).toEqual(['a.md', 'b.md', 'e.md', 'sub/c.mdx', 'sub/d.md']);
    expect(s.zuGross).toEqual(['riesig.md']);
    expect(s.dokumente[0].hash).toBe(dokumentHash('# Alpha\n\n## Teil\n\nText.\n'));
  });

  it('vergleicht neu / geaendert / gleich / entfernt', async () => {
    const s = await sammleDokumente(ordner);
    const v = vergleiche(s.dokumente, { 'a.md': s.dokumente[0].hash, 'b.md': 'anderer-hash', 'alt.md': 'x' });
    expect(v.gleich.map((d) => d.docKey)).toEqual(['a.md']);
    expect(v.geaendert.map((d) => d.docKey)).toEqual(['b.md']);
    expect(v.neu.map((d) => d.docKey)).toEqual(['e.md', 'sub/c.mdx', 'sub/d.md']);
    expect(v.entfernt).toEqual(['alt.md']);
  });
});

describe('import-docs: Laeufe gegen die gestellte API', () => {
  it('erster Lauf: 5 Dokumente hochgeladen; zweiter Lauf ohne Aenderung: 0 Uploads', async () => {
    const api = falscheApi();
    const r1 = await importiereDokumente(optionen(api));
    expect(r1.exitCode).toBe(0);
    expect(r1.uploads).toBe(5);
    expect(r1.dokumente).toEqual({ neu: 5, geaendert: 0, gleich: 0, entfernt: 0 });
    expect(api.aufrufe.filter((a) => a.methode === 'PUT')).toHaveLength(5);
    // Der Schluessel geht als Bearer mit, die Datei mit relativem Pfad und "/".
    const put = api.aufrufe.find((a) => a.pfad.endsWith('/documents') && a.body?.doc_key === 'sub/c.mdx');
    expect(put?.body?.format).toBe('markdown');

    api.aufrufe.length = 0;
    const r2 = await importiereDokumente(optionen(api));
    expect(r2.exitCode).toBe(0);
    expect(r2.uploads).toBe(0);
    expect(r2.dokumente).toEqual({ neu: 0, geaendert: 0, gleich: 5, entfernt: 0 });
    expect(api.aufrufe.filter((a) => a.methode === 'PUT')).toHaveLength(0);
    // Die unveraenderten Dateien melden sich beim Abschluss als gesehen.
    const fin = api.aufrufe.find((a) => a.pfad.endsWith('/finish'));
    expect((fin?.body?.seen as string[]).sort()).toEqual(['a.md', 'b.md', 'e.md', 'sub/c.mdx', 'sub/d.md']);
  });

  it('eine geaenderte Datei geht allein hoch, eine geloeschte wird als entfernt gemeldet', async () => {
    const api = falscheApi();
    await importiereDokumente(optionen(api));
    writeFileSync(join(ordner, 'b.md'), '# Beta\n\nNeuer Text.\n');
    rmSync(join(ordner, 'e.md'));
    api.aufrufe.length = 0;
    const r = await importiereDokumente(optionen(api));
    expect(r.dokumente).toEqual({ neu: 0, geaendert: 1, gleich: 3, entfernt: 1 });
    expect(api.aufrufe.filter((a) => a.methode === 'PUT').map((a) => a.body?.doc_key)).toEqual(['b.md']);
    expect(api.dokumente.has('e.md')).toBe(false);
    expect(zeilen.join('\n')).toMatch(/removed\s+e\.md/);
  });

  it('--dry-run: 0 schreibende Aufrufe, zeigt neu / geaendert / gleich / entfernt', async () => {
    const api = falscheApi();
    await importiereDokumente(optionen(api));
    writeFileSync(join(ordner, 'a.md'), '# Alpha\n\nGeaendert.\n');
    writeFileSync(join(ordner, 'neu.md'), '# Neu\n\nText.\n');
    rmSync(join(ordner, 'b.md'));
    api.aufrufe.length = 0;
    zeilen.length = 0;
    const r = await importiereDokumente(optionen(api, { dryRun: true }));
    expect(r.exitCode).toBe(0);
    expect(r.schreibendeAufrufe).toBe(0);
    expect(api.aufrufe.every((a) => a.methode === 'GET')).toBe(true);
    expect(api.aufrufe).toHaveLength(1);
    expect(r.dokumente).toEqual({ neu: 1, geaendert: 1, gleich: 3, entfernt: 1 });
    expect(zeilen.join('\n')).toContain('nothing was written');
  });

  it('die 30-%-Sicherung des Servers stoppt mit einer klaren Meldung, --confirm-removals fuehrt aus', async () => {
    const api = falscheApi({ entfernenBraucht: 2 });
    await importiereDokumente(optionen(api));
    rmSync(join(ordner, 'a.md'));
    rmSync(join(ordner, 'b.md'));
    zeilen.length = 0;
    const r = await importiereDokumente(optionen(api));
    expect(r.exitCode).toBe(1);
    expect(zeilen.join('\n')).toMatch(/would withdraw 8 of 10/);
    expect(zeilen.join('\n')).toContain('--confirm-removals');
    const r2 = await importiereDokumente(optionen(api, { confirmRemovals: true }));
    expect(r2.exitCode).toBe(0);
    expect(r2.abschnitte?.entfernt).toBe(4);
  });

  it('ein Fehler der API endet mit Exit 1 und einem Satz, nicht mit einem Stapel', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'x', code: 'not_admin' }), { status: 403 })) as unknown as typeof fetch;
    const r = await importiereDokumente({ ...optionen(falscheApi()), fetchImpl });
    expect(r.exitCode).toBe(1);
    expect(zeilen.join('\n')).toContain('Only the owner of this Brain or an admin');
  });

  it('ein leerer Ordner endet mit Exit 1, ohne die API zu rufen', async () => {
    const leer = mkdtempSync(join(tmpdir(), 'import-docs-leer-'));
    try {
      const api = falscheApi();
      const r = await importiereDokumente(optionen(api, { dir: leer }));
      expect(r.exitCode).toBe(1);
      expect(api.aufrufe).toHaveLength(0);
    } finally {
      rmSync(leer, { recursive: true, force: true });
    }
  });
});
