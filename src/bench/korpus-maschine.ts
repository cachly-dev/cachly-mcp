/**
 * ══ Die Erntemaschine: ein Durchgang ══════════════════════════════════════
 *
 * ── Wozu ─────────────────────────────────────────────────────────────────
 *
 * Heinrich, 24.08.2026: "Wir haben die letzten zwei Tage sehr viel mit Daten
 * sammeln und warten verbracht, anstatt mit der eigentlichen Arbeit."
 *
 * Das stimmt. Ernten ist billige Arbeit — sie besteht aus Warten auf GitHub.
 * Sie gehoert auf einen Server, nicht in eine Sitzung.
 *
 * Dieses Programm macht EINEN Durchgang: es nimmt das naechste faellige
 * Projekt, erntet es und schreibt auf, was dabei herauskam. Ein Dienst ruft
 * es immer wieder auf. Kein Zustand lebt im Arbeitsspeicher; ein Absturz
 * kostet hoechstens einen Durchgang.
 *
 * ── Von zwei Seiten (Heinrichs Vorschlag) ────────────────────────────────
 *
 * `--richtung vorne` nimmt das erste faellige Projekt der Liste,
 * `--richtung hinten` das letzte. Zwei Maschinen laufen aufeinander zu und
 * sind fertig, wenn sie sich treffen.
 *
 * Das braucht keine Absprache und keine Sperre: die Zustandsdatei liegt je
 * Maschine getrennt, und ein doppelt geerntetes Projekt in der Mitte kostet
 * eine Ernte, nicht die Richtigkeit.
 *
 * ── Warum die Zustandsdatei wichtiger ist als die Liste ──────────────────
 *
 * Vier von neunzehn Projekten der zweiten Welle lieferten NICHTS, und zwar
 * aus einem guten Grund: apache/spark und apache/kafka fuehren ihre Vorgaenge
 * in JIRA, mysql in Oracles Fehlerdatenbank. Dort gibt es die Verknuepfung
 * "Issue -> gemergter PR" schlicht nicht.
 *
 * Ohne Gedaechtnis fragt die Maschine sie jede Nacht neu und verbrennt
 * Kontingent. Deshalb merkt sie sich nicht nur "erledigt", sondern WARUM:
 *
 *   fertig          Paare geerntet, Datei liegt
 *   leer            gesehen, aber keine Paare — NIE wieder versuchen
 *   spaeter         Netz, Kontingent, Ueberlastung — spaeter noch einmal
 *   kaputt          zu oft "spaeter" gewesen — aufgeben und melden
 *
 * Der Unterschied zwischen "leer" und "spaeter" ist der ganze Trick. Wer ihn
 * nicht macht, hat entweder eine Maschine, die tote Projekte ewig anfasst,
 * oder eine, die nach einem Netzhaenger ein gutes Projekt fuer immer
 * abschreibt.
 *
 * ── Was VOR jedem Durchgang geprueft wird ────────────────────────────────
 *
 * Der Platz. Am 26.07.2026 lief die Platte eines Servers mitten im Bauen
 * voll; der Runner konnte danach nicht einmal mehr sein eigenes Protokoll
 * schreiben und stand eine halbe Stunde als "laeuft" da, obwohl er tot war.
 *
 * Diese Maschine laeuft auf demselben Node wie CI-Runner. Sie bricht ab,
 * bevor sie jemand anderen mitreisst.
 *
 * Aufruf:
 *   GH_TOKEN=… npx tsx src/bench/korpus-maschine.ts \
 *     --liste repos.txt --ordner /pfad/ernten [--richtung vorne|hinten]
 */

