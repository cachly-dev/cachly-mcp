/**
 * Moegliche Doppelungen — nach Bedeutung, nicht nach Woertern (Abhakliste 4.4, 14.10.2026).
 *
 * ── Der Befund ──────────────────────────────────────────────────────────────
 *
 * Eine Lektion wird oft ein zweites Mal geschrieben, unter neuem Themennamen
 * und mit anderen Worten: eine Korrektur, eine neuere Messung, ein spaeterer
 * Stand derselben Sache. Gemessen am eigenen Brain (888 Lektionen): die
 * hoechste Wort-Ueberlappung zweier Lektionen war 0,33 — Woerter finden das
 * nie. Die Volltext-Vektoren schon: ab 0,80 (DOPPEL_SCHWELLE, dort die
 * Zahlen) sind es echte Doppelungen oder Folgeschritte. Beispiel aus dem
 * Bestand: "KC_HOSTNAME ist seit 03.09. stillgelegt" gegen die aeltere
 * "Keycloak-Hostname fest auf auth.cachly.dev" — 0,82, und die aeltere ist
 * seitdem falsch.
 *
 * ── Was hier passiert ───────────────────────────────────────────────────────
 *
 * Nach dem Schreiben einer Lektion, im Hintergrund (der Vektor entsteht dort
 * ohnehin, brain.ts): die naechsten Nachbarn suchen, den besten ab der
 * Schwelle an der neuen Lektion vermerken. Das Briefing nennt frische
 * Kandidaten, `memory_consolidate` rechnet alle Paare.
 *
 * ── Was hier NICHT passiert ─────────────────────────────────────────────────
 *
 * Nichts wird zusammengelegt, geloescht oder gewaehlt. Am 13.08.2026 loeschte
 * eine "Duplikat"-Regel 529 von 626 Lektionen (Brain:
 * cachly:brain-pflege-loeschte-529-von-626-lektionen). Wer verknuepfen will,
 * sagt es mit `ersetzt` — die vorhandene Mechanik, mit Grund.
 */

import type { Redis } from 'ioredis';
import { kosinus, type Vektorbestand } from './bedeutung.js';
import { DOPPEL_SCHWELLE } from './rangfolge-stellschrauben.js';

/** Hash: Feld = neues Thema, Wert = {alt, naehe, am}. */
export const DOPPEL_SCHLUESSEL = 'cachly:doppel:kandidaten';
/**
 * So viele Zeichen `what_worked` braucht jede Seite. Im eigenen Brain lagen
 * zwei der drei naechsten Paare bei leeren `ci:*`-Lektionen: ohne Text traegt
 * der Vektor nur den Themennamen, und `ci:build-push-web` klingt wie
 * `ci:build-push-api` (0,95).
 */
export const DOPPEL_MINDEST_TEXT = 40;
/** So lange nennt das Briefing einen Kandidaten. Danach nur noch memory_consolidate. */
export const DOPPEL_BRIEFING_TAGE = 14;
/** Aeltere Vermerke raeumt der naechste Schreibvorgang weg. */
export const DOPPEL_HALTEN_TAGE = 30;
/**
 * Ablauf des ganzen Hashs. Mit Ablauf darf ihn die Speicherverdraengung
 * (volatile-lru) bei vollem Brain nehmen — ein Vermerk ist entbehrlich, eine
 * Lektion nicht.
 */
export const DOPPEL_TTL_S = 90 * 86_400;
/**
 * So lange wartet die Antwort von `learn_from_attempts` hoechstens auf die
 * Pruefung (Weg a, Heinrich 14.10.2026: erst Hintergrund, dann sofort). Die
 * Einbettung kostet rund 280 ms, das erste Laden des Vektorbestands einmal je
 * Prozess mehr. Kommt die Pruefung spaeter, fehlt nur der Satz in der
 * Antwort; der Vermerk fuers Briefing entsteht trotzdem.
 */
export const DOPPEL_WARTE_MS = 1500;
/** So viele naechste Nachbarn werden geprueft. */
const NACHBARN = 6;
const TAG_MS = 86_400_000;

export interface DoppelLektion {
  topic: string;
  what_worked?: unknown;
  ersetzt?: unknown;
  ersetzt_durch?: unknown;
  ts?: unknown;
}

