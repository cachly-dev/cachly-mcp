// Remote-MCP (HTTP-Modus): wem gehoert diese Anfrage?
//
// ── Warum es das gibt (18.11.2026) ───────────────────────────────────────────
//
// Hinter https://mcp.cachly.dev/mcp stand bis heute ein Server ohne Schluessel:
// er zeigte die Werkzeugliste und hatte kein Brain. Jetzt bringt der Aufrufer
// seinen Schluessel im Kopf mit (`Authorization: Bearer cky_...`) und bekommt
// SEIN Brain. Dann laufen aber Anfragen mehrerer Menschen im selben Prozess.
// Alles, was im stdio-Modus "der Schluessel dieses Prozesses" war, muss hier
// "der Schluessel DIESER Anfrage" werden — sonst sieht A das Brain von B.
//
// Diese Datei enthaelt nur die Teile, die sich ohne Netz pruefen lassen:
// Kopf lesen, Kontext je Anfrage (AsyncLocalStorage), Pool-Schluessel, ein
// begrenzter Speicher mit Ablaufzeit.
//
// Was NICHT hier steht: der Aufruf der API. Die API entscheidet, ob ein
// Schluessel eine Instanz sehen darf. Dieser Server entscheidet das nie selbst.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { KERNWERKZEUGE } from './werkzeug-auswahl.js';

// ── Kontext je Anfrage ───────────────────────────────────────────────────────

export interface MandantKontext {
  /** Der Schluessel dieser Anfrage. Nie loggen, nie in eine Antwort schreiben. */
  readonly schluessel: string;
  /** sha256 des Schluessels, hex. Darf in Schluesseln von Speichern stehen. */
  readonly schluesselHash: string;
  /** Die Instanz, die die API fuer diesen Schluessel freigegeben hat. */
  readonly instanzId: string;
}

const speicher = new AsyncLocalStorage<MandantKontext>();
let mehrmandant = false;

/** Schaltet den HTTP-Modus ein: ab jetzt gilt nur noch der Schluessel der Anfrage. */
export function setzeMehrmandant(an: boolean): void {
  mehrmandant = an;
}

/** Laeuft der Prozess als gemeinsamer Server fuer viele Schluessel? */
export function istMehrmandant(): boolean {
  return mehrmandant;
}

/** Der Kontext der laufenden Anfrage, oder undefined (stdio, oder kein Kopf). */
export function mandantKontext(): MandantKontext | undefined {
  return speicher.getStore();
}

/** Fuehrt `fn` mit diesem Kontext aus. Alles, was daraus async startet, erbt ihn. */
export function imMandant<T>(kontext: MandantKontext, fn: () => T): T {
  return speicher.run(kontext, fn);
}

export function hashDesSchluessels(schluessel: string): string {
  return createHash('sha256').update(schluessel).digest('hex');
}

export function baueKontext(schluessel: string, instanzId: string): MandantKontext {
  return { schluessel, schluesselHash: hashDesSchluessels(schluessel), instanzId };
}

/**
 * Schluessel des Verbindungs-Pools im HTTP-Modus: Hash UND Instanz.
 * Nie nur die Instanz — sonst bekaeme ein fremder Schluessel die offene
 * Verbindung, die ein anderer bezahlt hat.
 */
export function poolSchluessel(schluessel: string, instanzId: string): string {
  return `${hashDesSchluessels(schluessel)}:${instanzId}`;
}

// ── Kopf lesen ───────────────────────────────────────────────────────────────

/** Laenger darf der Authorization-Kopf nicht sein. Ein cky_-Schluessel hat ~50 Zeichen. */
export const MAX_AUTH_KOPF = 256;
const SCHLUESSEL_FORM = /^cky_[A-Za-z0-9_-]{8,200}$/;
const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KopfErgebnis =
  | { art: 'fehlt' }
  | { art: 'abgelehnt'; grund: 'zu-lang' | 'mehrfach' | 'kein-bearer' | 'form' }
  | { art: 'ok'; schluessel: string };

/**
 * Liest `Authorization: Bearer cky_...`. Nur Bearer, nur cky_-Schluessel, hoechstens
 * 256 Zeichen. Der Grund einer Ablehnung enthaelt nie den Kopf selbst.
 */
