/**
 * Die Team-Rolle kommt aus der API, nicht aus dem Speicher (Stufe 2, PR 2,
 * Bauplan A5, 27.11.2026).
 *
 * ── Warum ───────────────────────────────────────────────────────────────────
 *
 * Bis 0.10.280 stand die Rolle im Hash `cachly:team:roles:<id>`, und jeder mit
 * dem Passwort des Speichers konnte sich dort selbst zum Admin machen. Seit
 * Stufe 2 steht sie in Postgres. Die API nennt sie unter
 * `GET /instances/:id/role`; Mitglieder bekommen einen eigenen Benutzer im
 * Speicher, der Team-Daten und Wissen nicht schreiben darf
 * (schluessel-klassen.ts).
 *
 * ── Was hier steht ──────────────────────────────────────────────────────────
 *
 *   holeRolle         GET /role, 60 s im Speicher. 404 (alte API) = null, dann
 *                     gilt das alte Verhalten mit dem Hash.
 *   Zugang            merkt je Verbindung, ob sie ein Mitglieds-Zugang ist
 *                     (`access: "member"` aus /connection).
 *   Huelle            EINE Stelle, die `NOPERM` des Speichers in einen Satz
 *                     uebersetzt. Kein rohes NOPERM erreicht die KI.
 *   Werkzeuglauf      zaehlt je Werkzeugaufruf, wie viele Schreibbefehle der
 *                     Speicher abgewiesen hat. Auch einen verschluckten Fehler
 *                     meldet der Server dann mit einem Satz an der Antwort.
 *   API-Schreibwege   lernen, bestaetigen, Abrufzaehler fuer Mitglieder.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mitgliedDarfSchreiben } from './schluessel-klassen.js';

// ── Rolle ─────────────────────────────────────────────────────────────────

export type TeamRolle = 'admin' | 'reviewer' | 'contributor' | 'viewer';
const ROLLEN: ReadonlySet<string> = new Set(['admin', 'reviewer', 'contributor', 'viewer']);

/** Die Antwort von GET /instances/:id/role (api/internal/handler/brain_rolle_handler.go). */
export interface RollenAuskunft {
  role: TeamRolle;
  /** owner | org_admin | assigned | default */
  source: string;
  can: { learn: boolean; confirm: boolean; withdraw: boolean; manage: boolean };
  review_mode: boolean;
  /** on | off | external */
  protection: string;
  knowledge?: { brain: number; org: number };
  min_mcp?: string;
}

/** Ein GET/POST gegen die API mit dem Schluessel der laufenden Anfrage (apiFetch in index.ts). */
export type ApiAbruf = <T>(pfad: string, optionen?: RequestInit) => Promise<T>;

/** So lange gilt eine Antwort von GET /role. */
export const ROLLE_FRISCH_MS = 60_000;

/** Die Seite, auf der Admins Rollen setzen (Rollen-Seite kommt mit PR 6 dort hin). */
export const ROLLEN_SEITE = 'https://cachly.dev/team';

let abruf: ApiAbruf | null = null;
let bereich: () => string = () => '';
const gemerkt = new Map<string, { auskunft: RollenAuskunft | null; am: number }>();
const laufend = new Map<string, Promise<RollenAuskunft | null>>();

/**
 * Vom Server einmal beim Start gesetzt. `bereich` trennt im HTTP-Modus die
 * Antworten je Schluessel (hinter einem Prozess stehen dort viele Menschen).
 * Ohne Einrichtung (Tests, alte Aufrufer) gibt holeRolle null: altes Verhalten.
 */
export function richteRolleEin(opt: { abruf: ApiAbruf | null; bereich?: () => string }): void {
  abruf = opt.abruf;
  bereich = opt.bereich ?? (() => '');
  gemerkt.clear();
  laufend.clear();
}

/** Nur fuer Tests. */
export function setzeRollenZustandZurueck(): void {
  richteRolleEin({ abruf: null });
  abrufMeldungen.clear();
}

