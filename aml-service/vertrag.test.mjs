// Vertrags-Pruefreihe fuer sdk/mcp/aml-service/dienst.mjs.   Aus dem Arbeitsbaum-Wurzelordner:
//   timeout 900 node --test sdk/mcp/aml-service/vertrag.test.mjs
// Startet selbst: aml-valkey (falls nicht da), Einbettungs-Attrappe, Dienst (mit tsx). Kein Netz nach aussen.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis, MCP } from './kern.mjs';
import { starteAttrappe } from './einbettung-attrappe.mjs';

const HIER = dirname(fileURLToPath(import.meta.url));
const SCHLUESSEL = 'test-schluessel-' + Math.random().toString(36).slice(2);
const REDIS_URL = 'redis://127.0.0.1:6391';
const PORT = 18780 + Math.floor(Math.random() * 500);
const BASIS = `http://127.0.0.1:${PORT}`;
const LAUF = 't' + Date.now().toString(36);
let attrappe, dienst, wurzel; const log = [];

const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));
async function ruf(pfad, body, { key = SCHLUESSEL, roh = false } = {}) {
  const r = await fetch(BASIS + pfad, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : (roh ? body : JSON.stringify(body)),
  });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const uid = (n) => `eval:${LAUF}:ds:${n}`;
const addBody = (user, rid, msgs, sid = 's1') => ({ request_id: rid, messages: msgs, user_id: user, session_id: sid });
const nachr = (c, extra = {}) => ({ role: 'user', content: c, ...extra });
async function lektionen(user) {
  const db = await wurzel.hget('aml:dbmap', user); if (db === null) return 0;
  const r = new Redis(REDIS_URL, { db: Number(db) });
  let n = 0, cur = '0';
  do { const [c, ks] = await r.scan(cur, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 500); cur = c; n += ks.length; } while (cur !== '0');
  await r.quit(); return n;
}

before(async () => {
  wurzel = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
  try { await wurzel.connect(); await wurzel.ping(); } catch {
    wurzel.disconnect();
    const s = spawnSync('docker', ['start', 'aml-valkey'], { timeout: 60_000 });
    if (s.status !== 0) spawnSync('docker', ['run', '-d', '--name', 'aml-valkey', '-p', '127.0.0.1:6391:6379', 'valkey/valkey:8-alpine', 'valkey-server', '--databases', '16384', '--save', '', '--appendonly', 'no'], { timeout: 120_000 });
    await schlafe(1500);
    wurzel = new Redis(REDIS_URL);
  }
  attrappe = await starteAttrappe({ verzoegerungMs: 60 });
  dienst = spawn(join(MCP, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'), [join(HIER, 'dienst.mjs')], {
    cwd: MCP, shell: process.platform === 'win32',
    env: { ...process.env, AML_MEMORY_KEY: SCHLUESSEL, AML_PORT: String(PORT), AML_REDIS_URL: REDIS_URL,
      CACHLY_API_URL: `http://127.0.0.1:${attrappe.port}`, CACHLY_JWT: 'attrappe-kein-geheimnis', CACHLY_ADMIN_KEY: '', AML_VEKTOR_STILL_MS: '60000' },
  });
  dienst.stdout.on('data', (d) => log.push(String(d))); dienst.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASIS + '/health')).ok) return; } catch { /* noch nicht da */ }
    await schlafe(500);
  }
  throw new Error('Dienst startet nicht: ' + log.join('').slice(-800));
});
after(async () => {
  if (dienst) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(dienst.pid), '/T', '/F']); else dienst.kill(); }
  attrappe?.server.close(); attrappe?.server.closeAllConnections?.();
  // eigene Testnutzer wieder entfernen
  const karte = await wurzel.hgetall('aml:dbmap');
  for (const [u, db] of Object.entries(karte)) if (u.startsWith(`eval:${LAUF}:`)) { const r = new Redis(REDIS_URL, { db: Number(db) }); await r.flushdb(); await r.quit(); await wurzel.hdel('aml:dbmap', u); }
  await wurzel.quit();
  console.log('--- Dienstprotokoll (letzte 6 Zeilen) ---\n' + log.join('').trim().split('\n').slice(-6).join('\n'));
});

