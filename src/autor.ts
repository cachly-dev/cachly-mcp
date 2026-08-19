import { execSync } from 'node:child_process';

/**
 * Wer hat diese Lektion geschrieben?
 *
 * ── Der Befund, gemessen am 19.08.2026 ──────────────────────────────────────
 *
 * 195 von 493 Lektionen tragen keinen Autor — zwei Fuenftel. Ohne Autor zaehlt
 * keine Team-Wiederverwendung, brain_who_knows findet niemanden, und das
 * Versprechen "geteiltes Gedaechtnis" ist von einer Notizdatei nicht zu
 * unterscheiden.
 *
 * ── Und es war unser Fehler, nicht der der Nutzer ───────────────────────────
 *
 * Heinrich, 19.08.2026: "das mit dem Autor war doch eher ein Fehler von uns
 * bzw. wie cachly die Anweisungen fuer das Brain geschrieben hat, denn der
 * Autor steht doch in den Git-Zugangsdaten."
 *
 * Genau so ist es. `author` war ein OPTIONALES Feld, das ein Agent bei jedem
 * Aufruf mitschicken sollte — und natuerlich vergisst. Dabei steht der Name
 * seit jeher zwei Zeilen entfernt in `git config user.name`. Der Code holte
 * ihn sogar schon, aber nur an einer anderen Stelle (index.ts, fuer die
 * Demo-Ausgabe) und nie fuer die Lektion selbst.
 *
 * Ein Pflichtfeld, das man vergessen kann, ist kein Pflichtfeld. Ein Wert, der
 * sich herleiten laesst, gehoert hergeleitet.
 *
 * ── Reihenfolge, absichtlich in dieser Richtung ─────────────────────────────
 *
 *   1. was ausdruecklich uebergeben wurde  — der Aufrufer weiss es besser
 *   2. CACHLY_AUTHOR                        — bewusst gesetzt, etwa in der CI
 *   3. git config user.name                 — der angemeldete Mensch
 *   4. git config user.email (Teil vor dem @)
 *   5. leer — dann steht dort ehrlich nichts statt eines geratenen Namens
 *
 * Schritt 5 ist wichtig: lieber kein Autor als ein falscher. Ein erfundener
 * Name macht aus einer fehlenden Zuordnung eine falsche, und die faellt
 * niemandem mehr auf.
 */

/** Ein Git-Wert, oder leer. Wirft nie — Git kann fehlen, das ist kein Fehler. */
export type GitLeser = (schluessel: string) => string;

export const echterGitLeser =
  (cwd?: string): GitLeser =>
    (schluessel) => {
      try {
        return execSync(`git config ${schluessel}`, {
          cwd,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 1500,
        }).trim();
      } catch {
        return '';
      }
    };

/**
 * Einen Namen auf die Form bringen, in der Autoren gespeichert werden.
 *
 * Klein geschrieben und ohne Leerzeichen: "Heinrich Neb" wird zu "heinrich".
 * Das ist keine Kosmetik — brain_who_knows, team_recall und die
 * Wiederverwendungs-Zaehlung vergleichen Autoren als Zeichenketten. "Heinrich"
 * und "heinrich" waeren zwei Menschen.
 */
