// Gemeinsamer Kern fuer den AML-Dienst: Brain laden, Text in Stuecke teilen, auf Vektoren warten.
// Die Bruecke (bench/omnimemeval/bruecke.mjs) enthaelt dieselben Schritte als Einzelkopie.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const HIER = dirname(fileURLToPath(import.meta.url));
export const MCP = join(HIER, '..');
export const Redis = createRequire(join(MCP, 'package.json'))('ioredis');
export const CHUNK_MAX = 1500;

export const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));
export const keinApi = async () => ({ ok: false, status: 503, json: async () => ({}) });

function findeKonfig() {
  if (process.env.CACHLY_MCP_KONFIG) return process.env.CACHLY_MCP_KONFIG;
  let d = resolve(HIER);
  for (let i = 0; i < 8; i++) { const p = join(d, '.mcp.json'); if (existsSync(p)) return p; d = dirname(d); }
  return null;
}

/** Umgebung setzen (VOR dem Import), dann brain.ts laden. Gibt handleBrainTool zurueck. Schluessel werden nie ausgegeben. */
export async function ladeBrain() {
  if (!process.env.CACHLY_API_URL || !process.env.CACHLY_JWT) {
    const p = findeKonfig();
    if (p) {
      const s = JSON.parse(readFileSync(p, 'utf8')).mcpServers?.cachly?.env ?? {};
      process.env.CACHLY_API_URL ??= s.CACHLY_API_URL ?? 'https://api.cachly.dev';
      process.env.CACHLY_JWT ??= s.CACHLY_JWT;
    }
  }
  process.env.CACHLY_EMBED_TIMEOUT_MS ??= '30000';
  const { handleBrainTool } = await import(pathToFileURL(join(MCP, 'src', 'handlers', 'brain.ts')).href);
  return handleBrainTool;
}

const MONATE = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function lesbaresDatum(zeit) {
  if (zeit === '' || zeit === undefined || zeit === null) return null;
  const d = new Date(zeit);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONATE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Langen Text an Leerstellen in Teile bis max Zeichen schneiden; nichts geht verloren (ausser Trennleerzeichen). */
export function teileText(text, max = CHUNK_MAX) {
  const aus = [];
  let rest = text;
  while (rest.length > max) {
    let schnitt = rest.lastIndexOf(' ', max);
    if (schnitt < max * 0.5) schnitt = max; // kein brauchbares Leerzeichen: hart schneiden
    aus.push(rest.slice(0, schnitt));
    rest = rest.slice(schnitt).replace(/^ +/, '');
  }
  if (rest) aus.push(rest);
  return aus;
}

/**
 * Nachrichten -> Stuecke bis CHUNK_MAX Zeichen. Je Zeitstempel getrennt, Originaltext,
 * Sitzungsdatum VORN. Gibt [{text, giltAb(ISO oder ''), zeitMs(Zahl oder 0)}].
 *
 * Vorn, nicht am Ende (28.10.2026): Die Antwort-Anweisung von OmniMemEval rechnet relative
 * Angaben "vom Zeitstempel der Erinnerung". Stand das Datum am Ende eines 1.500-Zeichen-Stuecks,
 * las gpt-4.1-mini oft die erste Klammer ("yesterday (2022-12-21)") als Zeitstempel und zog
 * noch einen Tag ab. Mit Datum vorn und aufgeloesten Wochentagen: Zeitfragen 75,1 -> 81,9 %.
 */
export function stuecke(messages) {
  const nach = new Map();
  for (const m of messages) {
    const ts = m.timestamp ?? '';
    const text = String(m.content ?? '').trim();
    if (!text) continue;
    if (!nach.has(ts)) nach.set(ts, []);
    nach.get(ts).push(...teileText(text));
  }
  const aus = [];
  for (const [ts, zeilen] of nach) {
    const datum = lesbaresDatum(ts);
    const marke = datum ? `[session of ${datum}] ` : '';
    const giltAb = datum ? new Date(ts).toISOString() : '';
    const zeitMs = datum ? new Date(ts).getTime() : 0;
    let akt = []; let len = 0;
    const schliesse = () => { if (akt.length) aus.push({ text: `${marke}Original dialogue: ${akt.join(' ')}`, giltAb, zeitMs }); akt = []; len = 0; };
    for (const z of zeilen) {
      if (len + z.length > CHUNK_MAX && akt.length) schliesse();
      akt.push(z); len += z.length + 1;
    }
    schliesse();
  }
  return aus;
}

/** Zaehlt Schluessel je Art: best (Lektionen), vec, vecname, vec2. */
export async function deckung(redis) {
  const zahl = {};
  let cursor = '0';
  do {
    const [c, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:*', 'COUNT', 500);
    cursor = c;
    for (const k of keys) { const art = k.split(':')[2]; zahl[art] = (zahl[art] ?? 0) + 1; }
  } while (cursor !== '0');
  return zahl;
}

/** Wartet, bis zu jeder Lektion alle drei Vektoren da sind. Bricht ab, wenn stillMs lang nichts Neues kommt oder bis frist (ms-Zeitpunkt). */
export async function vektorenAbwarten(redis, { stillMs = 300_000, frist = Infinity } = {}) {
  let zahl = await deckung(redis); let zuletzt = JSON.stringify(zahl); let stillSeit = Date.now(); let pause = 100;
  const voll = (z) => ['vec', 'vecname', 'vec2'].every((a) => (z[a] ?? 0) >= (z.best ?? 0));
  while (!voll(zahl) && Date.now() - stillSeit < stillMs && Date.now() < frist) {
    await schlafe(pause); pause = Math.min(pause * 1.5, 2000);
    zahl = await deckung(redis);
    const jetzt = JSON.stringify(zahl);
    if (jetzt !== zuletzt) { zuletzt = jetzt; stillSeit = Date.now(); }
  }
  const n = zahl.best ?? 0;
  const luecken = ['vec', 'vecname', 'vec2'].filter((a) => (zahl[a] ?? 0) < n).map((a) => `${a} ${zahl[a] ?? 0}/${n}`);
  return { zahl, luecken };
}

export function lektionsText(roh) {
  if (!roh) return null;
  try { return JSON.parse(roh).what_worked ?? roh; } catch { return roh; }
}