test('1 Health ohne Auth 200; Add/Search ohne und mit falschem Schluessel 401', async () => {
  const h = await fetch(BASIS + '/health'); assert.equal(h.status, 200);
  for (const p of ['/v1/memory/add', '/v1/memory/search', '/v1/memory/delete']) {
    for (const key of [null, 'falsch']) {
      const r = await ruf(p, {}, { key }); assert.equal(r.status, 401); assert.ok(r.json.detail.reason);
    }
  }
});

test('2 Schemafehler -> 4xx mit detail.reason', async () => {
  const gut = addBody(uid('schema'), 'r1', [nachr('hallo')]);
  const faelle = [
    { ...gut, user_id: undefined }, { ...gut, messages: [nachr('')] }, { ...gut, messages: [{ role: 'system', content: 'x' }] },
    { ...gut, messages: 'text' }, { ...gut, request_id: '' }, { ...gut, session_id: undefined },
    { ...gut, messages: [nachr('x', { timestamp: 'gestern' })] },
  ];
  for (const f of faelle) { const r = await ruf('/v1/memory/add', f); assert.ok(r.status === 422 || r.status === 400, JSON.stringify(f) + ' -> ' + r.status); assert.ok(r.json.detail.reason); }
  const kaputt = await ruf('/v1/memory/add', '{nicht json', { roh: true }); assert.equal(kaputt.status, 422); assert.ok(kaputt.json.detail.reason);
  for (const f of [{ query: 'x', top_k: 5 }, { query: '', user_id: 'u', top_k: 5 }, { query: 'x', user_id: 'u' }, { query: 'x', user_id: 'u', top_k: 0 }]) {
    const r = await ruf('/v1/memory/search', f); assert.ok(r.status === 422 || r.status === 400); assert.ok(r.json.detail.reason);
  }
});

test('3 Add-Antwort byte-genau, danach sofort Search findet den Inhalt', async () => {
  const u = uid('a3');
  const r = await ruf('/v1/memory/add', addBody(u, 'req-ä-1', [nachr('Der Zebrakuchen steht im blauen Schrank.'), { role: 'assistant', content: 'Verstanden, Zebrakuchen blau.' }], 'sess-ö'));
  assert.equal(r.status, 200);
  assert.equal(r.text, JSON.stringify({ success: true, request_id: 'req-ä-1', user_id: u, session_id: 'sess-ö' }));
  const s = await ruf('/v1/memory/search', { query: 'Wo steht der Zebrakuchen?', options: ['x'], user_id: u, top_k: 100 });
  assert.equal(s.status, 200);
  assert.ok(s.json.data.some((d) => d.content.includes('Zebrakuchen') && d.id && d.content));
});

test('4 Idempotenz: 3x hintereinander und 3x gleichzeitig -> genau einmal geschrieben', async () => {
  const u = uid('a4'); const k = addBody(u, 'dup-1', [nachr('Einmalige Aussage ueber Quarkspeise.')]);
  for (let i = 0; i < 3; i++) assert.equal((await ruf('/v1/memory/add', k)).status, 200);
  assert.equal(await lektionen(u), 1);
  const k2 = addBody(u, 'dup-2', [nachr('Zweite Aussage ueber Rhabarberkompott.')]);
  const rs = await Promise.all([1, 2, 3].map(() => ruf('/v1/memory/add', k2)));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  assert.equal(await lektionen(u), 2);
});

