// Vertrags-Pruefreihe fuer AML_STUECKE=nutzer und AML_MARKE=uhrzeit (dienst.mjs).   Aus dem Arbeitsbaum-Wurzelordner:
//   timeout 900 node --test sdk/mcp/aml-service/nutzer.test.mjs
// Startet selbst: aml-valkey (falls nicht da), Einbettungs-Attrappe, Dienst mit beiden Schaltern. Kein Netz nach aussen.
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
const PORT = 19280 + Math.floor(Math.random() * 500);
const BASIS = `http://127.0.0.1:${PORT}`;
const LAUF = 'n' + Date.now().toString(36);
let attrappe, dienst, wurzel; const log = [];

const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));
async function ruf(pfad, body) {
  const r = await fetch(BASIS + pfad, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SCHLUESSEL}` },
  });
  const text = await r.text();
  assert.equal(r.status, 200, `${pfad}: ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const uid = (n) => `eval:${LAUF}:ds:${n}`;
const add = (user, rid, messages, sid = 's1') => ruf('/v1/memory/add', { request_id: rid, messages, user_id: user, session_id: sid });
const suche = (user, query, top_k) => ruf('/v1/memory/search', { query, user_id: user, top_k });

before(async () => {
  wurzel = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
  try { await wurzel.connect(); await wurzel.ping(); } catch {
    wurzel.disconnect();
    const s = spawnSync('docker', ['start', 'aml-valkey'], { timeout: 60_000 });
    if (s.status !== 0) spawnSync('docker', ['run', '-d', '--name', 'aml-valkey', '-p', '127.0.0.1:6391:6379', 'valkey/valkey:8-alpine', 'valkey-server', '--databases', '16384', '--save', '', '--appendonly', 'no'], { timeout: 120_000 });
    await schlafe(1500);
    wurzel = new Redis(REDIS_URL);
  }
  attrappe = await starteAttrappe({ verzoegerungMs: 20 });
  dienst = spawn(join(MCP, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'), [join(HIER, 'dienst.mjs')], {
    cwd: MCP, shell: process.platform === 'win32',
    // TZ=Asia/Tokyo: die Uhrzeit in der Marke muss trotzdem Weltzeit sein.
    env: { ...process.env, TZ: 'Asia/Tokyo', AML_MEMORY_KEY: SCHLUESSEL, AML_PORT: String(PORT), AML_REDIS_URL: REDIS_URL,
      AML_STUECKE: 'nutzer', AML_MARKE: 'uhrzeit',
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
  const karte = await wurzel.hgetall('aml:dbmap');
  for (const [u, db] of Object.entries(karte)) if (u.startsWith(`eval:${LAUF}:`)) { const r = new Redis(REDIS_URL, { db: Number(db) }); await r.flushdb(); await r.quit(); await wurzel.hdel('aml:dbmap', u); }
  await wurzel.quit();
  console.log('--- Dienstprotokoll (letzte 6 Zeilen) ---\n' + log.join('').trim().split('\n').slice(-6).join('\n'));
});

test('N1 Nutzersatz kommt nicht doppelt: ist sein Stueck unter den Treffern, faellt der eigene Eintrag weg', async () => {
  const u = uid('n1');
  const ts = Date.UTC(2023, 3, 11, 9, 30);
  await add(u, 'n1a', [
    { role: 'user', content: 'Ich habe zwoelf Tomatenpflanzen gesetzt.', timestamp: ts },
    { role: 'assistant', content: 'Zwoelf Tomatenpflanzen sind eine gute Zahl fuer das Beet.', timestamp: ts },
  ]);
  const s = await suche(u, 'Wie viele Tomatenpflanzen habe ich gesetzt?', 10);
  const inhalte = s.data.map((d) => d.content);
  assert.ok(inhalte.some((c) => c.includes('Original dialogue:')), JSON.stringify(inhalte));
  assert.equal(inhalte.filter((c) => c.includes('zwoelf Tomatenpflanzen gesetzt')).length, 1, JSON.stringify(inhalte));
});

test('N2 Nutzersatz als eigener Treffer, mit Uhrzeit (Weltzeit) und der Nummer seines Stuecks', async () => {
  const u = uid('n2');
  const ts = Date.UTC(2023, 3, 11, 9, 30);
  // Langes Stueck aus vielen fremden Woertern: der Satz geht darin unter, sein eigener Eintrag nicht.
  const fuell = Array.from({ length: 160 }, (_, i) => `fuellwort${i}`).join(' ');
  await add(u, 'n2a', [
    { role: 'assistant', content: fuell, timestamp: ts },
    { role: 'user', content: 'Der Kompost kommt im Mai.', timestamp: ts },
  ]);
  const s = await suche(u, 'Wann kommt der Kompost?', 1);
  assert.equal(s.data.length, 1);
  // Die Fuellwoerter (~1.900 Zeichen) ergeben zwei Stuecke; der Satz steht im zweiten, also #2.
  assert.equal(s.data[0].content, '[2023-04-11 09:30 · #2] User: Der Kompost kommt im Mai.');
});

test('N3 Uhrzeit-Marke und Nummern: Stuecke zaehlen in Einlese-Reihenfolge, Ausgabe aelteste zuerst', async () => {
  const u = uid('n3');
  await add(u, 'n3a', [{ role: 'assistant', content: 'Die Laterne im Garten ist rot.', timestamp: Date.UTC(2023, 4, 7, 12, 0) }], 's1');
  await add(u, 'n3b', [{ role: 'assistant', content: 'Die Laterne im Garten ist blau.', timestamp: Date.UTC(2023, 0, 9, 8, 5) }], 's0');
  const s = await suche(u, 'Welche Farbe hat die Laterne im Garten?', 10);
  assert.equal(s.ordnung, 'zeit');
  assert.deepEqual(s.data.map((d) => d.content), [
    '[2023-01-09 08:05 · #2] Original dialogue: Die Laterne im Garten ist blau.',
    '[2023-05-07 12:00 · #1] Original dialogue: Die Laterne im Garten ist rot.',
  ]);
});

test('N4 Wiederholter Add schreibt nichts doppelt, auch mit Nummer in der Marke', async () => {
  const u = uid('n4');
  const msgs = [{ role: 'user', content: 'Das Fahrrad ist gruen.', timestamp: Date.UTC(2023, 1, 2, 3, 4) }];
  await add(u, 'n4a', msgs);
  await add(u, 'n4a', msgs);
  const db = await wurzel.hget('aml:dbmap', u);
  const r = new Redis(REDIS_URL, { db: Number(db) });
  let n = 0, cur = '0';
  do { const [c, ks] = await r.scan(cur, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 500); cur = c; n += ks.length; } while (cur !== '0');
  await r.quit();
  assert.equal(n, 2, 'ein Stueck und ein Nutzer-Eintrag');
});
