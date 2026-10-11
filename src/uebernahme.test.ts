import { describe, it, expect } from 'vitest';
import {
  istTestSchluessel, waehleTestSchluessel, starteKeycloakAnmeldung, frageAnmeldungAb, warteAufKeycloakAnmeldung,
  uebernimm, brainImKonto, erfolgsText, fehlerText, ersetzeSchluessel, UebernahmeFehler, KEYCLOAK_BASIS,
  type Geraetecode,
} from './uebernahme.js';

const TEST = 'cky_trial_0123456789abcdef0123456789abcdef';

interface Aufruf { url: string; init?: RequestInit }

/** Ein fetch, das der Reihe nach vorbereitete Antworten liefert und mitschreibt. */
function abrufMit(...antworten: Array<{ status: number; body: unknown }>) {
  const aufrufe: Aufruf[] = [];
  const abruf = (async (url: string | URL, init?: RequestInit) => {
    aufrufe.push({ url: String(url), init });
    const a = antworten.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { abruf, aufrufe };
}

const kopf = (a: Aufruf, name: string) => (a.init?.headers as Record<string, string>)[name];

describe('Test-Schluessel waehlen', () => {
  it('nimmt nur cky_trial_-Schluessel', () => {
    expect(istTestSchluessel(TEST)).toBe(true);
    expect(istTestSchluessel('cky_live_0123456789abcdef')).toBe(false);
    expect(istTestSchluessel('')).toBe(false);
    expect(istTestSchluessel(undefined)).toBe(false);
  });

  it('Reihenfolge: --key, dann credentials.json', () => {
    const anderer = 'cky_trial_ffffffffffffffffffffffffffffffff';
    expect(waehleTestSchluessel({ argument: TEST, credentials: anderer })).toEqual({ schluessel: TEST, quelle: 'argument' });
    expect(waehleTestSchluessel({ credentials: TEST })).toEqual({ schluessel: TEST, quelle: 'credentials' });
  });

  // Umgebung und Projekt-.mcp.json kann ein fremdes Repository setzen. Die
  // Auswahl kennt sie deshalb gar nicht erst.
  it('ein echter Kontoschluessel ist nichts zum Uebernehmen', () => {
    expect(waehleTestSchluessel({ credentials: 'cky_live_0123456789abcdef' })).toBeNull();
    expect(waehleTestSchluessel({})).toBeNull();
  });
});

describe('Anmeldung bei Keycloak', () => {
  const code: Geraetecode = { deviceCode: 'dc', userCode: 'ABCD-EFGH', adresse: 'x', intervallMs: 5000, frist: 10_000 };

  it('startet direkt bei Keycloak mit dem Client cachly-cli — nicht ueber die cachly-API', async () => {
    const { abruf, aufrufe } = abrufMit({ status: 200, body: {
      device_code: 'dc', user_code: 'ABCD-EFGH', interval: 5, expires_in: 600,
      verification_uri_complete: 'https://auth.cachly.dev/realms/cachly/device?user_code=ABCD-EFGH',
    } });
    const c = await starteKeycloakAnmeldung(abruf, KEYCLOAK_BASIS, 1000);
    expect(aufrufe[0].url).toBe(`${KEYCLOAK_BASIS}/auth/device`);
    expect(String(aufrufe[0].init?.body)).toContain('client_id=cachly-cli');
    expect(c).toEqual({ deviceCode: 'dc', userCode: 'ABCD-EFGH',
      adresse: 'https://auth.cachly.dev/realms/cachly/device?user_code=ABCD-EFGH', intervallMs: 5000, frist: 601_000 });
  });

  it('liest Token, Warten, Bremsen und Absage', async () => {
    expect(await frageAnmeldungAb(abrufMit({ status: 200, body: { access_token: 'eyJ.t' } }).abruf, code))
      .toEqual({ art: 'token', token: 'eyJ.t' });
    expect(await frageAnmeldungAb(abrufMit({ status: 400, body: { error: 'authorization_pending' } }).abruf, code))
      .toEqual({ art: 'warten' });
    expect(await frageAnmeldungAb(abrufMit({ status: 400, body: { error: 'slow_down' } }).abruf, code))
      .toEqual({ art: 'langsamer' });
    expect(await frageAnmeldungAb(abrufMit({ status: 400, body: { error: 'access_denied' } }).abruf, code))
      .toEqual({ art: 'fehler', grund: 'access_denied' });
    expect(await frageAnmeldungAb(abrufMit({ status: 503, body: {} }).abruf, code)).toEqual({ art: 'warten' });
  });

  it('wartet bis zum Token', async () => {
    const { abruf } = abrufMit(
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'eyJ.t' } },
    );
    let uhr = 0;
    const token = await warteAufKeycloakAnmeldung(abruf, code, { schlafe: async (ms) => { uhr += ms; }, jetzt: () => uhr });
    expect(token).toBe('eyJ.t');
  });

  it('bricht bei Absage und nach Ablauf ab', async () => {
    let uhr = 0;
    const schlafe = async (ms: number) => { uhr += ms; };
    await expect(warteAufKeycloakAnmeldung(abrufMit({ status: 400, body: { error: 'access_denied' } }).abruf, code,
      { schlafe, jetzt: () => uhr })).rejects.toThrow('access_denied');
    uhr = 0;
    const immerWarten = (async () => new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })) as typeof fetch;
    await expect(warteAufKeycloakAnmeldung(immerWarten, code, { schlafe, jetzt: () => uhr })).rejects.toThrow('timed out');
  });
});

