import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/*
 * Der echte Server gegen eine nachgebaute API, in der die gespeicherte Instanz
 * fehlt (404). Hintergrund: seit 28.11.2026 loescht die API leere Sofort-Test-
 * Brains nach 14 Tagen (PR #1264); Konto und Schluessel bleiben gueltig.
 * Vorher endete jedes Werkzeug mit "cachly API error 404: not found".
 *
 * Warum ein Prozess: die Regel haengt an der Reihenfolge in handleTool und an
 * dem, was in ~/.cachly/credentials.json steht. Eine Einzelfunktion zeigt
 * keins von beiden.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const ALT = '11111111-2222-3333-4444-555555555555';
const NEU = '99999999-8888-7777-6666-555555555555';
const TRIAL = 'cky_trial_brainweg00000000000000000000';
const LIVE = 'cky_live_brainweg000000000000000000000';

interface Anfrage { methode: string; pfad: string; auth: string }

interface Verhalten {
  /** Antwort auf GET /api/v1/instances/<ALT>. */
  alt: number;
  /** Feld `grund` in der 404-Antwort auf GET /instances/<ALT> (fehlt: nicht gesetzt). */
  grund?: string;
  /** Antwort auf POST /api/v1/instances/auto. */
  auto: { status: number; body: unknown };
  /** Antwort auf GET /api/v1/instances (Liste). */
  liste?: unknown;
}

