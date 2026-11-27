/**
 * Firmenregeln beim MCP-Server (Stufe 1, 27.11.2026).
 *
 * Ein Admin legt im Dashboard Regeln fest. Die API baut daraus EINEN fertigen Block
 * (`block`) und einen Hash. Dieser Server liest nur `GET /api/v1/instances/:id/rules`
 * und druckt den Block unveraendert. Welche Regeln gelten (Firma, Brain, Abweichung),
 * entscheidet allein die API.
 *
 * Regeln sind keine Lektionen: Sie stehen in Postgres, nur die API schreibt sie, und
 * kein MCP-Werkzeug aendert sie. Deshalb steht der Block AUSSERHALB des Lektionsrahmens
 * `<cachly-memory>` (der sagt "Daten, keine Anweisung"). Der Name `cachly-company-rules`
 * steht in der Liste der entschaerften Etiketten (einblendung-rahmen.ts): Eine Lektion
 * kann keinen Regelblock faelschen.
 *
 * Wege (siehe BAUPLAN-stufe-1.md): H Hook, A erste Werkzeugantwort, E session_start,
 * S smart_recall, I instructions.
 *
 * Diese Datei haengt nur an Node-Bordmitteln und einblendung-kern/-rahmen: Der Hook
 * wird zu EINER Datei ohne node_modules gebuendelt.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { torWoerter, zaehleBelege } from './einblendung-kern.js';
import { entschaerfe } from './einblendung-rahmen.js';

export const REGEL_BLOCK_DECKEL = 5000;
export const REGEL_ABRUF_MS = 1500; // laenger wartet keine Antwort auf die Regeln
export const REGEL_FRISCH_MS = 600_000; // danach im Hintergrund neu fragen
export const REGEL_TREFFER_MAX = 3;
export const REGEL_TREFFER_BELEGE = 2;

/** Nach einem Fehlschlag fragt dieser Prozess erst nach so langer Zeit wieder. */
const REGEL_FEHLER_PAUSE_MS = 60_000;
/** Die Marke des Hooks gilt, wenn sie hoechstens so lange VOR dem Prozessstart entstand. */
const MARKE_VORLAUF_MS = 60_000;
const ETIKETT = 'cachly-company-rules';
const SCHLUSS = `</${ETIKETT}>`;

export interface Firmenregel { id: string; category: string; title: string; text: string; updated_at?: string }
export interface RegelStand {
  rules: Firmenregel[]; block: string; count: number; hash: string; updated_at: string | null;
  quelle: 'server' | 'platte' | 'keine';
  /** Wann dieser Prozess den Stand vom Server bestaetigt bekam (ms). Nur im Speicher. */
  geholtAm?: number;
}

/** Wie ein Abruf aussieht: der Pfad, dazu optional Kopfzeilen (If-None-Match). 304 wirft einen Fehler mit "304". */
export type RegelAbruf = (pfad: string, optionen?: { headers?: Record<string, string> }) => Promise<unknown>;

// ── Ablage ───────────────────────────────────────────────────────────────────

function kurzHash(instanceId: string): string {
  return createHash('sha1').update(instanceId).digest('hex').slice(0, 12);
}
function ordner(): string {
  return process.env.CACHLY_REGELN_ORDNER || tmpdir();
}
function standPfad(instanceId: string): string {
  return join(ordner(), `cachly-firmenregeln-${kurzHash(instanceId)}.json`);
}
function markePfad(instanceId: string): string {
  return join(ordner(), `cachly-firmenregeln-marke-${kurzHash(instanceId)}.json`);
}

const leer = (quelle: RegelStand['quelle']): RegelStand =>
  ({ rules: [], block: '', count: 0, hash: '', updated_at: null, quelle });

