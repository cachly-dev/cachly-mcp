/**
 * ABNAHME OAuth fuer den Remote-MCP-Server (20.11.2026).
 *
 * Claude.ai und ChatGPT setzen keinen Kopf, sie melden sich per OAuth an. Hier
 * steht, was der Server dafuer zusagt: Metadaten nach RFC 9728, ein 401-Kopf, der
 * auf sie zeigt, und eine Tokenpruefung, die nur Tokens des eigenen Ausstellers
 * fuer DIESEN Server annimmt. Der HTTP-Weg im echten Prozess steht in
 * remote-mcp.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  JWKS_MINDESTABSTAND_MS,
  JWKS_TTL_MS,
  KEIN_BRAIN_TEXT,
  MAX_RUMPF_OHNE_ANMELDUNG,
  WERKZEUG_BRAUCHT_ANMELDUNG,
  brauchtAnmeldung,
  OAUTH_VORGABE_ISSUER,
  OAUTH_VORGABE_RESOURCE,
  TokenAbgelehnt,
  UHR_SPIELRAUM_S,
  baueJwtPruefer,
  leseOAuthEinstellungen,
  pruefeAnsprueche,
  schutzMetadaten,
  waehleStandardBrain,
  wwwAuthenticate,
  zerlegeJwt,
  type JwksAbruf,
} from '../remote-oauth.js';
import { ZUGANG_TTL_MS, ABLEHNUNG_TTL_MS, baueZugangsAufloeser, leseBearer } from '../remote-zugang.js';
import { ecAussteller, rsaAussteller, unterschreibe, zugangsAnsprueche } from './helfer/test-jwt.js';

const ISS = OAUTH_VORGABE_ISSUER;
const RES = OAUTH_VORGABE_RESOURCE;
const INST_1 = '11111111-1111-4111-8111-111111111111';
const INST_2 = '22222222-2222-4222-8222-222222222222';
const INST_3 = '33333333-3333-4333-8333-333333333333';

describe('Einstellungen aus der Umgebung', () => {
  it('Vorgaben: mcp.cachly.dev, Realm cachly, Keycloak-Schluesselliste, Zielgruppe = Ressource', () => {
    const e = leseOAuthEinstellungen({});
    expect(e.resource).toBe('https://mcp.cachly.dev/mcp');
    expect(e.aussteller).toBe('https://auth.cachly.dev/realms/cachly');
    expect(e.jwksUrl).toBe('https://auth.cachly.dev/realms/cachly/protocol/openid-connect/certs');
    expect(e.zielgruppen).toEqual(['https://mcp.cachly.dev/mcp']);
    expect(e.scopes).toEqual(['profile', 'email']);
    expect(e.metadatenUrl).toBe('https://mcp.cachly.dev/.well-known/oauth-protected-resource/mcp');
    expect(e.metadatenPfade).toEqual(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
  });

  it('jede Variable greift; Schraegstrich am Ende faellt weg; Listen mit Komma', () => {
    const e = leseOAuthEinstellungen({
      MCP_OAUTH_RESOURCE: 'https://mcp.example.test/mcp/',
      MCP_OAUTH_ISSUER: 'https://id.example.test/realms/x/',
      MCP_OAUTH_AUDIENCE: 'https://mcp.example.test/mcp, cachly-api',
      MCP_OAUTH_JWKS_URL: 'https://id.example.test/keys',
      MCP_OAUTH_SCOPES: 'openid,email  offline_access',
    });
    expect(e.resource).toBe('https://mcp.example.test/mcp');
    expect(e.aussteller).toBe('https://id.example.test/realms/x');
    expect(e.zielgruppen).toEqual(['https://mcp.example.test/mcp', 'cachly-api']);
    expect(e.jwksUrl).toBe('https://id.example.test/keys');
    expect(e.scopes).toEqual(['openid', 'email', 'offline_access']);
    expect(e.metadatenUrl).toBe('https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
  });

  it('MCP_OAUTH_JWKS_URL=aus: Unterschrift nur in der API; leere Werte (Compose "${VAR:-}") = Vorgabe', () => {
    const e = leseOAuthEinstellungen({ MCP_OAUTH_JWKS_URL: 'aus', MCP_OAUTH_SCOPES: '' });
    expect(e.jwksUrl).toBeNull();
    expect(e.scopes).toEqual(['profile', 'email']);
    const leer = leseOAuthEinstellungen({ MCP_OAUTH_RESOURCE: '', MCP_OAUTH_ISSUER: ' ', MCP_OAUTH_AUDIENCE: '', MCP_OAUTH_JWKS_URL: '' });
    expect(leer).toEqual(leseOAuthEinstellungen({}));
  });

  it('Ressource ohne Pfad: nur der Well-known-Pfad an der Wurzel', () => {
    const e = leseOAuthEinstellungen({ MCP_OAUTH_RESOURCE: 'https://mcp.example.test' });
    expect(e.metadatenPfade).toEqual(['/.well-known/oauth-protected-resource']);
    expect(e.metadatenUrl).toBe('https://mcp.example.test/.well-known/oauth-protected-resource');
  });

  it('kaputte oder unverschluesselte URL bricht den Start ab (http nur fuer localhost)', () => {
    expect(() => leseOAuthEinstellungen({ MCP_OAUTH_RESOURCE: 'mcp.cachly.dev/mcp' })).toThrow(/MCP_OAUTH_RESOURCE/);
    expect(() => leseOAuthEinstellungen({ MCP_OAUTH_ISSUER: 'http://auth.cachly.dev/realms/cachly' })).toThrow(/https/);
    expect(() => leseOAuthEinstellungen({ MCP_OAUTH_RESOURCE: 'https://mcp.cachly.dev/mcp?x=1' })).toThrow(/\?/);
    expect(leseOAuthEinstellungen({ MCP_OAUTH_ISSUER: 'http://127.0.0.1:8080/realms/t' }).aussteller).toBe('http://127.0.0.1:8080/realms/t');
  });
});

describe('Metadaten (RFC 9728) und der 401-Kopf', () => {
  const e = leseOAuthEinstellungen({});

  it('das Dokument nennt Ressource, genau EINEN Anmeldedienst, Kopf als Weg und die Doku', () => {
    expect(schutzMetadaten(e)).toEqual({
      resource: 'https://mcp.cachly.dev/mcp',
      authorization_servers: ['https://auth.cachly.dev/realms/cachly'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['profile', 'email'],
      resource_name: 'cachly',
      resource_documentation: 'https://cachly.dev/docs/remote-mcp',
    });
  });

  it('Vorgabe enthaelt kein openid (Keycloak-DCR lehnt es mit 403 ab), weder in Metadaten noch im Kopf', () => {
    expect(schutzMetadaten(e).scopes_supported).not.toContain('openid');
    expect(wwwAuthenticate(e)).not.toMatch(/\bopenid\b/);
    expect(wwwAuthenticate(e, 'invalid_token', WERKZEUG_BRAUCHT_ANMELDUNG)).not.toMatch(/\bopenid\b/);
  });

  it('ohne Token: Bearer mit resource_metadata und scope, ohne error', () => {
    const k = wwwAuthenticate(e);
    expect(k).toMatch(/^Bearer /);
    expect(k).toContain('resource_metadata="https://mcp.cachly.dev/.well-known/oauth-protected-resource/mcp"');
    expect(k).toContain('scope="profile email"');
    expect(k).not.toContain('error=');
  });

  it('mit abgelehntem Token: error="invalid_token" (der Client holt ein neues)', () => {
    expect(wwwAuthenticate(e, 'invalid_token')).toContain('error="invalid_token"');
  });

  it('Werkzeugaufruf ohne Anmeldung: die Form aus der Claude-Doku (error, error_description, resource_metadata, scope)', () => {
    const k = wwwAuthenticate(e, 'invalid_token', WERKZEUG_BRAUCHT_ANMELDUNG);
    expect(k).toBe(
      'Bearer realm="cachly", error="invalid_token", error_description="Authentication required for this tool", ' +
      'resource_metadata="https://mcp.cachly.dev/.well-known/oauth-protected-resource/mcp", scope="profile email"',
    );
    // Anfuehrungszeichen und Nicht-ASCII koennen den Kopf nicht aufbrechen.
    expect(wwwAuthenticate(e, 'invalid_token', 'a"bäc')).toContain('error_description="abc"');
  });
});

describe('Lazy Authentication: nur der Werkzeugaufruf braucht eine Anmeldung', () => {
  const n = (method: string) => ({ jsonrpc: '2.0', id: 1, method, params: {} });

  it('initialize, Benachrichtigungen, Listen und ping laufen ohne Anmeldung', () => {
    for (const m of ['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'prompts/list',
      'resources/list', 'resources/templates/list', 'ping']) {
      expect(brauchtAnmeldung(n(m))).toBe(false);
    }
    expect(brauchtAnmeldung({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false); // Antwort des Clients
    expect(brauchtAnmeldung(null)).toBe(false);
  });

  it('tools/call braucht sie, auch versteckt in einem Stapel', () => {
    expect(brauchtAnmeldung(n('tools/call'))).toBe(true);
    expect(brauchtAnmeldung([n('tools/list'), n('tools/call')])).toBe(true);
    expect(brauchtAnmeldung([n('tools/list'), n('ping')])).toBe(false);
  });

  it('Grenze fuer den vorab gelesenen Rumpf: 4 MB', () => {
    expect(MAX_RUMPF_OHNE_ANMELDUNG).toBe(4 * 1024 * 1024);
  });
});

describe('Ansprueche pruefen', () => {
  const e = { aussteller: ISS, zielgruppen: [RES] };
  const jetzt = 1_800_000_000_000;
  const gut = zugangsAnsprueche(ISS, [RES, 'account'], 'nutzer-1', jetzt / 1000);

  it('ein passendes Zugangstoken liefert Inhaber und Ablauf', () => {
    expect(pruefeAnsprueche(gut, e, jetzt)).toEqual({ sub: 'nutzer-1', iss: ISS, bisMs: jetzt + 3600_000 });
  });

  it('fremder Aussteller, fremde Zielgruppe, ID- oder Refresh-Token, fehlender Inhaber: abgelehnt', () => {
    expect(pruefeAnsprueche({ ...gut, iss: 'https://evil.example/realms/cachly' }, e, jetzt)).toEqual({ fehler: 'aussteller' });
    expect(pruefeAnsprueche({ ...gut, aud: 'account' }, e, jetzt)).toEqual({ fehler: 'zielgruppe' });
    expect(pruefeAnsprueche({ ...gut, aud: undefined }, e, jetzt)).toEqual({ fehler: 'zielgruppe' });
    expect(pruefeAnsprueche({ ...gut, typ: 'ID' }, e, jetzt)).toEqual({ fehler: 'typ' });
    expect(pruefeAnsprueche({ ...gut, typ: 'Refresh' }, e, jetzt)).toEqual({ fehler: 'typ' });
    expect(pruefeAnsprueche({ ...gut, sub: '' }, e, jetzt)).toEqual({ fehler: 'inhaber' });
    expect(pruefeAnsprueche({ ...gut, exp: undefined }, e, jetzt)).toEqual({ fehler: 'form' });
  });

  it('Zielgruppe als einzelner Text zaehlt wie eine Liste', () => {
    expect('sub' in pruefeAnsprueche({ ...gut, aud: RES }, e, jetzt)).toBe(true);
  });

  it('Ablauf mit 30 s Spielraum fuer die Uhr; nbf in der Zukunft wird abgelehnt', () => {
    const exp = jetzt / 1000;
    expect('sub' in pruefeAnsprueche({ ...gut, exp: exp - UHR_SPIELRAUM_S + 1 }, e, jetzt)).toBe(true);
    expect(pruefeAnsprueche({ ...gut, exp: exp - UHR_SPIELRAUM_S }, e, jetzt)).toEqual({ fehler: 'abgelaufen' });
    expect(pruefeAnsprueche({ ...gut, nbf: exp + 120 }, e, jetzt)).toEqual({ fehler: 'noch-nicht-gueltig' });
  });
});

describe('Kopf lesen: Zugangstoken neben cky_-Schluesseln', () => {
  const rsa = rsaAussteller();
  const token = unterschreibe(rsa, zugangsAnsprueche(ISS, RES));

  it('ein JWT des erwarteten Ausstellers ist "jwt" (noch ungeprueft)', () => {
    expect(leseBearer(`Bearer ${token}`, { aussteller: ISS })).toEqual({ art: 'jwt', token });
  });

  it('ein JWT eines anderen Ausstellers ist "aussteller"; Muell mit drei Teilen ist "form"', () => {
    const fremd = unterschreibe(rsa, zugangsAnsprueche('https://evil.example/realms/cachly', RES));
    expect(leseBearer(`Bearer ${fremd}`, { aussteller: ISS })).toEqual({ art: 'abgelehnt', grund: 'aussteller' });
    expect(leseBearer('Bearer abc.def.ghi', { aussteller: ISS })).toEqual({ art: 'abgelehnt', grund: 'form' });
  });

  it('alg "none" (leere Unterschrift) sieht gar nicht erst wie ein JWT aus', () => {
    const [k, i] = token.split('.');
    expect(leseBearer(`Bearer ${k}.${i}.`, { aussteller: ISS })).toEqual({ art: 'abgelehnt', grund: 'form' });
  });

  it('ohne erwarteten Aussteller bleibt jedes JWT "form" (Verhalten bis 20.11.2026)', () => {
    expect(leseBearer(`Bearer ${token}`)).toEqual({ art: 'abgelehnt', grund: 'form' });
  });

  it('cky_-Schluessel laufen unveraendert, auch mit erwartetem Aussteller', () => {
    const key = 'cky_live_AAAAAAAAAAAAAAAAAAAAAAAA';
    expect(leseBearer(`Bearer ${key}`, { aussteller: ISS })).toEqual({ art: 'ok', schluessel: key });
  });

  it('zerlegeJwt liest Kopf und Ansprueche ohne Pruefung', () => {
    const t = zerlegeJwt(token)!;
    expect(t.kopf.alg).toBe('RS256');
    expect(t.ansprueche.iss).toBe(ISS);
    expect(zerlegeJwt('a.b')).toBeUndefined();
  });
});

describe('Unterschrift pruefen (JWKS)', () => {
  const rsa = rsaAussteller('rsa-1');
  const e = leseOAuthEinstellungen({});
  const liste = (...jwks: Array<Record<string, unknown>>) => ({ status: 200, body: { keys: jwks } });
  const ablehnung = async (p: Promise<unknown>): Promise<string> => {
    const f = await p.catch((err: unknown) => err);
    expect(f).toBeInstanceOf(TokenAbgelehnt);
    return (f as TokenAbgelehnt).grund;
  };

  it('RS256 von Keycloak: angenommen; die Schluesselliste wird einmal geladen', async () => {
    const abrufe: string[] = [];
    const p = baueJwtPruefer(e, { abruf: async (url) => { abrufe.push(url); return liste(rsa.jwk); } });
    const t = unterschreibe(rsa, zugangsAnsprueche(ISS, RES, 'nutzer-7'));
    await expect(p.pruefe(t)).resolves.toMatchObject({ sub: 'nutzer-7', iss: ISS });
    await p.pruefe(t);
    expect(abrufe).toEqual(['https://auth.cachly.dev/realms/cachly/protocol/openid-connect/certs']);
  });

  it('der Verschluesselungs-Schluessel von Keycloak (use "enc") wird nie zum Pruefen benutzt', async () => {
    const p = baueJwtPruefer(e, { abruf: async () => liste({ ...rsa.jwk, use: 'enc' }) });
    expect(await ablehnung(p.pruefe(unterschreibe(rsa, zugangsAnsprueche(ISS, RES))))).toBe('jwks-fehlt');
  });

  it('ES256 und PS256 werden ebenso geprueft', async () => {
    const ec = ecAussteller('ec-1');
    const { alg: _alg, ...ohneAlg } = rsa.jwk;
    const p = baueJwtPruefer(e, { abruf: async () => liste(ec.jwk, { ...ohneAlg, kid: 'rsa-pss' }) });
    await expect(p.pruefe(unterschreibe(ec, zugangsAnsprueche(ISS, RES)))).resolves.toMatchObject({ sub: 'nutzer-1' });
    await expect(p.pruefe(unterschreibe(rsa, zugangsAnsprueche(ISS, RES), { alg: 'PS256', kid: 'rsa-pss' }))).resolves.toMatchObject({ sub: 'nutzer-1' });
  });

  it('fremder Schluessel mit gleichem kid: Unterschrift ungueltig', async () => {
    const fremd = rsaAussteller('rsa-1');
    const p = baueJwtPruefer(e, { abruf: async () => liste(rsa.jwk) });
    expect(await ablehnung(p.pruefe(unterschreibe(fremd, zugangsAnsprueche(ISS, RES))))).toBe('unterschrift');
  });

  it('veraenderte Ansprueche (anderer Inhaber, alte Unterschrift): ungueltig', async () => {
    const p = baueJwtPruefer(e, { abruf: async () => liste(rsa.jwk) });
    const [k, , u] = unterschreibe(rsa, zugangsAnsprueche(ISS, RES, 'nutzer-1')).split('.');
    const anders = Buffer.from(JSON.stringify(zugangsAnsprueche(ISS, RES, 'nutzer-2'))).toString('base64url');
    expect(await ablehnung(p.pruefe(`${k}.${anders}.${u}`))).toBe('unterschrift');
  });

  it('HS256 und unbekannte Verfahren werden nie angenommen', async () => {
    const p = baueJwtPruefer(e, { abruf: async () => liste(rsa.jwk) });
    const t = unterschreibe(rsa, zugangsAnsprueche(ISS, RES), { kopf: { alg: 'HS256' } });
    expect(await ablehnung(p.pruefe(t))).toBe('algorithmus');
  });

  it('Ansprueche vor der Unterschrift: abgelaufen oder falsche Zielgruppe kostet keinen Abruf', async () => {
    let abrufe = 0;
    const p = baueJwtPruefer(e, { abruf: async () => { abrufe++; return liste(rsa.jwk); } });
    const alt = zugangsAnsprueche(ISS, RES, 'n', Math.floor(Date.now() / 1000) - 7200);
    expect(await ablehnung(p.pruefe(unterschreibe(rsa, alt)))).toBe('abgelaufen');
    expect(await ablehnung(p.pruefe(unterschreibe(rsa, zugangsAnsprueche(ISS, 'account'))))).toBe('zielgruppe');
    expect(abrufe).toBe(0);
  });

  it('Schluesselwechsel: ein neuer kid laedt die Liste neu — ein erfundener hoechstens alle 30 s', async () => {
    let t = 1_000_000;
    const neu = rsaAussteller('rsa-2');
    let angeboten: Array<Record<string, unknown>> = [rsa.jwk];
    let abrufe = 0;
    const abruf: JwksAbruf = async () => { abrufe++; return liste(...angeboten); };
    const p = baueJwtPruefer(e, { abruf, jetzt: () => t });
    const ansp = () => zugangsAnsprueche(ISS, RES, 'n', Math.floor(t / 1000));
    await p.pruefe(unterschreibe(rsa, ansp()));
    expect(abrufe).toBe(1);
    // Erfundener kid: innerhalb von 30 s kein neuer Abruf.
    t += 1000;
    expect(await ablehnung(p.pruefe(unterschreibe(rsa, ansp(), { kid: 'erfunden' })))).toBe('schluessel-unbekannt');
    expect(abrufe).toBe(1);
    // Keycloak hat gewechselt: nach 30 s wird neu geladen und der neue Schluessel gilt.
    angeboten = [neu.jwk];
    t += JWKS_MINDESTABSTAND_MS;
    await expect(p.pruefe(unterschreibe(neu, ansp()))).resolves.toMatchObject({ sub: 'n' });
    expect(abrufe).toBe(2);
  });

  it('nach 10 Minuten wird die Liste erneuert; antwortet Keycloak nicht, gilt die alte weiter', async () => {
    let t = 1_000_000;
    let kaputt = false;
    let abrufe = 0;
    const p = baueJwtPruefer(e, {
      abruf: async () => { abrufe++; if (kaputt) throw new Error('ECONNREFUSED'); return liste(rsa.jwk); },
      jetzt: () => t,
    });
    const tok = () => unterschreibe(rsa, zugangsAnsprueche(ISS, RES, 'n', Math.floor(t / 1000)));
    await p.pruefe(tok());
    kaputt = true;
    t += JWKS_TTL_MS + 1;
    await expect(p.pruefe(tok())).resolves.toMatchObject({ sub: 'n' });
    expect(abrufe).toBe(2);
  });

  it('ohne je geladene Liste und ohne Keycloak: "jwks-fehlt" (wird 502, nicht 401)', async () => {
    const p = baueJwtPruefer(e, { abruf: async () => ({ status: 503, body: null }) });
    expect(await ablehnung(p.pruefe(unterschreibe(rsa, zugangsAnsprueche(ISS, RES))))).toBe('jwks-fehlt');
  });

  it('MCP_OAUTH_JWKS_URL=aus: nur die Ansprueche, kein Abruf (die API prueft die Unterschrift)', async () => {
    let abrufe = 0;
    const p = baueJwtPruefer(leseOAuthEinstellungen({ MCP_OAUTH_JWKS_URL: 'aus' }), { abruf: async () => { abrufe++; return liste(); } });
    await expect(p.pruefe(unterschreibe(rsaAussteller(), zugangsAnsprueche(ISS, RES)))).resolves.toMatchObject({ sub: 'nutzer-1' });
    expect(abrufe).toBe(0);
  });
});

describe('Standard-Brain einer Anmeldung (Regel)', () => {
  const daten = (...i: Array<Record<string, unknown>>) => ({ data: i });

  it('nur laufende zaehlen; davon das zuletzt angelegte', () => {
    expect(waehleStandardBrain(daten(
      { id: INST_2, status: 'suspended', created_at: '2026-11-19T00:00:00Z' },
      { id: INST_3, status: 'running', created_at: '2026-10-01T00:00:00Z' },
      { id: INST_1, status: 'running', created_at: '2026-11-01T00:00:00Z' },
    ))).toBe(INST_1);
  });

  it('gleiches oder fehlendes Datum: die kleinere ID; Grossschrift wird klein', () => {
    expect(waehleStandardBrain(daten({ id: INST_2, status: 'running' }, { id: INST_1.toUpperCase(), status: 'running' }))).toBe(INST_1);
    expect(waehleStandardBrain(daten(
      { id: INST_1, status: 'running' },
      { id: INST_3, status: 'running', created_at: '2026-01-01T00:00:00Z' },
    ))).toBe(INST_3);
  });

  it('kein laufendes Brain, leere Liste, Muell: ""', () => {
    expect(waehleStandardBrain(daten({ id: INST_1, status: 'provisioning' }, { id: INST_2, status: 'pending_payment' }))).toBe('');
    expect(waehleStandardBrain(daten())).toBe('');
    expect(waehleStandardBrain(daten({ id: '../etc', status: 'running' }))).toBe('');
    expect(waehleStandardBrain(null)).toBe('');
  });

  it('die Auskunft ohne Brain nennt das Dashboard', () => {
    expect(KEIN_BRAIN_TEXT).toContain('https://cachly.dev/instances');
  });
});

describe('Zugang aufloesen mit Anmeldung', () => {
  const TOKEN = 'eyJ.token.nutzer1';
  const liste = (...i: Array<Record<string, unknown>>) => ({ status: 200, body: { data: i } });

  it('mehrere Brains sind bei einer Anmeldung kein Fehler: der Server waehlt nach der Regel', async () => {
    const z = baueZugangsAufloeser(async () => liste(
      { id: INST_1, status: 'running', created_at: '2026-11-01T00:00:00Z' },
      { id: INST_2, status: 'running', created_at: '2026-11-10T00:00:00Z' },
    ));
    await expect(z.loese(TOKEN, undefined, '203.0.113.1', { anmeldung: true })).resolves.toBe(INST_2);
  });

  it('dieselbe Liste bleibt fuer cky_-Schluessel ein Fehler mit Hinweis auf den Kopf (unveraendert)', async () => {
    const z = baueZugangsAufloeser(async () => liste({ id: INST_1, status: 'running' }, { id: INST_2, status: 'running' }));
    await expect(z.loese('cky_live_AAAAAAAAAAAAAAAAAAAAAAAA', undefined)).rejects.toThrow(/X-Cachly-Instance/);
  });

  it('kein laufendes Brain: "" — eine Minute gemerkt, dann neu gefragt (Brain angelegt)', async () => {
    let t = 0;
    let aufrufe = 0;
    let angelegt = false;
    const z = baueZugangsAufloeser(async () => {
      aufrufe++;
      return angelegt ? liste({ id: INST_1, status: 'running' }) : liste();
    }, { jetzt: () => t });
    await expect(z.loese(TOKEN, undefined, undefined, { anmeldung: true })).resolves.toBe('');
    await expect(z.loese(TOKEN, undefined, undefined, { anmeldung: true })).resolves.toBe('');
    expect(aufrufe).toBe(1);
    angelegt = true;
    t = ABLEHNUNG_TTL_MS + 1;
    await expect(z.loese(TOKEN, undefined, undefined, { anmeldung: true })).resolves.toBe(INST_1);
    expect(aufrufe).toBe(2);
  });

  it('ein Ergebnis gilt nie laenger als das Token', async () => {
    let t = 0;
    let aufrufe = 0;
    const z = baueZugangsAufloeser(async () => { aufrufe++; return liste({ id: INST_1, status: 'running' }); }, { jetzt: () => t });
    await z.loese(TOKEN, undefined, undefined, { anmeldung: true, bisMs: 120_000 });
    t = 119_000;
    await z.loese(TOKEN, undefined, undefined, { anmeldung: true, bisMs: 120_000 });
    expect(aufrufe).toBe(1);
    t = 120_001; // Token abgelaufen; ohne Grenze hielte der Merker ZUGANG_TTL_MS
    expect(ZUGANG_TTL_MS).toBeGreaterThan(t);
    await z.loese(TOKEN, undefined, undefined, { anmeldung: true, bisMs: 120_000 });
    expect(aufrufe).toBe(2);
  });

  it('API sagt 401: Anmeldung abgelaufen, der Text nennt das Token nicht', async () => {
    const z = baueZugangsAufloeser(async () => ({ status: 401, body: null }));
    const f = await z.loese(TOKEN, undefined, undefined, { anmeldung: true }).catch((e: Error) => e);
    expect((f as Error).message).toMatch(/neu anmelden/);
    expect((f as Error).message).not.toContain(TOKEN);
  });

  it('mit Instanzkopf fragt die API nach GENAU dieser Instanz, wie bei Schluesseln', async () => {
    const gefragt: string[] = [];
    const z = baueZugangsAufloeser(async (pfad) => { gefragt.push(pfad); return { status: 404, body: null }; });
    const f = await z.loese(TOKEN, INST_3, undefined, { anmeldung: true }).catch((e: unknown) => e);
    expect((f as { httpStatus: number }).httpStatus).toBe(403);
    expect(gefragt).toEqual([`/api/v1/instances/${INST_3}`]);
  });
});
