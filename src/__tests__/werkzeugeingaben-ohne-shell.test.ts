/**
 * Werkzeugeingaben laufen nicht durch eine Shell.
 *
 * Vorher setzten session_start, session_end und brain_from_git `workspace_path`,
 * `branch`, `since` und einen Hash in eine Befehlszeile (`execSync(\`git -C "${pfad}" ...\`)`).
 * Die Shell des Nutzers deutete dann Zeichen, die als Pfad gemeint waren. Dazu
 * schrieben brain_watch und cls_install_hooks die `instance_id` ungeprueft in
 * ein Hook-Skript, das bei jedem Commit laeuft.
 *
 * Die Proben fuehren die Werkzeuge wirklich aus (echter Git-Ordner, echte
 * Prozesse) und legen eine Marker-Datei als Zeuge aus: Ein Aufruf, der durch die
 * Shell liefe, wuerde ein kleines Node-Skript starten, das den Marker schreibt.
 * Die Proben sind GEGENPROBEN-tauglich: gegen den alten Stand sind sie rot.
 *
 * Run: npx vitest run src/__tests__/werkzeugeingaben-ohne-shell.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { handleFedbrainTool } from '../handlers/fedbrain.js';
import { buildClsPostCommitHook } from '../cls-hook.js';
import { installBrainWatchHook } from '../brain-watch-hook.js';
import { browserAdresse, fuerCmd } from '../browser-adresse.js';
import {
  alsShellWort, beginntMitBindestrich, gitLesen, instanzIdFuerSkript, istCommitHash, pruefeOrdner,
  schluesselFuerSkript,
} from '../git-ohne-shell.js';
import { MockRedis } from './redis-mock.js';

const INSTANCE = 'test-ohne-shell-instanz';
const NO_FETCH = (async () => { throw new Error('no fetch'); }) as unknown as Parameters<typeof handleBrainTool>[3];
const getConn = (redis: MockRedis) => (async (_id: string) => redis as unknown as Redis);

// ── Werkstatt: ein Wegwerf-Ordner, ein Marker-Skript, ein echtes Repo ─────────

let werkstatt: string;
let markerDatei: string;
let markerSkript: string;

beforeEach(() => {
  werkstatt = mkdtempSync(join(tmpdir(), 'cachly-ohne-shell-'));
  markerDatei = join(werkstatt, 'MARKER');
  markerSkript = join(werkstatt, 'marker.mjs');
  // Das Skript ist der Zeuge: laeuft es, existiert danach die Marker-Datei.
  writeFileSync(markerSkript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerDatei)}, 'ausgefuehrt');`);
});

afterEach(() => {
  rmSync(werkstatt, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Ein Repo mit einem Commit, dessen Begruendung lang genug fuer eine Lektion ist. */
function repoAnlegen(ordnername: string): string {
  const dir = join(werkstatt, ordnername);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'ohne-shell@example.invalid']);
  git(dir, ['config', 'user.name', 'Ohne Shell']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'a.txt'), 'x');
  git(dir, ['add', 'a.txt']);
  const begruendung = 'Ursache war ein falscher Zeitstempel-Vergleich gegen Mikrosekunden statt Sekunden. '.repeat(3);
  git(dir, ['commit', '--quiet', '-m', `fix: Zeitstempel-Vergleich repariert\n\n${begruendung}`]);
  return dir;
}

/**
 * Eingaben, die als Pfad gemeint sind, aber Shell-Zeichen tragen.
 *
 * Als Funktionen, die ERST IM TEST aufgerufen werden: Skript- und Marker-Pfad
 * entstehen in beforeEach. Wer die Texte beim Einsammeln der Tests baut, setzt
 * "undefined" ein, die Probe startet nie ein Skript und ist immer gruen (so
 * geschehen im ersten Entwurf; die Gegenprobe gegen den alten Stand hat es
 * gezeigt).
 */
const BOESE_PFADE: Record<string, (skript: string, marker: string) => string> = {
  // Funktioniert in sh UND in cmd.exe (Windows): git scheitert, dann laeuft das Skript.
  'oder-kette': (s) => `nirgendwo" || node "${s}" || "`,
  'semikolon': (s) => `nirgendwo"; node "${s}"; "`,
  'befehlsersetzung': (s) => `$(node "${s}")`,
  'backticks': (s) => `\`node "${s}"\``,
  'zeilenumbruch': (s) => `nirgendwo"\nnode "${s}"\n"`,
  'touch-marker': (_s, m) => `nirgendwo; touch ${m}`,
};
const boesesPfadNamen = Object.keys(BOESE_PFADE);
const boeserPfad = (name: string): string => BOESE_PFADE[name]!(markerSkript, markerDatei);

