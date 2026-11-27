/**
 * Schluessel-Klassen: wer in welche Familie `cachly:<x>:` schreiben darf
 * (Stufe 2, Vorhaben A, Bauplan A4, 27.11.2026).
 *
 * Ein Team-Mitglied meldet sich seit Stufe 2 mit einem eigenen Benutzer am
 * Speicher an. Die API setzt fuer diesen Benutzer EIN ACL-Muster
 * (api/internal/brainzugang/acl.go). Es erlaubt Lesen ueberall und Schreiben
 * ueberall ausser in zwei Klassen:
 *
 *   S  Team-Daten (Rollen, Freigabepflicht, Gruppen, Protokoll)   nie
 *   W  Wissen (Lektionen, Vektoren, Graph, Index, Rueckzuege ...)  nie direkt,
 *                                                                  Lektionen ueber die API
 *   B  Betrieb (Kontext, Sitzung, Zaehler, Zwischenspeicher)       ja
 *
 * Diese Datei haelt zwei Dinge, die zusammenpassen muessen:
 *   - die Tabelle: jede Familie, die der Quelltext benutzt, mit Klasse;
 *   - das Muster, wortgleich aus acl.go, und eine Auswertung davon in TS.
 *
 * Der Waechter src/__tests__/schluessel-klassen.test.ts liest den Quelltext
 * und verlangt fuer jede Familie eine Klasse. Er prueft ausserdem: jede
 * B-Familie ist nach dem Muster wirklich schreibbar, jede S- und W-Familie
 * nicht. Sonst stuende in der Tabelle eine zweite Wahrheit.
 *
 * Eine neue Familie mit t, l, c, i, w, g, f, b, m, p, d oder z am Anfang ist
 * fuer Mitglieder gesperrt, bis sie im Muster steht (`letzter-recall` und
 * `liefer` stehen dort einzeln und sind darum B).
 */

import { mitgliedMuster } from './raeume.js';

export type SchluesselKlasse = 'S' | 'W' | 'B';

/** Jede Familie `cachly:<x>:` im Quelltext, mit Klasse. Was fehlt, ist ein Fehler. */
export const SCHLUESSEL_KLASSEN: Readonly<Record<string, SchluesselKlasse>> =
  Object.freeze({
    // ── S: Team-Daten ──────────────────────────────────────────────────────
    team: 'S',

    // ── W: Wissen (Bauplan A4, wortgleich) ─────────────────────────────────
    lesson: 'W',
    lessons: 'W',
    ckg: 'W',
    crystal: 'W',
    contradictions: 'W',
    idx: 'W',
    index: 'W',
    withdrawn: 'W',
    global: 'W',
    fedbrain: 'W',
    fed: 'W',
    brain: 'W',
    brain_from_git: 'W',
    meta: 'W',
    public: 'W',
    doppel: 'W',
    // Raeume (Stufe 3): vom Muster fuer das Schreiben gesperrt, Lesen nur im eigenen Raum.
    zone: 'W',

    // ── B: Betrieb ─────────────────────────────────────────────────────────
    // im Muster einzeln freigegeben (gesperrter Anfangsbuchstabe):
    ctx: 'B',
    cls: 'B',
    wirkung: 'B',
    lock: 'B',
    mcp: 'B',
    mcm: 'B',
    prefs: 'B',
    dep: 'B',
    'letzter-recall': 'B',
    liefer: 'B',
    // frei ueber ~cachly:[^tlciwgfbmpdz]*:
    session: 'B',
    stats: 'B',
    sem: 'B',
    roadmap: 'B',
    recall: 'B',
    streak: 'B',
    agents: 'B',
    stream: 'B',
    vek: 'B',
    startwissen: 'B',
    versuch: 'B',
    quota: 'B',
    aussetzer: 'B',
  });

/**
 * Der feste Teil des ACL-Musters eines Mitglieds: Lesen fest, Schreiben,
 * Befehle, ohne "on", Passwort und Raum-Regeln. WORTGLEICH mit den Feldern
 * MITGLIED_LESEN_FEST, MITGLIED_SCHREIBEN und MITGLIED_BEFEHLE in
 * api/internal/raeume/testdata/abnahme-raeume-acl.sh (gegen Valkey 8 und
 * Dragonfly 1.25.0 gemessen). Raum-Regeln sind reine Lese-Regeln.
 */
export const MITGLIED_MUSTER: readonly string[] = Object.freeze(
  mitgliedMuster({ gruppen: [] }),
);

/** Ein Glob des Speichers (`*`, `?`, `[...]`, `[^...]`) als regulaerer Ausdruck. */
export function globAlsRegex(glob: string): RegExp {
  let aus = '';
  for (let i = 0; i < glob.length; i++) {
    const z = glob[i];
    if (z === '*') aus += '[\\s\\S]*';
    else if (z === '?') aus += '[\\s\\S]';
    else if (z === '[') {
      const ende = glob.indexOf(']', i + 1);
      if (ende === -1) {
        aus += '\\[';
        continue;
      }
      let innen = glob.slice(i + 1, ende);
      const nicht = innen.startsWith('^');
      if (nicht) innen = innen.slice(1);
      aus += `[${nicht ? '^' : ''}${innen.replace(/[\\\]]/g, '\\$&')}]`;
      i = ende;
    } else if (z === '\\' && i + 1 < glob.length) {
      aus += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else {
      aus += z.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${aus}$`);
}

const SCHREIB_MUSTER: readonly RegExp[] = MITGLIED_MUSTER.filter((r) =>
  r.startsWith('~'),
).map((r) => globAlsRegex(r.slice(1)));

/**
 * Darf ein Mitglied diesen Schluessel schreiben? Dieselbe Antwort, die der
 * Speicher mit dem Muster gibt (Lesen darf es ohnehin alles).
 */
export function mitgliedDarfSchreiben(schluessel: string): boolean {
  return SCHREIB_MUSTER.some((r) => r.test(schluessel));
}

/** Die Familie eines Schluessels `cachly:<x>:...`, sonst ''. */
export function familieVon(schluessel: string): string {
  const m = /^cachly:([A-Za-z0-9_-]+)/.exec(schluessel);
  return m ? m[1] : '';
}

/** Die Klasse eines Schluessels; Schluessel ausserhalb von `cachly:` sind Betrieb. */
export function klasseVon(schluessel: string): SchluesselKlasse | undefined {
  if (!schluessel.startsWith('cachly:')) return 'B';
  return SCHLUESSEL_KLASSEN[familieVon(schluessel)];
}
