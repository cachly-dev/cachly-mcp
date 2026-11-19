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
import { isIP } from 'node:net';
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
    readonly httpStatus: 400 | 401 | 403 | 429 | 502,
    message: string,
    /** Nur bei 429: so viele Sekunden warten (Kopf Retry-After). */
    readonly retryAfterS?: number,
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

/** `retryAfterS`: Wert des Retry-After-Kopfs der API (nur bei 429 gelesen). */
type Abruf = (pfad: string, schluessel: string) => Promise<{ status: number; body: unknown; retryAfterS?: number }>;

// ── Grenze fuer Schluesselpruefungen je Aufrufer-IP ──────────────────────────
//
// Die API zaehlt je Absender-IP 120 Anfragen/min. Alle Pruefungen dieses Servers
// kommen von einer Adresse. Wer mit erfundenen Schluesseln pruefen laesst, soll
// darum an DIESEM Server scheitern, bevor die API etwas merkt.

export const PRUEF_GRENZE_JE_MINUTE = 20;
export const PRUEF_FENSTER_MS = 60_000;
export const PRUEF_IP_MAX = 10_000;

export interface PruefGrenze {
  /** Zaehlt eine Pruefung fuer diese IP. `erlaubt: false` => kein API-Aufruf, Retry-After abwarten. */
  zaehle(ip: string): { erlaubt: true } | { erlaubt: false; retryAfterS: number };
}

/**
 * Festes Zeitfenster je IP, die Zaehler liegen in einem LRU (hoechstens `maxIps`
 * Adressen, aeltester geht zuerst). Beim Verdraengen geht nur ein Zaehler verloren.
 */
export function bauePruefGrenze(opt?: {
  max?: number; fensterMs?: number; maxIps?: number; jetzt?: () => number;
}): PruefGrenze {
  const max = opt?.max ?? PRUEF_GRENZE_JE_MINUTE;
  const fensterMs = opt?.fensterMs ?? PRUEF_FENSTER_MS;
  const jetzt = opt?.jetzt ?? Date.now;
  const zaehler = new BegrenzterSpeicher<{ n: number; ende: number }>({
    max: opt?.maxIps ?? PRUEF_IP_MAX,
    ttlMs: fensterMs,
    jetzt,
  });
  return {
    zaehle(ip) {
      const t = jetzt();
      let z = zaehler.get(ip);
      if (!z || z.ende <= t) {
        z = { n: 0, ende: t + fensterMs };
        zaehler.set(ip, z);
      }
      if (z.n >= max) return { erlaubt: false, retryAfterS: Math.max(1, Math.ceil((z.ende - t) / 1000)) };
      z.n += 1;
      return { erlaubt: true };
    },
  };
}

/**
 * Die Adresse des Aufrufers. Der Server steht hinter Caddy (127.0.0.1:3100, nur von
 * dort erreichbar), und Caddy SETZT X-Real-IP auf die TCP-Adresse des Aufrufers: er
 * reicht einen mitgeschickten Kopf nicht durch (infra/Caddyfile, mcp.cachly.dev:
 * header_up X-Real-IP {remote_host}). Fehlt der Kopf oder ist er mehrfach/ungueltig,
 * gilt die Adresse der Verbindung.
 */
export function leseAufruferIp(
  xRealIp: string | string[] | undefined,
  gegenstelle: string | undefined,
): string {
  const gueltig = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t && isIP(t) ? t.toLowerCase() : undefined;
  };
  const kopf = typeof xRealIp === 'string' ? gueltig(xRealIp) : undefined;
  return kopf ?? gueltig(gegenstelle) ?? 'unbekannt';
}

// ── Den Aufrufer an die API weiterreichen ────────────────────────────────────
//
// Alle Aufrufe dieses Servers kommen bei der API von EINER Adresse an. Ihre
// Grenzen (120/min je IP, Bremse fuer Fehlanmeldungen) zaehlten darum alle
// Nutzer von mcp.cachly.dev zusammen. Mit zwei Koepfen zaehlt die API je
// Aufrufer (api/internal/middleware/mcp_intern.go): ein gemeinsames Geheimnis
// (MCP_INTERNAL_SECRET, Infisical /api) und die Adresse aus X-Real-IP.
//
// Beide Koepfe gehen NUR an den Ursprung von CACHLY_API_URL, nie an einen
// anderen Host — das Geheimnis darf diesen Server nur in Richtung API verlassen.

export const MCP_GEHEIMNIS_KOPF = 'X-Cachly-Mcp-Secret';
export const MCP_AUFRUFER_KOPF = 'X-Cachly-Client-Ip';
/** Wie MCPGeheimnisMindestlaenge in der API: kuerzer = aus. */
export const MCP_GEHEIMNIS_MINDESTLAENGE = 32;

const aufruferSpeicher = new AsyncLocalStorage<string>();

/** Fuehrt `fn` fuer diesen Aufrufer aus; alles, was daraus startet, erbt die Adresse. */
export function imAufrufer<T>(ip: string, fn: () => T): T {
  return aufruferSpeicher.run(ip, fn);
}

/** Die Adresse des Aufrufers der laufenden Anfrage, oder undefined. */
export function aktuellerAufrufer(): string | undefined {
  return aufruferSpeicher.getStore();
}

