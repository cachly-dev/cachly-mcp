/**
 * ══ Starter-Brains aus der Dauerernte ══════════════════════════════════════
 *
 * ── Wozu ─────────────────────────────────────────────────────────────────
 *
 * `brain_seed_starter` liefert heute 16 handkuratierte, stapelneutrale
 * Lektionen. Dieses Werkzeug baut aus der oeffentlichen Ernte dasselbe
 * Format — je SPRACHE oder GEBIET, mehrere hundert statt sechzehn.
 *
 * "Dein Brain startet nicht leer" ist ein anderes Produktversprechen als
 * "dein Brain merkt sich Dinge". Ein neuer Nutzer mit einer Flutter-App
 * bekommt die haeufigsten Flutter-Fallen, bevor er die erste eigene Lektion
 * geschrieben hat.
 *
 * ── Woher die Felder kommen ──────────────────────────────────────────────
 *
 * Ein Ernte-Paar ist Issue (Frage) und gemergter PR (Lektion):
 *
 *   what_worked  der PR-Text — was es WIRKLICH behoben hat
 *   what_failed  der Issue-Anfang — der Fehler, in den Worten eines
 *                Menschen, der ihn hatte (genau das, was eine Suche trifft)
 *   ctx          Projekt und Fundstelle, damit die Herkunft prueffbar bleibt
 *
 * ── Die Auslese, jede Stufe mit Grund ────────────────────────────────────
 *
 *   1. `pruefePaar` — dieselbe Regel wie beim Messen (keine zweite Wahrheit):
 *      duenne Fragen, duenne Lektionen und Abschriften fliegen.
 *   2. Mindestens 20 Inhaltswoerter in der Lektion. Gemessen am 24.08.2026
 *      (Naturworkshop 3, Immunologe): unter dieser Schwelle ist eine Lektion
 *      "closes #60408 plus drei Dateipfade" — kein Wissen, das man einem
 *      Kunden ins Brain legt.
 *   3. Dublettenschutz ueber den Textabdruck (Bot-PRs sehen ueberall gleich
 *      aus) — dieselbe Funktion wie beim Zusammenfuehren.
 *   4. Obergrenze JE PROJEKT, damit kein Repo das Paket uebernimmt.
 *
 * Die Ernte-Dateien sind bereits nach `bewertePaar` absteigend sortiert —
 * die Reihenfolge der Datei IST die Guete-Reihenfolge, hier wird nur
 * gefiltert, nicht neu geraten.
 *
 * Aufruf:
 *   npx tsx src/bench/starter-brain-bauen.ts \
 *     --ordner  ~/.cachly/bench-korpus \
 *     --liste   ~/.cachly/bench-korpus/repos.txt \
 *     --paket   sprache:Dart \
 *     --nach    ~/.cachly/bench-korpus/starter/dart.json \
 *     [--je 400] [--je-projekt 150]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inhaltsWoerter } from '../rangfolge.js';
import { pruefePaar } from './fremdernte.js';
import { abdruck } from './ernten-zusammenfuehren.js';
import { nachDemStreichen } from './schablone-streichen.js';

type Ernte = {
  lessons: Array<{ topic: string; what_worked: string }>;
  queries: Array<{ query: string; relevant: string[] }>;
};

export type StarterEintrag = {
  topic: string;
  outcome: 'success';
  what_worked: string;
  what_failed: string;
  ctx: string;
  tags: string[];
  confidence: number;
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Mindestzahl Inhaltswoerter — unter 20 ist eine Lektion kein Wissen. */
export const MIN_WOERTER = 20;

/**
 * Der Issue-Anfang als `what_failed` — auf Satzgrenze gekuerzt.
 *
 * Nicht mitten im Wort abschneiden: das Feld wird Menschen gezeigt. Und
 * nicht laenger als noetig: die Suche gewichtet den Anfang ohnehin am
 * staerksten, und der Rest steht im Quell-Issue.
 */