export function leseBearer(kopf: string | string[] | undefined): KopfErgebnis {
  if (kopf === undefined) return { art: 'fehlt' };
  if (Array.isArray(kopf)) {
    // req.headersDistinct liefert immer eine Liste; Node selbst behaelt sonst nur
    // den ersten Kopf (Sicherheitsabnahme #1120, Fund 4).
    if (kopf.length > 1) return { art: 'abgelehnt', grund: 'mehrfach' };
    kopf = kopf[0];
    if (kopf === undefined) return { art: 'fehlt' };
  }
  if (kopf.trim() === '') return { art: 'fehlt' };
  if (kopf.length > MAX_AUTH_KOPF) return { art: 'abgelehnt', grund: 'zu-lang' };
  const m = /^Bearer[ \t]+(\S+)$/i.exec(kopf.trim());
  if (!m) return { art: 'abgelehnt', grund: 'kein-bearer' };
  if (!SCHLUESSEL_FORM.test(m[1])) return { art: 'abgelehnt', grund: 'form' };
  return { art: 'ok', schluessel: m[1] };
}

export type InstanzKopf =
  | { art: 'fehlt' }
  | { art: 'abgelehnt' }
  | { art: 'ok'; instanzId: string };

/** Liest `X-Cachly-Instance: <uuid>`. Alles ausser einer UUID wird abgelehnt. */
export function leseInstanzKopf(kopf: string | string[] | undefined): InstanzKopf {
  if (kopf === undefined) return { art: 'fehlt' };
  if (Array.isArray(kopf)) return { art: 'abgelehnt' };
  const t = kopf.trim();
  if (t === '') return { art: 'fehlt' };
  if (t.length > 36 || !UUID_FORM.test(t)) return { art: 'abgelehnt' };
  return { art: 'ok', instanzId: t.toLowerCase() };
}

// ── Begrenzter Speicher mit Ablaufzeit ───────────────────────────────────────

export interface SpeicherOptionen<V> {
  /** Hoechstens so viele Eintraege; der am laengsten ungenutzte geht zuerst. */
  max: number;
  /** Ein Eintrag gilt so lange, gerechnet ab dem Anlegen (NICHT ab dem letzten Zugriff). */
  ttlMs: number;
  /** Wird aufgerufen, wenn ein Eintrag wegen Alter oder Platz geht (z. B. Verbindung schliessen). */
  beiEntfernen?: (wert: V, grund: 'abgelaufen' | 'verdraengt' | 'geloescht') => void;
  /** Zeitquelle, fuer Tests. */
  jetzt?: () => number;
}

/**
 * LRU mit fester Lebensdauer. Die Lebensdauer zaehlt ab dem Anlegen: ein Schluessel,
 * der widerrufen wird, soll nach ttlMs ueber die API neu geprueft werden — auch wenn
 * er jede Sekunde benutzt wird.
 */
export class BegrenzterSpeicher<V> {
  private readonly eintraege = new Map<string, { wert: V; bis: number }>();
  private readonly jetzt: () => number;

  constructor(private readonly opt: SpeicherOptionen<V>) {
    this.jetzt = opt.jetzt ?? Date.now;
  }

  get groesse(): number {
    return this.eintraege.size;
  }

  has(schluessel: string): boolean {
    return this.get(schluessel) !== undefined;
  }

  get(schluessel: string): V | undefined {
    const e = this.eintraege.get(schluessel);
    if (!e) return undefined;
    if (e.bis <= this.jetzt()) {
      this.eintraege.delete(schluessel);
      this.opt.beiEntfernen?.(e.wert, 'abgelaufen');
      return undefined;
    }
    // Als zuletzt benutzt markieren (Map behaelt die Einfuege-Reihenfolge).
    this.eintraege.delete(schluessel);
    this.eintraege.set(schluessel, e);
    return e.wert;
  }

  set(schluessel: string, wert: V, ttlMs: number = this.opt.ttlMs): void {
    const alt = this.eintraege.get(schluessel);
    if (alt && alt.wert !== wert) this.opt.beiEntfernen?.(alt.wert, 'geloescht');
    this.eintraege.delete(schluessel);
    this.eintraege.set(schluessel, { wert, bis: this.jetzt() + ttlMs });
    while (this.eintraege.size > this.opt.max) {
      const aeltester = this.eintraege.keys().next().value;
      if (aeltester === undefined) break;
      const e = this.eintraege.get(aeltester);
      this.eintraege.delete(aeltester);
      if (e) this.opt.beiEntfernen?.(e.wert, 'verdraengt');
    }
  }

  /** Entfernt den Eintrag, ohne beiEntfernen aufzurufen (der Aufrufer raeumt selbst auf). */
  vergiss(schluessel: string): void {
    this.eintraege.delete(schluessel);
  }

  /** Nur entfernen, wenn es noch derselbe Wert ist (ein neuerer Eintrag bleibt). */
  vergissWenn(schluessel: string, wert: V): void {
    if (this.eintraege.get(schluessel)?.wert === wert) this.eintraege.delete(schluessel);
  }

  werte(): V[] {
    return [...this.eintraege.values()].map((e) => e.wert);
  }

  leeren(): void {
    for (const e of this.eintraege.values()) this.opt.beiEntfernen?.(e.wert, 'geloescht');
    this.eintraege.clear();
  }
}