async function starteApi(v: Verhalten): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  const server = createServer((req, res) => {
    req.on('data', () => { /* Rumpf egal */ });
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      anfragen.push({ methode: req.method ?? '', pfad, auth: String(req.headers.authorization ?? '') });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && pfad === `/api/v1/instances/${ALT}`) return json(v.alt, { error: v.alt === 404 ? 'not found' : 'x', ...(v.alt === 404 && v.grund ? { grund: v.grund } : {}) });
      if (req.method === 'POST' && pfad === '/api/v1/instances/auto') return json(v.auto.status, v.auto.body);
      if (req.method === 'GET' && pfad === '/api/v1/instances') return json(200, v.liste ?? { data: [], count: 0 });
      if (pfad === '/api/v1/telemetry/mcp') return json(200, { ok: true });
      if (pfad === '/health') return json(200, { status: 'ok', db: 'ok' });
      return json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

interface Lauf { schluessel: string; instanzUmgebung?: string; dateiInstanz?: string; aufrufe?: number }

/** Startet den Server, schickt `aufrufe` Werkzeugaufrufe nacheinander, liefert deren Texte. */
async function rufe(apiUrl: string, heim: string, l: Lauf): Promise<string[]> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^path$/i.test(k)) continue;
    if (/^CACHLY_/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    PATH: '', HOME: heim, USERPROFILE: heim, APPDATA: heim,
    CACHLY_API_URL: apiUrl,
    CACHLY_JWT: l.schluessel,
    CACHLY_AUTO_INDEX: 'false',
    CACHLY_STARTWISSEN: 'false',
  });
  if (l.instanzUmgebung) env.CACHLY_BRAIN_INSTANCE_ID = l.instanzUmgebung;

  const n = l.aufrufe ?? 1;
  const kind = spawn(process.execPath, [tsxCli, einstieg], { env, cwd: heim, stdio: ['pipe', 'pipe', 'pipe'] });
  let puffer = '';
  const antworten = new Map<number, { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } }>();
  kind.stdout.on('data', (c) => {
    puffer += String(c);
    let nl;
    while ((nl = puffer.indexOf('\n')) >= 0) {
      const z = puffer.slice(0, nl).trim();
      puffer = puffer.slice(nl + 1);
      if (!z.startsWith('{')) continue;
      try { const j = JSON.parse(z); if (typeof j.id === 'number') antworten.set(j.id, j); } catch { /* Teilzeile */ }
    }
  });
  kind.stderr.on('data', () => { /* Protokoll des Servers */ });

  const warte = async (id: number, ms: number) => {
    const bis = Date.now() + ms;
    while (!antworten.has(id) && Date.now() < bis) await new Promise((r) => setTimeout(r, 50));
  };
  kind.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  await warte(0, 40_000);
  const texte: string[] = [];
  for (let i = 1; i <= n; i++) {
    kind.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_api_status', arguments: {} } }) + '\n');
    await warte(i, 50_000);
    const a = antworten.get(i);
    if (!a) throw new Error(`Server hat auf Aufruf ${i} nicht geantwortet`);
    texte.push(a.error ? `FEHLER: ${a.error.message}` : (a.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
  }
  const ende = new Promise<void>((r) => kind.once('exit', () => r()));
  kind.stdin.end();
  await Promise.race([ende, new Promise((r) => setTimeout(r, 10_000))]);
  kind.kill();
  return texte;
}

function autoAufrufe(a: Anfrage[]): Anfrage[] {
  return a.filter((x) => x.methode === 'POST' && x.pfad === '/api/v1/instances/auto');
}

describe('Brain nicht mehr da (404): echter Prozess', () => {
  let aufraeumen: Array<() => void> = [];
  afterEach(() => { for (const f of aufraeumen) f(); aufraeumen = []; });

  function neuerHeim(datei?: { apiKey: string; instanceId: string }): { heim: string; dateiPfad: string } {
    const heim = mkdtempSync(join(tmpdir(), 'cachly-weg-'));
    aufraeumen.push(() => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const dateiPfad = join(heim, '.cachly', 'credentials.json');
    if (datei) {
      mkdirSync(join(heim, '.cachly'), { recursive: true });
      writeFileSync(dateiPfad, JSON.stringify(datei, null, 2));
    }
    return { heim, dateiPfad };
  }

  it('404 + Sofort-Test-Schluessel (ID aus der Umgebung): ein /auto, Meldung einmal, Datei unberuehrt', async () => {
    const g = await starteApi({ alt: 404, grund: 'leer_abgeraeumt', auto: { status: 201, body: { instance_id: NEU, status: 'provisioning', created: true } } });
    aufraeumen.push(() => g.server.close());
    const { heim, dateiPfad } = neuerHeim({ apiKey: TRIAL, instanceId: ALT });
    const vorher = readFileSync(dateiPfad, 'utf8');

    const [erst, zweit] = await rufe(g.url, heim, { schluessel: TRIAL, instanzUmgebung: ALT, aufrufe: 2 });

    expect(autoAufrufe(g.anfragen).length).toBe(1);
    expect(autoAufrufe(g.anfragen)[0]!.auth).toBe(`Bearer ${TRIAL}`);
    expect(erst).toContain('Your trial Brain was removed because it stayed empty and unused for 14 days.');
    expect(erst).toContain(NEU);
    expect(erst).toContain('CACHLY_BRAIN_INSTANCE_ID'); // sagt, was zu aendern ist
    expect(zweit).not.toContain('Your trial Brain was removed'); // einmalig
    // Aus der Umgebung: nichts ueberschrieben.
    expect(readFileSync(dateiPfad, 'utf8')).toBe(vorher);
    // Der Sitzungsstart und der erste Aufruf koennen gleichzeitig fragen (hoechstens 2);
    // danach gilt die neue Kennung, die alte wird nicht mehr abgefragt.
    expect(g.anfragen.filter((a) => a.pfad === `/api/v1/instances/${ALT}`).length).toBeLessThanOrEqual(2);
  }, 120_000);

  it('404 + registrierter Schluessel: keine Anlage, klare Meldung', async () => {
    const g = await starteApi({ alt: 404, auto: { status: 201, body: { instance_id: NEU, created: true } } });
    aufraeumen.push(() => g.server.close());
    const { heim, dateiPfad } = neuerHeim({ apiKey: LIVE, instanceId: ALT });
    const vorher = readFileSync(dateiPfad, 'utf8');

    const [text] = await rufe(g.url, heim, { schluessel: LIVE, instanzUmgebung: ALT });

    expect(autoAufrufe(g.anfragen).length).toBe(0);
    expect(text).toContain(`The Brain ${ALT} no longer exists in your account.`);
    expect(text).toContain('https://cachly.dev/instances');
    expect(text).toContain('npx @cachly-dev/mcp-server@latest setup');
    expect(readFileSync(dateiPfad, 'utf8')).toBe(vorher);
  }, 120_000);

  it('/auto schlaegt fehl (403): Meldung mit naechstem Schritt, kein zweiter Versuch', async () => {
    const g = await starteApi({ alt: 404, auto: { status: 403, body: { error: 'sign_in_required' } } });
    aufraeumen.push(() => g.server.close());
    const { heim } = neuerHeim();

    const [erst, zweit] = await rufe(g.url, heim, { schluessel: TRIAL, instanzUmgebung: ALT, aufrufe: 2 });

    expect(autoAufrufe(g.anfragen).length).toBe(1);
    expect(erst).toContain('could not create a new one');
    expect(erst).toContain('npx @cachly-dev/mcp-server@latest setup');
    expect(zweit).toContain('could not create a new one'); // dieselbe Auskunft, ohne neue Anfrage
  }, 120_000);

  it('404 ohne Grund (anders geloescht): neutrale Meldung, kein "14 Tage", kein "nichts verloren"', async () => {
    const g = await starteApi({ alt: 404, auto: { status: 201, body: { instance_id: NEU, status: 'provisioning', created: true } } });
    aufraeumen.push(() => g.server.close());
    const { heim } = neuerHeim({ apiKey: TRIAL, instanceId: ALT });

    const [erst] = await rufe(g.url, heim, { schluessel: TRIAL, instanzUmgebung: ALT });

    expect(autoAufrufe(g.anfragen).length).toBe(1);
    expect(erst).toContain(`Your trial Brain ${ALT} no longer exists. cachly created a new, empty Brain for you`);
    expect(erst).toContain(NEU);
    expect(erst).not.toContain('14 days');
    expect(erst).not.toContain('Nothing was lost');
  }, 120_000);

  it('401 auf die Instanz: altes Verhalten, keine Anlage, keine neue Meldung', async () => {
    const g = await starteApi({ alt: 401, auto: { status: 201, body: { instance_id: NEU, created: true } } });
    aufraeumen.push(() => g.server.close());
    const { heim } = neuerHeim();

    const [text] = await rufe(g.url, heim, { schluessel: TRIAL, instanzUmgebung: ALT });

    expect(autoAufrufe(g.anfragen).length).toBe(0);
    expect(text).not.toContain('no longer exists');
    expect(text).not.toContain('Your trial Brain was removed');
  }, 120_000);

  it('Sofort-Test-Konto ohne Instanz, alte Kennung in der Datei: neues Brain, Datei zeigt darauf, Meldung einmal', async () => {
    const g = await starteApi({
      alt: 404,
      grund: 'leer_abgeraeumt',
      liste: { data: [], count: 0 },
      auto: { status: 201, body: { instance_id: NEU, status: 'provisioning', created: true } },
    });
    aufraeumen.push(() => g.server.close());
    const { heim, dateiPfad } = neuerHeim({ apiKey: TRIAL, instanceId: ALT });

    const [text] = await rufe(g.url, heim, { schluessel: TRIAL });

    expect(autoAufrufe(g.anfragen).length).toBe(1);
    expect(text).toContain('Your trial Brain was removed because it stayed empty and unused for 14 days.');
    expect(JSON.parse(readFileSync(dateiPfad, 'utf8')).instanceId).toBe(NEU);
  }, 120_000);
});