export function alsFehlerbild(frage: string, hoechstens = 400): string {
  const glatt = frage.replace(/\s+/g, ' ').trim();
  if (glatt.length <= hoechstens) return glatt;
  const schnitt = glatt.slice(0, hoechstens);
  const satzEnde = Math.max(schnitt.lastIndexOf('. '), schnitt.lastIndexOf('? '), schnitt.lastIndexOf('! '));
  return satzEnde > hoechstens * 0.4 ? schnitt.slice(0, satzEnde + 1) : `${schnitt.trimEnd()} …`;
}

/**
 * Welche Repos gehoeren zum Paket?
 *
 * `repos.txt` traegt je Zeile `owner/repo  sterne  issues  woher` — `woher`
 * ist die Schicht, ueber die die Liste das Projekt gefunden hat
 * (`sprache:Dart`, `gebiet:database`). Ein Paket sammelt alle Repos einer
 * Schicht; zusaetzlich darf `--repos a,b,c` eine Liste erzwingen.
 */
export function reposFuerPaket(listeText: string, paket: string): string[] {
  return listeText
    .split(/\r?\n/)
    .map((z) => z.trim())
    .filter((z) => z && !z.startsWith('#'))
    .map((z) => z.split('\t'))
    .filter((sp) => sp[3] === paket)
    .map((sp) => sp[0]);
}

/** Ein Ernte-Paar in einen Starter-Eintrag uebersetzen — oder null mit Grund. */
export function uebersetze(
  frage: string,
  lektion: { topic: string; what_worked: string },
  schicht: string,
): { eintrag: StarterEintrag } | { verworfen: string } {
  const hart = pruefePaar(frage, lektion.what_worked);
  if (hart) return { verworfen: hart };
  /*
   * Schablone streichen, BEVOR die Woerter gezaehlt werden (Karte
   * ee7pmtjujucs, gemessen 30.08.2026: 8 % der Paket-Lektionen begannen mit
   * PR-Schablone statt mit Wissen).
   *
   * Die Reihenfolge ist die Aussage: eine Lektion, die nur wegen ihrer
   * Checkliste ueber die Wortgrenze kam, faellt jetzt darunter — und genau
   * das soll sie.
   */
  const gestrichen = nachDemStreichen(lektion.what_worked);
  if ('verworfen' in gestrichen) return { verworfen: `Schablone: ${gestrichen.verworfen}` };
  const sauber = gestrichen.rest;
  const woerter = inhaltsWoerter(sauber).size;
  if (woerter < MIN_WOERTER) return { verworfen: `unter ${MIN_WOERTER} Inhaltswoertern` };

  const projekt = lektion.topic.split(':')[0] ?? 'oss';
  return {
    eintrag: {
      topic: lektion.topic,
      outcome: 'success',
      what_worked: sauber,
      what_failed: alsFehlerbild(frage),
      ctx: `Aus dem oeffentlichen Projekt ${projekt} (Issue mit gemergtem PR). `
        + 'Automatisch geerntet und ausgelesen — Herkunft im Themennamen.',
      tags: [schicht.replace(':', '-').toLowerCase(), projekt, 'oss-ernte'],
      /*
       * 0,7 und nicht 0,9 wie die Handkuration: die Paare sind maschinell
       * ausgelesen, nicht von einem Menschen geprueft. Die Zuversicht steigt
       * beim Nutzer durch Gebrauch — nicht durch unsere Behauptung.
       */
      confidence: 0.7,
    },
  };
}

