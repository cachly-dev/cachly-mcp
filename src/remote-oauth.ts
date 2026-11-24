// Remote-MCP (HTTP-Modus): Anmeldung per OAuth statt festem Schluessel.
//
// ── Warum es das gibt (20.11.2026) ───────────────────────────────────────────
//
// Claude.ai (Settings > Connectors > Add custom connector) und ChatGPT kennen
// fuer einen Remote-MCP-Server nur zwei Wege: ohne Anmeldung oder OAuth. Einen
// eigenen Kopf `Authorization: Bearer cky_...` koennen sie nicht setzen. Bis
// heute kam dort also niemand an sein Brain.
//
// Ablauf nach der MCP-Spezifikation 2025-06-18 (Abschnitt Authorization), als
// "Lazy Authentication" nach claude.com/docs/connectors/building/lazy-authentication:
//   0. initialize, notifications/*, tools/list, prompts/list, resources/list
//      laufen OHNE Anmeldung wie bisher — Verzeichnisse wie Glama, Smithery und
//      mcptry lesen so die Werkzeugliste.
//   1. Erst ein Werkzeugaufruf (tools/call) ohne Authorization → 401 mit
//      `WWW-Authenticate: Bearer error="invalid_token", ..., resource_metadata="<url>"`.
//      Claude zeigt dann im Gespraech "Connect" und wiederholt den Aufruf nach
//      der Anmeldung. Eine 200 mit isError startet KEINE Anmeldung.
//   2. Der Client liest unter <url> die Metadaten dieses Servers (RFC 9728).
//      Darin steht der Anmeldedienst: der Keycloak-Realm cachly.
//   3. Der Client registriert sich dort selbst (Dynamic Client Registration),
//      der Mensch meldet sich mit seinem cachly-Konto an (PKCE S256), der Client
//      bekommt ein Zugangstoken (JWT).
//   4. Jede weitere Anfrage traegt `Authorization: Bearer <JWT>`. Dieser Server
//      prueft Unterschrift (JWKS), Aussteller, Zielgruppe und Ablauf und reicht
//      das Token an die API weiter. Die API prueft es noch einmal und entscheidet,
//      welche Instanzen es oeffnen darf.
//
// Diese Datei enthaelt nur Teile, die sich ohne Netz pruefen lassen (der JWKS-
// Abruf ist austauschbar). Der HTTP-Teil steht in index.ts.
//
// Umgebungsvariablen (alle optional, leer = nicht gesetzt, Vorgaben fuer mcp.cachly.dev):
//   MCP_OAUTH_RESOURCE  URL dieses MCP-Servers, genau wie der Nutzer sie eintraegt.
//                       Vorgabe https://mcp.cachly.dev/mcp
//   MCP_OAUTH_ISSUER    Aussteller (iss) der Tokens. Vorgabe https://auth.cachly.dev/realms/cachly
//   MCP_OAUTH_AUDIENCE  Zielgruppen (aud), von denen das Token eine nennen muss,
//                       mit Komma getrennt. Vorgabe: MCP_OAUTH_RESOURCE
//   MCP_OAUTH_JWKS_URL  Schluesselliste des Ausstellers. Vorgabe
//                       <ISSUER>/protocol/openid-connect/certs (Keycloak).
//                       "aus" = Unterschrift nur in der API pruefen.
//   MCP_OAUTH_SCOPES    Scopes, die Clients anfragen sollen (Leerzeichen oder
//                       Komma). Vorgabe "profile email cachly-mcp" (ohne openid,
//                       mit dem Scope, der aud setzt; siehe unten).

