import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Redis } from 'ioredis';
import { MockRedis } from './__tests__/redis-mock.js';
import { handleFedbrainTool } from './handlers/fedbrain.js';
import { keywordSearch } from './search.js';
import { sichereZugang, _zugangZuruecksetzen, type ZugangsAufruf } from './zugang.js';
import { VEKTOR_NACHTRAG, VEKTOR_PRAEFIX, NAME_VEKTOR_PRAEFIX } from './bedeutung.js';
import {
  starteStartwissen, lerneAusGitGeschichte, holeStartwissenHinweis, beanspruchStartwissen,
  ausschlussGrund, waehleProjektOrdner, startwissenGestartet, _startwissenZuruecksetzen,
  STARTWISSEN_MARKE, STARTWISSEN_COMMITS, type StartwissenUmfeld,
} from './startwissen.js';

/*
 * Befund 11.10.2026: Ein frisches Test-Brain antwortete auf das erste
 * smart_recall mit "Nichts Passendes im Bestand". Der Git-Import lief nur auf
 * Zuruf oder synchron im ersten session_start.
 *
 * Diese Tests halten fest: Ein NEU angelegtes Brain lernt im Hintergrund aus
 * der Git-Geschichte — einmal, ohne den Werkzeugaufruf aufzuhalten, nur in
 * einem Repo, nur in ein leeres Brain, mit hoechstens einer Einbettung zur Zeit.
 *
 * Echt sind: git, brain_from_git (handlers/fedbrain.ts), die Ablage im
 * Brain (MockRedis). Nachgebaut ist nur der Einbettungsdienst.
 */

const INSTANZ = 'inst-startwissen';
const ohneFetch = (async () => { throw new Error('kein Netz im Test'); }) as unknown as Parameters<typeof handleFedbrainTool>[3];

const ordner: string[] = [];
function frischerOrdner(): string {
  // realpath: auf macOS ist /var ein Verweis auf /private/var; git meldet den echten Pfad.
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cachly-startwissen-')));
  ordner.push(d);
  return d;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ein kleines echtes Repo mit unterschiedlichen Betreffzeilen (= unterschiedliche Themen). */
function repoMitCommits(betreffe: string[]): string {
  const dir = frischerOrdner();
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'startwissen-test@example.invalid']);
  git(dir, ['config', 'user.name', 'Startwissen Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const b of betreffe) git(dir, ['commit', '--quiet', '--allow-empty', '-m', b]);
  return dir;
}

const BETREFFE = [
  'fix: login token expired after deploy',
  'feat: add invoice export to accounting page',
  'fix: docker build cache busted by version argument',
  'refactor: extract payment gateway client',
  'perf: speed up dashboard query with index',
  'fix: race condition in session cleanup worker',
  'feat: implement webhook retries with backoff',
];

/** Ein Einbettungsdienst, der zaehlt, wie viele Anfragen GLEICHZEITIG laufen. */
function zaehlenderDienst(dauerMs = 5) {
  const stand = { aktiv: 0, hoechstens: 0, anfragen: 0 };
  const einbetten = async (_text: string): Promise<number[]> => {
    stand.aktiv++;
    stand.anfragen++;
    stand.hoechstens = Math.max(stand.hoechstens, stand.aktiv);
    await new Promise((r) => setTimeout(r, dauerMs));
    stand.aktiv--;
    return [0.1, 0.2, 0.3, 0.4];
  };
  return { stand, einbetten };
}

function umfeld(redis: MockRedis, projekt: string, ueber: Partial<StartwissenUmfeld> = {}) {
  const spur = { verbindungen: 0, importe: 0, pausen: 0 };
  const u: StartwissenUmfeld = {
    instanzId: INSTANZ,
    verbindung: async () => { spur.verbindungen++; return redis as unknown as Redis; },
    ausGit: async (a) => { spur.importe++; return handleFedbrainTool('brain_from_git', a, async () => redis as unknown as Redis, ohneFetch); },
    projektOrdner: async () => projekt,
    env: {},
    anlaufMs: 0,
    pauseMs: 0,
    schlafen: async () => { spur.pausen++; },
    protokoll: () => {},
    ...ueber,
  };
  return { u, spur };
}

async function lektionen(redis: MockRedis): Promise<string[]> {
  return new Promise((r) => {
    const s = redis.scanStream({ match: 'cachly:lesson:best:*' });
    s.on('data', (k: string[]) => r(k));
  });
}

beforeEach(() => {
  _startwissenZuruecksetzen();
  _zugangZuruecksetzen();
});

afterEach(() => {
  for (const d of ordner.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows haelt manchmal fest */ }
  }
});