test('5 Isolation: user A sieht nichts von user B', async () => {
  const a = uid('a5a'), b = uid('a5b');
  await ruf('/v1/memory/add', addBody(a, 'i1', [nachr('Geheimwort Flamingo gehoert A.')]));
  await ruf('/v1/memory/add', addBody(b, 'i2', [nachr('Geheimwort Pinguin gehoert B.')]));
  const sa = (await ruf('/v1/memory/search', { query: 'Geheimwort Pinguin', user_id: a, top_k: 100 })).json.data;
  const sb = (await ruf('/v1/memory/search', { query: 'Geheimwort Flamingo', user_id: b, top_k: 100 })).json.data;
  assert.ok(sa.every((d) => !d.content.includes('Pinguin')) && sa.some((d) => d.content.includes('Flamingo')));
  assert.ok(sb.every((d) => !d.content.includes('Flamingo')) && sb.some((d) => d.content.includes('Pinguin')));
});

test('6 top_k: nie mehr als top_k; top_k=1 -> 1; ohne Daten -> {"data":[]}', async () => {
  const u = uid('a6');
  await ruf('/v1/memory/add', addBody(u, 't1', Array.from({ length: 6 }, (_, i) => nachr(`Eintrag ${i} ueber Mandelhoernchen.`, { timestamp: Date.UTC(2023, 0, 1 + i) }))));
  assert.ok(await lektionen(u) >= 3);
  const eins = (await ruf('/v1/memory/search', { query: 'Mandelhoernchen', user_id: u, top_k: 1 })).json.data;
  assert.equal(eins.length, 1);
  const drei = (await ruf('/v1/memory/search', { query: 'Mandelhoernchen', user_id: u, top_k: 3 })).json.data;
  assert.ok(drei.length <= 3 && drei.length >= 1);
  const leer = await ruf('/v1/memory/search', { query: 'irgendwas', user_id: uid('niemand'), top_k: 100 });
  assert.equal(leer.text, '{"data":[]}');
});

test('7 Zeit: timestamp -> Datum steht im content', async () => {
  const u = uid('a7');
  await ruf('/v1/memory/add', addBody(u, 'z1', [nachr('Wir waren im Zoo bei den Okapis.', { timestamp: Date.UTC(2023, 4, 7, 12) })]));
  const d = (await ruf('/v1/memory/search', { query: 'Zoo Okapis', user_id: u, top_k: 100 })).json.data;
  assert.ok(d.some((x) => x.content.includes('[session of 7 May 2023]')), JSON.stringify(d));
});

test('8 Last: 16 gleichzeitige Add mit je 20 Nachrichten (~12.000 Zeichen)', async () => {
  const t0 = Date.now();
  const nutzer = Array.from({ length: 16 }, (_, i) => uid('last' + i));
  const msg = (u, j) => nachr(`Nachricht ${j} von ${u.slice(-6)}: ` + `Wort${j}x `.repeat(60) + `Eigenmarke${u.slice(-6).replace(/\W/g, '')}${j}`, { timestamp: Date.UTC(2023, 1, 1 + j) });
  const rs = await Promise.all(nutzer.map((u) => ruf('/v1/memory/add', addBody(u, 'last-' + u, Array.from({ length: 20 }, (_, j) => msg(u, j))))));
  const dauerAdd = (Date.now() - t0) / 1000;
  assert.deepEqual(rs.map((r) => r.status), Array(16).fill(200));
  const t1 = Date.now();
  const ss = await Promise.all(nutzer.map((u) => ruf('/v1/memory/search', { query: `Eigenmarke${u.slice(-6).replace(/\W/g, '')}7`, user_id: u, top_k: 100 })));
  for (let i = 0; i < 16; i++) {
    assert.equal(ss[i].status, 200);
    const marke = `Eigenmarke${nutzer[i].slice(-6).replace(/\W/g, '')}7`;
    assert.ok(ss[i].json.data.some((d) => d.content.includes(marke)), 'nicht suchbar: ' + nutzer[i]);
  }
  console.log(`LAST: 16 Add parallel (je 20 Nachrichten, ~${msg(nutzer[0], 0).content.length * 20} Zeichen) in ${dauerAdd.toFixed(1)} s; 16 Search in ${((Date.now() - t1) / 1000).toFixed(1)} s; Attrappe: ${attrappe.stat.anfragen} Einbettungen, max ${attrappe.stat.gleichzeitigMax} gleichzeitig`);
});

