/**
 * fragewolke.ts — die Impfung: jede Lektion bekommt Fragen, bevor jemand fragt.
 *
 * ── Das Vorbild ─────────────────────────────────────────────────────────────
 *
 * Die Impfung. Ein synthetischer Erreger trainiert das Immunsystem, bevor der
 * echte kommt. Dazu der Zeitumkehr-Spiegel aus der Ultraschall-Physik: eine
 * aufgezeichnete Welle, rueckwaerts abgespielt, fokussiert exakt auf ihre
 * Quelle zurueck — sogar durch streuendes Gewebe. Die Fragewolke einer Lektion
 * ist ihr aufgezeichnetes Wellenfeld; Suchen ist Rueckfokussieren.
 *
 * ── Die gemessene Luecke, die es schliessen soll ────────────────────────────
 *
 * Am 21.08.2026 kreuzweise gemessen (resonanz-vergleich.ts): ist eine Lektion
 * durch ihre Fragen adressiert, steigt Platz 1 von 38 auf 64 Prozent. Der
 * Mechanismus wirkt also gewaltig — nur verhungert er: ein Index aus echten
 * Fragen deckte 64 von 499 Lektionen. Diese Datei erzeugt den Startbestand.
 *
 * ── Zwei Quellen, und warum beide gebraucht werden ──────────────────────────
 *
 * REGEL (kostenlos, sofort): formt die vorhandenen Felder mechanisch in
 * Fragesprache um. Das ist bewusst die SCHWACHE Fassung — sie benutzt
 * dieselben Woerter wie der Lektionstext. Wenn schon sie gewinnt, ist die Idee
 * stark; wenn sie verliert, ist damit NICHT die Idee widerlegt, sondern nur
 * diese Fassung. Genau das ist ihr Zweck: ein billiger Vortest, der die teure
 * Messung entscheidet.
 *
 * MODELL (teuer, echt): ein Sprachmodell schreibt Fragen aus der Sicht dessen,
 * der die Lektion BRAUCHT — nicht dessen, der sie schrieb. Nur diese Fassung
 * kann die eigentliche Luecke schliessen (Fragesprache ist nicht
 * Lektionssprache). Diese Datei nimmt sie als JSONL entgegen; erzeugt werden
 * sie ausserhalb.
 *
 * ── Die Sollbruchstelle, vorher benannt — und sofort eingetreten ────────────
 *
 * Haben die erzeugten Fragen dieselbe Sprache wie der Lektionstext, messen sie
 * nur den Volltext-Vektor ein zweites Mal. Dann ist der Gewinn nahe null — und
 * das ist ein Ergebnis, kein Fehler. Die Regel-Fassung ist der Testfall dafuer.
 *
 * GEMESSEN am 21.08.2026, vor der ersten Einbettung:
 *
 *   Wort-Ueberlappung mit dem Lektionstext
 *     Regel-Wolke (1850 Fragen, 499 von 499 Lektionen)   65,4 %
 *     die 100 ECHTEN Pruef-Fragen                        23,2 %
 *
 * Die Regel-Fassung ist DREIMAL so nah am Text wie eine echte Frage. Damit ist
 * sie als Vortest erledigt, ohne dass ein einziger Einbettungsaufruf noetig
 * war — 1850 gesparte Aufrufe fuer eine Zahl, die in Sekunden zu haben ist.
 *
 * Die Erkenntnis ist allgemeiner als der Testfall: eine REGEL kann diese
 * Luecke prinzipiell nicht schliessen. Die Luecke besteht ja gerade darin,
 * dass Fragende ANDERE Woerter benutzen als der Text — und eine Regel hat
 * keine anderen Woerter, sie kann nur umstellen, was schon dasteht.
 *
 * Fuer die Modell-Fassung folgt daraus eine harte Abnahmebedingung: ihre
 * Ueberlappung muss in die Naehe der 23,2 Prozent kommen. Liegt sie deutlich
 * darueber, hat das Modell abgeschrieben statt uebersetzt — und die teure
 * Einbettung lohnt nicht. Diese Pruefung laeuft VOR jedem Einbetten.
 *
 * ── ERGEBNIS DES ERSTEN SCHARFEN LAUFS (21.08.2026) ────────────────────────
 *
 * 40 Lektionen geimpft (20 Ziele + 20 Ablenker), 120 Fragen von Hand
 * geschrieben, kontaminationsgeprueft, eingebettet, gemessen:
 *
 *   Gruppe             Platz1 vor -> nach    @3 vor -> nach
 *   betroffen (20)        15,0 -> 15,0        15,0 -> 35,0   (+20 Punkte)
 *   uebrige   (80)        46,3 -> 47,5        65,0 -> 65,0
 *   alle     (100)        40,0 -> 41,0        55,0 -> 59,0   (+4 Punkte)
 *
 *   Je Frage, betroffen: 15 besser, 0 schlechter, 5 gleich.
 *
 * KEINE EINZIGE VERSCHLECHTERUNG unter den betroffenen Fragen. Das ist der
 * staerkste Einzeleffekt, der an diesem Messstand bisher gemessen wurde.
 *
 * ── Der Haken, und er ist ein Artefakt ─────────────────────────────────────
 *
 * Unter den 80 uebrigen Fragen wurden 10 schlechter. Der Grund ist bekannt und
 * heute schon einmal aufgetreten: spreizeImTopf gibt einem fehlenden Wert eine
 * NULL. Wer das Merkmal hat, kann nur gewinnen; wer es nicht hat, nur
 * verlieren. Bei einer TEILimpfung haben 40 von 499 Lektionen die Wolke — die
 * anderen 459 tragen den Nachteil.
 *
 * Daraus folgt die Bauregel: VOLLIMPFUNG ODER GAR NICHT. Ein Merkmal, das nur
 * ein Teil des Bestands hat, verzerrt die Rangfolge zugunsten dieses Teils.
 * Bei vollstaendiger Impfung faellt der Nachteil weg, weil es keine
 * Lektion ohne Wolke mehr gibt.
 *
 * Aufruf:
 *   npx tsx src/bench/fragewolke.ts --regel > wolken.jsonl
 *   npx tsx src/bench/fragewolke.ts --pruefe wolken.jsonl
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface Lektion {
  topic: string;
  what_worked?: string;
  what_failed?: string;
  severity?: string;
  outcome?: string;
}
interface Korpus { lektionen: Lektion[]; fragen: Array<{ query: string; relevant: string[] }> }

/** Eine Zeile der Ausgabe: welche Lektion, welche Frage. */
export interface Wolkenzeile { topic: string; frage: string; quelle: 'regel' | 'modell' }