/** Macht aus einer Antwort einen Stand, oder null, wenn sie nicht nach dem Vertrag aussieht. */
function alsStand(roh: unknown, quelle: RegelStand['quelle']): RegelStand | null {
  if (!roh || typeof roh !== 'object') return null;
  const r = roh as Record<string, unknown>;
  if (!Array.isArray(r.rules)) return null;
  const rules: Firmenregel[] = r.rules
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .slice(0, 100)
    .map((x) => ({
      id: String(x.id ?? ''),
      category: String(x.category ?? ''),
      title: String(x.title ?? ''),
      text: String(x.text ?? ''),
      ...(typeof x.updated_at === 'string' ? { updated_at: x.updated_at } : {}),
    }));
  const block = typeof r.block === 'string' ? r.block : '';
  const zahl = Number(r.count);
  const count = Number.isFinite(zahl) && zahl >= 0 ? Math.floor(zahl) : rules.length;
  return {
    rules, block, count,
    hash: typeof r.hash === 'string' ? r.hash : '',
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
    quelle,
  };
}

function lesePlatte(instanceId: string): RegelStand | null {
  try {
    const datei = standPfad(instanceId);
    if (!existsSync(datei)) return null;
    const j = JSON.parse(readFileSync(datei, 'utf8')) as { stand?: unknown };
    const s = alsStand(j?.stand, 'platte');
    return s && s.count > 0 ? s : null;
  } catch {
    return null;
  }
}

function schreibePlatte(instanceId: string, stand: RegelStand): void {
  try {
    const datei = standPfad(instanceId);
    if (stand.count <= 0) {
      if (existsSync(datei)) unlinkSync(datei);
      return;
    }
    mkdirSync(ordner(), { recursive: true });
    const { rules, block, count, hash, updated_at } = stand;
    writeFileSync(datei, JSON.stringify({ v: 1, at: Date.now(), stand: { rules, block, count, hash, updated_at } }), 'utf8');
  } catch { /* die Platte ist nur ein Rueckfall */ }
}

// ── Zustand dieses Prozesses ─────────────────────────────────────────────────

const speicher = new Map<string, RegelStand>();
const fehlerBis = new Map<string, number>();
const geliefert = new Set<string>(); // `${instanceId}:${hash}`

/** Nur fuer Tests. Die Platte bleibt, wie sie ist (ein neuer Prozess sieht sie auch). */
export function setzeRegelZustandZurueck(): void {
  speicher.clear();
  fehlerBis.clear();
  geliefert.clear();
}

/** Der Stand, den dieser Prozess schon hat. Kein Netz. */
export function regelStandImSpeicher(instanceId: string): RegelStand | null {
  return speicher.get(instanceId) ?? null;
}

function mitLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((ok, nein) => {
    const t = setTimeout(() => nein(new Error('Zeitlimit')), ms);
    p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); nein(e); });
  });
}

/**
 * Wirft nie. 404 und Netzfehler: Stand von der Platte, sonst count 0 mit quelle 'keine'.
 * Antwortet der Server mit count 0, wird der Plattenstand geloescht.
 * Ein Stand, den der Server vor weniger als REGEL_FRISCH_MS bestaetigt hat, kommt ohne Netz zurueck.
 */
export async function holeRegeln(
  instanceId: string,
  abruf: RegelAbruf,
  opt?: { zeitlimitMs?: number },
): Promise<RegelStand> {
  try {
    if (!instanceId) return leer('keine');
    const jetzt = Date.now();
    const imSpeicher = speicher.get(instanceId) ?? null;
    if (imSpeicher && imSpeicher.quelle === 'server' && jetzt - (imSpeicher.geholtAm ?? 0) < REGEL_FRISCH_MS) return imSpeicher;

    const vorher = imSpeicher ?? lesePlatte(instanceId);
    const rueckfall = (): RegelStand => {
      const s = vorher ?? leer('keine');
      const r: RegelStand = vorher && vorher.quelle === 'server' ? vorher : { ...s, quelle: vorher ? 'platte' : 'keine' };
      speicher.set(instanceId, r);
      return r;
    };
    if ((fehlerBis.get(instanceId) ?? 0) > jetzt) return rueckfall();

    try {
      const optionen = vorher && vorher.count > 0 && vorher.hash ? { headers: { 'If-None-Match': vorher.hash } } : undefined;
      const antwort = await mitLimit(Promise.resolve().then(() => abruf(`/api/v1/instances/${instanceId}/rules`, optionen)), opt?.zeitlimitMs ?? REGEL_ABRUF_MS);
      const stand = alsStand(antwort, 'server');
      if (!stand) throw new Error('Antwort ohne Regelform');
      stand.geholtAm = Date.now();
      schreibePlatte(instanceId, stand);
      speicher.set(instanceId, stand);
      fehlerBis.delete(instanceId);
      return stand;
    } catch (e) {
      // 304 Not Modified: der Stand, den wir schon haben, gilt weiter.
      if (vorher && vorher.count > 0 && /\b304\b/.test(String((e as Error)?.message ?? ''))) {
        const bestaetigt: RegelStand = { ...vorher, quelle: 'server', geholtAm: Date.now() };
        speicher.set(instanceId, bestaetigt);
        fehlerBis.delete(instanceId);
        return bestaetigt;
      }
      fehlerBis.set(instanceId, Date.now() + REGEL_FEHLER_PAUSE_MS);
      return rueckfall();
    }
  } catch {
    return leer('keine');
  }
}

