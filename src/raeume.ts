/**
 * Raeume im Speicher (Stufe 3): private Raeume je Konto und Raeume je Gruppe.
 * Schluessel wortgleich mit api/internal/raeume (Go). Gelesen wird nur, was
 * das ACL-Muster des Mitglieds erlaubt; geschrieben wird nie von hier.
 */

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { zugangVon } from './rolle.js';

export interface RaumRef {
  name?: string;
  praefix: string;
}
export interface Raeume {
  privat?: string;
  gruppen: RaumRef[];
  alle?: boolean;
}
export interface RaumLektion {
  thema: string;
  praefix: string;
  art: 'p' | 'g';
  gruppe?: string;
  lektion: Record<string, unknown>;
  roh: string;
}
export type RaumLeser = Pick<
  Redis,
  'mget' | 'smembers' | 'hgetall' | 'pipeline'
>;

export const RAUM_VERZEICHNIS = 'cachly:zone:raeume';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Der Praefix des privaten Raums eines Kontos. */
export function raumPrivat(kontoId: string): string {
  return `cachly:zone:p:${kontoId.replace(/-/g, '').slice(0, 16)}:`;
}

/** Der Praefix des Raums einer Gruppe (Name klein, getrimmt, gehasht). */
export function raumGruppe(name: string): string {
  return `cachly:zone:g:${sha(`gruppe:${name.toLowerCase().trim()}`).slice(0, 16)}:`;
}

/** Der Schluessel der Lektion zu diesem Thema im Raum. */
export function lektionsSchluessel(praefix: string, thema: string): string {
  return `${praefix}lesson:best:${sha(thema).slice(0, 32)}`;
}

/** Der Schluessel der Themenliste eines Raums. */
export function themenSchluessel(praefix: string): string {
  return `${praefix}themen`;
}

/** Die ACL-Regeln eines Mitglieds ohne "on" und Passwort, wortgleich mit brainzugang.MusterMitglied (Go). */
export function mitgliedMuster(r: {
  privat?: string;
  gruppen: string[];
}): string[] {
  return [
    '%R~cachly:[^z]*',
    ...(r.privat ? [`%R~${r.privat}*`] : []),
    ...r.gruppen.map((g) => `%R~${g}*`),
    '~[^c]*',
    '~c[^a]*',
    '~ca[^c]*',
    '~cac[^h]*',
    '~cach[^l]*',
    '~cachl[^y]*',
    '~cachly[^:]*',
    '~cachly:[^tlciwgfbmpdz]*',
    '~cachly:ctx:*',
    '~cachly:cls:*',
    '~cachly:wirkung:*',
    '~cachly:lock:*',
    '~cachly:mcp:*',
    '~cachly:mcm:*',
    '~cachly:prefs:*',
    '~cachly:dep:*',
    '~cachly:letzter-recall:*',
    '~cachly:liefer:*',
    '+@all',
    '-@admin',
    '-@dangerous',
    '+keys',
    '+info',
    '-client',
  ];
}

function alsText(x: unknown): string | undefined {
  return typeof x === 'string' && x ? x : undefined;
}

/** Das Feld `rooms` aus GET /connection (Vertrag V2); alles Unpassende gibt undefined. */
export function raeumeAusAuskunft(rooms: unknown): Raeume | undefined {
  if (!rooms || typeof rooms !== 'object') return undefined;
  const r = rooms as { private?: unknown; groups?: unknown; all?: unknown };
  const privat = alsText(r.private);
  const gruppen: RaumRef[] = [];
  if (Array.isArray(r.groups)) {
    for (const g of r.groups) {
      const praefix = alsText((g as { prefix?: unknown } | null)?.prefix);
      if (!praefix) continue;
      const name = alsText((g as { name?: unknown }).name);
      gruppen.push({ ...(name ? { name } : {}), praefix });
    }
  }
  const alle = r.all === true;
  if (!privat && gruppen.length === 0 && !alle) return undefined;
  return {
    ...(privat ? { privat } : {}),
    gruppen,
    ...(alle ? { alle: true } : {}),
  };
}

/** Die Raeume dieser Verbindung, wie sie am Zugang stehen. */
export function raeumeVon(redis: unknown): Raeume | undefined {
  return zugangVon(redis)?.raeume;
}

function artVon(praefix: string): 'p' | 'g' {
  return praefix.startsWith('cachly:zone:p:') ? 'p' : 'g';
}

