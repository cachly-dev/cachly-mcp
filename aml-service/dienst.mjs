// Add/Search-Dienst fuer das Agent Memory Leaderboard (Vertrag memory-api-v1.1), nur auf 127.0.0.1.
//   GET /health   POST /v1/memory/add   POST /v1/memory/search   POST /v1/memory/delete {user_id}
// Start (aus sdk/mcp):  AML_MEMORY_KEY=... node_modules/.bin/tsx aml-service/dienst.mjs
// Umgebung: AML_MEMORY_KEY (Pflicht), AML_PORT (8780), AML_REDIS_URL (redis://127.0.0.1:6391), AML_MAX_ADD (16),
//   AML_AUFFUELLEN (aus), AML_ADD_ZEIT_MS (1500000), AML_VEKTOR_STILL_MS (300000), AML_MAX_DB (16384), AML_INSTANZ_ID
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Redis, ladeBrain, keinApi, stuecke, vektorenAbwarten, lektionsText } from './kern.mjs';

const PORT = Number(process.env.AML_PORT ?? 8780);
const HOST = process.env.AML_HOST ?? '127.0.0.1'; // im Container 0.0.0.0; nach aussen oeffnet nur compose.yml und nur auf 127.0.0.1
const REDIS_URL = process.env.AML_REDIS_URL ?? 'redis://127.0.0.1:6391';
const KEY = process.env.AML_MEMORY_KEY ?? '';
const MAX_ADD = Number(process.env.AML_MAX_ADD ?? 16);
const AUFFUELLEN = /^(1|an|ja|true)$/i.test(process.env.AML_AUFFUELLEN ?? '');
const ADD_ZEIT_MS = Number(process.env.AML_ADD_ZEIT_MS ?? 1_500_000);
const STILL_MS = Number(process.env.AML_VEKTOR_STILL_MS ?? 300_000);
const MAX_DB = Number(process.env.AML_MAX_DB ?? 16384);
const INSTANZ_ID = process.env.AML_INSTANZ_ID ?? '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const MAX_VERBINDUNGEN = 256;
const MAX_BODY = 8 * 1024 * 1024;
if (!KEY) { console.error('AML_MEMORY_KEY fehlt'); process.exit(2); }
if (!/^redis:\/\/(127\.0\.0\.1|localhost)[:/]/.test(REDIS_URL)) { console.error('AML_REDIS_URL muss auf 127.0.0.1 zeigen'); process.exit(2); }

const brainTool = await ladeBrain();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const kurz = (u) => (u.length > 14 ? `${u.slice(0, 6)}..${sha(u).slice(0, 6)}` : u);
class Fehler extends Error { constructor(status, reason) { super(reason); this.status = status; this.reason = reason; } }

// ── Valkey: eine Verbindung auf DB 0 fuer die Zuordnung, je DB eine weitere (begrenzt) ──
const wurzel = new Redis(REDIS_URL, { db: 0, maxRetriesPerRequest: 3 });
const pool = new Map(); // db -> {r, busy, zuletzt}
async function mitDb(db, f) {
  let e = pool.get(db);
  if (!e) {
    if (pool.size >= MAX_VERBINDUNGEN) {
      const idle = [...pool.entries()].filter(([, x]) => x.busy === 0).sort((a, b) => a[1].zuletzt - b[1].zuletzt);
      for (const [d, x] of idle.slice(0, Math.max(1, pool.size - MAX_VERBINDUNGEN + 32))) { pool.delete(d); x.r.quit().catch(() => {}); }
    }
    const r = new Redis(REDIS_URL, { db, maxRetriesPerRequest: 3, commandTimeout: 60_000 });
    e = { r, busy: 0, zuletzt: 0 }; pool.set(db, e);
  }
  e.busy++; e.zuletzt = Date.now();
  try { return await f(e.r); } finally { e.busy--; }
}

/**
 * Eine Verbindung aus dem Vorrat nehmen, wenn sie gerade niemand nutzt. Die naechste Anfrage baut eine neue
 * auf — und mit ihr frische Bestaende im Arbeitsspeicher (handlers/brain.ts haelt sie je Verbindung).
 */
function verbindungVergessen(db) {
  const e = pool.get(db);
  if (e && e.busy === 0) { pool.delete(db); e.r.quit().catch(() => {}); }
}
const DB_FREI = 'aml:dbfrei';

