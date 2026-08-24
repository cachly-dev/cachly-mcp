/**
 * ══ Einbetten in Buendeln, direkt an Ollama, binaer abgelegt ═══════════════
 *
 * ── Was gemessen wurde (24.08.2026, node-1, bge-m3, 8 Kerne) ─────────────
 *
 *   1 Text einzeln       0,55 s   =  1,8 Texte/s
 *   16 in EINER Anfrage  4,27 s   =  3,8 Texte/s      2,1x schneller
 *   64 in EINER Anfrage  17,0 s   =  3,8 Texte/s      kein Gewinn mehr
 *   4 Buendel PARALLEL            =  3,6 Texte/s      kein Gewinn
 *
 * Zwei Ergebnisse, beide wichtig:
 *
 * 1. **Ueber die Haelfte der Zeit war Verwaltung, nicht Rechnen.** 0,55 s je
 *    Text einzeln gegen 0,27 s im Buendel — die Differenz ist reiner
 *    Anfrage-Aufwand. Buendeln holt ihn zurueck, ohne dass sich am Ergebnis
 *    irgendetwas aendert: gleiches Modell, gleiche Texte.
 *
 * 2. **Parallel bringt NICHTS.** Ollama arbeitet die Anfragen intern
 *    nacheinander ab. Wer hier Nebenlaeufigkeit einbaut, macht den Code
 *    komplizierter und die Sache nicht schneller. Das steht hier, damit es
 *    niemand ein zweites Mal versucht.
 *
 * ── Warum direkt an Ollama und nicht ueber /api/v1/embed ─────────────────
 *
 * Unser eigener Endpunkt nimmt genau EINEN Text je Anfrage (`req.Text` ist
 * ein String). Buendeln ginge dort nur mit einer Aenderung am
 * Produktionsdienst.
 *
 * Fuer den Messstand ist der direkte Weg ohnehin richtig: er ist kein
 * Kundenpfad, und der serverseitige Zwischenspeicher bringt hier nichts —
 * jeder Text des Korpus kommt genau einmal vor.
 *
 * ── Was dieser Lauf NICHT tut ────────────────────────────────────────────
 *
 * Er rechnet nichts neu, was schon in der Zieldatei steht. Ein abgebrochener
 * Lauf wird fortgesetzt, nicht wiederholt.
 *
 * Aufruf:
 *   npx tsx src/bench/einbetten-schnell.ts \
 *     --korpus  ~/.cachly/bench-korpus/fremdsatz.json \
 *     --nach    ~/.cachly/bench-korpus/fremdsatz.vek \
 *     [--ollama http://10.8.0.1:11434] [--buendel 16] [--modell bge-m3]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { lesen, schreiben } from './vektoren-binaer.js';

type Korpus = {
  lessons?: Array<{ topic: string; what_worked: string }>;
  queries?: Array<{ query: string }>;
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Der Schluessel eines Textes.
 *
 * Ueber den Inhalt, nicht ueber die Position: derselbe Text zweimal im Korpus
 * wird einmal gerechnet. Und wenn sich die Reihenfolge des Korpus aendert,
 * bleibt der vorhandene Bestand brauchbar.
 */
