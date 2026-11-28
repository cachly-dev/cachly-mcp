/**
 * Abnahme Stufe 4, Pack S4-2: Notizen, Sitzung und Fragen im eigenen Konto-Bereich.
 * Aufbau wie abnahme-stufe3-raeume.test.ts. Echter Valkey, Datenbank 10.
 *
 * Lauf: CACHLY_TEST_VALKEY_URL=redis://127.0.0.1:6390/0 npx vitest run src/__tests__/stufe4-konto.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { handleContextTool } from '../handlers/context.js';
import { handleSyndicateTool } from '../handlers/syndicate.js';
import { alsMitgliedsSpeicher, merkeVollenZugang, richteRolleEin, setzeRollenZustandZurueck, SCHREIBVERBOT_ANFANG } from '../rolle.js';
import { mitgliedMuster, raumPrivat, raeumeAusAuskunft } from '../raeume.js';
import { KONTO_FAMILIEN, istKontoSchluessel, kontoSchluessel, alterSchluessel } from '../konto-bereich.js';

const ADRESSE = process.env.CACHLY_TEST_VALKEY_URL ?? '';
const DB = 10;
const IID = '44444444-2222-4333-8444-555555555555';
const MIA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTTO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CHEF = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const MIA_BENUTZER = 'm-s4konto-mia';
const ADA_BENUTZER = 'a-s4konto-ada';
const PW = 'konto-probe-geheim';
const KONTO = (id: string): string => `${raumPrivat(id)}k:`;

type Aufruf = { pfad: string; methode: string };

describe.runIf(ADRESSE)('Stufe 4 gegen echten Valkey: der Konto-Bereich', () => {
  let admin: Redis;
  let besitzerRoh: Redis;
  let miaRoh: Redis;
  let adaRoh: Redis;
  let mia: Redis;
  let ada: Redis;
  let besitzer: Redis;
  const aufrufe: Aufruf[] = [];

  const api = (async <T>(pfad: string, optionen?: RequestInit): Promise<T> => {
    aufrufe.push({ pfad, methode: optionen?.method ?? 'GET' });
    if (pfad.endsWith('/role')) {
      return { role: 'contributor', source: 'default', can: { learn: true, confirm: false, withdraw: false, manage: false },
        review_mode: false, protection: 'on', rooms: true } as T;
    }
    return {} as T;
  }) as unknown as Parameters<typeof handleBrainTool>[3];

  const als = (r: Redis) => async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const voll = { instance_id: IID, ...args };
    for (const h of [handleBrainTool, handleContextTool, handleSyndicateTool]) {
      const t = await h(name, voll, async () => r, api);
      if (t !== null) return String(t);
    }
    return 'null';
  };

  const sechsWerkzeuge = async (r: Redis, marke: string): Promise<string[]> => {
    const f = als(r);
    const a = [
      await f('remember_context', { key: `notiz-${marke}`, content: `NEUE-NOTIZ-${marke} deploy rollback` }),
      await f('session_start', { focus: 'deploy rollback' }),
      await f('smart_recall', { query: 'deploy rollback' }),
      await f('session_ping', { task: `aufgabe ${marke}` }),
      await f('session_handoff', { completed_tasks: ['a'], remaining_tasks: [`weiter-${marke}`], context_summary: `UEBERGABE-${marke}` }),
      await f('session_end', { summary: `ende ${marke} deploy` }),
    ];
    await warte(150);
    return a;
  };

  const warte = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const bis = async (bedingung: () => Promise<boolean>): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      if (await bedingung()) return true;
      await warte(100);
    }
    return false;
  };

  const lektion = (topic: string, text: string, autor: string) => JSON.stringify({
    topic, outcome: 'success', severity: 'major', what_worked: text, what_failed: '', ts: new Date().toISOString(),
    verified_at: new Date().toISOString(), author: autor, tags: ['ops'], recall_count: 0, version: 3,
  });

  /** Alle Schluessel der acht Familien am alten Ort, mit ihrem Inhalt. */
  const alteSchluessel = async (): Promise<Record<string, string>> => {
    const aus: Record<string, string> = {};
    for (const k of (await admin.keys('cachly:*')).sort()) {
      if (k.startsWith('cachly:zone:') || !istKontoSchluessel(k)) continue;
      const art = await admin.type(k);
      let inhalt = '';
      if (art === 'string') inhalt = (await admin.get(k)) ?? '';
      else if (art === 'list') inhalt = JSON.stringify(await admin.lrange(k, 0, -1));
      else if (art === 'set') inhalt = JSON.stringify((await admin.smembers(k)).sort());
      else if (art === 'hash') inhalt = JSON.stringify(await admin.hgetall(k));
      aus[k] = `${art}:${inhalt}`;
    }
    return aus;
  };
  const zoneSchluessel = async (): Promise<string[]> => (await admin.keys('cachly:zone:*')).sort();
  const imBereich = async (konto: string): Promise<string[]> => (await admin.keys(`${konto}*`)).sort();

  const saeen = async (): Promise<void> => {
    await admin.flushdb();
    await admin.set('cachly:lesson:best:deploy:web', lektion('deploy:web', 'TEAMWEIT rollback ueber das tag deploy', 'anna'));
    await admin.sadd('cachly:lesson:topics', 'deploy:web');
    // Der Besitzer.
    await admin.set('cachly:ctx:custom:chef-notiz', 'CHEF-NOTIZ-1A deploy rollback', 'EX', 86400);
    await admin.set('cachly:ctx:custom:chef-notiz:meta', '{"key":"chef-notiz"}', 'EX', 86400);
    await admin.set('cachly:session:last', JSON.stringify({ ts: new Date().toISOString(), summary: 'CHEF-SITZUNG-2B deploy' }));
    await admin.set('cachly:session:handoff', JSON.stringify({
      ts: new Date().toISOString(), completed_tasks: [], remaining_tasks: ['CHEF-UEBERGABE-3C'], context_summary: 'CHEF-UEBERGABE-3C',
    }));
    await admin.lpush(`cachly:stats:suchprotokoll:${IID}`, JSON.stringify({ ts: new Date().toISOString(), frage: 'CHEF-FRAGE-4D', geliefert: [] }));
    await admin.rpush(`cachly:wirkung:${IID}`, JSON.stringify({ ts: new Date().toISOString(), frage: 'CHEF-WIRKUNG-5E', thema: 'x', geholfen: true, rang: 0, quelle: 'angabe' }));
    await admin.set('cachly:agents:active:chef', JSON.stringify({ author: 'CHEF-AKTIV-6F', last_topic: 'deploy:web', last_outcome: 'success', ts: new Date().toISOString() }));
    await admin.sadd(`cachly:stats:reuse_pairs:${IID}`, 'CHEF-PAAR-7G<-X', 'CHEF-PAAR-8H<-Y');
    // Otto: nur Bestand.
    const o = KONTO(OTTO);
    await admin.set(`${o}ctx:custom:otto-notiz`, 'OTTO-NOTIZ-1A deploy rollback', 'EX', 86400);
    await admin.set(`${o}session:last`, JSON.stringify({ ts: new Date().toISOString(), summary: 'OTTO-SITZUNG-2B deploy' }));
    await admin.set(`${o}session:handoff`, JSON.stringify({
      ts: new Date().toISOString(), completed_tasks: [], remaining_tasks: ['OTTO-UEBERGABE-3C'], context_summary: 'OTTO-UEBERGABE-3C',
    }));
    await admin.lpush(`${o}stats:suchprotokoll:${IID}`, JSON.stringify({ ts: new Date().toISOString(), frage: 'OTTO-FRAGE-4D', geliefert: [] }));
    await admin.set(`${o}agents:active:otto`, JSON.stringify({ author: 'OTTO-AKTIV-6F', last_topic: 'deploy:web', last_outcome: 'success', ts: new Date().toISOString() }));
    await admin.sadd(`${o}stats:reuse_pairs:${IID}`, 'OTTO-PAAR-7G<-X');
    // Mia und Ada: eigener Bestand (Notiz, Uebergabe, eigene Aktiv-Zeile, ein Paar).
    for (const [id, name] of [[MIA, 'MIA'], [ADA, 'ADA']] as const) {
      const k = KONTO(id);
      await admin.set(`${k}ctx:custom:${name.toLowerCase()}-notiz`, `${name}-NOTIZ-1A deploy rollback`, 'EX', 86400);
      await admin.set(`${k}session:handoff`, JSON.stringify({
        ts: new Date().toISOString(), completed_tasks: [], remaining_tasks: [`${name}-UEBERGABE-3C`], context_summary: `${name}-UEBERGABE-3C`,
      }));
      await admin.set(`${k}agents:active:${name.toLowerCase()}`, JSON.stringify({ author: `${name}-AKTIV-6F`, last_topic: 'deploy:web', last_outcome: 'success', ts: new Date().toISOString() }));
      await admin.sadd(`${k}stats:reuse_pairs:${IID}`, `${name}-PAAR-7G<-X`);
    }
  };

  beforeAll(async () => {
    const url = new URL(ADRESSE);
    const basis = { host: url.hostname, port: Number(url.port || 6379), db: DB, maxRetriesPerRequest: 2, connectTimeout: 5000 };
    const besitzerAnmeldung = url.password ? { password: decodeURIComponent(url.password) } : {};
    admin = new Redis({ ...basis, ...besitzerAnmeldung });
    besitzerRoh = new Redis({ ...basis, ...besitzerAnmeldung });
    await admin.flushdb();
    richteRolleEin({ abruf: api as never });

    await admin.call('ACL', 'DELUSER', MIA_BENUTZER, ADA_BENUTZER).catch(() => undefined);
    await admin.call('ACL', 'SETUSER', MIA_BENUTZER, 'on', `>${PW}`, ...mitgliedMuster({ privat: raumPrivat(MIA), gruppen: [] }));
    await admin.call('ACL', 'SETUSER', ADA_BENUTZER, 'on', `>${PW}`, '~*', '+@all', '-@admin', '-@dangerous', '+keys', '+info', '-client');
    miaRoh = new Redis({ ...basis, username: MIA_BENUTZER, password: PW });
    adaRoh = new Redis({ ...basis, username: ADA_BENUTZER, password: PW });
    mia = alsMitgliedsSpeicher(miaRoh, {
      role: 'contributor', username: MIA_BENUTZER, instanceId: IID,
      raeume: { privat: raumPrivat(MIA), gruppen: [], konto: KONTO(MIA) },
    } as never);
    ada = alsMitgliedsSpeicher(adaRoh, {
      role: 'admin', username: ADA_BENUTZER, instanceId: IID,
      raeume: { privat: raumPrivat(ADA), gruppen: [], alle: true, konto: KONTO(ADA) },
    } as never);
    besitzer = besitzerRoh;
    merkeVollenZugang(besitzer, { instanceId: IID, raeume: { privat: raumPrivat(CHEF), gruppen: [], alle: true } } as never);
  }, 30_000);

  beforeEach(async () => { await saeen(); });

  afterAll(async () => {
    setzeRollenZustandZurueck();
    if (admin?.status === 'ready') {
      await admin.flushdb();
      await admin.call('ACL', 'DELUSER', MIA_BENUTZER, ADA_BENUTZER).catch(() => undefined);
    }
    await Promise.all([admin, besitzerRoh, miaRoh, adaRoh].map((r) => r?.quit().catch(() => undefined)));
  });

  it('Mitglied: Notiz, Sitzung, Uebergabe und Suche liegen im eigenen Konto-Bereich', async () => {
    const vorher = await alteSchluessel();
    const antworten = await sechsWerkzeuge(mia, 'mia');
    for (const a of antworten) {
      expect(a).not.toContain(SCHREIBVERBOT_ANFANG);
      expect(a).not.toContain('NOPERM');
    }
    expect(await alteSchluessel()).toEqual(vorher);
    const k = KONTO(MIA);
    const schluessel = await imBereich(k);
    expect(schluessel).toContain(`${k}ctx:custom:notiz-mia`);
    expect(schluessel).toContain(`${k}session:last`);
    expect(schluessel).toContain(`${k}session:handoff`);
    expect(schluessel).toContain(`${k}stats:suchprotokoll:${IID}`);
    expect(await admin.get(`${k}ctx:custom:notiz-mia`)).toContain('NEUE-NOTIZ-mia');
  });

  it('Mitglied sieht Notiz, Sitzung und Uebergabe des Besitzers und des Kollegen nicht', async () => {
    const f = als(mia);
    await admin.set(`${KONTO(MIA)}session:last`, JSON.stringify({ ts: new Date().toISOString(), summary: 'MIA-SITZUNG-2B deploy' }));
    const texte = [
      await f('session_start', { focus: 'deploy rollback' }),
      await f('recall_context', { key: 'chef-notiz' }),
      await f('recall_context', { key: '*notiz*' }),
      await f('list_remembered'),
      await f('smart_recall', { query: 'deploy rollback notiz uebergabe' }),
      await f('brain_search', { query: 'deploy rollback notiz uebergabe' }),
    ];
    const alles = texte.join('\n');
    for (const marke of ['CHEF-NOTIZ-1A', 'CHEF-SITZUNG-2B', 'CHEF-UEBERGABE-3C', 'OTTO-NOTIZ-1A', 'OTTO-SITZUNG-2B', 'OTTO-UEBERGABE-3C']) {
      expect(alles, `fremde Marke ${marke}`).not.toContain(marke);
    }
    expect(texte[0]).toContain('MIA-UEBERGABE-3C');
    expect(texte[0]).toContain('MIA-SITZUNG-2B');
    expect(texte[2]).toContain('MIA-NOTIZ-1A');
    expect(texte[3]).toContain('mia-notiz');
    expect(texte[5]).toContain('MIA-NOTIZ-1A');
  });

  it('Mitglied: forget_context loescht nur eigene Notizen', async () => {
    const aus = await als(mia)('forget_context', { keys: ['*'] });
    expect(aus).toContain('Forgot');
    expect(await admin.exists(`${KONTO(MIA)}ctx:custom:mia-notiz`)).toBe(0);
    expect(await admin.exists('cachly:ctx:custom:chef-notiz')).toBe(1);
    expect(await admin.exists('cachly:ctx:custom:chef-notiz:meta')).toBe(1);
    expect(await admin.exists(`${KONTO(OTTO)}ctx:custom:otto-notiz`)).toBe(1);
  });

  it('Mitglied: recall_feedback zaehlt die eigene Suche', async () => {
    const f = als(mia);
    const wirkungMia = `${KONTO(MIA)}wirkung:${IID}`;
    const letzterMia = `${KONTO(MIA)}letzter-recall:${IID}`;
    await f('smart_recall', { query: 'deploy rollback tag' });
    expect(await bis(async () => (await admin.exists(letzterMia)) === 1), 'letzter-recall nach smart_recall').toBe(true);
    await f('recall_best_solution', { topic: 'deploy:web' });
    expect(await bis(async () => (await admin.llen(wirkungMia)) >= 1), 'Wirkung nach recall_best_solution').toBe(true);
    expect(await admin.llen(`cachly:wirkung:${IID}`)).toBe(1);
    expect(await admin.exists(`cachly:letzter-recall:${IID}`)).toBe(0);
  });

  it('Admin: eigener Konto-Bereich, die alten Schluessel des Besitzers bleiben Byte fuer Byte', async () => {
    const vorher = await alteSchluessel();
    const antworten = await sechsWerkzeuge(ada, 'ada');
    for (const a of antworten) expect(a).not.toContain('NOPERM');
    expect(await alteSchluessel()).toEqual(vorher);
    const k = KONTO(ADA);
    const schluessel = await imBereich(k);
    expect(schluessel).toContain(`${k}session:last`);
    expect(schluessel).toContain(`${k}session:handoff`);
    expect(schluessel).toContain(`${k}ctx:custom:notiz-ada`);
  });

  it('Besitzer: dieselben Schluessel wie 0.10.283', async () => {
    const zoneVorher = await zoneSchluessel();
    const antworten = await sechsWerkzeuge(besitzer, 'chef');
    for (const a of antworten) expect(a).not.toContain('NOPERM');
    expect(await zoneSchluessel()).toEqual(zoneVorher);
    for (const k of ['cachly:ctx:custom:notiz-chef', 'cachly:session:last', 'cachly:session:handoff', 'cachly:session:checkpoint', `cachly:stats:suchprotokoll:${IID}`]) {
      expect(await admin.exists(k), `fehlt: ${k}`).toBe(1);
    }
    expect(await admin.get('cachly:ctx:custom:notiz-chef')).toContain('NEUE-NOTIZ-chef');
  });

  it('alte API ohne rooms.account: das Mitglied arbeitet am alten Ort', () => {
    const ohne = alsMitgliedsSpeicher({}, { role: 'contributor', raeume: { privat: raumPrivat(MIA), gruppen: [] } } as never);
    expect(kontoSchluessel(ohne, 'cachly:session:last')).toBe('cachly:session:last');
    expect(alterSchluessel(ohne, 'cachly:session:last')).toBe('cachly:session:last');
    const mit = alsMitgliedsSpeicher({}, { role: 'contributor', raeume: { privat: raumPrivat(MIA), gruppen: [], konto: KONTO(MIA) } } as never);
    expect(kontoSchluessel(mit, 'cachly:session:last').startsWith(KONTO(MIA))).toBe(true);
    expect(kontoSchluessel(mit, 'cachly:session:last')).toBe(`${KONTO(MIA)}session:last`);
    expect(alterSchluessel(mit, `${KONTO(MIA)}session:last`)).toBe('cachly:session:last');
    expect(kontoSchluessel(mit, 'cachly:lesson:best:x')).toBe('cachly:lesson:best:x');
    for (const f of KONTO_FAMILIEN) {
      expect(kontoSchluessel(mit, `${f}x`)).toBe(`${KONTO(MIA)}${f.slice('cachly:'.length)}x`);
      expect(alterSchluessel(mit, kontoSchluessel(mit, `${f}x`))).toBe(`${f}x`);
    }
  });

  it('raeumeAusAuskunft nimmt rooms.account nur an, wenn es zum privaten Raum passt', () => {
    const privat = raumPrivat(MIA);
    expect(raeumeAusAuskunft({ private: privat, groups: [], account: KONTO(MIA) })?.konto).toBe(KONTO(MIA));
    expect(raeumeAusAuskunft({ private: privat, groups: [], account: KONTO(OTTO) })?.konto).toBeUndefined();
    expect(raeumeAusAuskunft({ private: privat, groups: [], account: `${privat}*` })?.konto).toBeUndefined();
    expect(raeumeAusAuskunft({ private: privat, groups: [], account: privat })?.konto).toBeUndefined();
    expect(raeumeAusAuskunft({ private: privat, groups: [], account: `${privat}k:x` })?.konto).toBeUndefined();
    expect(raeumeAusAuskunft({ groups: [], all: true, account: KONTO(MIA) })?.konto).toBeUndefined();
    expect(raeumeAusAuskunft({ private: privat, groups: [] })?.konto).toBeUndefined();
  });

  it('Mitglied: wer woran arbeitet und wer wessen Lektion nutzt bleibt je Konto', async () => {
    const f = als(mia);
    const konflikte = await f('brain_conflicts');
    expect(konflikte).toContain('Only your own activity is shown.');
    for (const marke of ['CHEF-AKTIV-6F', 'OTTO-AKTIV-6F']) expect(konflikte).not.toContain(marke);
    expect(konflikte).toContain('MIA-AKTIV-6F');
    const metriken = await f('brain_metrics');
    for (const marke of ['CHEF-PAAR', 'OTTO-PAAR']) expect(metriken).not.toContain(marke);
    expect(metriken).toMatch(/\*\*1\*\* distinct reuse relationship for your account/);
    expect(metriken).not.toContain('across the team');

    const alteMenge = (await admin.smembers(`cachly:stats:reuse_pairs:${IID}`)).sort();
    await f('smart_recall', { query: 'deploy rollback tag', author: 'mia' });
    expect(await bis(async () => (await admin.smembers(`${KONTO(MIA)}stats:reuse_pairs:${IID}`)).includes('mia<-anna')), 'Paar im Konto').toBe(true);
    expect((await admin.smembers(`cachly:stats:reuse_pairs:${IID}`)).sort()).toEqual(alteMenge);

    const chefKonflikte = await als(besitzer)('brain_conflicts');
    expect(chefKonflikte).toContain('CHEF-AKTIV-6F');
    expect(chefKonflikte).not.toContain('Only your own activity is shown.');
    const chefMetriken = await als(besitzer)('brain_metrics');
    expect(chefMetriken).toContain('across the team');
    expect(chefMetriken).not.toContain('for your account');
  });
});