// ── session_end ───────────────────────────────────────────────────────────────

describe('session_end · workspace_path geht nicht durch eine Shell', () => {
  it('ZEUGE: das Marker-Skript schreibt wirklich die Marker-Datei, und jede Eingabe nennt es', () => {
    // Ohne diese Probe koennten alle "fuehrt nichts aus"-Proben gruen sein, weil
    // der Zeuge nie laeuft (im ersten Entwurf stand "undefined" im Befehl).
    expect(existsSync(markerDatei)).toBe(false);
    execFileSync(process.execPath, [markerSkript]);
    expect(existsSync(markerDatei)).toBe(true);
    rmSync(markerDatei);
    for (const name of boesesPfadNamen) {
      const pfad = boeserPfad(name);
      expect(pfad, name).not.toContain('undefined');
      expect(pfad.includes(markerSkript) || pfad.includes(markerDatei), name).toBe(true);
    }
  });

  async function sessionEnde(redis: MockRedis, workspacePath: string): Promise<string> {
    await redis.set('cachly:session:current', JSON.stringify({ started: new Date(Date.now() - 5 * 60_000).toISOString() }));
    return String(await handleBrainTool(
      'session_end',
      { instance_id: INSTANCE, summary: 'Probe ohne Shell.', workspace_path: workspacePath, files_changed: [] },
      getConn(redis),
      NO_FETCH,
    ));
  }

  for (const name of boesesPfadNamen) {
    it(`Pfad "${name}" fuehrt nichts aus und legt keine Marker-Datei an`, async () => {
      const redis = new MockRedis();
      const antwort = await sessionEnde(redis, boeserPfad(name));
      expect(antwort).toContain('Session saved');
      expect(existsSync(markerDatei), 'Marker-Datei existiert: der Pfad wurde von einer Shell gedeutet').toBe(false);
    });
  }

  it('ein normaler Pfad funktioniert weiter: der Commit wird zur Lektion', async () => {
    const dir = repoAnlegen('normal');
    const redis = new MockRedis();
    await sessionEnde(redis, dir);
    expect((await alleLektionsSchluessel(redis)).length).toBe(1);
  });

  it('ein Pfad mit Leerzeichen und Shell-Zeichen im NAMEN funktioniert (Windows: C:\\Users\\Max Mustermann)', async () => {
    // Auf Windows sind ; & ( ) $ ' ! im Ordnernamen erlaubt, auf Linux auch.
    const dir = repoAnlegen("mit Leerzeichen; amp&(klammer) $x 'y' !z");
    const redis = new MockRedis();
    await sessionEnde(redis, dir);
    expect((await alleLektionsSchluessel(redis)).length).toBe(1);
    expect(existsSync(markerDatei)).toBe(false);
  });

  it('ein Pfad, der kein Ordner ist, wird uebergangen, ohne Absturz', async () => {
    const redis = new MockRedis();
    const antwort = await sessionEnde(redis, join(werkstatt, 'marker.mjs'));
    expect(antwort).toContain('Session saved');
    expect((await alleLektionsSchluessel(redis)).length).toBe(0);
  });
});

async function alleLektionsSchluessel(redis: MockRedis): Promise<string[]> {
  const [, keys] = await redis.scan('0', 'MATCH', 'cachly:lesson:best:git:*', 'COUNT', 1000);
  return keys;
}

// ── session_start ─────────────────────────────────────────────────────────────

describe('session_start · workspace_path geht nicht durch eine Shell', () => {
  for (const name of boesesPfadNamen) {
    it(`Pfad "${name}" fuehrt nichts aus`, async () => {
      const redis = new MockRedis();
      await handleBrainTool(
        'session_start',
        { instance_id: INSTANCE, focus: 'probe', workspace_path: boeserPfad(name) },
        getConn(redis),
        NO_FETCH,
      );
      expect(existsSync(markerDatei), 'Marker-Datei existiert: der Pfad wurde von einer Shell gedeutet').toBe(false);
    });
  }

  it('ein normaler Pfad mit Leerzeichen liefert die Git-Rekonstruktion', async () => {
    const dir = repoAnlegen('start mit leerzeichen');
    const redis = new MockRedis();
    const antwort = String(await handleBrainTool(
      'session_start',
      { instance_id: INSTANCE, focus: 'probe', workspace_path: dir },
      getConn(redis),
      NO_FETCH,
    ));
    expect(antwort).toContain('Git reconstruction');
    expect(antwort).toContain('Zeitstempel-Vergleich repariert');
  });
});

// ── brain_from_git ────────────────────────────────────────────────────────────