describe('startwissen: ein neues Brain lernt aus der Git-Geschichte', () => {
  it('neues Brain + Git-Repo: der Import startet einmal und haelt den Werkzeugaufruf NICHT an', async () => {
    const redis = new MockRedis();
    const repo = repoMitCommits(BETREFFE);
    const dienst = zaehlenderDienst();

    // Der Import wartet, bis der Test ihn freigibt. Kommt sichereZugang
    // trotzdem zurueck, hat der Werkzeugaufruf nicht auf ihn gewartet.
    let freigeben: () => void = () => {};
    const tor = new Promise<void>((r) => { freigeben = r; });
    const { u, spur } = umfeld(redis, repo, { einbetten: dienst.einbetten });
    const echtAusGit = u.ausGit;
    u.ausGit = async (a) => { await tor; return echtAusGit(a); };

    const laeufe: Array<Promise<unknown>> = [];
    const reihenfolge: string[] = [];
    const aufruf: ZugangsAufruf = {
      schluessel: '',
      konfigurierteInstanz: '',
      werkzeugName: 'smart_recall',
      holeSofortTest: async () => ({ apiKey: 'cky_trial_x', instanzId: INSTANZ }),
      ablagen: {
        setzeSchluessel: () => {}, setEmbedJwt: () => {}, saveApiKey: () => {},
        persistApiKeyToConfig: async () => {}, merkeInstanz: () => {}, persistInstanceIdToConfig: async () => {},
      },
      meldeEreignis: () => {},
      werkzeug: async () => { reihenfolge.push('werkzeug'); return 'ANTWORT'; },
      anmelden: async () => 'ANMELDEN',
      neuesBrain: (id) => { reihenfolge.push(`neuesBrain(${id})`); laeufe.push(starteStartwissen({ ...u, instanzId: id })); },
      protokoll: () => {},
    };

    const antwort = await sichereZugang(aufruf);
    expect(antwort.startsWith('ANTWORT')).toBe(true);
    // Erst die Antwort, dann der Start — und der Import ist noch nicht durch.
    expect(reihenfolge).toEqual(['werkzeug', `neuesBrain(${INSTANZ})`]);
    expect(await lektionen(redis)).toEqual([]);

    // Ein zweiter Start im selben Prozess ist derselbe Lauf.
    expect(starteStartwissen(u)).toBe(laeufe[0]);
    expect(startwissenGestartet(INSTANZ)).toBe(true);

    freigeben();
    const ergebnis = await laeufe[0];
    expect(ergebnis).toMatchObject({ art: 'fertig', ordner: resolve(repo), lektionen: BETREFFE.length, vektoren: BETREFFE.length });
    expect(spur.importe).toBe(1);
    expect((await lektionen(redis)).length).toBe(BETREFFE.length);
    expect(JSON.parse((await redis.get(STARTWISSEN_MARKE))!)).toMatchObject({ stand: 'fertig', lektionen: BETREFFE.length });

    // Die Zahl steht EINMAL an der naechsten Antwort, danach nicht mehr.
    const satz = holeStartwissenHinweis();
    expect(satz).toContain(`learned ${BETREFFE.length} lessons`);
    expect(holeStartwissenHinweis()).toBe('');
  });

  it('kein Git-Repo: nichts — keine Verbindung, kein Import, keine Marke', async () => {
    const redis = new MockRedis();
    const { u, spur } = umfeld(redis, frischerOrdner());
    const ergebnis = await lerneAusGitGeschichte(u);
    expect(ergebnis.art).toBe('kein-repo');
    expect(spur).toMatchObject({ verbindungen: 0, importe: 0 });
    expect(await redis.get(STARTWISSEN_MARKE)).toBeNull();
    expect(holeStartwissenHinweis()).toBe('');
  });

  it('Brain hat schon Lektionen: nichts — kein Import, keine Marke', async () => {
    const redis = new MockRedis();
    await redis.set('cachly:lesson:best:deploy:eigene', JSON.stringify({ topic: 'deploy:eigene', what_worked: 'x' }));
    const { u, spur } = umfeld(redis, repoMitCommits(BETREFFE));
    const ergebnis = await lerneAusGitGeschichte(u);
    expect(ergebnis.art).toBe('hat-lektionen');
    expect(spur.importe).toBe(0);
    expect(await redis.get(STARTWISSEN_MARKE)).toBeNull();
    expect((await lektionen(redis)).length).toBe(1);
  });

  it('Neustart: kein zweiter Import — auch nicht, wenn der erste mittendrin starb', async () => {
    const repo = repoMitCommits(BETREFFE);

    // (a) Voller Lauf, dann neuer Prozess auf demselben Brain.
    const redis = new MockRedis();
    const erster = umfeld(redis, repo, { einbetten: zaehlenderDienst().einbetten });
    expect((await starteStartwissen(erster.u)).art).toBe('fertig');
    _startwissenZuruecksetzen(); // = neuer Prozess
    const zweiter = umfeld(redis, repo);
    expect((await starteStartwissen(zweiter.u)).art).not.toBe('fertig');
    expect(zweiter.spur.importe).toBe(0);
    expect((await lektionen(redis)).length).toBe(BETREFFE.length);

    // (b) Die Marke steht, aber keine Lektion: der erste Prozess starb nach
    // dem Beanspruchen. Die Marke allein verhindert den zweiten Import.
    const leer = new MockRedis();
    await leer.set(STARTWISSEN_MARKE, JSON.stringify({ stand: 'laeuft' }));
    _startwissenZuruecksetzen();
    const dritter = umfeld(leer, repo);
    expect(await starteStartwissen(dritter.u)).toEqual({ art: 'schon-erledigt' });
    expect(dritter.spur.importe).toBe(0);
    expect(await lektionen(leer)).toEqual([]);
  });

  it('hoechstens EINE Einbettungsanfrage zur Zeit, mit Pause davor; jedes Thema vorher im Nachtrag', async () => {
    const redis = new MockRedis();
    const dienst = zaehlenderDienst(15);
    const nachtragBeimErstenAufruf: string[][] = [];
    const einbetten = async (t: string) => {
      if (dienst.stand.anfragen === 0) nachtragBeimErstenAufruf.push(await redis.smembers(VEKTOR_NACHTRAG));
      return dienst.einbetten(t);
    };
    const { u, spur } = umfeld(redis, repoMitCommits(BETREFFE), { einbetten });
    const ergebnis = await lerneAusGitGeschichte(u);

    expect(ergebnis).toMatchObject({ art: 'fertig', lektionen: BETREFFE.length, vektoren: BETREFFE.length });
    expect(dienst.stand.hoechstens).toBe(1);
    // Volltext + Themenname je Lektion, und vor jeder Anfrage eine Pause.
    expect(dienst.stand.anfragen).toBe(2 * BETREFFE.length);
    expect(spur.pausen).toBeGreaterThanOrEqual(dienst.stand.anfragen);
    // Write-ahead: alle Themen standen im Nachtrag, bevor die erste Anfrage lief ...
    expect(nachtragBeimErstenAufruf[0]!.length).toBe(BETREFFE.length);
    // ... und sind nach dem geschriebenen Vektor wieder ausgetragen.
    expect(await redis.smembers(VEKTOR_NACHTRAG)).toEqual([]);
    const themen = (await lektionen(redis)).map((k) => k.slice('cachly:lesson:best:'.length));
    for (const t of themen) {
      expect(await redis.get(`${VEKTOR_PRAEFIX}${t}`)).not.toBeNull();
      expect(await redis.get(`${NAME_VEKTOR_PRAEFIX}${t}`)).not.toBeNull();
    }
  });

  it('Dienst faellt aus: die Lektionen bleiben, die Themen bleiben im Nachtrag, nach 3 Fehlern ist Schluss', async () => {
    const redis = new MockRedis();
    let anfragen = 0;
    const { u } = umfeld(redis, repoMitCommits(BETREFFE), {
      einbetten: async () => { anfragen++; throw new Error('503'); },
    });
    const ergebnis = await lerneAusGitGeschichte(u);
    expect(ergebnis).toMatchObject({ art: 'fertig', lektionen: BETREFFE.length, vektoren: 0 });
    expect(anfragen).toBe(3);
    expect((await redis.smembers(VEKTOR_NACHTRAG)).length).toBe(BETREFFE.length);
  });

  it(`hoechstens ${STARTWISSEN_COMMITS} Commits`, async () => {
    const redis = new MockRedis();
    const viele = Array.from({ length: STARTWISSEN_COMMITS + 5 }, (_, i) => `feat: module number${i} alpha${i} beta${i}`);
    const { u } = umfeld(redis, repoMitCommits(viele));
    const ergebnis = await lerneAusGitGeschichte(u);
    expect(ergebnis).toMatchObject({ art: 'fertig', lektionen: STARTWISSEN_COMMITS });
  });

  it('der synchrone Weg im ersten session_start bekommt die Marke nicht mehr', async () => {
    const redis = new MockRedis();
    const { u } = umfeld(redis, repoMitCommits(BETREFFE));
    await starteStartwissen(u);
    expect(await beanspruchStartwissen(redis as unknown as Redis, 'sitzungsstart')).toBe(false);
    expect(await beanspruchStartwissen(new MockRedis() as unknown as Redis, 'sitzungsstart')).toBe(true);
  });

  it('brain_from_git entwertet den Wortindex: die neuen Lektionen sind sofort findbar, nicht erst nach 60 s', async () => {
    const redis = new MockRedis();
    const r = redis as unknown as Redis;
    const muster = ['cachly:ctx:*', 'cachly:lesson:best:*', 'cachly:idx:*']; // die Muster von smart_recall
    // Ein nicht leerer Bestand (z. B. vom automatischen index_project) steht schon.
    await redis.set('cachly:idx:README.md', 'File: README.md\nProject overview and setup');
    expect(await keywordSearch(r, muster, 'invoice export accounting', 5)).toEqual([]);

    await handleFedbrainTool('brain_from_git', { instance_id: INSTANZ, repo_path: repoMitCommits(BETREFFE), limit: 30 }, async () => r, ohneFetch);

    const treffer = await keywordSearch(r, muster, 'invoice export accounting', 5);
    expect(treffer.map((t) => t.key)).toContain('cachly:lesson:best:feat:feat-invoice-export');
  });

  it('kein Satz, wenn der Import nichts anlegt', async () => {
    const redis = new MockRedis();
    const repo = frischerOrdner();
    git(repo, ['init', '--quiet']); // Repo ohne einen einzigen Commit
    const { u } = umfeld(redis, repo);
    const ergebnis = await lerneAusGitGeschichte(u);
    expect(ergebnis).toMatchObject({ art: 'fertig', lektionen: 0 });
    expect(holeStartwissenHinweis()).toBe('');
  });
});