export interface DoppelKandidat {
  neu: string;
  alt: string;
  naehe: number;
  am: string;
}

const textLaenge = (l: DoppelLektion): number => (typeof l.what_worked === 'string' ? l.what_worked.trim().length : 0);

/**
 * Zaehlt das Paar als moegliche Doppelung? Verschiedene Themen, beide mit
 * Text, ab der Schwelle — und noch nicht verknuepft: wer schon `ersetzt`
 * gesagt hat, braucht keinen Hinweis mehr.
 */
export function zaehltAlsDoppelung(a: DoppelLektion, b: DoppelLektion, naehe: number, schwelle = DOPPEL_SCHWELLE): boolean {
  if (a.topic === b.topic || !(naehe >= schwelle)) return false;
  if (textLaenge(a) < DOPPEL_MINDEST_TEXT || textLaenge(b) < DOPPEL_MINDEST_TEXT) return false;
  const verknuepft = a.ersetzt === b.topic || a.ersetzt_durch === b.topic
    || b.ersetzt === a.topic || b.ersetzt_durch === a.topic;
  return !verknuepft;
}

/** Der naechste Nachbar, der als Doppelung zaehlt, oder null. */
export function waehleDoppelKandidat(
  neu: DoppelLektion,
  nachbarn: ReadonlyArray<{ lektion: DoppelLektion; naehe: number }>,
): { topic: string; naehe: number } | null {
  let best: { topic: string; naehe: number } | null = null;
  for (const n of nachbarn) {
    if (!zaehltAlsDoppelung(neu, n.lektion, n.naehe)) continue;
    if (!best || n.naehe > best.naehe) best = { topic: n.lektion.topic, naehe: n.naehe };
  }
  return best;
}

function lies(roh: string | null | undefined): Record<string, unknown> | null {
  if (!roh) return null;
  try {
    const v = JSON.parse(roh);
    return v && typeof v === 'object' ? v as Record<string, unknown> : null;
  } catch { return null; }
}

const runde = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Nach dem Schreiben des Volltext-Vektors einer Lektion: Kandidat suchen und
 * vermerken. Ohne Kandidat verschwindet ein alter Vermerk dieses Themas (das
 * Update hat ihn vielleicht mit `ersetzt` erledigt). Wirft nie.
 */
export async function pruefeDoppelung(
  redis: Redis,
  neu: DoppelLektion,
  vektor: number[],
  bestand: Vektorbestand,
  jetzt: Date = new Date(),
): Promise<DoppelKandidat | null> {
  try {
    await bestand.aktualisiere(redis);
    const nachbarn = bestand.aehnlichste(vektor, NACHBARN + 1)
      .filter((n) => n.topic !== neu.topic && n.naehe >= DOPPEL_SCHWELLE);
    let kandidat: { topic: string; naehe: number } | null = null;
    if (nachbarn.length > 0) {
      const roh = await redis.mget(...nachbarn.map((n) => `cachly:lesson:best:${n.topic}`));
      const mitLektion = nachbarn.flatMap((n, i) => {
        const l = lies(roh[i]);
        return l ? [{ lektion: { ...l, topic: n.topic } as DoppelLektion, naehe: n.naehe }] : [];
      });
      kandidat = waehleDoppelKandidat(neu, mitLektion);
    }

    // Alte Vermerke wegraeumen; der Hash bleibt klein.
    const alle = await redis.hgetall(DOPPEL_SCHLUESSEL);
    const weg = Object.entries(alle)
      .filter(([feld, wert]) => feld === neu.topic
        || jetzt.getTime() - Date.parse(String(lies(wert)?.am ?? '')) > DOPPEL_HALTEN_TAGE * TAG_MS
        || !lies(wert))
      .map(([feld]) => feld);
    if (weg.length > 0) await redis.hdel(DOPPEL_SCHLUESSEL, ...weg);

    if (!kandidat) return null;
    const eintrag: DoppelKandidat = { neu: neu.topic, alt: kandidat.topic, naehe: runde(kandidat.naehe), am: jetzt.toISOString() };
    await redis.hset(DOPPEL_SCHLUESSEL, neu.topic, JSON.stringify({ alt: eintrag.alt, naehe: eintrag.naehe, am: eintrag.am }));
    await redis.expire(DOPPEL_SCHLUESSEL, DOPPEL_TTL_S);
    return eintrag;
  } catch {
    return null;
  }
}