import {
  constants as kryptoKonstanten,
  createPublicKey,
  verify as kryptoPruefen,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

// ── Einstellungen ────────────────────────────────────────────────────────────

export const OAUTH_VORGABE_RESOURCE = 'https://mcp.cachly.dev/mcp';
export const OAUTH_VORGABE_ISSUER = 'https://auth.cachly.dev/realms/cachly';
// Bewusst OHNE "openid": Claude.ai uebernimmt scopes_supported in die dynamische
// Client-Registrierung (DCR) bei Keycloak. Die Keycloak-Regel "Allowed Client Scopes"
// lehnt jede Registrierung mit "openid" ab (HTTP 403 "Not permitted to use specified
// clientScope", belegt am 24.11.2026) - Claude.ai meldet dann "Couldn't register with
// Cachly's sign-in service". Die Token-Pruefung braucht kein openid.
//
// MIT "cachly-mcp": nur dieser Client-Scope setzt die Zielgruppe (aud)
// https://mcp.cachly.dev/mcp. Er ist zwar Realm-Vorgabe, aber eine DCR mit eigenem
// "scope" bekommt als Vorgabe nur "basic" und die angefragten Scopes als optionale
// (belegt 24.11.2026: defaultClientScopes ["basic"]). Ohne cachly-mcp in der Anfrage
// fehlt aud im Token, und JEDER Werkzeugaufruf von Claude.ai endet in 401.
// Ueberschreibbar per MCP_OAUTH_SCOPES.
export const OAUTH_VORGABE_SCOPES: readonly string[] = ['profile', 'email', 'cachly-mcp'];
export const OAUTH_DOKU = 'https://cachly.dev/docs/remote-mcp';
export const DASHBOARD_URL = 'https://cachly.dev/instances';
const METADATEN_PFAD = '/.well-known/oauth-protected-resource';

export interface OAuthEinstellungen {
  /** Die URL dieses Servers, genau wie der Nutzer sie eintraegt (Feld `resource`). */
  readonly resource: string;
  /** Der erwartete Aussteller (iss); steht als einziger Eintrag in authorization_servers. */
  readonly aussteller: string;
  /** Das Token muss eine dieser Zielgruppen (aud) nennen. */
  readonly zielgruppen: readonly string[];
  /** Schluesselliste des Ausstellers; null = Unterschrift nur in der API pruefen. */
  readonly jwksUrl: string | null;
  /** Scopes, die ein Client anfragen soll (scopes_supported, scope im 401). */
  readonly scopes: readonly string[];
  /** Wo die Metadaten liegen (steht im WWW-Authenticate). */
  readonly metadatenUrl: string;
  /** Pfade, unter denen dieser Server die Metadaten ausliefert. */
  readonly metadatenPfade: readonly string[];
}

function ohneSchraegstrichAmEnde(s: string): string {
  return s.replace(/\/+$/, '');
}

function liste(roh: string | undefined, trenner: RegExp): string[] {
  return (roh ?? '').split(trenner).map((s) => s.trim()).filter((s) => s !== '');
}

function pruefeUrl(name: string, wert: string): URL {
  let u: URL;
  try {
    u = new URL(wert);
  } catch {
    throw new Error(`${name} ist keine URL: "${wert}"`);
  }
  const lokal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && lokal)) {
    throw new Error(`${name} muss mit https:// beginnen (http nur fuer localhost): "${wert}"`);
  }
  if (u.search || u.hash) throw new Error(`${name} darf weder ? noch # enthalten: "${wert}"`);
  return u;
}

/**
 * Liest die Einstellungen aus der Umgebung. Wirft bei einer kaputten URL: ein
 * Tippfehler soll den Start sichtbar scheitern lassen, nicht still jede
 * Anmeldung.
 */
export function leseOAuthEinstellungen(env: NodeJS.ProcessEnv = process.env): OAuthEinstellungen {
  const resource = ohneSchraegstrichAmEnde(env.MCP_OAUTH_RESOURCE?.trim() || OAUTH_VORGABE_RESOURCE);
  const aussteller = ohneSchraegstrichAmEnde(env.MCP_OAUTH_ISSUER?.trim() || OAUTH_VORGABE_ISSUER);
  const r = pruefeUrl('MCP_OAUTH_RESOURCE', resource);
  pruefeUrl('MCP_OAUTH_ISSUER', aussteller);

  const zielgruppen = liste(env.MCP_OAUTH_AUDIENCE, /,/);
  const jwksRoh = env.MCP_OAUTH_JWKS_URL?.trim() ?? '';
  let jwksUrl: string | null;
  if (jwksRoh.toLowerCase() === 'aus' || jwksRoh.toLowerCase() === 'off') jwksUrl = null;
  else if (jwksRoh) jwksUrl = pruefeUrl('MCP_OAUTH_JWKS_URL', jwksRoh).href;
  else jwksUrl = `${aussteller}/protocol/openid-connect/certs`;

  // Leer zaehlt wie nicht gesetzt (Compose reicht "${VAR:-}" als leeren Text durch).
  const scopesListe = liste(env.MCP_OAUTH_SCOPES, /[\s,]+/);
  const scopes = scopesListe.length > 0 ? scopesListe : [...OAUTH_VORGABE_SCOPES];

  // RFC 9728, 3.1: der Pfad der Ressource wird an den Well-known-Pfad angehaengt.
  const pfad = r.pathname === '/' ? '' : r.pathname;
  const metadatenPfade = pfad ? [`${METADATEN_PFAD}${pfad}`, METADATEN_PFAD] : [METADATEN_PFAD];
  return {
    resource,
    aussteller,
    zielgruppen: zielgruppen.length > 0 ? zielgruppen : [resource],
    jwksUrl,
    scopes,
    metadatenUrl: `${r.origin}${metadatenPfade[0]}`,
    metadatenPfade,
  };
}