describe('brain_from_git · branch, since und repo_path gehen nicht durch eine Shell', () => {
  async function ausfuehren(args: Record<string, unknown>): Promise<string> {
    const redis = new MockRedis();
    try {
      return String(await handleFedbrainTool(
        'brain_from_git',
        { instance_id: INSTANCE, incremental: false, ...args },
        getConn(redis),
        NO_FETCH,
      ));
    } catch (e) {
      // Nach dem Git-Aufruf darf die Weiterverarbeitung am Mock scheitern; die Probe gilt dem Git-Aufruf.
      return `AUSNAHME ${(e as Error).message}`;
    }
  }

  const boeseRevisionen: Record<string, string> = {
    'oder-kette': `nirgendwo || node "${'MARKERSKRIPT'}"`,
    'semikolon': `HEAD; node "${'MARKERSKRIPT'}"`,
    'befehlsersetzung': `$(node "${'MARKERSKRIPT'}")`,
    'zeilenumbruch': `HEAD\nnode "${'MARKERSKRIPT'}"`,
  };

  for (const [name, vorlage] of Object.entries(boeseRevisionen)) {
    it(`branch "${name}" fuehrt nichts aus`, async () => {
      const dir = repoAnlegen('repo');
      await ausfuehren({ repo_path: dir, branch: vorlage.replace('MARKERSKRIPT', markerSkript) });
      expect(existsSync(markerDatei)).toBe(false);
    });

    it(`since "${name}" fuehrt nichts aus`, async () => {
      const dir = repoAnlegen('repo');
      await ausfuehren({ repo_path: dir, since: vorlage.replace('MARKERSKRIPT', markerSkript) });
      expect(existsSync(markerDatei)).toBe(false);
    });
  }

  for (const name of boesesPfadNamen) {
    it(`repo_path "${name}" fuehrt nichts aus und meldet "kein Repo"`, async () => {
      const antwort = await ausfuehren({ repo_path: boeserPfad(name) });
      expect(antwort).toContain('Not a git repository');
      expect(existsSync(markerDatei)).toBe(false);
    });
  }

  it('since bricht nicht aus seinen Anfuehrungszeichen aus', async () => {
    const dir = repoAnlegen('repo');
    // "&&": der Git-Aufruf davor gelingt, also laeuft die Kette in sh und cmd.exe weiter.
    for (const since of [`x" && node "${markerSkript}" && "`, `x"; node "${markerSkript}"; "`]) {
      await ausfuehren({ repo_path: dir, since });
      expect(existsSync(markerDatei), since).toBe(false);
    }
  });

  it('branch als Option (--output=<datei>) wird abgelehnt, es entsteht keine Datei', async () => {
    const dir = repoAnlegen('repo');
    const ziel = join(werkstatt, 'ausgabe.txt');
    const antwort = await ausfuehren({ repo_path: dir, branch: `--output=${ziel}` });
    expect(antwort).toContain('Ungueltiger');
    expect(existsSync(ziel)).toBe(false);
  });

  it('ein Repo in einem Ordner mit Leerzeichen wird gelesen (kein "Not a git repository")', async () => {
    const dir = repoAnlegen('repo mit leerzeichen & amp');
    const antwort = await ausfuehren({ repo_path: dir });
    expect(antwort).not.toContain('Not a git repository');
    expect(antwort).not.toContain('git log failed');
  });
});

// ── Hook-Skripte und Befehlsbloecke ───────────────────────────────────────────