/**
 * Wartet hoechstens `ms` auf die Pruefung, sonst null. Der Zeitgeber haelt den
 * Prozess nicht am Leben (CLI und Hooks enden sonst erst nach der Frist).
 */
export async function mitFrist<T>(p: Promise<T | null>, ms: number = DOPPEL_WARTE_MS): Promise<T | null> {
  let zeitgeber: ReturnType<typeof setTimeout> | undefined;
  const frist = new Promise<null>((r) => { zeitgeber = setTimeout(() => r(null), ms); zeitgeber.unref?.(); });
  try {
    return await Promise.race([p, frist]);
  } finally {
    if (zeitgeber) clearTimeout(zeitgeber);
  }
}

/**
 * Der Satz fuer die Antwort von `learn_from_attempts`. Leer, wenn der
 * Wort-Vorschlag (ersetzung-vorschlag.ts) dieselbe Lektion schon nennt — ein
 * Paar, zwei Hinweise waere Laerm.
 */
export function doppelHinweis(k: DoppelKandidat | null, schonGenannt = ''): string {
  if (!k || schonGenannt.includes(`\`${k.alt}\``)) return '';
  return `♻️ Sagt fast dasselbe wie \`${k.alt}\` (Bedeutung ${k.naehe.toFixed(2)}). `
    + `Ist das die neuere Fassung: dieselbe Lektion noch einmal mit \`ersetzt="${k.alt}"\` und \`grund\` schreiben. `
    + 'Ist es eine eigene Sache: nichts zu tun.';
}

/**
 * Die frischen Kandidaten fuers Briefing, die noch gelten: beide Lektionen
 * gibt es noch, keine ist inzwischen verknuepft, der Vermerk ist juenger als
 * DOPPEL_BRIEFING_TAGE. Die naechsten zuerst.
 */
export async function leseDoppelKandidaten(
  redis: Redis,
  lektionen: ReadonlyArray<DoppelLektion>,
  jetzt: Date = new Date(),
): Promise<DoppelKandidat[]> {
  try {
    const roh = await redis.hgetall(DOPPEL_SCHLUESSEL);
    const nachThema = new Map(lektionen.map((l) => [l.topic, l]));
    const aus: DoppelKandidat[] = [];
    for (const [neu, wert] of Object.entries(roh)) {
      const w = lies(wert);
      if (!w || typeof w.alt !== 'string') continue;
      const am = String(w.am ?? '');
      if (!(jetzt.getTime() - Date.parse(am) <= DOPPEL_BRIEFING_TAGE * TAG_MS)) continue;
      const a = nachThema.get(neu);
      const b = nachThema.get(w.alt);
      const naehe = Number(w.naehe);
      if (!a || !b || !zaehltAlsDoppelung(a, b, naehe)) continue;
      aus.push({ neu, alt: w.alt, naehe, am });
    }
    return aus.sort((x, y) => y.naehe - x.naehe);
  } catch {
    return [];
  }
}

/**
 * Alle Paare eines Bestands, die als Doppelung zaehlen — fuer
 * memory_consolidate. Quadratisch: bei 888 Lektionen rund 390.000 Vergleiche.
 * `neu` ist die juengere Lektion (nach `ts`).
 */
export function doppelPaare(eintraege: ReadonlyArray<{ lektion: DoppelLektion; vektor: number[] }>): Array<Omit<DoppelKandidat, 'am'>> {
  const aus: Array<Omit<DoppelKandidat, 'am'>> = [];
  for (let i = 0; i < eintraege.length; i++) {
    for (let j = i + 1; j < eintraege.length; j++) {
      const a = eintraege[i]!;
      const b = eintraege[j]!;
      const naehe = kosinus(a.vektor, b.vektor);
      if (!zaehltAlsDoppelung(a.lektion, b.lektion, naehe)) continue;
      const aJuenger = String(a.lektion.ts ?? '') >= String(b.lektion.ts ?? '');
      const [neu, alt] = aJuenger ? [a.lektion, b.lektion] : [b.lektion, a.lektion];
      aus.push({ neu: neu.topic, alt: alt.topic, naehe: runde(naehe) });
    }
  }
  return aus.sort((x, y) => y.naehe - x.naehe);
}