/** Das Dokument unter /.well-known/oauth-protected-resource (RFC 9728). */
export function schutzMetadaten(e: OAuthEinstellungen): Record<string, unknown> {
  return {
    resource: e.resource,
    // Claude nimmt nur den ersten Eintrag; es gibt genau einen.
    authorization_servers: [e.aussteller],
    bearer_methods_supported: ['header'],
    ...(e.scopes.length > 0 ? { scopes_supported: [...e.scopes] } : {}),
    resource_name: 'cachly',
    resource_documentation: OAUTH_DOKU,
  };
}

/**
 * Der Kopf WWW-Authenticate fuer jede 401-Antwort (RFC 6750, 3; RFC 9728, 5.1).
 * `beschreibung` wird zu error_description und darf nur ASCII ohne " enthalten.
 */
export function wwwAuthenticate(e: OAuthEinstellungen, fehler?: 'invalid_token', beschreibung?: string): string {
  const teile = ['Bearer realm="cachly"'];
  if (fehler) teile.push(`error="${fehler}"`);
  if (fehler && beschreibung) teile.push(`error_description="${beschreibung.replace(/[^\x20-\x7e]|"/g, '')}"`);
  teile.push(`resource_metadata="${e.metadatenUrl}"`);
  if (e.scopes.length > 0) teile.push(`scope="${e.scopes.join(' ')}"`);
  return teile.join(', ');
}

// ── Lazy Authentication: nur der Werkzeugaufruf braucht eine Anmeldung ───────

/** error_description der 401 auf einen Werkzeugaufruf ohne Anmeldung (wie im Beispiel der Claude-Doku). */
export const WERKZEUG_BRAUCHT_ANMELDUNG = 'Authentication required for this tool';

/**
 * Hoechstens so gross darf der Rumpf einer Anfrage OHNE Anmeldung sein, die der
 * Server vorab liest (4 MB wie MAXIMUM_MESSAGE_SIZE frueherer SDK-Fassungen).
 */
export const MAX_RUMPF_OHNE_ANMELDUNG = 4 * 1024 * 1024;

/**
 * Braucht diese JSON-RPC-Nachricht (oder ein Stapel davon) eine Anmeldung?
 *
 * REGEL: nur `tools/call`. Alles andere — initialize, notifications/*,
 * tools/list, prompts/list, resources/list, ping — laeuft ohne Anmeldung wie vor
 * dem 20.11.2026. Ein Stapel braucht eine Anmeldung, sobald EINE Nachricht darin
 * ein Werkzeugaufruf ist. Werkzeuge mit Wirkung ohne Anmeldung gibt es nicht:
 * auch "harmlose" Werkzeuge lesen oder schreiben das Brain des Aufrufers.
 */
export function brauchtAnmeldung(body: unknown): boolean {
  const nachrichten = Array.isArray(body) ? body : [body];
  return nachrichten.some((n) => !!n && typeof n === 'object' && (n as { method?: unknown }).method === 'tools/call');
}

// ── JWT zerlegen und Ansprueche pruefen ──────────────────────────────────────

/** Drei Base64url-Teile, keiner leer. Ein Token mit alg "none" (leere Unterschrift) faellt hier schon raus. */
const JWT_FORM = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function siehtAusWieJwt(token: string): boolean {
  return JWT_FORM.test(token);
}

export interface JwtTeile {
  readonly kopf: Record<string, unknown>;
  readonly ansprueche: Record<string, unknown>;
  /** "<kopf>.<inhalt>" — das, was unterschrieben ist. */
  readonly signiert: string;
  readonly unterschrift: Buffer;
}