// ── Zugang aufloesen (Schluessel -> Instanz) ─────────────────────────────────

export class ZugangAbgelehnt extends Error {
  constructor(
    readonly httpStatus: 400 | 401 | 403 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'ZugangAbgelehnt';
  }
}

export const ZUGANG_TTL_MS = 10 * 60_000;
export const ZUGANG_MAX = 200;
/** Abgelehnte Schluessel merkt sich der Server kurz, damit Raten nicht jedes Mal die API trifft. */
export const ABLEHNUNG_TTL_MS = 60_000;
export const ABLEHNUNG_MAX = 1000;

type Abruf = (pfad: string, schluessel: string) => Promise<{ status: number; body: unknown }>;

export interface ZugangsAufloeser {
  /** Gibt die Instanz zurueck, die die API fuer diesen Schluessel freigibt, oder wirft ZugangAbgelehnt. */
  loese(schluessel: string, instanzKopf: string | undefined): Promise<string>;
  /** Nur fuer Tests und Abbau. */
  leeren(): void;
}

/**
 * Baut den Aufloeser. `abruf` ist ein GET gegen die API mit dem Schluessel des
 * Aufrufers (nie mit einem eigenen). Ergebnisse (positiv UND negativ) liegen im
 * Speicher, geschluesselt nach Hash — nie nach dem Schluessel selbst.
 */
export function baueZugangsAufloeser(abruf: Abruf, opt?: { jetzt?: () => number }): ZugangsAufloeser {
  const jetzt = opt?.jetzt;
  const gut = new BegrenzterSpeicher<string>({ max: ZUGANG_MAX, ttlMs: ZUGANG_TTL_MS, jetzt });
  const schlecht = new BegrenzterSpeicher<ZugangAbgelehnt>({ max: ABLEHNUNG_MAX, ttlMs: ABLEHNUNG_TTL_MS, jetzt });
  // Parallele Anfragen mit demselben Schluessel teilen EINEN Abruf.
  const laufend = new Map<string, Promise<string>>();

  async function ohneMerker(schluessel: string, instanzKopf: string | undefined): Promise<string> {
    if (instanzKopf) {
      const r = await abruf(`/api/v1/instances/${instanzKopf}`, schluessel);
      if (r.status === 200) return instanzKopf;
      if (r.status === 401) throw new ZugangAbgelehnt(401, 'Der Schluessel wurde abgelehnt (ungueltig, abgelaufen oder widerrufen).');
      // 403 und 404 bewusst gleich: wer fremde Instanz-IDs probiert, erfaehrt nichts.
      if (r.status === 403 || r.status === 404) {
        throw new ZugangAbgelehnt(403, 'Dieser Schluessel gilt nicht fuer die angegebene Instanz (Kopf X-Cachly-Instance).');
      }
      throw new ZugangAbgelehnt(502, `Die cachly-API antwortete mit ${r.status}; bitte spaeter erneut versuchen.`);
    }
    const r = await abruf('/api/v1/instances', schluessel);
    if (r.status === 401) throw new ZugangAbgelehnt(401, 'Der Schluessel wurde abgelehnt (ungueltig, abgelaufen oder widerrufen).');
    if (r.status === 403) {
      throw new ZugangAbgelehnt(
        400,
        'Dieser Schluessel ist an ein einzelnes Brain gebunden und darf keine Instanzliste lesen. ' +
          'Setze den Kopf "X-Cachly-Instance: <Instanz-ID>" (die ID steht im Dashboard unter cachly.dev/instances).',
      );
    }
    if (r.status !== 200) {
      throw new ZugangAbgelehnt(502, `Die cachly-API antwortete mit ${r.status}; bitte spaeter erneut versuchen.`);
    }
    const daten = (r.body as { data?: Array<{ id?: unknown }> } | null)?.data;
    const ids = (Array.isArray(daten) ? daten : [])
      .map((i) => (typeof i?.id === 'string' ? i.id.toLowerCase() : ''))
      .filter((id) => UUID_FORM.test(id));
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) {
      throw new ZugangAbgelehnt(400, 'Zu diesem Schluessel gehoert noch kein Brain. Lege eines an: https://cachly.dev/setup-ai');
    }
    throw new ZugangAbgelehnt(
      400,
      `Zu diesem Schluessel gehoeren ${ids.length} Brains. Waehle eines mit dem Kopf "X-Cachly-Instance: <Instanz-ID>" ` +
        `(Dashboard: cachly.dev/instances).`,
    );
  }

  return {
    async loese(schluessel, instanzKopf) {
      const merker = `${hashDesSchluessels(schluessel)}|${instanzKopf ?? '*'}`;
      const bekannt = gut.get(merker);
      if (bekannt) return bekannt;
      const abgelehnt = schlecht.get(merker);
      if (abgelehnt) throw abgelehnt;
      let p = laufend.get(merker);
      if (!p) {
        p = ohneMerker(schluessel, instanzKopf)
          .then((id) => { gut.set(merker, id); return id; })
          .catch((e: unknown) => {
            // Nur eindeutige Antworten der API merken, nie Netzfehler (502).
            if (e instanceof ZugangAbgelehnt && e.httpStatus !== 502) schlecht.set(merker, e);
            throw e;
          })
          .finally(() => { laufend.delete(merker); });
        laufend.set(merker, p);
      }
      return p;
    },
    leeren() {
      gut.leeren();
      schlecht.leeren();
      laufend.clear();
    },
  };
}