test('9 Lange Nachricht (> 1.500 Zeichen) wird zerteilt, nichts geht verloren', async () => {
  const u = uid('a9');
  const woerter = Array.from({ length: 600 }, (_, i) => `lang${i}`);
  const text = woerter.join(' '); assert.ok(text.length > 3000);
  assert.equal((await ruf('/v1/memory/add', addBody(u, 'l1', [nachr(text)]))).status, 200);
  assert.ok(await lektionen(u) >= 2);
  const gefunden = (await ruf('/v1/memory/search', { query: 'lang10 lang300 lang599', user_id: u, top_k: 100 })).json.data;
  assert.ok(gefunden.length >= 1);
  // Vollstaendigkeit am Speicher pruefen (smart_recall liefert nur die besten Treffer, nicht alle Stuecke)
  const db = Number(await wurzel.hget('aml:dbmap', u)); const r = new Redis(REDIS_URL, { db });
  const ks = await r.keys('cachly:lesson:best:*');
  const alle = (await r.mget(ks)).map((x) => ({ content: JSON.parse(x).what_worked })); await r.quit();
  assert.ok(alle.every((d) => d.content.length <= 1500 + 80), 'Stueck zu lang');
  const fehlt = woerter.filter((w) => !alle.some((d) => new RegExp(`\\b${w}\\b`).test(d.content)));
  assert.deepEqual(fehlt, []);
});

test('10 Delete: A ist weg, B bleibt; unbekannt -> deleted:false; ohne Schluessel 401; danach neu einlesen geht', async () => {
  const a = uid('d10a'), b = uid('d10b');
  await ruf('/v1/memory/add', addBody(a, 'd1', [nachr('Codewort Kormoran gehoert A.')]));
  await ruf('/v1/memory/add', addBody(b, 'd2', [nachr('Codewort Reiher gehoert B.')]));
  for (const key of [null, 'falsch']) assert.equal((await ruf('/v1/memory/delete', { user_id: a }, { key })).status, 401);
  for (const f of [{}, { user_id: '' }, []]) {
    const r = await ruf('/v1/memory/delete', f); assert.equal(r.status, 422); assert.ok(r.json.detail.reason);
  }
  const dbA = await wurzel.hget('aml:dbmap', a);
  const weg = await ruf('/v1/memory/delete', { user_id: a });
  assert.equal(weg.status, 200); assert.deepEqual(weg.json, { deleted: true, user_id: a });
  assert.equal(await wurzel.hget('aml:dbmap', a), null);
  const r = new Redis(REDIS_URL, { db: Number(dbA) }); assert.equal(await r.dbsize(), 0); await r.quit();
  assert.deepEqual((await ruf('/v1/memory/search', { query: 'Codewort Kormoran', user_id: a, top_k: 10 })).json, { data: [] });
  const sb = (await ruf('/v1/memory/search', { query: 'Codewort Reiher', user_id: b, top_k: 10 })).json.data;
  assert.ok(sb.some((d) => d.content.includes('Reiher')), 'B muss bleiben');
  assert.deepEqual((await ruf('/v1/memory/delete', { user_id: uid('nie-da') })).json, { deleted: false, user_id: uid('nie-da') });
  // Gleiche request_id wie vorher: nach dem Loeschen gilt sie nicht mehr als erledigt
  await ruf('/v1/memory/add', addBody(a, 'd1', [nachr('Codewort Kormoran gehoert A.')]));
  const sa = (await ruf('/v1/memory/search', { query: 'Codewort Kormoran', user_id: a, top_k: 10 })).json.data;
  assert.ok(sa.some((d) => d.content.includes('Kormoran')), 'nach dem Loeschen neu einlesen');
});