function jsonObjekt(b64: string): Record<string, unknown> | undefined {
  try {
    const wert: unknown = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return wert && typeof wert === 'object' && !Array.isArray(wert) ? (wert as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Zerlegt ein JWT OHNE es zu pruefen. undefined, wenn es keins ist. */
export function zerlegeJwt(token: string): JwtTeile | undefined {
  if (!siehtAusWieJwt(token)) return undefined;
  const [k, i, u] = token.split('.');
  const kopf = jsonObjekt(k);
  const ansprueche = jsonObjekt(i);
  if (!kopf || !ansprueche) return undefined;
  return { kopf, ansprueche, signiert: `${k}.${i}`, unterschrift: Buffer.from(u, 'base64url') };
}

export type TokenFehler =
  | 'form'
  | 'aussteller'
  | 'abgelaufen'
  | 'noch-nicht-gueltig'
  | 'zielgruppe'
  | 'typ'
  | 'inhaber'
  | 'algorithmus'
  | 'schluessel-unbekannt'
  | 'unterschrift'
  | 'jwks-fehlt';

/** Spielraum fuer abweichende Uhren (exp/nbf), in Sekunden. */
export const UHR_SPIELRAUM_S = 30;

export interface GepruefteAnsprueche {
  readonly sub: string;
  readonly iss: string;
  /** Ablauf in Millisekunden seit 1970. */
  readonly bisMs: number;
}

/**
 * Prueft die Ansprueche (ohne Unterschrift). Gibt den ersten Fehler zurueck oder
 * die Werte, die der Server weiter braucht.
 */
export function pruefeAnsprueche(
  a: Record<string, unknown>,
  e: Pick<OAuthEinstellungen, 'aussteller' | 'zielgruppen'>,
  jetztMs: number,
): { fehler: TokenFehler } | GepruefteAnsprueche {
  if (a.iss !== e.aussteller) return { fehler: 'aussteller' };
  if (typeof a.exp !== 'number' || !Number.isFinite(a.exp)) return { fehler: 'form' };
  if (a.exp * 1000 + UHR_SPIELRAUM_S * 1000 <= jetztMs) return { fehler: 'abgelaufen' };
  if (typeof a.nbf === 'number' && a.nbf * 1000 - UHR_SPIELRAUM_S * 1000 > jetztMs) return { fehler: 'noch-nicht-gueltig' };
  const aud = typeof a.aud === 'string' ? [a.aud] : Array.isArray(a.aud) ? a.aud.filter((x): x is string => typeof x === 'string') : [];
  if (e.zielgruppen.length > 0 && !aud.some((x) => e.zielgruppen.includes(x))) return { fehler: 'zielgruppe' };
  // Keycloak schreibt den Zweck ins Token: "Bearer" = Zugangstoken. ID- und
  // Refresh-Tokens ("ID", "Refresh") sind keine Eintrittskarte.
  if (typeof a.typ === 'string' && a.typ.toLowerCase() !== 'bearer') return { fehler: 'typ' };
  if (typeof a.sub !== 'string' || a.sub === '') return { fehler: 'inhaber' };
  return { sub: a.sub, iss: a.iss, bisMs: a.exp * 1000 };
}

/** Text fuer den Menschen. Nennt nie das Token. */
export function tokenFehlerText(f: TokenFehler): string {
  switch (f) {
    case 'aussteller': return 'Das Token stammt nicht vom cachly-Anmeldedienst.';
    case 'abgelaufen': return 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.';
    case 'noch-nicht-gueltig': return 'Das Token ist noch nicht gueltig (Uhrzeit pruefen).';
    case 'zielgruppe': return 'Das Token ist nicht fuer diesen MCP-Server ausgestellt (Zielgruppe passt nicht).';
    case 'typ': return 'Das ist kein Zugangstoken.';
    case 'inhaber': return 'Dem Token fehlt der Inhaber.';
    case 'algorithmus': return 'Das Token ist mit einem nicht erlaubten Verfahren unterschrieben.';
    case 'schluessel-unbekannt': return 'Der Schluessel, mit dem das Token unterschrieben ist, ist unbekannt.';
    case 'unterschrift': return 'Die Unterschrift des Tokens ist ungueltig.';
    case 'jwks-fehlt': return 'Der cachly-Anmeldedienst ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.';
    default: return 'Das Token hat keine gueltige Form.';
  }
}

export class TokenAbgelehnt extends Error {
  constructor(readonly grund: TokenFehler) {
    super(tokenFehlerText(grund));
    this.name = 'TokenAbgelehnt';
  }
}

// ── Unterschrift pruefen (JWKS, nur node:crypto) ─────────────────────────────

type Verfahren = { familie: 'RS' | 'PS' | 'ES'; hash: 'sha256' | 'sha384' | 'sha512' };

/** Nur asymmetrische Verfahren. Nie "none", nie HS* (ein oeffentlicher Schluessel als Geheimnis). */
const VERFAHREN: Readonly<Record<string, Verfahren>> = {
  RS256: { familie: 'RS', hash: 'sha256' }, RS384: { familie: 'RS', hash: 'sha384' }, RS512: { familie: 'RS', hash: 'sha512' },
  PS256: { familie: 'PS', hash: 'sha256' }, PS384: { familie: 'PS', hash: 'sha384' }, PS512: { familie: 'PS', hash: 'sha512' },
  ES256: { familie: 'ES', hash: 'sha256' }, ES384: { familie: 'ES', hash: 'sha384' }, ES512: { familie: 'ES', hash: 'sha512' },
};

export function unterschriftStimmt(alg: string, schluessel: KeyObject, signiert: string, unterschrift: Buffer): boolean {
  const v = VERFAHREN[alg];
  if (!v) return false;
  const art = schluessel.asymmetricKeyType;
  const daten = Buffer.from(signiert, 'utf8');
  try {
    if (v.familie === 'RS') return art === 'rsa' && kryptoPruefen(v.hash, daten, schluessel, unterschrift);
    if (v.familie === 'PS') {
      return (art === 'rsa' || art === 'rsa-pss') && kryptoPruefen(v.hash, daten, {
        key: schluessel,
        padding: kryptoKonstanten.RSA_PKCS1_PSS_PADDING,
        saltLength: kryptoKonstanten.RSA_PSS_SALTLEN_DIGEST,
      }, unterschrift);
    }
    return art === 'ec' && kryptoPruefen(v.hash, daten, { key: schluessel, dsaEncoding: 'ieee-p1363' }, unterschrift);
  } catch {
    return false;
  }
}

/** GET auf die Schluesselliste; austauschbar fuer Tests. */
export type JwksAbruf = (url: string) => Promise<{ status: number; body: unknown }>;

/** So lange gilt eine geladene Schluesselliste. */
export const JWKS_TTL_MS = 10 * 60_000;
/** Ein unbekannter kid laedt die Liste hoechstens so oft neu (Schutz gegen erfundene kids). */
export const JWKS_MINDESTABSTAND_MS = 30_000;

interface GeladenerSchluessel {
  kid?: string;
  alg?: string;
  schluessel: KeyObject;
}

function ladeSchluessel(body: unknown): GeladenerSchluessel[] {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  const out: GeladenerSchluessel[] = [];
  for (const k of keys as Array<Record<string, unknown>>) {
    if (!k || typeof k !== 'object') continue;
    // Keycloak liefert auch einen Schluessel zum Verschluesseln (use "enc", RSA-OAEP).
    if (k.use !== undefined && k.use !== 'sig') continue;
    if (k.kty !== 'RSA' && k.kty !== 'EC') continue;
    try {
      const schluessel = createPublicKey({ key: k as JsonWebKey, format: 'jwk' });
      out.push({
        kid: typeof k.kid === 'string' ? k.kid : undefined,
        alg: typeof k.alg === 'string' ? k.alg : undefined,
        schluessel,
      });
    } catch {
      // Ein kaputter Eintrag macht die anderen nicht ungueltig.
    }
  }
  return out;
}

export interface JwtPruefer {
  /** Prueft Form, Ansprueche und (falls eingeschaltet) Unterschrift. Wirft TokenAbgelehnt. */
  pruefe(token: string): Promise<GepruefteAnsprueche>;
}

export function baueJwtPruefer(
  e: OAuthEinstellungen,
  opt?: { abruf?: JwksAbruf; jetzt?: () => number },
): JwtPruefer {
  const jetzt = opt?.jetzt ?? Date.now;
  const abruf: JwksAbruf = opt?.abruf ?? (async (url) => {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
  });
  let geladen: { schluessel: GeladenerSchluessel[]; um: number } | undefined;
  let laufend: Promise<GeladenerSchluessel[]> | undefined;

  const holeListe = (): Promise<GeladenerSchluessel[]> => {
    if (!e.jwksUrl) return Promise.resolve([]);
    if (!laufend) {
      const url = e.jwksUrl;
      laufend = abruf(url)
        .then((r) => {
          const liste = r.status === 200 ? ladeSchluessel(r.body) : [];
          if (liste.length === 0) throw new TokenAbgelehnt('jwks-fehlt');
          geladen = { schluessel: liste, um: jetzt() };
          return liste;
        })
        .catch((err: unknown) => {
          throw err instanceof TokenAbgelehnt ? err : new TokenAbgelehnt('jwks-fehlt');
        })
        .finally(() => { laufend = undefined; });
    }
    return laufend;
  };

  const passend = (liste: GeladenerSchluessel[], kid: string | undefined, alg: string): GeladenerSchluessel | undefined =>
    liste.find((s) => (kid === undefined || s.kid === kid) && (s.alg === undefined || s.alg === alg));

  return {
    async pruefe(token) {
      const teile = zerlegeJwt(token);
      if (!teile) throw new TokenAbgelehnt('form');
      const a = pruefeAnsprueche(teile.ansprueche, e, jetzt());
      if ('fehler' in a) throw new TokenAbgelehnt(a.fehler);
      if (!e.jwksUrl) return a; // MCP_OAUTH_JWKS_URL=aus: die API prueft die Unterschrift.

      const alg = typeof teile.kopf.alg === 'string' ? teile.kopf.alg : '';
      if (!VERFAHREN[alg]) throw new TokenAbgelehnt('algorithmus');
      const kid = typeof teile.kopf.kid === 'string' ? teile.kopf.kid : undefined;

      const frisch = geladen && jetzt() - geladen.um < JWKS_TTL_MS;
      let treffer = frisch ? passend(geladen!.schluessel, kid, alg) : undefined;
      if (!treffer) {
        // Neu laden, wenn die Liste alt ist oder der kid fehlt (Schluesselwechsel
        // bei Keycloak) — aber einen erfundenen kid nicht bei jeder Anfrage.
        const darf = !geladen || !frisch || jetzt() - geladen.um >= JWKS_MINDESTABSTAND_MS;
        if (darf) {
          try {
            treffer = passend(await holeListe(), kid, alg);
          } catch (err) {
            // Keycloak antwortet gerade nicht: eine alte Liste gilt weiter, bis er wieder da ist.
            treffer = geladen ? passend(geladen.schluessel, kid, alg) : undefined;
            if (!treffer) throw err;
          }
        }
      }
      if (!treffer) throw new TokenAbgelehnt('schluessel-unbekannt');
      if (!unterschriftStimmt(alg, treffer.schluessel, teile.signiert, teile.unterschrift)) {
        throw new TokenAbgelehnt('unterschrift');
      }
      return a;
    },
  };
}

// ── Welches Brain, wenn der Client keins nennt ───────────────────────────────

const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Das Standard-Brain einer Anmeldung (OAuth) ohne Kopf X-Cachly-Instance.
 * Claude.ai und ChatGPT koennen keinen Kopf setzen, also muss der Server waehlen.
 *
 * REGEL: Aus der Antwort von GET /api/v1/instances zaehlen nur Instanzen mit
 * status "running". Davon gewinnt die zuletzt angelegte (created_at); bei
 * gleichem oder fehlendem Datum die kleinere ID. Kein laufendes Brain: "".
 *
 * Das ist dieselbe Wahl wie beim Geraete-Login der API (AutoProvision in
 * api/internal/service/instance_service.go: laufend vor allem anderen, neueste
 * zuerst) — nur ohne Rueckfall auf ein nicht laufendes Brain, weil die Werkzeuge
 * damit ohnehin nur Fehler liefern wuerden.
 */
export function waehleStandardBrain(body: unknown): string {
  const daten = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(daten)) return '';
  const zeit = (v: unknown): number => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  const laufend = (daten as Array<Record<string, unknown>>)
    .filter((i) => i && typeof i.id === 'string' && UUID_FORM.test(i.id) && i.status === 'running')
    .map((i) => ({ id: (i.id as string).toLowerCase(), t: zeit(i.created_at) }))
    .sort((x, y) => (y.t - x.t) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return laufend[0]?.id ?? '';
}

/** Die Antwort auf einen Werkzeugaufruf, wenn das Konto kein laufendes Brain hat. */
export const KEIN_BRAIN_TEXT = [
  'Zu deinem cachly-Konto gehoert noch kein laufendes Brain.',
  `Lege eines an oder starte es im Dashboard: ${DASHBOARD_URL}`,
  'Danach geht es hier ohne neue Anmeldung weiter (spaetestens nach einer Minute).',
  '',
  'Your cachly account has no running Brain yet.',
  `Create or start one in the dashboard: ${DASHBOARD_URL}`,
].join('\n');