async function main(): Promise<void> {
  const ordner = flag('ordner');
  const listePfad = flag('liste');
  const paket = flag('paket');
  const nach = flag('nach');
  if (!ordner || !nach || (!paket && !flag('repos'))) {
    console.error('NICHT GEBAUT: --ordner, --nach und (--paket sprache:X | --repos a,b) sind Pflicht.');
    process.exit(2);
  }
  const je = Number(flag('je') ?? '400');
  const jeProjekt = Number(flag('je-projekt') ?? '150');

  const repos = flag('repos')
    ? flag('repos')!.split(',').map((x) => x.trim())
    : reposFuerPaket(readFileSync(resolve(listePfad!), 'utf8'), paket!);
  if (repos.length === 0) {
    console.error(`NICHT GEBAUT: kein Repo in der Liste traegt "${paket}".`);
    process.exit(3);
  }

  const eintraege: StarterEintrag[] = [];
  const gesehen = new Set<string>();
  const gruende = new Map<string, number>();
  const proProjekt = new Map<string, number>();
  let fehlend = 0;

  for (const repo of repos) {
    const name = repo.split('/')[1]?.toLowerCase() ?? repo.toLowerCase();
    const datei = join(resolve(ordner), `ernte-${name}.json`);
    if (!existsSync(datei)) { fehlend++; continue; }
    const e = JSON.parse(readFileSync(datei, 'utf8')) as Ernte;

    for (let i = 0; i < e.queries.length && eintraege.length < je; i++) {
      const q = e.queries[i]; const l = e.lessons[i];
      if (!q || !l || q.relevant?.[0] !== l.topic) continue;
      const projekt = l.topic.split(':')[0] ?? name;
      if ((proProjekt.get(projekt) ?? 0) >= jeProjekt) continue;

      const erg = uebersetze(q.query, l, paket ?? 'oss');
      if ('verworfen' in erg) {
        gruende.set(erg.verworfen, (gruende.get(erg.verworfen) ?? 0) + 1);
        continue;
      }
      const schluessel = abdruck(l.what_worked);
      if (gesehen.has(schluessel)) { gruende.set('Dublette', (gruende.get('Dublette') ?? 0) + 1); continue; }
      gesehen.add(schluessel);
      proProjekt.set(projekt, (proProjekt.get(projekt) ?? 0) + 1);
      eintraege.push(erg.eintrag);
    }
  }

  if (eintraege.length < 50) {
    // Ein Paket unter 50 Lektionen ist kein Starter-Brain, sondern eine
    // Behauptung. Lieber laut scheitern als duenn ausliefern.
    console.error(`⛔ NICHT GESCHRIEBEN: nur ${eintraege.length} Eintraege (Mindestmass 50).`);
    console.error(`   ${fehlend} von ${repos.length} Repos ohne Ernte-Datei — erst ernten, dann packen.`);
    process.exit(4);
  }

  mkdirSync(dirname(resolve(nach)), { recursive: true });
  writeFileSync(resolve(nach), JSON.stringify({
    name: paket ?? 'eigene-auswahl',
    gebaut: 'aus oeffentlichen GitHub-Ernten (Issue + gemergter PR), maschinell ausgelesen',
    hinweis: 'Format wie STARTER_CORPUS (starter-corpus.ts). Auslese: pruefePaar, '
      + `mindestens ${MIN_WOERTER} Inhaltswoerter, Dublettenschutz, hoechstens ${jeProjekt} je Projekt.`,
    lessons: eintraege,
  }, null, 1));

  console.log('');
  console.log(`📦  ${paket ?? flag('repos')} — ${eintraege.length} Lektionen aus ${proProjekt.size} Projekten`);
  for (const [p, n] of [...proProjekt].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${p}`);
  if (gruende.size) {
    console.log(`    verworfen: ${[...gruende].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${n} ${g}`).join(' · ')}`);
  }
  if (fehlend) console.log(`    ⚠️  ${fehlend} von ${repos.length} Repos noch ohne Ernte — das Paket waechst mit der Maschine.`);
  console.log(`    geschrieben nach ${nach}`);
}

// Nur laufen, wenn DIREKT aufgerufen — ein Import darf nie main() starten.
if (process.argv[1]?.includes('starter-brain-bauen')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
