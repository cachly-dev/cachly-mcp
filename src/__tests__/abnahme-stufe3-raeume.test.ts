/**
 * EINGEFRORENE ABNAHME Stufe 3, FASSUNG 4 (Architekt, 28.11.2026). Zielort im Produkt-Repo:
 *
 *   sdk/mcp/src/__tests__/abnahme-stufe3-raeume.test.ts   (diese Datei ERSETZT die Fassung vom 27.11.)
 *
 * Was Fassung 4 aendert (nur das, sonst nichts):
 *   1. Der Fall "das Muster traegt genau die eigenen Raeume": das Muster von
 *      Stufe 4 (Lesen ohne die Konto-Familien, eine Regel fuer den Konto-Bereich,
 *      letzter-recall und liefer nicht mehr einzeln frei).
 *   2. Die Raeume von Mia tragen `konto` (Feld `rooms.account` aus /connection):
 *      ihre Sitzungs-Daten liegen im eigenen Konto-Bereich.
 * NICHT GEMESSEN: Fassung 4 ist gelesen, nicht gelaufen (kein Produktcode fuer
 * Stufe 4 vorhanden). Passt ein Fall nicht: Befund an den Orchestrator.
 *
 * Worker aendern diese Datei NICHT. Passt sie nicht zum Code, ist das ein
 * Befund fuer den Orchestrator, kein Anlass, den Test zu biegen.
 *
 * HEUTE ROT: ../raeume.js gibt es nicht. Mit einem leeren Ersatz fuer raeume.ts
 * (nur Schluessel und Muster, Werkzeuge unveraendert) sind 6 von 14 Faellen rot,
 * gemessen am 27.11.2026 gegen Valkey 8 (Liste in ABNAHMEN-stufe-3.md).
 *
 * Vertrag, den der Test festschreibt (alles aus ../raeume.js):
 *
 *   interface Raeume { privat?: string; gruppen: { name: string; praefix: string }[]; alle?: boolean }
 *   raumPrivat(kontoId)            "cachly:zone:p:<16 hex>:"
 *   raumGruppe(name)               "cachly:zone:g:<sha256('gruppe:'+name klein, getrimmt)[:16]>:"
 *   lektionsSchluessel(praefix, thema)   praefix + "lesson:best:" + sha256(thema)[:32]
 *   themenSchluessel(praefix)      praefix + "themen"
 *   RAUM_VERZEICHNIS               "cachly:zone:raeume"
 *   mitgliedMuster({ privat, gruppen })  die ACL-Regeln ohne "on" und Passwort,
 *                                  wortgleich mit brainzugang.MusterMitglied (Go)
 *
 * Die Raeume einer Verbindung stehen am Zugang (rolle.ts):
 *   alsMitgliedsSpeicher(client, { role, username, instanceId, raeume })
 *   merkeVollenZugang(client, { instanceId, raeume })
 * Im Betrieb kommen sie aus dem Feld `rooms` von GET /connection.
 *
 * Lauf: CACHLY_TEST_VALKEY_URL=redis://127.0.0.1:6390/0 npx vitest run <diese Datei>
 * Der Test benutzt Datenbank 8 und leert nur sie.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { alsMitgliedsSpeicher, merkeVollenZugang, richteRolleEin, setzeRollenZustandZurueck } from '../rolle.js';
import {
  raumPrivat, raumGruppe, lektionsSchluessel, themenSchluessel, mitgliedMuster, RAUM_VERZEICHNIS,
} from '../raeume.js';

const ADRESSE = process.env.CACHLY_TEST_VALKEY_URL ?? '';
const PFLICHT = process.env.CACHLY_ECHTER_SPEICHER_PFLICHT === '1';
const DB = 8;
const IID = '33333333-2222-4333-8444-555555555555';
const MIA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTTO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHEF = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const MIA_BENUTZER = 'm-aaaaaaaaaaaaaaaa';
const MIA_PW = 'mia-probe-geheim';

type Aufruf = { pfad: string; methode: string; koerper: Record<string, unknown> };

describe('Stufe 3: Schluessel-Vertrag (ohne Speicher)', () => {
  it('Raum- und Lektionsschluessel sind wortgleich mit der Go-Seite', () => {
    expect(raumPrivat(MIA)).toBe('cachly:zone:p:aaaaaaaaaaaaaaaa:');
    expect(raumGruppe('  Chefs ')).toBe('cachly:zone:g:5e2221f6c6e62c15:');
    expect(lektionsSchluessel(raumPrivat(MIA), 'deploy:web'))
      .toBe('cachly:zone:p:aaaaaaaaaaaaaaaa:lesson:best:b13a5060c64b3a4b437e82f9fd040d0e');
    expect(themenSchluessel(raumPrivat(MIA))).toBe('cachly:zone:p:aaaaaaaaaaaaaaaa:themen');
    expect(RAUM_VERZEICHNIS).toBe('cachly:zone:raeume');
    expect(lektionsSchluessel(raumPrivat(OTTO), 'otto:gehalt')).not.toMatch(/otto|gehalt/);
  });

  it('das Muster traegt genau die eigenen Raeume und sperrt die Familie zone', () => {
    const m = mitgliedMuster({ privat: raumPrivat(MIA), gruppen: [raumGruppe('security')] });
    expect(m[0]).toBe('%R~cachly:[^zcslmwa]*');
    expect(m).toContain('%R~cachly:zone:p:aaaaaaaaaaaaaaaa:*');
    expect(m).toContain(`%R~${raumGruppe('security')}*`);
    expect(m.filter((r) => r.includes('cachly:zone:')).length).toBe(3);
    expect(m).toContain('~cachly:zone:p:aaaaaaaaaaaaaaaa:k:*');
    expect(m).toContain('~cachly:[^tlciwgfbmpdzsa]*');
    expect(m).toContain('~cachly:a[^g]*');
    expect(m).toContain('~cachly:stats:[^sr]*');
    expect(m).not.toContain('~cachly:letzter-recall:*');
    expect(m).not.toContain('~cachly:liefer:*');
    expect(m).not.toContain('~cachly:ctx:*');
    expect(m).not.toContain('~cachly:wirkung:*');
    expect(m).not.toContain('%R~cachly:[^z]*');
    expect(m).not.toContain('%R~*');
    expect(m.slice(-6)).toEqual(['+@all', '-@admin', '-@dangerous', '+keys', '+info', '-client']);
  });
});

describe('echter Speicher: Pflicht, wo verlangt', () => {
  it.runIf(PFLICHT)('die Adresse des echten Speichers ist gesetzt', () => {
    expect(ADRESSE, 'CACHLY_TEST_VALKEY_URL fehlt; in der CI ist der echte Speicher Pflicht').not.toBe('');
  });
  it.runIf(!ADRESSE && !PFLICHT)('uebersprungen: kein echter Speicher', () => {
    console.warn('[stufe3] NICHT GEMESSEN: CACHLY_TEST_VALKEY_URL nicht gesetzt.');
  });
});

describe.runIf(ADRESSE)('Stufe 3 gegen echten Valkey: Mitglieder lesen nur, was sie duerfen', () => {
  let admin: Redis;          // Besitzer, Standardbenutzer, Raeume: alle
  let besitzerOhne: Redis;   // Besitzer wie vor Stufe 3 (kein Feld raeume am Zugang)
  let miaRoh: Redis;
  let mia: Redis;            // Mitglied mit Huelle
  const aufrufe: Aufruf[] = [];

  const api = (async <T>(pfad: string, optionen?: RequestInit): Promise<T> => {
    const koerper = typeof optionen?.body === 'string' ? JSON.parse(optionen.body) as Record<string, unknown> : {};
    aufrufe.push({ pfad, methode: optionen?.method ?? 'GET', koerper });
    if (pfad.endsWith('/role')) {
      return { role: 'contributor', source: 'default', can: { learn: true, confirm: false, withdraw: false, manage: false },
        review_mode: false, protection: 'on', rooms: true } as T;
    }
    if (pfad.endsWith('/learn')) {
      return { ok: true, topic: koerper.topic, room: koerper.visibility === 'private' ? 'private' : koerper.group ? 'group' : 'team' } as T;
    }
    return {} as T;
  }) as unknown as Parameters<typeof handleBrainTool>[3];

  const als = (r: Redis) => (name: string, args: Record<string, unknown>) =>
    handleBrainTool(name, { instance_id: IID, ...args }, async () => r, api).then(String);

  const jetzt = new Date().toISOString();
  const lektion = (topic: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    topic, outcome: 'success', severity: 'major', what_worked: text, what_failed: '', ts: jetzt, verified_at: jetzt,
    author: 'anna', tags: ['ops'], recall_count: 0, version: 3, ...extra,
  });
  const legeInRaum = async (praefix: string, art: 'p' | 'g', topic: string, text: string, extra: Record<string, unknown> = {}) => {
    await admin.set(lektionsSchluessel(praefix, topic), lektion(topic, text, extra));
    await admin.sadd(themenSchluessel(praefix), topic);
    await admin.hset(RAUM_VERZEICHNIS, praefix, JSON.stringify({ art }));
  };

  /** Alle Werte ausserhalb der Raeume, als ein Text (als Besitzer gelesen). */
  const ausserhalbDerRaeume = async (): Promise<string> => {
    const teile: string[] = [];
    for (const k of await admin.keys('*')) {
      if (k.startsWith('cachly:zone:')) continue;
      const art = await admin.type(k);
      teile.push(k);
      if (art === 'string') teile.push((await admin.get(k)) ?? '');
      else if (art === 'list') teile.push(...await admin.lrange(k, 0, -1));
      else if (art === 'set') teile.push(...await admin.smembers(k));
      else if (art === 'zset') teile.push(...await admin.zrange(k, 0, -1));
      else if (art === 'hash') teile.push(JSON.stringify(await admin.hgetall(k)));
    }
    return teile.join('\n');
  };

  /** Summe aller bisher ausgefuehrten Befehle des Speichers. */
  const befehlsZahl = async (): Promise<number> => {
    const text = await admin.info('commandstats');
    let n = 0;
    for (const m of text.matchAll(/calls=(\d+)/g)) n += Number(m[1]);
    return n;
  };

  beforeAll(async () => {
    // Nicht new Redis(ADRESSE, { db }): die Datenbank aus der Adresse ("/0") gewinnt dort.
    const url = new URL(ADRESSE);
    const basis = { host: url.hostname, port: Number(url.port || 6379), db: DB, maxRetriesPerRequest: 2, connectTimeout: 5000 };
    const besitzerAnmeldung = url.password ? { password: decodeURIComponent(url.password) } : {};
    admin = new Redis({ ...basis, ...besitzerAnmeldung });
    besitzerOhne = new Redis({ ...basis, ...besitzerAnmeldung });
    await admin.flushdb();
    richteRolleEin({ abruf: api as never });

    // Team-Lektion, wie bisher.
    await admin.set('cachly:lesson:best:deploy:web', lektion('deploy:web', 'TEAMWEIT-SICHTBAR rollback ueber das tag'));
    // Raeume.
    await legeInRaum(raumPrivat(MIA), 'p', 'mia:notiz', 'EIGEN-PRIVAT-4K pruefsumme vom laptop', { visibility: 'private', author_id: MIA });
    await legeInRaum(raumPrivat(OTTO), 'p', 'otto:gehalt', 'TRESORINHALT-7Q liegt hinter dem bild im tresor', { visibility: 'private', author_id: OTTO });
    await legeInRaum(raumGruppe('security'), 'g', 'sec:rota', 'GRUPPE-EIGEN-2M schluessel drehen am montag', { group: 'security' });
    await legeInRaum(raumGruppe('chefs'), 'g', 'chefs:plan', 'FREMD-GRUPPE-9Z umbau im quartal', { group: 'chefs' });

    // Mitglied Mia: eigener Benutzer mit dem Muster, Gruppe security.
    const eigeneRaeume = {
      privat: raumPrivat(MIA), gruppen: [{ name: 'security', praefix: raumGruppe('security') }],
      konto: `${raumPrivat(MIA)}k:`,
    };
    await admin.call('ACL', 'DELUSER', MIA_BENUTZER).catch(() => undefined);
    await admin.call('ACL', 'SETUSER', MIA_BENUTZER, 'on', `>${MIA_PW}`,
      ...mitgliedMuster({ privat: eigeneRaeume.privat, gruppen: eigeneRaeume.gruppen.map((g) => g.praefix) }));
    miaRoh = new Redis({ ...basis, username: MIA_BENUTZER, password: MIA_PW });
    mia = alsMitgliedsSpeicher(miaRoh, { role: 'contributor', username: MIA_BENUTZER, instanceId: IID, raeume: eigeneRaeume } as never);
    // Besitzer: volles Passwort, sieht alle Raeume.
    merkeVollenZugang(admin, { instanceId: IID, raeume: { privat: raumPrivat(CHEF), gruppen: [], alle: true } } as never);
    merkeVollenZugang(besitzerOhne, { instanceId: IID } as never);
  }, 30_000);

  afterAll(async () => {
    setzeRollenZustandZurueck();
    if (admin?.status === 'ready') {
      await admin.flushdb();
      await admin.call('ACL', 'DELUSER', MIA_BENUTZER).catch(() => undefined);
    }
    await Promise.all([admin, besitzerOhne, miaRoh].map((r) => r?.quit().catch(() => undefined)));
  });

  // ── Positivkontrollen ────────────────────────────────────────────────────
  it('POSITIVKONTROLLE: das Mitglied liest die Team-Lektion', async () => {
    expect(await als(mia)('recall_best_solution', { topic: 'deploy:web' })).toContain('TEAMWEIT-SICHTBAR');
  });

  it('POSITIVKONTROLLE: das Mitglied liest seine eigene private Lektion ueber den genauen Namen', async () => {
    expect(await als(mia)('recall_best_solution', { topic: 'mia:notiz' })).toContain('EIGEN-PRIVAT-4K');
  });

  it('das Gruppenmitglied liest die Lektion seiner Gruppe', async () => {
    expect(await als(mia)('recall_best_solution', { topic: 'sec:rota' })).toContain('GRUPPE-EIGEN-2M');
  });

  it('smart_recall zeigt dem Mitglied die Lektion seiner Gruppe', async () => {
    expect(await als(mia)('smart_recall', { query: 'schluessel drehen montag' })).toContain('GRUPPE-EIGEN-2M');
  });

  // ── Fremdes: auf keinem Weg ──────────────────────────────────────────────
  it('fremde private Lektion: der genaue Name antwortet wie "nicht gefunden"', async () => {
    const fremd = await als(mia)('recall_best_solution', { topic: 'otto:gehalt' });
    const unbekannt = await als(mia)('recall_best_solution', { topic: 'gibt:es-nicht' });
    expect(fremd).not.toContain('TRESORINHALT-7Q');
    expect(fremd).toContain('No lessons found');
    expect(fremd.replaceAll('otto:gehalt', 'X')).toBe(unbekannt.replaceAll('gibt:es-nicht', 'X'));
  });

  it('Nicht-Gruppenmitglied: die Lektion der fremden Gruppe bleibt zu', async () => {
    const aus = await als(mia)('recall_best_solution', { topic: 'chefs:plan' });
    expect(aus).not.toContain('FREMD-GRUPPE-9Z');
    expect(aus).toContain('No lessons found');
  });

  it('Suche, Briefing und Zusammenfassung nennen nichts Fremdes', async () => {
    const texte = [
      await als(mia)('smart_recall', { query: 'tresor bild gehalt umbau quartal' }),
      await als(mia)('session_start', { focus: 'tresor umbau' }),
      await als(mia)('session_start_summary', { focus: 'tresor umbau' }),
    ].join('\n');
    for (const marke of ['TRESORINHALT-7Q', 'FREMD-GRUPPE-9Z', 'otto:gehalt', 'chefs:plan']) {
      expect(texte, `fremdes Stueck "${marke}" in einer Ausgabe`).not.toContain(marke);
    }
  });

  it('roh am Speicher: der Benutzer des Mitglieds liest fremde Raeume nicht', async () => {
    await expect(miaRoh.get(lektionsSchluessel(raumPrivat(OTTO), 'otto:gehalt'))).rejects.toThrow(/NOPERM/);
    await expect(miaRoh.get(lektionsSchluessel(raumGruppe('chefs'), 'chefs:plan'))).rejects.toThrow(/NOPERM/);
    await expect(miaRoh.smembers(themenSchluessel(raumPrivat(OTTO)))).rejects.toThrow(/NOPERM/);
    await expect(miaRoh.hgetall(RAUM_VERZEICHNIS)).rejects.toThrow(/NOPERM/);
    // Positivkontrolle: derselbe Benutzer liest den eigenen Raum roh.
    expect(await miaRoh.get(lektionsSchluessel(raumPrivat(MIA), 'mia:notiz'))).toContain('EIGEN-PRIVAT-4K');
  });

  // ── Schreiben in Raeume geht ueber die API, fuer alle ───────────────────
  it('ein Mitglied speichert eine private Lektion: ein POST /learn mit visibility, kein direkter Schreibbefehl', async () => {
    aufrufe.length = 0;
    const vorher = await admin.dbsize();
    const aus = await als(mia)('learn_from_attempts', {
      topic: 'mia:neu', outcome: 'success', what_worked: 'NEU-PRIVAT-1A merken', visibility: 'private',
    });
    const lern = aufrufe.filter((a) => a.pfad.endsWith('/learn'));
    expect(lern.length, `Antwort: ${aus}`).toBe(1);
    expect(lern[0].koerper.visibility).toBe('private');
    expect(lern[0].koerper.topic).toBe('mia:neu');
    expect(aus).not.toContain('Nicht gespeichert');
    expect(await ausserhalbDerRaeume()).not.toContain('NEU-PRIVAT-1A');
    expect(await admin.dbsize()).toBeGreaterThanOrEqual(vorher); // Positivkontrolle: Speicher erreichbar
  });

  it('auch der Besitzer speichert private und Gruppen-Lektionen ueber die API, nichts landet im Team-Bereich', async () => {
    aufrufe.length = 0;
    await als(admin)('learn_from_attempts', {
      topic: 'chef:privat', outcome: 'success', what_worked: 'CHEF-PRIVAT-5T nur fuer mich', visibility: 'private',
    });
    await als(admin)('learn_from_attempts', {
      topic: 'chefs:neu', outcome: 'success', what_worked: 'CHEF-GRUPPE-6U nur fuer chefs', group: 'chefs',
    });
    const lern = aufrufe.filter((a) => a.pfad.endsWith('/learn'));
    expect(lern.map((a) => a.koerper.topic)).toEqual(['chef:privat', 'chefs:neu']);
    expect(lern[0].koerper.visibility).toBe('private');
    expect(lern[1].koerper.group).toBe('chefs');
    const draussen = await ausserhalbDerRaeume();
    for (const marke of ['CHEF-PRIVAT-5T', 'CHEF-GRUPPE-6U', 'chef:privat', 'chefs:neu']) {
      expect(draussen, `"${marke}" steht ausserhalb der Raeume`).not.toContain(marke);
    }
    // Positivkontrolle: eine Team-Lektion des Besitzers geht weiter direkt in den Speicher.
    await als(admin)('learn_from_attempts', { topic: 'chef:team', outcome: 'success', what_worked: 'CHEF-TEAM-8W fuer alle' });
    expect(await admin.get('cachly:lesson:best:chef:team')).toContain('CHEF-TEAM-8W');
  });

  // ── Besitzer: alles wie heute ────────────────────────────────────────────
  it('der Besitzer liest eine fremde private Lektion ueber den genauen Namen, und sie hinterlaesst keine Spur im Team-Bereich', async () => {
    const aus = await als(admin)('recall_best_solution', { topic: 'otto:gehalt' });
    expect(aus).toContain('TRESORINHALT-7Q');
    await als(admin)('smart_recall', { query: 'bild tresor' });
    await new Promise((r) => setTimeout(r, 500));
    const draussen = await ausserhalbDerRaeume();
    expect(draussen).not.toContain('TRESORINHALT-7Q');
    expect(draussen).not.toContain('otto:gehalt');
    // Positivkontrolle: der Abzug sieht den Team-Bereich wirklich.
    expect(draussen).toContain('TEAMWEIT-SICHTBAR');
  });

  it('der Besitzer-Weg wird nicht teurer: hoechstens 2 Speicherbefehle mehr je smart_recall', async () => {
    const messe = async (r: Redis): Promise<number> => {
      const vor = await befehlsZahl();
      await als(r)('smart_recall', { query: 'rollback tag deploy' });
      await new Promise((res) => setTimeout(res, 400));
      return (await befehlsZahl()) - vor;
    };
    await messe(besitzerOhne); // Anlauf: Zwischenspeicher fuellen
    await messe(admin);
    const unterschiede: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ohne = await messe(besitzerOhne);
      const mit = await messe(admin);
      expect(ohne, 'Positivkontrolle: smart_recall sendet ueberhaupt Befehle').toBeGreaterThan(0);
      unterschiede.push(mit - ohne);
    }
    expect(Math.min(...unterschiede), `Mehrbefehle je Abruf in drei Paaren: ${unterschiede.join(', ')}`).toBeLessThanOrEqual(2);
  }, 60_000);
});