const zuordnungLaeuft = new Map();
function dbFuer(userId, anlegen) {
  const lies = async () => {
    const v = await wurzel.hget('aml:dbmap', userId);
    if (v !== null) return Number(v);
    if (!anlegen) return null;
    // Erst eine Datenbank wiederverwenden, die eine Loeschung frei gemacht hat (geleert, siehe loesche).
    const frei = await wurzel.spop(DB_FREI);
    if (frei !== null) { verbindungVergessen(Number(frei)); await wurzel.hset('aml:dbmap', userId, frei); return Number(frei); }
    const n = await wurzel.incr('aml:dbnext');
    if (n >= MAX_DB) { await wurzel.decr('aml:dbnext'); throw new Fehler(503, `Datenbankgrenze erreicht (${MAX_DB - 1} user_id); aml-service/loeschen.mjs ausfuehren oder Dienst mit mehr Datenbanken starten`); }
    await wurzel.hset('aml:dbmap', userId, n);
    return n;
  };
  if (!anlegen) return lies();
  let p = zuordnungLaeuft.get(userId);
  if (!p) { p = lies().finally(() => zuordnungLaeuft.delete(userId)); zuordnungLaeuft.set(userId, p); }
  return p;
}

// ── Eingabepruefung ──
const nichtLeer = (x) => typeof x === 'string' && x.trim() !== '';
function inhalt(c) { // Zeichenkette oder Teile [{type:'text', text}]
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length && c.every((t) => t && t.type === 'text' && typeof t.text === 'string')) return c.map((t) => t.text).join('\n');
  return null;
}
function pruefeAdd(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Fehler(422, 'Body muss ein Objekt sein');
  for (const f of ['request_id', 'user_id', 'session_id']) if (!nichtLeer(b[f])) throw new Fehler(422, `${f} fehlt oder ist leer`);
  if (!Array.isArray(b.messages) || b.messages.length === 0) throw new Fehler(422, 'messages muss ein nicht leeres Array sein');
  const messages = b.messages.map((m, i) => {
    if (!m || typeof m !== 'object') throw new Fehler(422, `messages[${i}] ist kein Objekt`);
    if (m.role !== 'user' && m.role !== 'assistant') throw new Fehler(422, `messages[${i}].role muss user oder assistant sein`);
    const c = inhalt(m.content);
    if (c === null || c.trim() === '') throw new Fehler(422, `messages[${i}].content fehlt oder ist leer`);
    if (m.timestamp !== undefined && m.timestamp !== null && !Number.isFinite(m.timestamp)) throw new Fehler(422, `messages[${i}].timestamp muss eine Zahl sein`);
    return { role: m.role, content: c, timestamp: m.timestamp ?? undefined };
  });
  return { request_id: b.request_id, user_id: b.user_id, session_id: b.session_id, messages };
}
function pruefeSearch(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Fehler(422, 'Body muss ein Objekt sein');
  const query = inhalt(b.query);
  if (query === null || query.trim() === '') throw new Fehler(422, 'query fehlt oder ist leer');
  if (!nichtLeer(b.user_id)) throw new Fehler(422, 'user_id fehlt oder ist leer');
  if (!Number.isInteger(b.top_k) || b.top_k < 1 || b.top_k > 1000) throw new Fehler(422, 'top_k muss eine ganze Zahl von 1 bis 1000 sein');
  if (b.options !== undefined && b.options !== null && !(Array.isArray(b.options) && b.options.every((o) => typeof o === 'string'))) throw new Fehler(422, 'options muss ein Array aus Zeichenketten sein');
  return { query, user_id: b.user_id, top_k: b.top_k };
}
function pruefeDelete(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Fehler(422, 'Body muss ein Objekt sein');
  if (!nichtLeer(b.user_id)) throw new Fehler(422, 'user_id fehlt oder ist leer');
  return { user_id: b.user_id };
}

// ── Add: idempotent, gleichzeitig, mit Obergrenze ──
let laeuft = 0; const warte = [];
async function platz() { if (laeuft < MAX_ADD) { laeuft++; return; } await new Promise((r) => warte.push(r)); }
function frei() { const n = warte.shift(); if (n) n(); else laeuft--; }