/**
 * Der Themenname traegt bei uns Struktur: "bereich:worte-mit-strichen".
 * Daraus wird Alltagssprache — der Doppelpunkt ist ein Bereich, die Striche
 * sind Wortgrenzen.
 */
export function themaAlsWorte(topic: string): { bereich: string; worte: string } {
  const [erst, ...rest] = topic.split(':');
  const roh = (rest.length ? rest.join(':') : erst).replace(/[-_]+/g, ' ').trim();
  return { bereich: rest.length ? erst : '', worte: roh };
}

/**
 * Der erste Satz eines Feldes, gekuerzt.
 *
 * Unsere Lektionen tragen die entscheidende Tatsache bewusst in den ersten
 * 100 Zeichen von `what_worked` (Hausregel seit dem Briefing-Fund). Der erste
 * Satz ist damit die dichteste Stelle des ganzen Datensatzes.
 */
export function ersterSatz(text: string | undefined, maxLaenge = 160): string {
  if (!text) return '';
  const sauber = text.replace(/\s+/g, ' ').trim();
  const ende = sauber.search(/[.!?](\s|$)/);
  const satz = ende > 20 ? sauber.slice(0, ende) : sauber;
  return satz.slice(0, maxLaenge).trim();
}

/**
 * Die Regel-Fassung: mechanische Umformung in Fragesprache.
 *
 * Vier Formen, weil unsere 100 Pruef-Fragen genau vier Arten haben
 * (stoerung, vorhaben, nachschlagen, entscheidung). Jede Form zielt auf eine
 * davon — eine Wolke, die nur eine Art bedient, hilft nur einem Viertel.
 */