function ursprung(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Die Zusatzkoepfe fuer einen Aufruf an `url`, oder undefined. Nur wenn `url`
 * denselben Ursprung wie `apiUrl` hat, das Geheimnis lang genug ist und die
 * Adresse eine echte IP ist.
 */
export function apiKoepfeFuer(
  url: string,
  apiUrl: string,
  geheimnis: string | undefined,
  ip: string | undefined,
): Record<string, string> | undefined {
  if (!geheimnis || geheimnis.length < MCP_GEHEIMNIS_MINDESTLAENGE) return undefined;
  if (!ip || !isIP(ip)) return undefined;
  const ziel = ursprung(url);
  if (!ziel || ziel !== ursprung(apiUrl)) return undefined;
  return { [MCP_GEHEIMNIS_KOPF]: geheimnis, [MCP_AUFRUFER_KOPF]: ip };
}

/**
 * Legt einen Aufsatz um `ziel.fetch`: Aufrufe an die API bekommen die Koepfe
 * aus apiKoepfeFuer, alle anderen laufen unveraendert. Ein Aufsatz statt
 * Aenderungen an jeder Aufrufstelle, weil die Werkzeuge die API an rund
 * 60 Stellen direkt mit fetch aufrufen (gezaehlt 19.11.2026: 63).
 */
export function installiereApiKoepfe(
  apiUrl: string,
  geheimnis: string | undefined,
  ziel: { fetch: typeof fetch } = globalThis,
): boolean {
  if (!geheimnis || geheimnis.length < MCP_GEHEIMNIS_MINDESTLAENGE) return false;
  const roh = ziel.fetch.bind(ziel);
  ziel.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const extra = apiKoepfeFuer(url, apiUrl, geheimnis, aktuellerAufrufer());
    if (!extra) return roh(input, init);
    const koepfe = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(extra)) koepfe.set(k, v);
    return roh(input, { ...init, headers: koepfe });
  }) as typeof fetch;
  return true;
}

export interface ZugangsAufloeser {
  /** Gibt die Instanz zurueck, die die API fuer diesen Schluessel freigibt, oder wirft ZugangAbgelehnt. */
  loese(schluessel: string, instanzKopf: string | undefined, aufruferIp?: string): Promise<string>;
  /** Nur fuer Tests und Abbau. */
  leeren(): void;
}

/**
 * Baut den Aufloeser. `abruf` ist ein GET gegen die API mit dem Schluessel des
 * Aufrufers (nie mit einem eigenen). Ergebnisse (positiv UND negativ) liegen im
 * Speicher, geschluesselt nach Hash — nie nach dem Schluessel selbst.
 */
export function baueZugangsAufloeser(
  abruf: Abruf,
  opt?: { jetzt?: () => number; grenze?: PruefGrenze },
): ZugangsAufloeser {
  const jetzt = opt?.jetzt;
  const gut = new BegrenzterSpeicher<string>({ max: ZUGANG_MAX, ttlMs: ZUGANG_TTL_MS, jetzt });
  const schlecht = new BegrenzterSpeicher<ZugangAbgelehnt>({ max: ABLEHNUNG_MAX, ttlMs: ABLEHNUNG_TTL_MS, jetzt });
  // Parallele Anfragen mit demselben Schluessel teilen EINEN Abruf.
  const laufend = new Map<string, Promise<string>>();

  const zuVieleAnfragen = (r: { retryAfterS?: number }): ZugangAbgelehnt => {
    const s = r.retryAfterS && r.retryAfterS > 0 ? Math.min(Math.ceil(r.retryAfterS), 3600) : 60;
    return new ZugangAbgelehnt(429, `Die cachly-API begrenzt gerade die Anfragen. Bitte in ${s} s erneut versuchen.`, s);
  };

  async function ohneMerker(schluessel: string, instanzKopf: string | undefined): Promise<string> {
    if (instanzKopf) {
      const r = await abruf(`/api/v1/instances/${instanzKopf}`, schluessel);
      if (r.status === 429) throw zuVieleAnfragen(r);
      if (r.status === 200) return instanzKopf;
      if (r.status === 401) throw new ZugangAbgelehnt(401, 'Der Schluessel wurde abgelehnt (ungueltig, abgelaufen oder widerrufen).');
      // 403 und 404 bewusst gleich: wer fremde Instanz-IDs probiert, erfaehrt nichts.
      if (r.status === 403 || r.status === 404) {
        throw new ZugangAbgelehnt(403, 'Dieser Schluessel gilt nicht fuer die angegebene Instanz (Kopf X-Cachly-Instance).');
      }
      throw new ZugangAbgelehnt(502, `Die cachly-API antwortete mit ${r.status}; bitte spaeter erneut versuchen.`);
    }
    const r = await abruf('/api/v1/instances', schluessel);
    if (r.status === 429) throw zuVieleAnfragen(r);
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
    async loese(schluessel, instanzKopf, aufruferIp) {
      const merker = `${hashDesSchluessels(schluessel)}|${instanzKopf ?? '*'}`;
      const bekannt = gut.get(merker);
      if (bekannt) return bekannt;
      const abgelehnt = schlecht.get(merker);
      if (abgelehnt) throw abgelehnt;
      let p = laufend.get(merker);
      if (!p) {
        // Ab hier geht ein Aufruf an die API: je Aufrufer-IP begrenzen. Treffer im
        // Merker (oben) und parallele Anfragen mit demselben Schluessel zaehlen nicht.
        if (opt?.grenze) {
          const g = opt.grenze.zaehle(aufruferIp || 'unbekannt');
          if (!g.erlaubt) {
            throw new ZugangAbgelehnt(429, `Zu viele Schluesselpruefungen von dieser Adresse. Bitte in ${g.retryAfterS} s erneut versuchen.`, g.retryAfterS);
          }
        }
        p = ohneMerker(schluessel, instanzKopf)
          .then((id) => { gut.set(merker, id); return id; })
          .catch((e: unknown) => {
            // Nur eindeutige Antworten der API merken, nie Netzfehler (502).
            if (e instanceof ZugangAbgelehnt && e.httpStatus !== 502 && e.httpStatus !== 429) schlecht.set(merker, e);
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