export function normalisiere(roh: string): string {
  const t = (roh ?? '').trim();
  if (!t) return '';
  // Nur der Rufname: Nachnamen aendern sich (Heirat), Rufnamen selten. Und
  // ein Nachname im Autorenfeld ist eine Personendatei mehr, die niemand
  // gebeten hat anzulegen.
  const erster = t.split(/[\s.]+/)[0] ?? '';
  return erster
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

export interface AutorHerkunft {
  /** Der ermittelte Name, oder leer. */
  autor: string;
  /** Woher er kam — steht im Hinweis an den Aufrufer. */
  quelle: 'uebergeben' | 'umgebung' | 'git-name' | 'git-mail' | 'anonym' | 'unbekannt';
}

/**
 * Ausdrueckliche Wortmeldung "ohne meinen Namen".
 *
 * Ohne diesen Weg gaebe es keinen mehr: seit der Name aus git hergeleitet
 * wird, bekaeme JEDE Lektion einen Autor, auch die, bei der der Mensch das
 * nicht will. Eine private Notiz ueber einen Kunden, ein Fund, den man nicht
 * an sich haengen will — das muss weiterhin gehen, und zwar sichtbar statt
 * durch Weglassen.
 *
 * Der Test, der beim Umbau rot wurde, hat genau diese Luecke gezeigt: er
 * speicherte eine Lektion ohne Autor und erwartete, dass skill_gaps sie
 * anmeckert. Das ging vorher versehentlich, jetzt geht es absichtlich.
 */
const ANONYM = new Set(['-', 'anonym', 'anonymous', 'none', 'kein', 'off']);

export function ermittleAutor(input: {
  uebergeben?: string;
  umgebung?: string;
  git: GitLeser;
}): AutorHerkunft {
  const rohUeb = (input.uebergeben ?? '').trim().toLowerCase();
  if (ANONYM.has(rohUeb)) return { autor: '', quelle: 'anonym' };
  const rohEnv = (input.umgebung ?? '').trim().toLowerCase();
  if (ANONYM.has(rohEnv)) return { autor: '', quelle: 'anonym' };

  const ueb = normalisiere(input.uebergeben ?? '');
  if (ueb) return { autor: ueb, quelle: 'uebergeben' };

  const env = normalisiere(input.umgebung ?? '');
  if (env) return { autor: env, quelle: 'umgebung' };

  const name = normalisiere(input.git('user.name'));
  if (name) return { autor: name, quelle: 'git-name' };

  const mail = input.git('user.email');
  const vorDemAt = normalisiere((mail ?? '').split('@')[0] ?? '');
  if (vorDemAt) return { autor: vorDemAt, quelle: 'git-mail' };

  return { autor: '', quelle: 'unbekannt' };
}

/**
 * Der Mitautor — standardmaessig AUS.
 *
 * Heinrich: "Wir koennen im gleichen Zuge ja auch zum Beispiel claude als
 * Co-Author nehmen, wenn der User das moechte? Einstellungssache,
 * standardmaessig aber aus."
 *
 * Aus zwei Gruenden aus: erstens gehoert die Entscheidung dem Menschen, und
 * zweitens wuerde ein automatisch gesetzter Mitautor die Zahl, um die es hier
 * geht — wie viele Lektionen einen MENSCHEN als Autor haben — sofort wieder
 * unbrauchbar machen.
 *
 * Eingeschaltet wird er mit
 *   brain_set_pref(key="coauthor", value="claude")
 * und wieder aus mit value="" oder "off".
 */
export const COAUTHOR_PREF_KEY = 'coauthor';

/** Aus dem gespeicherten Wert den Mitautor lesen — leer heisst aus. */
export function coautorAus(prefWert: string | null | undefined): string {
  const t = (prefWert ?? '').trim().toLowerCase();
  if (!t || t === 'off' || t === 'false' || t === '0' || t === 'none') return '';
  return normalisiere(t);
}

/**
 * Wie der Autor gespeichert wird, wenn ein Mitautor eingeschaltet ist.
 *
 * "heinrich+claude" — ein Feld, kein zweites. Ein zweites Feld haette jede
 * Abfrage im ganzen Haus anfassen muessen (who_knows, team_recall,
 * reuse_pairs, das Briefing), und die Zahl "wie viele Lektionen haben einen
 * Autor" waere dabei zweideutig geworden.
 *
 * Der Mensch steht VORN. Wer die Zeichenkette an "+" trennt, bekommt zuerst
 * den, der die Entscheidung getroffen hat.
 */
export function mitCoautor(autor: string, coautor: string): string {
  if (!autor) return '';
  if (!coautor || coautor === autor) return autor;
  return `${autor}+${coautor}`;
}

/** Nur der Mensch, ohne Mitautor — fuer Zaehlungen und Vergleiche. */
export function nurMensch(autorFeld: string): string {
  return (autorFeld ?? '').split('+')[0] ?? '';
}

/**
 * Ein Satz an den Aufrufer, wenn kein Autor ermittelt werden konnte.
 *
 * Wieder ein HINWEIS und keine Ablehnung: eine abgelehnte Lektion ist immer
 * schlechter als eine ohne Autor. Aber schweigen waere falsch — genau das
 * Schweigen hat die 195 erzeugt.
 */
export function autorHinweis(h: AutorHerkunft): string | null {
  if (h.autor) return null;
  // Wer ausdruecklich anonym speichert, bekommt keine Belehrung.
  if (h.quelle === 'anonym') return null;
  return (
    `👤 **Kein Autor ermittelt** — weder \`author\`, noch \`CACHLY_AUTHOR\`, noch \`git config user.name\`. ` +
    `Ohne Autor zählt diese Lektion nicht als Team-Wissen: \`brain_who_knows\` findet niemanden und ` +
    `Wiederverwendung über Personengrenzen bleibt ungezählt. Ein \`git config user.name "Vorname"\` ` +
    `im Projekt genügt für alle künftigen Lektionen.`
  );
}