describe('startwissen: welcher Ordner ist das Projekt', () => {
  const dateiPfad = (uri: string) => uri.replace(/^file:\/\//, '');

  it('die Wurzel des Clients (MCP roots) geht vor Umgebung und cwd', () => {
    expect(waehleProjektOrdner({
      wurzeln: [{ uri: 'https://example.invalid/x' }, { uri: 'file:///projekt' }],
      env: { CLAUDE_PROJECT_DIR: '/env' }, cwd: '/cwd', dateiPfad,
    })).toBe('/projekt');
  });

  it('ohne Wurzeln: CLAUDE_PROJECT_DIR, dann CACHLY_WORKSPACE, dann cwd; Platzhalter zaehlen nicht', () => {
    expect(waehleProjektOrdner({ env: { CLAUDE_PROJECT_DIR: '/a', CACHLY_WORKSPACE: '/b' }, cwd: '/c', dateiPfad })).toBe('/a');
    expect(waehleProjektOrdner({ env: { CLAUDE_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', CACHLY_WORKSPACE: '/b' }, cwd: '/c', dateiPfad })).toBe('/b');
    expect(waehleProjektOrdner({ env: {}, cwd: '/c', dateiPfad })).toBe('/c');
  });

  it('Plugin-, Paket- und Heimordner sind nicht das Projekt des Nutzers', () => {
    const heim = resolve('/heim/nutzer');
    expect(ausschlussGrund(resolve('/plugins/cachly/sub'), { CLAUDE_PLUGIN_ROOT: resolve('/plugins/cachly'), HOME: heim })).toBe('plugin-ordner');
    expect(ausschlussGrund(resolve('/x/node_modules/@cachly-dev/mcp-server'), { HOME: heim })).toBe('paketordner');
    expect(ausschlussGrund(resolve('/cache/_npx/abc'), { HOME: heim })).toBe('paketordner');
    expect(ausschlussGrund(heim, { HOME: heim })).toBe('heimordner');
    expect(ausschlussGrund(resolve('/heim/nutzer/projekt'), { HOME: heim, CLAUDE_PLUGIN_ROOT: resolve('/plugins/cachly') })).toBe('');
  });

  it('ein ausgeschlossener Ordner: kein Import', async () => {
    const redis = new MockRedis();
    const repo = repoMitCommits(BETREFFE);
    const { u, spur } = umfeld(redis, repo, { env: { CLAUDE_PLUGIN_ROOT: repo } });
    expect((await lerneAusGitGeschichte(u)).art).toBe('ausgeschlossen');
    expect(spur).toMatchObject({ verbindungen: 0, importe: 0 });
  });
});