/** Prueft die Form der Antwort. Alles andere als eine der vier Rollen: null. */
export function alsRollenAuskunft(roh: unknown): RollenAuskunft | null {
  if (!roh || typeof roh !== 'object') return null;
  const r = roh as Partial<RollenAuskunft>;
  if (typeof r.role !== 'string' || !ROLLEN.has(r.role)) return null;
  const can = (r.can && typeof r.can === 'object' ? r.can : {}) as Partial<RollenAuskunft['can']>;
  return {
    role: r.role as TeamRolle,
    source: typeof r.source === 'string' ? r.source : '',
    can: { learn: can.learn === true, confirm: can.confirm === true, withdraw: can.withdraw === true, manage: can.manage === true },
    review_mode: r.review_mode === true,
    protection: typeof r.protection === 'string' ? r.protection : '',
    ...(r.knowledge && typeof r.knowledge === 'object' ? { knowledge: r.knowledge } : {}),
    ...(typeof r.min_mcp === 'string' ? { min_mcp: r.min_mcp } : {}),
  };
}

function rollenSchluessel(instanceId: string): string {
  return `${bereich()}|${instanceId}`;
}

/**
 * Die eigene Rolle in diesem Brain, aus der API. 60 s im Speicher.
 *
 *   null  = die API kennt keine Rollen (404, alte API) oder der Server ist
 *           nicht eingerichtet: dann gilt das alte Verhalten (Hash).
 *   Fehler im Netz oder 5xx: der letzte bekannte Stand, sonst null. Das oeffnet
 *   nichts: Ein Mitglied darf Team-Daten und Wissen ohnehin nicht schreiben,
 *   das sperrt der Speicher selbst.
 *
 * Wirft nie.
 */
export async function holeRolle(instanceId: string): Promise<RollenAuskunft | null> {
  if (!abruf || !instanceId) return null;
  const k = rollenSchluessel(instanceId);
  const vorher = gemerkt.get(k);
  if (vorher && Date.now() - vorher.am < ROLLE_FRISCH_MS) return vorher.auskunft;
  const offen = laufend.get(k);
  // Abgelaufen, aber schon einmal gelesen: den alten Stand sofort, die neue
  // Antwort im Hintergrund. Kein Abruf wartet nach der ersten Minute auf /role.
  if (vorher) {
    if (!offen) void frage(k, instanceId, vorher);
    return vorher.auskunft;
  }
  if (offen) return offen;
  return frage(k, instanceId, undefined);
}

function frage(
  k: string,
  instanceId: string,
  vorher: { auskunft: RollenAuskunft | null; am: number } | undefined,
): Promise<RollenAuskunft | null> {
  if (!abruf) return Promise.resolve(vorher?.auskunft ?? null);
  const holen = abruf;
  const p = (async (): Promise<RollenAuskunft | null> => {
    try {
      const auskunft = alsRollenAuskunft(await holen(`/api/v1/instances/${encodeURIComponent(instanceId)}/role`));
      gemerkt.set(k, { auskunft, am: Date.now() });
      return auskunft;
    } catch (e) {
      if (apiFehler(e).status === 404) {
        gemerkt.set(k, { auskunft: null, am: Date.now() });
        return null;
      }
      return vorher?.auskunft ?? null;
    }
  })().finally(() => laufend.delete(k));
  laufend.set(k, p);
  return p;
}

/** Was holeRolle zuletzt bekam, ohne Netz. */
export function rolleImSpeicher(instanceId: string): RollenAuskunft | null {
  return gemerkt.get(rollenSchluessel(instanceId))?.auskunft ?? null;
}

// ── Fehler der API ───────────────────────────────────────────────────────

export interface ApiFehlerInfo { status?: number; code?: string; role?: string; reason?: string }

/**
 * Haengt Status, Code, Rolle und Grund einer Fehlerantwort an den Fehler, den
 * apiFetch wirft. Eigene Namen (apiStatus, apiCode ...): `code` eines McpError
 * ist die Fehlernummer des Protokolls und darf nicht ueberschrieben werden.
 */
export function markiereApiFehler<E>(fehler: E, status: number, koerper: unknown): E {
  if (fehler && typeof fehler === 'object') {
    const k = (koerper && typeof koerper === 'object' ? koerper : {}) as { code?: unknown; role?: unknown; reason?: unknown };
    Object.assign(fehler as object, {
      apiStatus: status,
      ...(typeof k.code === 'string' ? { apiCode: k.code } : {}),
      ...(typeof k.role === 'string' ? { apiRole: k.role } : {}),
      ...(typeof k.reason === 'string' ? { apiReason: k.reason } : {}),
    });
  }
  return fehler;
}