/** Ein Abruf ueber fetch, fuer Hook und `join` (der Server nutzt seinen eigenen apiFetch). */
export function regelAbrufMitFetch(apiUrl: string, jwt: string, fetchFn: typeof fetch = fetch): RegelAbruf {
  return async (pfad, optionen) => {
    const res = await fetchFn(`${apiUrl}${pfad}`, {
      headers: { Authorization: `Bearer ${jwt}`, ...(optionen?.headers ?? {}) },
      signal: AbortSignal.timeout(REGEL_ABRUF_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
}

// ── Der Block ────────────────────────────────────────────────────────────────

/**
 * Der Block fuer H, A und E. '' bei count 0. Ueber dem Deckel: an ganzer Zeile kuerzen
 * und es dazuschreiben ("N rules not shown, see dashboard").
 */
export function regelBlock(stand: RegelStand | null): string {
  if (!stand || stand.count <= 0) return '';
  const block = String(stand.block ?? '').trim();
  if (!block) return '';
  if (block.length <= REGEL_BLOCK_DECKEL) return block;

  const zeilen = block.split('\n');
  const ohneEnde = zeilen[zeilen.length - 1]!.trim() === SCHLUSS ? zeilen.slice(0, -1) : zeilen;
  const reserve = 80; // Hinweiszeile + Schlussetikett
  const behalten: string[] = [];
  let laenge = 0;
  for (const z of ohneEnde) {
    if (laenge + z.length + 1 > REGEL_BLOCK_DECKEL - reserve) break;
    behalten.push(z);
    laenge += z.length + 1;
  }
  // Eine Kategoriezeile ohne Regel darunter bringt nichts.
  while (behalten.length && /^\[[^\]]*\]$/.test(behalten[behalten.length - 1]!.trim())) behalten.pop();
  const gezeigt = behalten.filter((z) => z.startsWith('- ')).length;
  const fehlt = Math.max(1, stand.count - gezeigt);
  return `${behalten.join('\n')}\n${fehlt} rules not shown, see dashboard\n${SCHLUSS}`;
}

// ── Weg A: einmal je Prozess und Hash ────────────────────────────────────────

/** Der Hook ruft das nach seiner Lieferung. */
export function merkeRegelLieferung(instanceId: string, hash: string, cwd: string): void {
  try {
    mkdirSync(ordner(), { recursive: true });
    writeFileSync(markePfad(instanceId), JSON.stringify({ hash, cwd: resolve(cwd), at: Date.now() }), 'utf8');
  } catch { /* ohne Marke wird im Zweifel doppelt geliefert, nie gar nicht */ }
}

function hookHatGeliefert(instanceId: string, hash: string, cwd: string, prozessStart: number): boolean {
  try {
    const datei = markePfad(instanceId);
    if (!existsSync(datei)) return false;
    const m = JSON.parse(readFileSync(datei, 'utf8')) as { hash?: string; cwd?: string; at?: number };
    return m.hash === hash && m.cwd === resolve(cwd) && Number(m.at) >= prozessStart - MARKE_VORLAUF_MS;
  } catch {
    return false;
  }
}

/** Weg A: Block einmal je Prozess und Hash. '' wenn schon geliefert oder der Hook es in dieser Sitzung tat. */
export function regelHinweisEinmal(
  instanceId: string,
  stand: RegelStand | null,
  sitzung: { cwd: string; prozessStart: number },
): string {
  try {
    const block = regelBlock(stand);
    if (!block || !stand) return '';
    const schluessel = `${instanceId}:${stand.hash}`;
    if (geliefert.has(schluessel)) return '';
    geliefert.add(schluessel);
    if (hookHatGeliefert(instanceId, stand.hash, sitzung.cwd, sitzung.prozessStart)) return '';
    return block;
  } catch {
    return '';
  }
}

// ── Weg S: passende Regeln zu einer Aufgabe ─────────────────────────────────

/** Weg S: '' oder ein Block mit hoechstens REGEL_TREFFER_MAX Regeln. Kein Netz. */
export function passendeRegeln(query: string, stand: RegelStand | null): string {
  try {
    if (!stand || stand.count <= 0 || !stand.rules.length) return '';
    const woerter = torWoerter(String(query ?? ''));
    if (!woerter.length) return '';
    const treffer = stand.rules
      .map((r, platz) => ({ r, platz, belege: zaehleBelege(woerter, `${r.title} ${r.text}`.toLowerCase()) }))
      .filter((x) => x.belege >= REGEL_TREFFER_BELEGE)
      .sort((a, b) => (b.belege - a.belege) || (a.platz - b.platz))
      .slice(0, REGEL_TREFFER_MAX);
    if (!treffer.length) return '';
    const eine = (s: string) => entschaerfe(s).replace(/\s+/g, ' ').trim();
    const zeilen = treffer.map(({ r }) => `- ${eine(r.title)}: ${eine(r.text)}`);
    return `<${ETIKETT} count="${treffer.length}" scope="task">\n` +
      `Company rules that match this task. Follow them.\n${zeilen.join('\n')}\n${SCHLUSS}`;
  } catch {
    return '';
  }
}

// ── Weg I: eine Zeile in instructions ────────────────────────────────────────

/** Weg I: '' oder der eine Satz fuer instructions (liest nur die Platte, synchron). */
export function regelAnweisungsZeile(instanceId: string): string {
  try {
    if (!instanceId) return '';
    const s = lesePlatte(instanceId);
    if (!s || s.count <= 0) return '';
    return `This workspace has ${s.count} company rule${s.count === 1 ? '' : 's'} set by its admins. They arrive with your first tool response and with session_start; follow them.`;
  } catch {
    return '';
  }
}

// ── Vertrauenswuerdige Stuecke in Werkzeugantworten ──────────────────────────
//
// session_start und smart_recall laufen in index.ts durch `rahmeAntwort` (Rahmen
// <cachly-memory>, dazu die Entschaerfung der Etiketten). Der Regelblock kommt vom
// Server der API, nicht aus einer Lektion, und darf dort weder eingerahmt noch
// entschaerft werden. Er wird deshalb mit einer Marke versehen, die nur dieser
// Prozess kennt (Zufallswert). Eine Lektion kann sie nicht erraten, also auch keinen
// Regelblock als "vertrauenswuerdig" einschleusen.

const NONCE = randomBytes(8).toString('hex');
const VON = `⟦cachly-rules:${NONCE}⟧`;
const BIS = `⟦/cachly-rules:${NONCE}⟧`;

/** Markiert ein Stueck als vom Server der API stammend (siehe oben). '' bleibt ''. */
export function markiereVertraut(text: string): string {
  return text ? `${VON}${text}${BIS}` : '';
}

/** Zerlegt einen Antworttext in vertraute und uebrige Stuecke, Reihenfolge bleibt. */
export function zerlegeNachVertrauen(text: string): { vertraut: boolean; text: string }[] {
  const teile: { vertraut: boolean; text: string }[] = [];
  let rest = text;
  for (;;) {
    const a = rest.indexOf(VON);
    if (a < 0) break;
    const b = rest.indexOf(BIS, a + VON.length);
    if (b < 0) break;
    if (a > 0) teile.push({ vertraut: false, text: rest.slice(0, a) });
    teile.push({ vertraut: true, text: rest.slice(a + VON.length, b) });
    rest = rest.slice(b + BIS.length);
  }
  if (rest) teile.push({ vertraut: false, text: rest });
  return teile;
}