export function regelWolke(l: Lektion): string[] {
  const { worte } = themaAlsWorte(l.topic);
  const fehler = ersterSatz(l.what_failed, 120);
  const fix = ersterSatz(l.what_worked, 120);
  const fragen: string[] = [];

  // stoerung: das Symptom als Klage.
  if (fehler) fragen.push(`Was tun, wenn ${fehler.charAt(0).toLowerCase()}${fehler.slice(1)}?`);
  // vorhaben: die Vorsichtsfrage.
  if (worte) fragen.push(`Worauf muss ich achten bei ${worte}?`);
  // nachschlagen: die Wissensfrage.
  if (fix) fragen.push(`Woran erkenne ich, dass ${fix.charAt(0).toLowerCase()}${fix.slice(1)}?`);
  // entscheidung: die Abwaegung.
  if (worte) fragen.push(`Spricht etwas dagegen, ${worte} so zu machen?`);

  return fragen.filter((f) => f.length > 25).slice(0, 4);
}

/**
 * Wie stark ueberlappt eine Frage woertlich mit dem Lektionstext?
 *
 * Das ist die Selbstpruefung gegen die benannte Sollbruchstelle. Liegt der
 * Wert nahe 1, ist die Frage eine Umformulierung des Textes und misst nur den
 * Volltext-Vektor ein zweites Mal.
 */
export function wortUeberlappung(frage: string, l: Lektion): number {
  const worte = (s: string): Set<string> => new Set(
    (s.toLowerCase().match(/[a-zäöüß]{4,}/g) ?? []),
  );
  const f = worte(frage);
  if (f.size === 0) return 0;
  const t = worte(`${l.topic} ${l.what_worked ?? ''} ${l.what_failed ?? ''}`);
  let treffer = 0;
  for (const w of f) if (t.has(w)) treffer++;
  return treffer / f.size;
}

// ── Aufruf ─────────────────────────────────────────────────────────────────

const direkt = process.argv[1]?.endsWith('fragewolke.ts');
if (direkt) {
  const hier = dirname(fileURLToPath(import.meta.url));
  const korpus = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus.json'), 'utf8')) as Korpus;

  if (process.argv.includes('--regel')) {
    for (const l of korpus.lektionen) {
      for (const frage of regelWolke(l)) {
        process.stdout.write(`${JSON.stringify({ topic: l.topic, frage, quelle: 'regel' } as Wolkenzeile)}\n`);
      }
    }
    process.exit(0);
  }

  const pruefIdx = process.argv.indexOf('--pruefe');
  if (pruefIdx > -1) {
    const datei = process.argv[pruefIdx + 1];
    const zeilen = readFileSync(datei, 'utf8').split('\n').filter(Boolean)
      .map((z) => JSON.parse(z) as Wolkenzeile);
    const nachTopic = new Map<string, Lektion>(korpus.lektionen.map((l) => [l.topic, l]));

    let summe = 0; let n = 0;
    const proTopic = new Map<string, number>();
    for (const z of zeilen) {
      const l = nachTopic.get(z.topic);
      if (!l) continue;
      summe += wortUeberlappung(z.frage, l);
      n++;
      proTopic.set(z.topic, (proTopic.get(z.topic) ?? 0) + 1);
    }

    // Wie viele Lektionen haben ueberhaupt eine Wolke? Die Deckung ist die
    // Zahl, an der die Resonanz zuletzt gescheitert ist (64 von 499).
    console.log(`Zeilen: ${zeilen.length} · Lektionen mit Wolke: ${proTopic.size} von ${korpus.lektionen.length}`);
    console.log(`Mittlere Wort-Ueberlappung mit dem Lektionstext: ${(summe / Math.max(n, 1) * 100).toFixed(1)} %`);
    console.log('  (nahe 100 % = die Frage ist eine Umformulierung und misst den Volltext doppelt)');

    // Gegenprobe: wie stark ueberlappen die ECHTEN Pruef-Fragen? Das ist der
    // Massstab — synthetische Fragen sollten in dieselbe Groessenordnung
    // kommen, nicht darueber.
    let echtSumme = 0; let echtN = 0;
    for (const q of korpus.fragen) {
      for (const t of q.relevant) {
        const l = nachTopic.get(t);
        if (!l) continue;
        echtSumme += wortUeberlappung(q.query, l);
        echtN++;
      }
    }
    console.log(`\nZum Vergleich, die 100 ECHTEN Fragen: ${(echtSumme / Math.max(echtN, 1) * 100).toFixed(1)} %`);
    console.log('  Liegt die synthetische Zahl deutlich hoeher, ist die Wolke zu nah am Text.');
    process.exit(0);
  }

  console.error('Aufruf: fragewolke.ts --regel  |  --pruefe <datei.jsonl>');
  process.exit(2);
}