/**
 * Status, Code und Rolle aus einem Fehler von apiFetch (markiereApiFehler).
 * Attrappen in Tests duerfen auch `status`/`code` setzen. Fuer aeltere Formen
 * wird der Status aus dem Text gelesen ("(403)", "error 409").
 */
export function apiFehler(e: unknown): ApiFehlerInfo {
  const roh = (e && typeof e === 'object' ? e : {}) as {
    apiStatus?: unknown; apiCode?: unknown; apiRole?: unknown; apiReason?: unknown;
    status?: unknown; code?: unknown; role?: unknown; reason?: unknown; message?: unknown;
  };
  const text = (a: unknown, b: unknown) => (typeof a === 'string' ? a : typeof b === 'string' ? b : undefined);
  const info: ApiFehlerInfo = {};
  const status = typeof roh.apiStatus === 'number' ? roh.apiStatus : typeof roh.status === 'number' ? roh.status : undefined;
  if (status !== undefined) info.status = status;
  const code = text(roh.apiCode, roh.code);
  if (code !== undefined) info.code = code;
  const role = text(roh.apiRole, roh.role);
  if (role !== undefined) info.role = role;
  const reason = text(roh.apiReason, roh.reason);
  if (reason !== undefined) info.reason = reason;
  if (info.status === undefined) {
    const m = /\((\d{3})\)|error (\d{3})/.exec(String(roh.message ?? ''));
    if (m) info.status = Number(m[1] ?? m[2]);
  }
  return info;
}

// ── Zugang je Verbindung ─────────────────────────────────────────────────

export interface Speicherzugang {
  /** member = eigener Benutzer mit ACL-Muster; full = volles Passwort (Besitzer, Admin, Schutz aus). */
  access: 'member' | 'full';
  role?: string;
  username?: string;
  instanceId?: string;
}

const zugaenge = new WeakMap<object, Speicherzugang>();

/** Der Zugang einer Verbindung; undefined = wie vor Stufe 2 (volles Passwort). */
export function zugangVon(redis: unknown): Speicherzugang | undefined {
  return redis && typeof redis === 'object' ? zugaenge.get(redis) : undefined;
}

/** true, wenn diese Verbindung ein Mitglieds-Zugang ist (`access: "member"`). */
export function istMitglied(redis: unknown): boolean {
  return zugangVon(redis)?.access === 'member';
}

/** Die Rolle fuer Saetze an die KI: zuletzt gelesene API-Rolle, sonst die aus /connection. */
export function rolleFuer(redis: unknown): string {
  const z = zugangVon(redis);
  const aktuell = z?.instanceId ? rolleImSpeicher(z.instanceId)?.role : undefined;
  return aktuell ?? z?.role ?? 'contributor';
}

/**
 * Darf diese Verbindung den Schluessel direkt schreiben? Fuer Messzeilen in
 * gesperrten Familien: ein Mitglied laesst sie aus, statt am Speicher
 * abgewiesen zu werden.
 */
export function darfDirektSchreiben(redis: unknown, schluessel: string): boolean {
  return !istMitglied(redis) || mitgliedDarfSchreiben(schluessel);
}

/** Fehlercode der API, wenn ein Mitglied gerade keinen eigenen Zugang bekommt (409). */
export const CODE_ZUGANG_NICHT_VERFUEGBAR = 'member_access_unavailable';

/**
 * Der Satz fuer 409 `member_access_unavailable` an /connection. Danach baut
 * der Server KEINE Verbindung: ein Versuch ohne Passwort hiesse NOAUTH, und
 * das volle Passwort gibt die API einem Mitglied nie als Ersatz.
 */
export function zugangNichtVerfuegbarText(brainName: string, grund?: string): string {
  const warum = grund ? ` (Grund: ${grund})` : '';
  return [
    `🔒 Der Zugang fuer Mitglieder zu Brain "${brainName}" geht gerade nicht${warum}.`,
    `Bitte den Besitzer des Brains oder einen Org-Admin fragen. Rollen und Zugang stehen unter ${ROLLEN_SEITE}.`,
    `(Member access to this brain is not available right now; ask the brain owner or an organisation admin.)`,
  ].join('\n');
}

// ── Der Satz statt NOPERM ────────────────────────────────────────────────

/** Der Anfang des Satzes; daran erkennt der Server, ob er schon dasteht. */
export const SCHREIBVERBOT_ANFANG = 'Das darf nur der Besitzer oder ein Admin.';

