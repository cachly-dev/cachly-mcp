/**
 * Rueckfall-Hinweis — nach einer geloesten Aufgabe sagen, was oft wiederkommt.
 *
 * ── Woher das Wissen kommt (08.11.2026) ─────────────────────────────────────
 *
 * Gemessen an 289 Open-Source-Projekten in drei unabhaengigen Datensaetzen
 * (geschlossene Issues mit gemergtem PR, mit Datum): Nach einer Reparatur kam
 * an DENSELBEN Dateien innerhalb von 90 Tagen haeufiger wieder dieselbe ART
 * Problem als ein beliebiges Issue desselben Projekts. Belegt nur fuer
 * Zeit/Datum (4,4-fach) und Abhaengigkeiten (2,3-fach). Upload/Download hielt
 * auf zwei Datensaetzen, fiel auf dem dritten aber auf 1,6 und ist seit
 * 0.10.234 draussen. Die Idee "nach X kommt meistens Y" trug nicht — sie wird
 * hier bewusst nicht gezeigt.
 * Befund und Messung: forge-foundry .agent/cachly/BEFUND-was-kam-danach-*.md.
 *
 * ── Was das NICHT ist ───────────────────────────────────────────────────────
 *
 * Keine Vorhersage fuer dieses Projekt. Der Satz nennt gezaehlte Zahlen aus
 * fremden Projekten und einen Test, der sich lohnt. Kein Netzaufruf, keine
 * Daten verlassen den Rechner; der Erkenner ist eine Handvoll Muster.
 */
import { RUECKFALL } from './rueckfall-daten.js';

type Beispiel = { repo: string; issue: number; folge_issue: number; tage: number; datei: string };
type Zahl = {
  name: string;
  projekte: number;
  fenster_tage: number;
  folgen: number;
  wiederkehr: number;
  zufall_quote: number;
  faktor: number;
  rat: string;
  beispiel: Beispiel;
};

const MUSTER: ReadonlyArray<readonly [string, RegExp]> = Object.entries(RUECKFALL.arten).map(
  ([art, quelle]) => [art, new RegExp(quelle, 'gi')] as const,
);
const ZAHLEN: Readonly<Record<string, Zahl>> = RUECKFALL.zahlen as unknown as Record<string, Zahl>;

/**
 * Art eines Textes: die Art mit den meisten Treffern in den ersten 600
 * Zeichen, bei Gleichstand die frueher genannte, ohne Treffer 'sonstiges'.
 * Genau die Regel der Messung (was_kam_danach.py, klasse()).
 */
export function artVon(text: string): string {
  const t = text.slice(0, 600);
  let beste = 'sonstiges';
  let meist = 0;
  for (const [art, muster] of MUSTER) {
    const n = t.match(muster)?.length ?? 0;
    if (n > meist) {
      meist = n;
      beste = art;
    }
  }
  return beste;
}

/** Ein bis zwei Zeilen fuer die Antwort von learn_from_attempts, sonst ''. */
export function rueckfallHinweis(l: {
  outcome: string;
  topic: string;
  what_worked: string;
  what_failed?: string | null;
  file_paths?: readonly string[];
}): string {
  if (l.outcome !== 'success') return '';
  const z = ZAHLEN[artVon([l.topic, l.what_failed ?? '', l.what_worked].join('\n'))];
  if (!z) return '';
  const prozent = Math.round((100 * z.wiederkehr) / z.folgen);
  const datei = l.file_paths?.[0];
  const b = z.beispiel;
  const quelle = `https://github.com/${b.repo}/issues`;
  return [
    `🔁 **Relapse watch (${z.name}):** across ${z.projekte} open-source projects, ${z.wiederkehr} of ${z.folgen} ${z.name} fixes (${prozent} %) were followed within ${z.fenster_tage} days by another ${z.name} problem in the same files — ${z.faktor.toFixed(1)}× as often as a random issue in the same project. ${z.rat}${datei ? ` Same files here: \`${datei}\`.` : ''}`,
    `   Example: ${quelle}/${b.issue} → ${quelle}/${b.folge_issue} (${b.tage} days later, same file \`${b.datei}\`).`,
  ].join('\n');
}