const imFlug = new Map(); // user|request_id -> Promise
const zaehler = { add: 0, add_wiederholt: 0, add_fehler: 0, search: 0, stuecke: 0, delete: 0 };

async function schreibe(req) {
  const db = await dbFuer(req.user_id, true);
  return mitDb(db, async (redis) => {
    const doneKey = `aml:done:${sha(req.request_id).slice(0, 32)}`;
    if (await redis.exists(doneKey)) return { wiederholt: true, stuecke: 0 };
    const liste = stuecke(req.messages);
    const frist = Date.now() + ADD_ZEIT_MS - 10_000;
    await Promise.all(liste.map(async (s, i) => {
      const topic = `aml:${sha(`${req.request_id}\n${i}\n${s.text}`).slice(0, 24)}`;
      const marke = `aml:chunk:${topic}`;
      if (await redis.exists(marke)) return;
      let letzter;
      for (let v = 1; v <= 3; v++) {
        try {
          await brainTool('learn_from_attempts', {
            instance_id: INSTANZ_ID, topic, outcome: 'success', what_worked: s.text, severity: 'minor',
            tags: ['aml'], ...(s.giltAb ? { gilt_ab: s.giltAb } : {}),
          }, async () => redis, keinApi);
          await redis.zadd('aml:index', s.zeitMs || 0, topic);
          await redis.set(marke, '1');
          return;
        } catch (e) { letzter = e; await new Promise((r) => setTimeout(r, 500 * v)); }
      }
      throw letzter;
    }));
    const { luecken } = await vektorenAbwarten(redis, { stillMs: STILL_MS, frist });
    if (luecken.length) throw new Fehler(503, `Vektoren noch nicht vollstaendig (${luecken.join(', ')}); bitte wiederholen`);
    await redis.set(doneKey, '1');
    return { wiederholt: false, stuecke: liste.length };
  });
}

async function add(req) {
  const t0 = Date.now();
  const schl = `${req.user_id}\n${req.request_id}`;
  let p = imFlug.get(schl);
  if (!p) {
    p = (async () => { await platz(); try { return await schreibe(req); } finally { frei(); } })();
    imFlug.set(schl, p);
    p.then(() => imFlug.delete(schl), () => imFlug.delete(schl));
  }
  let timer;
  const frist = new Promise((_, no) => { timer = setTimeout(() => no(new Fehler(503, 'Zeitgrenze des Add erreicht; Vorgang laeuft weiter, bitte mit gleicher request_id wiederholen')), ADD_ZEIT_MS); });
  try {
    const r = await Promise.race([p, frist]);
    zaehler.add++; if (r.wiederholt) zaehler.add_wiederholt++; zaehler.stuecke += r.stuecke;
    console.log(`add user=${kurz(req.user_id)} nachrichten=${req.messages.length} stuecke=${r.stuecke} wiederholt=${r.wiederholt} dauer_s=${((Date.now() - t0) / 1000).toFixed(1)}`);
    return { success: true, request_id: req.request_id, user_id: req.user_id, session_id: req.session_id };
  } catch (e) {
    zaehler.add_fehler++;
    console.log(`add user=${kurz(req.user_id)} FEHLER ${String(e.reason ?? e.message).slice(0, 80)} dauer_s=${((Date.now() - t0) / 1000).toFixed(1)}`);
    throw e;
  } finally { clearTimeout(timer); }
}

// ── Search ──
async function search(req) {
  zaehler.search++;
  const db = await dbFuer(req.user_id, false);
  if (db === null) return { data: [] };
  return mitDb(db, async (redis) => {
    // top_k reicht als limit durch; smart_recall deckelt bei 20 (recall-tiefe.ts, TIEFE_HOECHSTENS).
    const ausgabe = String(await brainTool('smart_recall', { instance_id: INSTANZ_ID, query: req.query, limit: req.top_k }, async () => redis, keinApi));
    const gesehen = new Set(); const themen = [];
    for (const m of ausgabe.matchAll(/(aml:[0-9a-f]{24})/g)) if (!gesehen.has(m[1])) { gesehen.add(m[1]); themen.push(m[1]); }
    let treffer = themen.slice(0, req.top_k);
    if (AUFFUELLEN && treffer.length < req.top_k) {
      const alle = await redis.zrange('aml:index', 0, -1); // nach Zeit geordnet
      const schon = new Set(treffer);
      for (const t of alle) { if (treffer.length >= req.top_k) break; if (!schon.has(t)) treffer.push(t); }
    }
    const roh = treffer.length ? await redis.mget(treffer.map((t) => `cachly:lesson:best:${t}`)) : [];
    const data = [];
    treffer.forEach((t, i) => { const c = lektionsText(roh[i]); if (c && c.trim()) data.push({ id: t, content: c }); });
    return { data };
  });
}