export function schluessel(art: 'frage' | 'lektion', text: string): string {
  return `${art}:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
}

/**
 * Texte auf diese Laenge kuerzen.
 *
 * ── Warum das die teuerste Stellschraube ist ─────────────────────────────
 *
 * Gemessen am 24.08.2026 auf TEI/bge-m3 (node-3), mit ECHTEN Textlaengen:
 *
 *    200 Zeichen   2,84 Texte/s
 *    800 Zeichen   0,59 Texte/s
 *   2000 Zeichen   0,28 Texte/s
 *
 * Der Durchsatz haengt fast umgekehrt proportional an der Laenge. 2000 ist
 * also die teuerste Einstellung, die es gibt.
 *
 * Vorher stand hier "mehr traegt bge-m3 nicht zur Sache bei" — eine
 * Behauptung ohne Zahl. Ob 800 oder 400 Zeichen dieselbe Findequote liefern,
 * ist MESSBAR, und der Prueflauf dafuer laeuft ueber --max-zeichen.
 *
 * Bis das gemessen ist, bleibt 2000 die Vorgabe: lieber langsam und richtig
 * als schnell und ungeprueft.
 */
export const MAX_ZEICHEN = 2000;

/**
 * Ein Buendel einbetten.
 *
 * Gibt `null` zurueck, wenn es nach allen Versuchen nicht ging — NICHT einen
 * leeren Vektor. Ein Nullvektor waere ein gueltig aussehendes Ergebnis, das
 * jede spaetere Messung still verfaelscht.
 */
export type Art = 'tei' | 'ollama';

/**
 * Wohin die Anfrage geht und wie sie aussieht.
 *
 * Zwei Dienste, zwei Formen — und sie sehen sich aehnlich genug, dass man
 * den Unterschied uebersieht:
 *
 *   Ollama  POST /api/embed  { model, input: [...] }  -> { embeddings }
 *   TEI     POST /embed      { inputs: [...] }        -> [[...], [...]]
 *
 * TEI kennt kein `model`: es laedt genau eines beim Start. Wer ihm eines
 * mitschickt, bekommt einen Fehler, der nach etwas anderem aussieht.
 */
export function anfrage(art: Art, basis: string, modell: string, texte: string[]): {
  url: string; rumpf: string;
} {
  return art === 'tei'
    ? { url: `${basis}/embed`, rumpf: JSON.stringify({ inputs: texte, truncate: true }) }
    : { url: `${basis}/api/embed`, rumpf: JSON.stringify({ model: modell, input: texte }) };
}

/** Die Vektoren aus der Antwort holen — beide Formen. */
export function vektorenAus(art: Art, j: unknown): number[][] | null {
  if (art === 'tei') return Array.isArray(j) ? j as number[][] : null;
  const e = (j as { embeddings?: number[][] })?.embeddings;
  return Array.isArray(e) ? e : null;
}

export async function buendelEinbetten(
  basis: string,
  modell: string,
  texte: string[],
  versuche = 7,
  art: Art = 'tei',
): Promise<number[][] | null> {
  for (let n = 1; n <= versuche; n++) {
    try {
      const { url, rumpf } = anfrage(art, basis, modell, texte);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rumpf,
        // 16 Texte brauchen gemessen 4,3 s. Fuenf Minuten sind grosszuegig
        // und fangen nur den echten Haenger ab.
        signal: AbortSignal.timeout(300_000),
      });
      if (!r.ok) {
        /*
         * ── 429 ist eine Bitte um Geduld, keine Absage ──────────────────
         *
         * Gemessen am 24.08.2026: mit zwoelf gleichzeitigen Straengen gegen
         * zwei Dienste kamen 840 von 1000 Texten als "⛔ antwortet 429"
         * zurueck und wurden WEGGEWORFEN. TEI sagt damit nur "meine
         * Warteschlange ist voll" — eine Sekunde spaeter geht es.
         *
         * Genau derselbe Fehler wie bei GitHubs Nebengrenze am selben Tag:
         * ein "warte kurz" als "nein" gelesen. Wer das tut, macht aus jeder
         * Beschleunigung einen Datenverlust.
         *
         * Wartezeit waechst deutlich (1s, 2s, 4s, 8s): bei voller
         * Warteschlange hilft ein zweiter Versuch nach 200 ms gar nichts,
         * er macht sie nur laenger.
         */
        if (r.status === 429 || r.status === 503) {
          await new Promise((f) => { setTimeout(f, 1000 * 2 ** (n - 1)); });
          continue;
        }
        if (r.status < 500) {
          console.error(`  ⛔ ${art} antwortet ${r.status} — das wiederholt sich nicht von selbst.`);
          return null;
        }
        await new Promise((f) => { setTimeout(f, 2000 * n); });
        continue;
      }
      const v = vektorenAus(art, await r.json());
      /*
       * Die ZAHL wird geprueft, nicht nur die Anwesenheit. Kaeme ein Buendel
       * mit 15 statt 16 Vektoren zurueck, waeren ab da alle Schluessel um
       * eins verschoben — und nichts wuerde es melden.
       */
      if (!Array.isArray(v) || v.length !== texte.length) {
        console.error(`  ⛔ ${texte.length} Texte geschickt, ${v?.length ?? 0} Vektoren zurueck.`);
        return null;
      }
      return v;
    } catch {
      await new Promise((f) => { setTimeout(f, 1500 * n); });
    }
  }
  return null;
}

async function main(): Promise<void> {
  const korpusPfad = flag('korpus');
  const ziel = flag('nach');
  if (!korpusPfad || !ziel) {
    console.error('NICHT EINGEBETTET: --korpus <datei.json> und --nach <datei.vek> sind Pflicht.');
    process.exit(2);
  }
  /*
   * ── Mehrere Dienste, komma-getrennt ────────────────────────────────────
   *
   * Der erste Entwurf sprach mit EINEM Dienst und wartete jedes Mal, bis er
   * fertig war. Gemessen am 24.08.2026: 1,1 Texte/s, waehrend auf vier
   * Maschinen 32 Kerne standen und drei davon arbeiteten.
   *
   * Das ist keine Feinheit. Bei 1,15 Millionen Texten sind das zwoelf Tage
   * gegen anderthalb.
   *
   * Jeder Dienst bekommt gleich viele gleichzeitige Anfragen. Eine langsame
   * Maschine bremst die anderen NICHT: es gibt keinen gemeinsamen Takt,
   * jeder Strang holt sich das naechste Buendel, sobald er frei ist.
   */
  const dienste = (flag('ollama') ?? flag('dienst') ?? 'http://10.8.0.6:8080')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const art = (flag('art') ?? (dienste[0].includes('11434') ? 'ollama' : 'tei')) as Art;
  const modell = flag('modell') ?? 'bge-m3';
  const buendelGroesse = Number(flag('buendel') ?? '16');
  /** Gleichzeitige Anfragen JE Dienst. */
  const straenge = Number(flag('straenge') ?? '4');
  // Zum Messen, ob kuerzere Texte reichen. Die Schluessel haengen am
  // gekuerzten Text, zwei Laengen kommen sich also nicht ins Gehege.
  const maxZeichen = Number(flag('max-zeichen') ?? String(MAX_ZEICHEN));

  const korpus = JSON.parse(readFileSync(resolve(korpusPfad), 'utf8')) as Korpus;

  // Alle zu rechnenden Texte, ohne Dubletten.
  const gebraucht = new Map<string, string>();
  for (const l of korpus.lessons ?? []) {
    const t = (l.what_worked ?? '').slice(0, maxZeichen);
    if (t) gebraucht.set(schluessel('lektion', t), t);
  }
  for (const q of korpus.queries ?? []) {
    const t = (q.query ?? '').slice(0, maxZeichen);
    if (t) gebraucht.set(schluessel('frage', t), t);
  }

  if (gebraucht.size === 0) {
    console.error('NICHT EINGEBETTET: der Korpus enthaelt weder Lektionen noch Fragen.');
    process.exit(3);
  }

  // Was schon da ist, wird nicht neu gerechnet.
  let vorhanden: Record<string, number[]> = {};
  if (existsSync(resolve(ziel))) {
    try {
      vorhanden = lesen(resolve(ziel));
      console.log(`  ${Object.keys(vorhanden).length} Vektoren liegen schon vor.`);
    } catch (e) {
      // Eine kaputte Datei wird NICHT stillschweigend ueberschrieben. Sie
      // koennte das Ergebnis von Stunden sein.
      console.error(`  ⛔ ${ziel} ist nicht lesbar: ${e instanceof Error ? e.message : e}`);
      console.error('     Loeschen und neu rechnen — oder nachsehen, was passiert ist.');
      process.exit(4);
    }
  }

  const offen = [...gebraucht].filter(([k]) => !(k in vorhanden));
  console.log('');
  console.log('🧮  Einbetten in Buendeln');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${gebraucht.size} Texte gebraucht · ${vorhanden ? Object.keys(vorhanden).length : 0} vorhanden · ${offen.length} offen`);
  console.log(`  ${art} · ${modell} · ${buendelGroesse} je Anfrage · ${straenge} Straenge je Dienst`);
  for (const d of dienste) console.log(`    ${d}`);

  if (offen.length === 0) {
    console.log('  Nichts zu tun.');
    return;
  }

  const begonnen = Date.now();
  let fertig = 0;
  let gescheitert = 0;

  /*
   * ── Ein gemeinsamer Stapel, viele Straenge ─────────────────────────────
   *
   * KEINE feste Aufteilung nach Diensten. Wer die Arbeit vorher in gleiche
   * Teile schneidet, wartet am Ende auf den langsamsten — und node-3 hat
   * vier Kerne, node-4 zwoelf.
   *
   * Stattdessen holt sich jeder Strang das naechste Buendel, sobald er frei
   * ist. Der schnelle Dienst holt sich mehr. Ganz von selbst.
   */
  let naechsterIndex = 0;
  const holen = (): Array<[string, string]> | null => {
    if (naechsterIndex >= offen.length) return null;
    const teil = offen.slice(naechsterIndex, naechsterIndex + buendelGroesse);
    naechsterIndex += buendelGroesse;
    return teil;
  };

  let zuletztGemeldet = 0;
  const strang = async (dienst: string): Promise<void> => {
    for (;;) {
      const teil = holen();
      if (!teil) return;
      const v = await buendelEinbetten(dienst, modell, teil.map(([, t]) => t), 4, art);
      if (!v) {
        /*
         * Ein gescheitertes Buendel wird gezaehlt und uebersprungen, nicht
         * ignoriert. Am Ende steht die Zahl im Bericht — sonst waere ein
         * halb gerechneter Bestand von einem vollstaendigen nicht zu
         * unterscheiden.
         */
        gescheitert += teil.length;
        continue;
      }
      for (let n = 0; n < teil.length; n++) vorhanden[teil[n][0]] = v[n];
      fertig += teil.length;

      if (fertig - zuletztGemeldet >= 200 || fertig + gescheitert >= offen.length) {
        zuletztGemeldet = fertig;
        const sek = (Date.now() - begonnen) / 1000;
        const proSek = fertig / Math.max(sek, 1);
        const rest = Math.round((offen.length - fertig - gescheitert) / Math.max(proSek, 0.01));
        console.log(`  ${fertig}/${offen.length} · ${proSek.toFixed(1)}/s · noch ~${Math.round(rest / 60)} min`);
      }
    }
  };

  const alleStraenge: Array<Promise<void>> = [];
  for (const d of dienste) for (let i = 0; i < straenge; i++) alleStraenge.push(strang(d));
  await Promise.all(alleStraenge);

  if (fertig === 0) {
    console.error('  ⛔ NICHT GESCHRIEBEN: kein einziger Vektor gerechnet.');
    process.exit(5);
  }

  schreiben(resolve(ziel), Object.entries(vorhanden));
  const s = (Date.now() - begonnen) / 1000;
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${fertig} neu in ${Math.round(s)} s = ${(fertig / s).toFixed(1)}/s`);
  if (gescheitert > 0) {
    console.log(`  ⚠️  ${gescheitert} Texte NICHT gerechnet — der Bestand ist unvollstaendig.`);
  }
  console.log(`  ${Object.keys(vorhanden).length} Vektoren in ${ziel}`);
}

// Nur laufen, wenn DIREKT aufgerufen — ein Import darf nie main() starten
// (die CI von PR #497 fiel an genau dieser Falle in korpus-maschine.ts).
if (process.argv[1]?.includes('einbetten-schnell')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