function lese(roh: string): Record<string, unknown> | null {
  try {
    const x: unknown = JSON.parse(roh);
    return x && typeof x === 'object' && !Array.isArray(x)
      ? (x as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Die sichtbaren Raeume: erst der eigene, dann die Gruppen, bei `alle` danach der Rest des Verzeichnisses (ein HGETALL). */
async function sichtbareRaeume(redis: RaumLeser): Promise<RaumRef[]> {
  const r = raeumeVon(redis);
  if (!r) return [];
  const aus: RaumRef[] = [];
  const gesehen = new Set<string>();
  const nimm = (x: RaumRef) => {
    if (gesehen.has(x.praefix)) return;
    gesehen.add(x.praefix);
    aus.push(x);
  };
  if (r.privat) nimm({ praefix: r.privat });
  for (const g of r.gruppen) nimm(g);
  if (r.alle) {
    let verz: Record<string, string> = {};
    try {
      verz = await redis.hgetall(RAUM_VERZEICHNIS);
    } catch {
      verz = {};
    }
    for (const [praefix, wert] of Object.entries(verz)) {
      const name = alsText(lese(wert)?.name);
      nimm({ ...(name ? { name } : {}), praefix });
    }
  }
  return aus;
}

function alsRaumLektion(
  roh: string,
  ref: RaumRef,
  thema?: string,
): RaumLektion | null {
  const lektion = lese(roh);
  if (!lektion) return null;
  const art = artVon(ref.praefix);
  const t =
    typeof lektion.topic === 'string' && lektion.topic ? lektion.topic : thema;
  if (!t) return null;
  const gruppe = art === 'g' ? (ref.name ?? alsText(lektion.group)) : undefined;
  return {
    thema: t,
    praefix: ref.praefix,
    art,
    ...(gruppe ? { gruppe } : {}),
    lektion,
    roh,
  };
}

/** Die Lektion zu diesem Thema im ersten sichtbaren Raum, der sie hat: ein MGET (bei `alle` vorher ein HGETALL). */
export async function leseRaumLektion(
  redis: RaumLeser,
  thema: string,
): Promise<RaumLektion | null> {
  const raeume = await sichtbareRaeume(redis);
  if (raeume.length === 0) return null;
  const werte = await redis.mget(
    ...raeume.map((x) => lektionsSchluessel(x.praefix, thema)),
  );
  for (let i = 0; i < raeume.length; i++) {
    const roh = werte[i];
    if (typeof roh !== 'string') continue;
    const l = alsRaumLektion(roh, raeume[i], thema);
    if (l) return l;
  }
  return null;
}

/** Bis zu `grenze` Lektionen aus den sichtbaren Raeumen: pipeline SMEMBERS, dann ein MGET. */
export async function ladeRaumLektionen(
  redis: RaumLeser,
  grenze = 200,
): Promise<RaumLektion[]> {
  const raeume = await sichtbareRaeume(redis);
  if (raeume.length === 0) return [];
  const p = redis.pipeline();
  for (const x of raeume) p.smembers(themenSchluessel(x.praefix));
  const ergebnis = (await p.exec()) ?? [];
  const paare: { ref: RaumRef; thema: string }[] = [];
  raeume.forEach((ref, i) => {
    const [fehler, liste] = ergebnis[i] ?? [null, []];
    if (fehler || !Array.isArray(liste)) return;
    for (const t of (liste as unknown[]).slice().sort())
      if (typeof t === 'string') paare.push({ ref, thema: t });
  });
  const gewaehlt = paare.slice(0, Math.max(0, grenze));
  if (gewaehlt.length === 0) return [];
  const werte = await redis.mget(
    ...gewaehlt.map((x) => lektionsSchluessel(x.ref.praefix, x.thema)),
  );
  const aus: RaumLektion[] = [];
  gewaehlt.forEach((x, i) => {
    const roh = werte[i];
    if (typeof roh !== 'string') return;
    const l = alsRaumLektion(roh, x.ref, x.thema);
    if (l) aus.push(l);
  });
  return aus;
}

function woerter(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/** Die besten Treffer nach Wortvergleich (Frage gegen Thema, Text, Tags); ohne Speicher. Vorgabe 3. */
export function raumTreffer(
  lektionen: RaumLektion[],
  frage: string,
  hoechstens = 3,
): RaumLektion[] {
  const gesucht = new Set(woerter(frage));
  if (gesucht.size === 0) return [];
  const bewertet: { l: RaumLektion; n: number }[] = [];
  for (const l of lektionen) {
    const k = l.lektion;
    const tags = Array.isArray(k.tags)
      ? k.tags.filter((t): t is string => typeof t === 'string').join(' ')
      : '';
    const text = [l.thema, k.what_worked, k.what_failed, k.context, tags]
      .filter((t): t is string => typeof t === 'string')
      .join(' ');
    const da = new Set(woerter(text));
    let n = 0;
    for (const w of gesucht) if (da.has(w)) n++;
    if (n > 0) bewertet.push({ l, n });
  }
  bewertet.sort((a, b) => b.n - a.n);
  return bewertet.slice(0, Math.max(0, hoechstens)).map((x) => x.l);
}