// ── Delete: alles eines Nutzers weg, alle anderen bleiben (OmniMemEval CONTRIBUTING Schritt 4, AML-Loeschpflicht) ──
async function loesche(req) {
  const db = await dbFuer(req.user_id, false);
  if (db === null) return { deleted: false, user_id: req.user_id };
  // Ein laufender oder wartender Add dieses Nutzers hat seine Datenbank schon gewaehlt; er wuerde in die
  // geleerte schreiben. Jeder Add steht in imFlug, bevor er seine Datenbank waehlt.
  for (const schl of imFlug.keys()) {
    if (schl.startsWith(`${req.user_id}\n`)) throw new Fehler(409, 'Add fuer diese user_id laeuft noch; danach erneut loeschen');
  }
  // Zuordnung zuerst loesen: ein neuer Add dieses Nutzers bekommt dann eine andere Datenbank.
  await wurzel.hdel('aml:dbmap', req.user_id);
  await mitDb(db, (redis) => redis.flushdb());
  verbindungVergessen(db);
  await wurzel.sadd(DB_FREI, db);
  zaehler.delete++;
  console.log(`delete user=${kurz(req.user_id)} db=${db}`);
  return { deleted: true, user_id: req.user_id };
}

// ── HTTP ──
function berechtigt(req) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = createHash('sha256').update(m[1]).digest(); const b = createHash('sha256').update(KEY).digest();
  return timingSafeEqual(a, b);
}
async function lesen(req) {
  const teile = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new Fehler(413, 'Body zu gross'); teile.push(c); }
  try { return JSON.parse(Buffer.concat(teile).toString('utf8') || 'null'); } catch { throw new Fehler(422, 'Body ist kein gueltiges JSON'); }
}
const server = http.createServer(async (req, res) => {
  const antwort = (code, obj, kopf = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...kopf }); res.end(JSON.stringify(obj)); };
  try {
    const pfad = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && pfad === '/health') return antwort(200, { status: 'ok' });
    if (req.method === 'GET' && pfad === '/stat' && berechtigt(req)) return antwort(200, { ...zaehler, laeuft, wartend: warte.length, im_flug: imFlug.size, verbindungen: pool.size, auffuellen: AUFFUELLEN });
    if (!(req.method === 'POST' && ['/v1/memory/add', '/v1/memory/search', '/v1/memory/delete'].includes(pfad))) return antwort(404, { detail: { reason: 'nicht gefunden' } });
    if (!berechtigt(req)) return antwort(401, { detail: { reason: 'Schluessel fehlt oder ist falsch' } });
    const body = await lesen(req);
    if (pfad === '/v1/memory/add') return antwort(200, await add(pruefeAdd(body)));
    if (pfad === '/v1/memory/delete') return antwort(200, await loesche(pruefeDelete(body)));
    return antwort(200, await search(pruefeSearch(body)));
  } catch (e) {
    if (e instanceof Fehler) return antwort(e.status, { detail: { reason: e.reason } }, e.status === 503 ? { 'retry-after': '5' } : {});
    console.error('Fehler:', req.url, String(e?.message ?? e).slice(0, 200));
    antwort(503, { detail: { reason: 'voruebergehender Fehler: ' + String(e?.message ?? e).slice(0, 120) } }, { 'retry-after': '5' });
  }
});
server.requestTimeout = 0; server.headersTimeout = 0; server.timeout = 0; server.keepAliveTimeout = 120_000;
server.listen(PORT, HOST, () => console.log(`AML-Dienst lauscht auf ${HOST}:${PORT}, Valkey ${REDIS_URL}, max_add=${MAX_ADD}, auffuellen=${AUFFUELLEN}`));