// ── Texte ────────────────────────────────────────────────────────────────────

/** Die Antwort auf einen Werkzeugaufruf ohne Schluessel. Nennt nie einen Schluessel. */
export const ANLEITUNG_OHNE_KOPF = [
  'Dieser Remote-MCP-Server braucht deinen cachly-Schluessel, damit er DEIN Brain oeffnet.',
  'The remote MCP server needs your cachly API key to open YOUR Brain.',
  '',
  '1. Schluessel holen / get a key: https://cachly.dev/setup-ai',
  '2. Kopf setzen / set the header, zum Beispiel / for example:',
  '   claude mcp add --transport http cachly https://mcp.cachly.dev/mcp --header "Authorization: Bearer <key>"',
  '   (Cursor / VS Code: "url" und "headers" in der mcp.json, siehe https://cachly.dev/docs)',
  '3. Mehrere Brains im Konto? Zusaetzlich / more than one Brain? Add: --header "X-Cachly-Instance: <instance-id>"',
  '',
  'Lieber lokal, ohne Kopf: npx @cachly-dev/mcp-server@latest autopilot',
].join('\n');

/** Kernwerkzeuge, die trotzdem nicht remote laufen, weil sie den Rechner des Servers anfassen. */
export const NUR_LOKAL_WERKZEUGE: ReadonlySet<string> = new Set([
  'autopilot', // richtet Editor-Dateien auf dem Rechner des Servers ein
  'brain_from_git', // liest ein Git-Verzeichnis des Servers
  'index_project', // liest ein Verzeichnis des Servers
]);

/**
 * Im HTTP-Modus laufen nur die Kernwerkzeuge (Gedaechtnis, Roadmap, Cache, Team) ohne
 * die lokalen. Der lange Schwanz (team.ts, fedbrain.ts, ...) ist NICHT freigegeben:
 * jedes dort ungeprueft freigegebene Werkzeug waere ein neuer Weg zu Dateien oder
 * Zustand des Servers. Die Liste der Werkzeuge bleibt trotzdem vollstaendig sichtbar.
 */
export function istRemoteErlaubt(name: string): boolean {
  return KERNWERKZEUGE.includes(name) && !NUR_LOKAL_WERKZEUGE.has(name);
}

/** Argumente, die einen Pfad auf dem Server benennen. Im HTTP-Modus werden sie entfernt. */
export const PFAD_ARGUMENTE: readonly string[] = ['workspace_path', 'repo_path', 'dir', 'project_dir'];

export function nurLokalText(name: string): string {
  return (
    `Das Werkzeug "${name}" ist ueber den Remote-Server (mcp.cachly.dev) nicht verfuegbar: ` +
    `es liest Dateien auf deinem Rechner oder gehoert nicht zu den Kernwerkzeugen. ` +
    `Lokal geht es: npx @cachly-dev/mcp-server@latest autopilot. ` +
    `/ "${name}" is not available on the remote server; run the local server for it.`
  );
}

/**
 * Bereinigt Werkzeug-Argumente fuer den HTTP-Modus: Pfade des Servers fliegen raus,
 * und die Instanz ist immer die freigegebene. Gibt einen Fehlertext zurueck, wenn der
 * Aufrufer eine ANDERE Instanz nennt (kein stilles Umbiegen).
 */
export function bereinigeArgumente(
  args: Record<string, unknown>,
  instanzId: string,
): { args: Record<string, unknown> } | { fehler: string } {
  const gegeben = args.instance_id;
  if (typeof gegeben === 'string' && gegeben.trim() !== '' && gegeben.trim().toLowerCase() !== instanzId) {
    return {
      fehler:
        'Die Instanz in instance_id ist nicht die, die dieser Schluessel freigibt. ' +
        'Lass instance_id weg: dieser Server nimmt immer das Brain des Schluessels (oder des Kopfs X-Cachly-Instance).',
    };
  }
  const sauber: Record<string, unknown> = { ...args };
  for (const k of PFAD_ARGUMENTE) delete sauber[k];
  sauber.instance_id = instanzId;
  return { args: sauber };
}