describe('uebernimm', () => {
  it('schickt Anmeldung UND Test-Schluessel im selben Aufruf', async () => {
    const { abruf, aufrufe } = abrufMit({ status: 200, body: {
      api_key: 'cky_live_neu', instance_id: 'inst-1', instances: ['inst-1'], account_created: false,
      revoked_keys: 2, brain_restarting: true,
    } });
    const erg = await uebernimm(abruf, 'https://api.cachly.dev/', 'eyJ.anmeldung', TEST, 'mcp', 'cachly-mcp/1');
    expect(aufrufe[0].url).toBe('https://api.cachly.dev/auth/trial/claim');
    expect(kopf(aufrufe[0], 'Authorization')).toBe('Bearer eyJ.anmeldung');
    expect(kopf(aufrufe[0], 'X-Trial-Key')).toBe(TEST);
    expect(JSON.parse(String(aufrufe[0].init?.body))).toEqual({ client: 'mcp' });
    expect(erg).toEqual({ apiKey: 'cky_live_neu', instanceId: 'inst-1', instances: ['inst-1'],
      accountCreated: false, revokedKeys: 2, brainRestarting: true });
  });

  it('ein API-Schluessel ist keine Anmeldung — es geht gar nicht erst raus', async () => {
    const { abruf, aufrufe } = abrufMit();
    await expect(uebernimm(abruf, 'https://api.cachly.dev', 'cky_live_x', TEST)).rejects.toBeInstanceOf(UebernahmeFehler);
    expect(aufrufe).toHaveLength(0);
  });

  it('gibt den Grund des Servers weiter', async () => {
    const { abruf } = abrufMit({ status: 409, body: { reason: 'instance_limit', error: 'Your account already has a free Brain.' } });
    const fehler = await uebernimm(abruf, 'https://api.cachly.dev', 'eyJ.a', TEST).catch((e) => e);
    expect(fehler).toBeInstanceOf(UebernahmeFehler);
    expect(fehler.reason).toBe('instance_limit');
    expect(fehlerText(fehler)).toBe('Your account already has a free Brain. Nothing was changed.');
  });
});

describe('Texte', () => {
  const erg = { apiKey: 'k', instanceId: 'inst-1', instances: ['inst-1'], accountCreated: true, revokedKeys: 2, brainRestarting: true };

  it('"Lessons kept" nur, wenn der neue Schluessel das Brain erreicht hat', () => {
    expect(erfolgsText(erg, true)).toContain('Your test Brain is now part of your account. Lessons kept.');
    expect(erfolgsText(erg, false)).not.toContain('Lessons kept');
    expect(erfolgsText(erg, true)).toContain('2 keys revoked');
  });

  it('jede Absage sagt, dass nichts veraendert wurde', () => {
    for (const reason of ['trial_key_invalid', 'claim_unavailable', 'paid', 'app_account']) {
      const text = fehlerText(new UebernahmeFehler(409, reason, 'Server sagt nein.'));
      expect(text.toLowerCase()).toMatch(/nothing (was changed|to claim)|finish the sign-in/);
    }
  });
});

describe('brainImKonto', () => {
  it('ja nur, wenn der neue Schluessel genau dieses Brain zurueckbekommt', async () => {
    expect(await brainImKonto(abrufMit({ status: 200, body: { id: 'inst-1' } }).abruf, 'https://a', 'k', 'inst-1')).toBe(true);
    expect(await brainImKonto(abrufMit({ status: 404, body: {} }).abruf, 'https://a', 'k', 'inst-1')).toBe(false);
    expect(await brainImKonto(abrufMit({ status: 200, body: { id: 'anders' } }).abruf, 'https://a', 'k', 'inst-1')).toBe(false);
  });
});

describe('ersetzeSchluessel', () => {
  it('ersetzt nur den alten Schluessel, woertlich', () => {
    const text = JSON.stringify({ mcpServers: { cachly: { env: { CACHLY_JWT: TEST } }, andere: { env: { X: 'cky_trial_' } } } });
    const r = ersetzeSchluessel(text, TEST, 'cky_live_neu');
    expect(r.ersetzt).toBe(true);
    expect(JSON.parse(r.text).mcpServers.cachly.env.CACHLY_JWT).toBe('cky_live_neu');
    expect(JSON.parse(r.text).mcpServers.andere.env.X).toBe('cky_trial_');
    expect(ersetzeSchluessel('{}', TEST, 'neu')).toEqual({ text: '{}', ersetzt: false });
  });
});