import {
  existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export type Ausgang = 'fertig' | 'leer' | 'spaeter' | 'kaputt';

export type Eintrag = {
  ausgang: Ausgang;
  paare?: number;
  versuche: number;
  zuletzt: string;
  grund?: string;
};

export type Zustand = Record<string, Eintrag>;

/** So oft darf ein Projekt "spaeter" sein, bevor es als kaputt gilt. */
export const VERSUCHE_MAX = 5;

/** Unter so viel freiem Platz wird nicht mehr geerntet. */
export const MIN_FREI_GB = 3;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Die Projektnamen aus der Liste — ohne Kommentare, ohne Zusatzspalten.
 *
 * Die Liste traegt Sterne und Issue-Zahlen mit; hier zaehlt nur der Name.
 * Sie wird bewusst NICHT nach Groesse sortiert: die Reihenfolge der Datei
 * ist die Reihenfolge der Ernte, und nur so bedeutet "von vorne" und "von
 * hinten" etwas Verlaessliches.
 */
export function projekteAusListe(inhalt: string): string[] {
  return inhalt
    .split(/\r?\n/)
    .map((z) => z.trim())
    .filter((z) => z && !z.startsWith('#'))
    .map((z) => z.split('\t')[0])
    .filter((z) => /^[^/\s]+\/[^/\s]+$/.test(z));
}

/**
 * Ist dieses Projekt jetzt dran?
 *
 * "leer" und "kaputt" sind endgueltig. "fertig" auch — eine zweite Ernte
 * desselben Projekts liefert dieselben Paare und kostet nur Kontingent.
 */
export function istFaellig(e: Eintrag | undefined): boolean {
  if (!e) return true;
  return e.ausgang === 'spaeter' && e.versuche < VERSUCHE_MAX;
}

/**
 * Das naechste faellige Projekt — von vorne oder von hinten.
 *
 * Gibt `null` zurueck, wenn nichts mehr offen ist. Das ist KEIN Fehler,
 * sondern das Ziel: die beiden Maschinen haben sich getroffen.
 */
export function naechstes(
  projekte: readonly string[],
  zustand: Zustand,
  richtung: 'vorne' | 'hinten',
): string | null {
  const reihe = richtung === 'vorne' ? projekte : [...projekte].reverse();
  const offen = reihe.filter((p) => istFaellig(zustand[p]));
  if (offen.length === 0) return null;

  /*
   * ── Wer schon gescheitert ist, kommt nach hinten ────────────────────────
   *
   * Der erste Entwurf nahm einfach das erste faellige Projekt. Gemessen am
   * 24.08.2026 auf node-3: `public-apis/public-apis` scheiterte, und der
   * naechste Durchgang nahm GENAU DASSELBE Projekt wieder. Die Maschine
   * haette fuenf Durchgaenge gebraucht, um an einem einzigen kaputten
   * Eintrag vorbeizukommen — und bei einem laengeren Ausfall von GitHub
   * stuende sie stundenlang auf Projekt eins.
   *
   * Jetzt zaehlt zuerst, wie oft ein Projekt schon versucht wurde. Alles
   * Unversuchte kommt vor jedem Wiederholungsfall. Ein voruebergehend
   * gestoertes Projekt wird trotzdem nicht vergessen — es ist nur zuletzt
   * dran, und das ist genau richtig.
   *
   * Die Reihenfolge innerhalb derselben Versuchszahl bleibt die der Liste.
   * Nur so bedeuten "von vorne" und "von hinten" noch etwas.
   */
  let besterWert = Infinity;
  let bester: string | null = null;
  for (const p of offen) {
    const n = zustand[p]?.versuche ?? 0;
    if (n < besterWert) {
      besterWert = n;
      bester = p;
      if (n === 0) break; // besser wird es nicht
    }
  }
  return bester;
}

/** Freier Platz in GB auf dem Dateisystem eines Pfades. */
export function freiGb(pfad: string): number {
  const s = statfsSync(pfad);
  return (s.bavail * s.bsize) / 1024 ** 3;
}

/**
 * Die Zustandsdatei schreiben — erst daneben, dann umbenennen.
 *
 * Ein Absturz mitten im Schreiben wuerde sonst eine halbe JSON-Datei
 * hinterlassen, und der naechste Durchgang faende gar keinen Zustand mehr
 * vor: er wuerde ALLES neu ernten. Umbenennen ist auf einem Dateisystem
 * unteilbar.
 */
export function zustandSchreiben(pfad: string, z: Zustand): void {
  const temp = `${pfad}.neu`;
  writeFileSync(temp, JSON.stringify(z, null, 1), 'utf8');
  renameSync(temp, pfad);
}

/** Was die Ernte gemeldet hat, in eine der vier Klassen uebersetzen. */
export function ausgangAusCode(
  code: number,
  ausgabe: string,
  paareGeschrieben = 0,
): { ausgang: Ausgang; grund: string } {
  /*
   * ── Das ERGEBNIS schlaegt den Rueckgabecode ────────────────────────────
   *
   * Gemessen am 24.08.2026 auf node-4: `inducer/pycuda` wurde als "spaeter"
   * gebucht. Die Ernte war aber ERFOLGREICH — 7 Paare geschrieben. Sie endet
   * nur mit einem Warncode, weil unter 30 Paaren "keine Aussage" traegt.
   *
   * Liegen Paare in der Datei, ist der Lauf fertig. Punkt. Alles andere
   * hiesse: die Maschine wirft eigene Arbeit weg, weil ein Warnhinweis
   * anders aussieht als erwartet.
   */
  if (paareGeschrieben > 0) return { ausgang: 'fertig', grund: '' };
  if (code === 0) return { ausgang: 'fertig', grund: '' };
  // Code 4 setzt fremdernte.ts, wenn Issues gesehen wurden, aber kein Paar
  // dabei war. Das ist eine Eigenschaft des Projekts, keine Stoerung.
  if (code === 4) return { ausgang: 'leer', grund: 'gesehen, aber kein einziges Paar' };
  if (/Kontingent leer/i.test(ausgabe)) return { ausgang: 'spaeter', grund: 'Kontingent leer' };
  if (/zu schwer/i.test(ausgabe)) return { ausgang: 'spaeter', grund: 'GitHub brach ab (zu schwer)' };
  /*
   * ── Die Zahl muss an ihrer STELLE stehen ───────────────────────────────
   *
   * Der erste Entwurf suchte `50[024]` irgendwo im Text. Getroffen hat er
   * die Kontingent-Zeile:
   *
   *     Kosten: 2 Punkte · 4258 von 5000 uebrig
   *                                 ^^^^
   *
   * Ein erfolgreicher Lauf wurde damit als Serverfehler gebucht. Deshalb
   * jetzt nur an der Stelle, an der `fremdernte` einen Status wirklich
   * meldet: hinter "GraphQL: " oder "HTTP ".
   */
  if (/fetch failed|ETIMEDOUT|ECONNRESET|(GraphQL:|HTTP) 50[024]\b/i.test(ausgabe)) {
    return { ausgang: 'spaeter', grund: 'Netz oder Server' };
  }
  if (/(GraphQL:|HTTP) 40[134]\b/.test(ausgabe)) {
    return { ausgang: 'leer', grund: 'nicht zugaenglich' };
  }
  return { ausgang: 'spaeter', grund: ausgabe.split('\n').pop()?.slice(0, 80) ?? `Code ${code}` };
}

async function main(): Promise<void> {
  const listePfad = flag('liste');
  const ordner = flag('ordner');
  const richtung = (flag('richtung') ?? 'vorne') as 'vorne' | 'hinten';
  if (!listePfad || !ordner) {
    console.error('NICHT GELAUFEN: --liste <repos.txt> und --ordner <pfad> sind Pflicht.');
    process.exit(2);
  }
  if (richtung !== 'vorne' && richtung !== 'hinten') {
    console.error(`NICHT GELAUFEN: --richtung "${richtung}" — erlaubt sind vorne und hinten.`);
    process.exit(2);
  }

  const ziel = resolve(ordner);
  if (!existsSync(ziel)) mkdirSync(ziel, { recursive: true });

  const frei = freiGb(ziel);
  if (frei < MIN_FREI_GB) {
    // Laut abbrechen, bevor jemand anderes mitgerissen wird.
    console.error(`⛔ NICHT GEERNTET: nur ${frei.toFixed(1)} GB frei (Grenze ${MIN_FREI_GB}).`);
    console.error('   Auf diesem Node laufen CI-Runner. Eine volle Platte kostet Deploys.');
    process.exit(7);
  }

  const zustandPfad = join(ziel, `zustand-${richtung}.json`);
  const zustand: Zustand = existsSync(zustandPfad)
    ? JSON.parse(readFileSync(zustandPfad, 'utf8')) as Zustand
    : {};

  const projekte = projekteAusListe(readFileSync(resolve(listePfad), 'utf8'));
  if (projekte.length === 0) {
    console.error('⛔ NICHT GEERNTET: die Liste enthaelt kein einziges Projekt.');
    process.exit(3);
  }

  const dran = naechstes(projekte, zustand, richtung);
  if (!dran) {
    const fertig = Object.values(zustand).filter((e) => e.ausgang === 'fertig').length;
    const leer = Object.values(zustand).filter((e) => e.ausgang === 'leer').length;
    const kaputt = Object.values(zustand).filter((e) => e.ausgang === 'kaputt').length;
    console.log(`✅ Nichts mehr offen (${richtung}). ${fertig} geerntet · ${leer} ohne Paare · ${kaputt} aufgegeben.`);
    return;
  }

  const name = dran.split('/')[1].toLowerCase();
  const datei = join(ziel, `ernte-${name}.json`);
  const vorher = zustand[dran]?.versuche ?? 0;

  console.log(`[${new Date().toISOString().slice(0, 19)}] ${richtung} · ${dran} (Versuch ${vorher + 1}) · ${frei.toFixed(1)} GB frei`);

  /*
   * ── Der Ernter als eigener Prozess, mit einstellbarem Pfad ──────────────
   *
   * Als Unterprozess und nicht als Aufruf im selben Programm: `fremdernte`
   * beendet sich bei manchen Faellen selbst (process.exit). Im selben Prozess
   * risse das die Maschine mit, und der Zustand waere nie geschrieben. Die
   * Zeitgrenze von 30 Minuten braucht ohnehin einen eigenen Prozess.
   *
   * Der Pfad ist einstellbar, weil er von der Auslieferung abhaengt: in der
   * Entwicklung liegt `fremdernte.ts` daneben, auf dem Server eine
   * gebuendelte `fremdernte.mjs`. Ein aus `import.meta.url` erratener Pfad
   * ging nach dem Buendeln ins Leere — und die Ernte haette jedes Projekt
   * als "spaeter" gemeldet, ohne dass jemand den Grund gesehen haette.
   */
  const eigeneEndung = import.meta.url.endsWith('.mjs') ? '.mjs' : '.ts';
  const ernter = flag('ernter')
    ?? resolve(new URL(`./fremdernte${eigeneEndung}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  if (!existsSync(ernter)) {
    console.error(`⛔ NICHT GEERNTET: der Ernter liegt nicht unter ${ernter}.`);
    console.error('   Mit --ernter <pfad> angeben. Ohne ihn waere jedes Projekt "spaeter",');
    console.error('   und niemand saehe, dass gar nichts geerntet wurde.');
    process.exit(8);
  }

  const { spawnSync } = await import('node:child_process');
  const lauf = spawnSync(process.execPath, [
    ...process.execArgv,
    ernter,
    '--repo', dran, '--anzahl', flag('anzahl') ?? '500', '--nach', datei,
  ], { encoding: 'utf8', env: process.env, timeout: 30 * 60_000 });

  const ausgabe = `${lauf.stdout ?? ''}\n${lauf.stderr ?? ''}`;
  /*
   * Erst NACHSEHEN, was in der Datei liegt — dann urteilen. Der Rueckgabecode
   * allein hat am 24.08.2026 eine erfolgreiche Ernte (7 Paare) als Stoerung
   * gebucht, weil `fremdernte` bei wenigen Paaren warnt.
   */
  let paare = 0;
  if (existsSync(datei)) {
    try {
      paare = (JSON.parse(readFileSync(datei, 'utf8')) as { queries?: unknown[] }).queries?.length ?? 0;
    } catch { paare = 0; }
  }

  const { ausgang, grund } = ausgangAusCode(lauf.status ?? 1, ausgabe, paare);

  const versuche = vorher + 1;
  const endgueltig: Ausgang = ausgang === 'spaeter' && versuche >= VERSUCHE_MAX ? 'kaputt' : ausgang;

  zustand[dran] = {
    ausgang: endgueltig,
    ...(paare ? { paare } : {}),
    versuche,
    zuletzt: new Date().toISOString(),
    ...(grund ? { grund } : {}),
  };
  zustandSchreiben(zustandPfad, zustand);

  const offen = projekte.filter((p) => istFaellig(zustand[p])).length;
  const zeichen = { fertig: '✓', leer: '·', spaeter: '~', kaputt: '⛔' }[endgueltig];
  console.log(`  ${zeichen} ${endgueltig}${paare ? ` · ${paare} Paare` : ''}${grund ? ` · ${grund}` : ''} · noch ${offen} offen`);
}

/*
 * Nur laufen, wenn DIREKT aufgerufen — nicht beim Import.
 *
 * Ohne diese Zeile startete `main()` beim blossen Laden des Moduls. Der
 * Test korpus-maschine.test.ts importiert `naechstes` und `ausgangAusCode`,
 * main sah keine Flags und rief process.exit(2) — die CI von PR #497 fiel
 * genau daran. fremdernte.ts traegt denselben Schutz seit jeher; diese
 * Datei hatte ihn schlicht nicht.
 */
/*
 * NACHGESCHAERFT am 25.08.2026: der includes-Vergleich war selbst die
 * naechste Falle. Unter vitest kann argv[1] die TESTDATEI sein, und
 * 'korpus-maschine.test.ts'.includes('korpus-maschine') ist wahr — main()
 * lief beim Testlauf an und rief process.exit(2): 1594 gruene Tests UND
 * ein Fehler. Deshalb exakter Dateinamen-Vergleich mit Endung.
 */
const aufgerufenAls = process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '';
if (aufgerufenAls === 'korpus-maschine.ts' || aufgerufenAls === 'korpus-maschine.js') {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