describe('Hook-Skripte · instance_id und Schluessel bleiben frei von Shell-Zeichen', () => {
  const boese = [
    'x"; node marker.mjs; "',
    'x$(node marker.mjs)',
    'x`node marker.mjs`',
    'x\nnode marker.mjs',
    'x" || node marker.mjs || "',
    '',
  ];

  for (const wert of boese) {
    it(`cls-Hook lehnt instance_id ${JSON.stringify(wert)} ab`, () => {
      expect(() => buildClsPostCommitHook(wert)).toThrow(/instance_id/);
    });
    it(`brain_watch-Hook lehnt instance_id ${JSON.stringify(wert)} ab`, async () => {
      await expect(installBrainWatchHook(tmpdir(), wert)).rejects.toThrow(/instance_id/);
    });
  }

  it('cls-Hook schreibt keinen Schluessel', () => {
    expect(buildClsPostCommitHook('inst-1', 'k"; node x; "')).not.toContain('node x');
  });

  it('echte Werte gehen durch: UUID als ID, cky_live_… und JWT als Schluessel', () => {
    const uuid = '8e03addd-a2d9-406e-bcbb-d6d8c938a3d0';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXI';
    expect(buildClsPostCommitHook(uuid, 'cky_live_abc123')).toContain(`CACHLY_BRAIN_INSTANCE_ID="${uuid}"`);
    expect(buildClsPostCommitHook(uuid, jwt)).not.toContain(jwt);
  });

  it('cls_install_hooks lehnt eine boese instance_id ab und quotet repo_path als ein Wort', async () => {
    await expect(handleFedbrainTool(
      'cls_install_hooks',
      { instance_id: 'x"; node marker.mjs; "', repo_path: '.' },
      getConn(new MockRedis()),
      NO_FETCH,
    )).rejects.toThrow(/instance_id/);

    const text = String(await handleFedbrainTool(
      'cls_install_hooks',
      { instance_id: 'inst-1', repo_path: "/tmp/x'; touch /tmp/pwned; '" },
      getConn(new MockRedis()),
      NO_FETCH,
    ));
    // Das einfache Anfuehrungszeichen ist als '\'' gesetzt: der Pfad bleibt EIN Wort.
    expect(text).toContain(`touch '/tmp/x'\\''; touch /tmp/pwned; '\\''/.git/hooks/post-commit'`);
  });
});

// ── Bausteine ─────────────────────────────────────────────────────────────────

describe('pruefeOrdner', () => {
  it('lehnt Nicht-Texte, leere Texte, NUL, fehlende Pfade und Dateien ab', () => {
    expect(pruefeOrdner(undefined)).toBeNull();
    expect(pruefeOrdner(42)).toBeNull();
    expect(pruefeOrdner('')).toBeNull();
    expect(pruefeOrdner(`${werkstatt}\0evil`)).toBeNull();
    expect(pruefeOrdner(join(werkstatt, 'gibt-es-nicht'))).toBeNull();
    expect(pruefeOrdner(markerSkript)).toBeNull();
  });

  it('nimmt Ordner mit Leerzeichen an und liefert einen absoluten Pfad', () => {
    const dir = join(werkstatt, 'mit Leerzeichen');
    mkdirSync(dir);
    expect(pruefeOrdner(dir)).toBe(dir);
    const rel = pruefeOrdner('.');
    expect(rel).not.toBeNull();
    expect(rel).toBe(process.cwd());
  });
});

describe('gitLesen', () => {
  it('ein Argument mit Shell-Zeichen bleibt EIN Argument: Git meldet "unbekannte Revision", nichts laeuft', () => {
    const dir = repoAnlegen('repo');
    expect(() => gitLesen(dir, ['log', '-1', `nirgendwo; node "${markerSkript}"`])).toThrow();
    expect(() => gitLesen(dir, ['log', '-1', `$(node "${markerSkript}")`])).toThrow();
    expect(existsSync(markerDatei)).toBe(false);
  });

  it('liest einen normalen Aufruf', () => {
    const dir = repoAnlegen('repo');
    expect(gitLesen(dir, ['log', '-1', '--format=%s']).trim()).toBe('fix: Zeitstempel-Vergleich repariert');
  });
});

describe('Kleinteile', () => {
  it('istCommitHash nimmt nur Hex von 7 bis 64 Zeichen', () => {
    expect(istCommitHash('a'.repeat(40))).toBe(true);
    expect(istCommitHash('abc1234')).toBe(true);
    expect(istCommitHash('abc123')).toBe(false);
    expect(istCommitHash('abc1234; node x')).toBe(false);
    expect(istCommitHash('--output=x')).toBe(false);
    expect(istCommitHash(undefined)).toBe(false);
  });

  it('beginntMitBindestrich erkennt Optionen', () => {
    expect(beginntMitBindestrich('--output=x')).toBe(true);
    expect(beginntMitBindestrich('-n')).toBe(true);
    expect(beginntMitBindestrich('main')).toBe(false);
    expect(beginntMitBindestrich('feature/x')).toBe(false);
  });

  it('instanzIdFuerSkript und schluesselFuerSkript', () => {
    expect(instanzIdFuerSkript('8e03addd-a2d9-406e-bcbb-d6d8c938a3d0')).toBe('8e03addd-a2d9-406e-bcbb-d6d8c938a3d0');
    expect(() => instanzIdFuerSkript('a b')).toThrow();
    expect(() => instanzIdFuerSkript(undefined)).toThrow();
    expect(schluesselFuerSkript('cky_live_Abc-1.2~3')).toBe('cky_live_Abc-1.2~3');
    expect(() => schluesselFuerSkript('a"b')).toThrow();
  });

  it('alsShellWort: eine echte Shell liest den Text unveraendert zurueck', () => {
    const texte = ["a'b", 'a"b', 'a$(b)c', 'a`b`c', 'a;b', 'a\nb', 'a b', "'", ''];
    let sh = true;
    try { execFileSync('sh', ['-c', 'true']); } catch { sh = false; }
    if (!sh) return; // keine sh auf dieser Maschine: die Form wird unten geprueft
    for (const t of texte) {
      const aus = execFileSync('sh', ['-c', `printf %s ${alsShellWort(t)}`], { encoding: 'utf8' });
      expect(aus).toBe(t);
    }
  });

  it('alsShellWort: Form', () => {
    expect(alsShellWort("a'b")).toBe(`'a'\\''b'`);
    expect(alsShellWort('x y')).toBe(`'x y'`);
  });
});