/** Der Satz, den die KI statt `NOPERM` bekommt (Bauplan A5). */
export function schreibverbotText(rolle: string): string {
  return `${SCHREIBVERBOT_ANFANG} Deine Rolle: ${rolle}.`;
}

/** Ein Schreibbefehl, den der Speicher abgewiesen hat, als Satz. */
export class SchreibVerweigert extends Error {
  readonly rolle: string;
  constructor(rolle: string) {
    super(schreibverbotText(rolle));
    this.name = 'SchreibVerweigert';
    this.rolle = rolle;
  }
}

/** Hat der Speicher wegen fehlender Rechte abgelehnt? Auch in einer abgebrochenen Transaktion. */
export function istNoPerm(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const f = e as { message?: unknown; previousErrors?: unknown };
  if (/\bNOPERM\b/.test(String(f.message ?? ''))) return true;
  return Array.isArray(f.previousErrors) && f.previousErrors.some((p) => istNoPerm(p));
}

// ── Werkzeuglauf: abgewiesene Schreibbefehle je Aufruf ───────────────────

interface Lauf { abgewiesen: number; rolle?: string }
const lauf = new AsyncLocalStorage<Lauf>();

function vermerkeAbweisung(rolle: string): void {
  const l = lauf.getStore();
  if (!l) return;
  l.abgewiesen++;
  l.rolle = rolle;
}

/** Fuehrt einen Werkzeugaufruf aus und zaehlt, was der Speicher abgewiesen hat. */
export async function imWerkzeugLauf<T>(fn: () => Promise<T>): Promise<{ ergebnis: T; abgewiesen: number; rolle?: string }> {
  const l: Lauf = { abgewiesen: 0 };
  const ergebnis = await lauf.run(l, fn);
  return { ergebnis, abgewiesen: l.abgewiesen, rolle: l.rolle };
}

/**
 * Hat der Speicher in diesem Aufruf etwas abgewiesen, und steht der Satz noch
 * nicht in der Antwort, kommt er ans Ende. So bleibt kein Schreibversuch still
 * gescheitert, auch wenn ein Werkzeug den Fehler selbst verschluckt.
 */
export function mitAbweisungsHinweis(text: string, abgewiesen: number, rolle = 'contributor'): string {
  if (abgewiesen <= 0 || text.includes(SCHREIBVERBOT_ANFANG)) return text;
  const was = abgewiesen === 1 ? '1 Schreibbefehl' : `${abgewiesen} Schreibbefehle`;
  return `${text}\n\n🔒 ${schreibverbotText(rolle)} Nicht gespeichert: ${was} dieses Aufrufs.`;
}

// ── Die Huelle um den Redis-Client ───────────────────────────────────────

function istZusage(x: unknown): x is Promise<unknown> {
  return !!x && typeof (x as { then?: unknown }).then === 'function';
}

function uebersetzer(rolle: () => string): (e: unknown) => unknown {
  return (e) => {
    if (!istNoPerm(e)) return e;
    const r = rolle();
    vermerkeAbweisung(r);
    return new SchreibVerweigert(r);
  };
}

/** Ergebnisse eines exec(): [[fehler, wert], ...] mit uebersetzten Fehlern. */
function uebersetzeErgebnisse(ergebnis: unknown, uebersetze: (e: unknown) => unknown): unknown {
  if (!Array.isArray(ergebnis)) return ergebnis;
  return ergebnis.map((eintrag) =>
    Array.isArray(eintrag) && eintrag[0] ? [uebersetze(eintrag[0]), eintrag[1]] : eintrag);
}

function huelleBuendel<T extends object>(buendel: T, uebersetze: (e: unknown) => unknown): T {
  const fertig = new Map<PropertyKey, unknown>();
  const proxy: T = new Proxy(buendel, {
    get(ziel, name) {
      const wert = Reflect.get(ziel, name, ziel);
      if (typeof wert !== 'function') return wert;
      if (fertig.has(name)) return fertig.get(name);
      const fn = (...argumente: unknown[]) => {
        const r = (wert as (...a: unknown[]) => unknown).apply(ziel, argumente);
        if (r === ziel) return proxy;
        if (name === 'exec' && istZusage(r)) {
          return r.then((v) => uebersetzeErgebnisse(v, uebersetze), (e) => { throw uebersetze(e); });
        }
        if (istZusage(r)) return r.then(undefined, (e) => { throw uebersetze(e); });
        return r;
      };
      fertig.set(name, fn);
      return fn;
    },
  });
  return proxy;
}

