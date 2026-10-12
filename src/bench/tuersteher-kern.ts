/**
 * Kern der Tuersteher-Messung: feste Teilung der Proben und Urteil je Probe.
 *
 * Getrennt vom Aufrufer (tuersteher-messen.ts), damit ein Test die Teilung
 * pruefen kann, ohne die Probendatei zu brauchen.
 */

import { schwaerze } from '../geheimnis-filter.js';
import { pruefeMitStelle, type Verdacht } from '../tuersteher.js';

export interface Probe {
  id: string;
  text: string;
  label: 'gift' | 'harmlos';
  art: string;
}

/** Feste Saat der Teilung. Aendern nur zusammen mit tuersteher-vorher.json. */
export const SAAT = 20261012;

/** Arten, bei denen ein Muster ueberhaupt etwas sehen kann. */
export const MUSTER_ARTEN = ['prompt_injektion', 'befehl_einschleusung', 'geheimnis_klartext'];

function mulberry32(start: number): () => number {
  let a = start | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Teilt die Proben je (Art, Label) in zwei Haelften: die erste (aufgerundet) zum
 * Einstellen der Regeln, der Rest zum Pruefen. Gleiche Saat, gleiche Teilung —
 * unabhaengig von der Reihenfolge in der Datei.
 */
export function teile(proben: Probe[], saat = SAAT): { einstell: Probe[]; pruef: Probe[] } {
  const rnd = mulberry32(saat);
  const gruppen = new Map<string, Probe[]>();
  for (const p of [...proben].sort((a, b) => a.id.localeCompare(b.id))) {
    const k = `${p.art}|${p.label}`;
    const g = gruppen.get(k) ?? [];
    g.push(p);
    gruppen.set(k, g);
  }
  const einstell: Probe[] = [];
  const pruef: Probe[] = [];
  for (const [, g] of [...gruppen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const m = [...g];
    for (let i = m.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [m[i], m[j]] = [m[j], m[i]];
    }
    const n = Math.ceil(m.length / 2);
    einstell.push(...m.slice(0, n));
    pruef.push(...m.slice(n));
  }
  return { einstell, pruef };
}

export interface Urteil {
  erkannt: boolean;
  /** Arten geschwaerzter Geheimnisse. */
  geheimnis: string[];
  verdacht: Array<Verdacht & { stelle: string }>;
}

/** Was der Schreibweg mit diesem Text taete: schwaerzen und/oder markieren. */
export function urteil(text: string, mitTuersteher = true): Urteil {
  const geheimnis = schwaerze(text).funde;
  const verdacht = mitTuersteher ? pruefeMitStelle(text) : [];
  return { erkannt: geheimnis.length > 0 || verdacht.length > 0, geheimnis, verdacht };
}

export interface ArtZahl {
  gift: number;
  giftErkannt: number;
  harmlos: number;
  harmlosAlarm: number;
}

export function messe(proben: Probe[], mitTuersteher = true): Record<string, ArtZahl> {
  const z: Record<string, ArtZahl> = {};
  for (const p of proben) {
    const e = (z[p.art] ??= { gift: 0, giftErkannt: 0, harmlos: 0, harmlosAlarm: 0 });
    const hit = urteil(p.text, mitTuersteher).erkannt;
    if (p.label === 'gift') {
      e.gift++;
      if (hit) e.giftErkannt++;
    } else {
      e.harmlos++;
      if (hit) e.harmlosAlarm++;
    }
  }
  return z;
}

/** Summe ueber die genannten Arten (ohne Angabe: alle). */
export function summe(z: Record<string, ArtZahl>, arten?: string[]): ArtZahl {
  const s: ArtZahl = { gift: 0, giftErkannt: 0, harmlos: 0, harmlosAlarm: 0 };
  for (const [art, e] of Object.entries(z)) {
    if (arten && !arten.includes(art)) continue;
    s.gift += e.gift;
    s.giftErkannt += e.giftErkannt;
    s.harmlos += e.harmlos;
    s.harmlosAlarm += e.harmlosAlarm;
  }
  return s;
}