describe('Browser oeffnen · nur http(s), cmd-Zeichen entwertet', () => {
  it('nimmt Webadressen an', () => {
    expect(browserAdresse('https://auth.cachly.dev/realms/x/device?user_code=ABCD-EFGH'))
      .toBe('https://auth.cachly.dev/realms/x/device?user_code=ABCD-EFGH');
    expect(browserAdresse('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/');
  });

  it('lehnt Dateien, Programme und andere Schemata ab', () => {
    for (const s of ['calc.exe', 'file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\System32\\calc.exe',
      'javascript:alert(1)', 'ms-msdt:/id', '', 'mailto:a@b.c']) {
      expect(browserAdresse(s), s).toBeNull();
    }
    expect(browserAdresse(undefined)).toBeNull();
  });

  it('fuerCmd setzt ein ^ vor & | < > ^', () => {
    expect(fuerCmd('https://x/?a=1&b=2')).toBe('https://x/?a=1^&b=2');
    expect(fuerCmd('https://x/?a=1|b<c>d^e')).toBe('https://x/?a=1^|b^<c^>d^^e');
    expect(fuerCmd('https://x/plain')).toBe('https://x/plain');
  });
});

// ── Waechter: im Quelltext steht keine Shell mehr ─────────────────────────────

/** Zeilen, die eine Shell einschalten: execSync/exec aus child_process, `shell: true`. */
function findeShellAufrufe(quelltext: string): string[] {
  const treffer: string[] = [];
  for (const zeile of quelltext.split('\n')) {
    const t = zeile.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue; // Kommentare
    if (/\bexecSync\s*\(/.test(t) || /\bshell\s*:\s*true\b/.test(t) || /\bimport\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*'(?:node:)?child_process'/.test(t)) {
      treffer.push(t);
    }
  }
  return treffer;
}

describe('Waechter · kein execSync, kein exec, kein shell:true im Produktcode', () => {
  const srcOrdner = join(dirname(fileURLToPath(import.meta.url)), '..');

  function quelldateien(ordner: string): string[] {
    const aus: string[] = [];
    for (const eintrag of readdirSync(ordner, { withFileTypes: true })) {
      const pfad = join(ordner, eintrag.name);
      if (eintrag.isDirectory()) {
        if (eintrag.name === '__tests__' || eintrag.name === 'bench' || eintrag.name === 'node_modules') continue;
        aus.push(...quelldateien(pfad));
      } else if (/\.ts$/.test(eintrag.name) && !/\.test\.ts$/.test(eintrag.name)) {
        aus.push(pfad);
      }
    }
    return aus;
  }

  it('GEGENPROBE: der Waechter erkennt die alten Muster', () => {
    expect(findeShellAufrufe("const x = execSync(`git -C \"${p}\" log`);")).toHaveLength(1);
    expect(findeShellAufrufe("spawn(kommando, { shell: true });")).toHaveLength(1);
    expect(findeShellAufrufe("import { exec } from 'node:child_process';")).toHaveLength(1);
    expect(findeShellAufrufe("// execSync( steht nur im Kommentar")).toHaveLength(0);
    expect(findeShellAufrufe("execFileSync('git', args)")).toHaveLength(0);
  });

  it('GEGENPROBE: er liest wirklich Dateien (mehr als 20, darunter brain.ts)', () => {
    const dateien = quelldateien(srcOrdner);
    expect(dateien.length).toBeGreaterThan(20);
    expect(dateien.some((d) => d.endsWith(join('handlers', 'brain.ts')))).toBe(true);
  });

  it('keine Quelldatei ruft execSync auf oder schaltet eine Shell ein', () => {
    const funde: string[] = [];
    for (const datei of quelldateien(srcOrdner)) {
      for (const zeile of findeShellAufrufe(readFileSync(datei, 'utf8'))) funde.push(`${datei}: ${zeile}`);
    }
    expect(funde).toEqual([]);
  });
});