/**
 * Die Huelle um den Redis-Client eines Mitglieds. Jeder Befehl laeuft
 * unveraendert; nur ein `NOPERM` des Speichers wird zu SchreibVerweigert
 * (der Satz aus schreibverbotText) und im laufenden Werkzeugaufruf gezaehlt.
 * Buendel (pipeline, multi) werden mit umhuellt, ihre Einzelfehler auch.
 *
 * Die Huelle ist der Schluessel fuer zugangVon/istMitglied.
 */
export function alsMitgliedsSpeicher<T extends object>(client: T, zugang: Omit<Speicherzugang, 'access'>): T {
  const z: Speicherzugang = { ...zugang, access: 'member' };
  // Die Rolle wird erst beim Fehler gelesen; bis dahin steht `proxy`.
  const uebersetze = uebersetzer(() => rolleFuer(proxy));
  const fertig = new Map<PropertyKey, unknown>();
  const proxy: T = new Proxy(client, {
    get(ziel, name) {
      const wert = Reflect.get(ziel, name, ziel);
      if (typeof wert !== 'function') return wert;
      if (fertig.has(name)) return fertig.get(name);
      const fn = (...argumente: unknown[]) => {
        const r = (wert as (...a: unknown[]) => unknown).apply(ziel, argumente);
        if (r === ziel) return proxy;
        if (istZusage(r)) return r.then(undefined, (e) => { throw uebersetze(e); });
        if ((name === 'pipeline' || name === 'multi') && r && typeof r === 'object') {
          return huelleBuendel(r as object, uebersetze);
        }
        return r;
      };
      fertig.set(name, fn);
      return fn;
    },
  });
  zugaenge.set(proxy, z);
  return proxy;
}

/** Merkt einen Zugang mit vollem Passwort (nur, damit zugangVon ihn nennen kann). */
export function merkeVollenZugang(client: object, zugang: Omit<Speicherzugang, 'access'> = {}): void {
  zugaenge.set(client, { ...zugang, access: 'full' });
}

// ── Schreibwege ueber die API (nur fuer Mitglieder) ──────────────────────

/** Der Koerper von POST /instances/:id/learn (LearnRequest in instance_handler.go). */
export interface LernAnfrage {
  topic: string;
  outcome: string;
  what_worked: string;
  what_failed?: string;
  context?: string;
  severity?: string;
  tags?: string[];
  commands?: string[];
  file_paths?: string[];
  source?: string;
  author?: string;
}

interface LernAntwort { ok?: boolean; topic?: string; proposed?: boolean; geschwaerzt?: unknown; tuersteher?: unknown }

function rolleAusFehler(e: unknown, ersatz: string): string {
  const f = apiFehler(e);
  if (f.role) return f.role;
  if (f.code?.startsWith('role_')) return f.code.slice('role_'.length);
  return ersatz;
}

function fehlerText(e: unknown): string {
  const roh = e instanceof Error ? e.message : String(e);
  return roh.split('\n')[0].slice(0, 300);
}

/**
 * Eine Lektion als Mitglied speichern: genau ein POST /instances/:id/learn.
 * Die API prueft Rolle und Freigabepflicht und setzt den Autor aus Postgres.
 * Wirft nie; jeder Ausgang ist ein Satz.
 */
export async function lerneUeberApi(
  api: ApiAbruf,
  instanceId: string,
  anfrage: LernAnfrage,
  rolle: string,
): Promise<string> {
  let antwort: LernAntwort;
  try {
    antwort = await api<LernAntwort>(`/api/v1/instances/${encodeURIComponent(instanceId)}/learn`, {
      method: 'POST',
      body: JSON.stringify({ source: 'mcp', ...anfrage }),
    });
  } catch (e) {
    const f = apiFehler(e);
    if (f.status === 403) {
      const r = rolleAusFehler(e, rolle);
      return [
        `🔒 Deine Rolle (${r}) darf in diesem Brain keine Lektionen speichern. Nichts wurde gespeichert.`,
        `Rollen setzt der Besitzer oder ein Admin unter ${ROLLEN_SEITE}.`,
      ].join('\n');
    }
    return `⚠️ Nicht gespeichert: Die API hat \`${anfrage.topic}\` nicht angenommen (${fehlerText(e)}). Bitte noch einmal versuchen.`;
  }
  const thema = antwort?.topic || anfrage.topic;
  if (antwort?.proposed) {
    return [
      `📝 **Lesson submitted for review** — \`${thema}\` is now a pending proposal.`,
      ``,
      `This team requires review before knowledge enters the Team Brain (org setting).`,
      `An org owner/admin can approve or reject it in the dashboard under **Team → Review**.`,
      `Until approved it will NOT surface in \`smart_recall\` / \`team_recall\`.`,
    ].join('\n');
  }
  return [
    `✅ Lesson stored: \`${thema}\` (${anfrage.outcome}) — saved through the cachly API as a team member (role: ${rolle}).`,
    `💡 ${String(anfrage.what_worked ?? '').slice(0, 120)}`,
  ].join('\n');
}

/** Eine Lektion als Mitglied bestaetigen: POST /instances/:id/lessons/confirm. Wirft nie. */
export async function bestaetigeUeberApi(
  api: ApiAbruf,
  instanceId: string,
  anfrage: { topic: string; tier?: string; note?: string },
  rolle: string,
): Promise<string> {
  try {
    const a = await api<{ topic?: string; review_level?: string; endorsements?: number; reviewed_by?: string }>(
      `/api/v1/instances/${encodeURIComponent(instanceId)}/lessons/confirm`,
      { method: 'POST', body: JSON.stringify(anfrage) },
    );
    const stufe = a?.review_level === 'senior' ? '🛡️ senior-reviewed' : '✔️ peer-reviewed';
    const zahl = Number(a?.endorsements ?? 0);
    return `${stufe} — \`${a?.topic ?? anfrage.topic}\` confirmed by **${a?.reviewed_by ?? '?'}** (role: ${rolle}, ${zahl} distinct endorsement${zahl === 1 ? '' : 's'}).\n📈 This lesson now ranks higher in \`smart_recall\` / \`team_recall\`.`;
  } catch (e) {
    const f = apiFehler(e);
    if (f.status === 403) {
      return [
        `🔒 Bestaetigen duerfen nur reviewer und admin. Deine Rolle: ${rolleAusFehler(e, rolle)}. Nichts wurde geaendert.`,
        `Rollen setzt der Besitzer oder ein Admin unter ${ROLLEN_SEITE}.`,
      ].join('\n');
    }
    if (f.status === 404) {
      return `📭 No best-solution lesson found for \`${anfrage.topic}\`.\n\nA lesson must exist (store one with \`team_learn\` / \`learn_from_attempts\`) before it can be confirmed.`;
    }
    return `⚠️ Nicht bestaetigt: Die API hat \`${anfrage.topic}\` nicht angenommen (${fehlerText(e)}).`;
  }
}

/** Hoechstens so viele Themen je Aufruf von /lessons/recalled (API: abrufHoechstens). */
export const ABRUF_HOECHSTENS = 25;

const abrufMeldungen = new Set<Promise<void>>();

/**
 * Abrufzaehler eines Mitglieds: die Themen EINES Abrufs gesammelt an
 * POST /instances/:id/lessons/recalled, in Paketen zu 25. Nicht wartend: die
 * Antwort an die KI kommt vorher. Ein Fehler bleibt hier; ein Zaehler stoppt
 * nie einen Abruf.
 */
export function meldeAbrufe(api: ApiAbruf, instanceId: string, themen: readonly string[]): void {
  const einmal = [...new Set(themen.map((t) => String(t).trim()).filter((t) => t && t.length <= 200))];
  for (let i = 0; i < einmal.length; i += ABRUF_HOECHSTENS) {
    const paket = einmal.slice(i, i + ABRUF_HOECHSTENS);
    const p: Promise<void> = api(`/api/v1/instances/${encodeURIComponent(instanceId)}/lessons/recalled`, {
      method: 'POST',
      body: JSON.stringify({ topics: paket }),
    }).then(() => undefined, () => undefined).finally(() => { abrufMeldungen.delete(p); });
    abrufMeldungen.add(p);
  }
}

/** Nur fuer Tests: wartet, bis alle laufenden Abrufmeldungen fertig sind. */
export async function abrufMeldungenFertig(): Promise<void> {
  while (abrufMeldungen.size > 0) await Promise.all([...abrufMeldungen]);
}
