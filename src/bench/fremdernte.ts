/**
 * ══ Fremdernte: Frage-Antwort-Paare aus oeffentlichen Repos ════════════════
 *
 * ── Wozu das gut ist — und wozu NICHT ─────────────────────────────────────
 *
 * Die naheliegende Erwartung ist "mehr Daten zum Einstellen". Die traegt
 * nicht: wir haben seit dem 22.08.2026 bereits 2997 Einstellfragen, und die
 * Anpassung darauf war nach 63 Bewertungen fertig, mit tragenden Nachbarn.
 * Noch mehr Fragen AUS DERSELBEN Verteilung aendern daran nichts.
 *
 * Der Wert liegt woanders: **wir haben auf EINEM Bestand angepasst — unseren
 * 499 Lektionen.** Dass `thema` dort nichts traegt, koennte an unseren
 * Themennamen liegen. Fremde Repos sind der einzige Weg, das zu pruefen,
 * ohne auf Kunden zu warten.
 *
 * Also: **eine Verallgemeinerungsprobe, keine Datenquelle.** Daraus folgt die
 * ganze Auswahl weiter unten: BREITE schlaegt Menge, und ein SCHWERER Fall
 * schlaegt zehn leichte.
 *
 * ── Woher die Etiketten kommen ───────────────────────────────────────────
 *
 * Ein geschlossenes Issue mit verknuepftem, gemergtem PR ist genau unser
 * Paar: ein Mensch beschreibt in eigenen Worten, dass etwas nicht geht
 * (die Frage), und der PR ist, was es geloest hat (die Lektion).
 *
 * ── Warum GraphQL und nicht mehr REST (24.08.2026) ───────────────────────
 *
 * Der erste Weg holte je Issue die Zeitachse, dann den PR, dann seine
 * Dateien: rund 2,5 Anfragen. Bei 5000 Anfragen je Stunde waren das
 * **2000 Paare je Stunde** — und nach fuenf Projekten war Schluss.
 *
 * Gemessen am 24.08.2026, dieselbe Auskunft ueber GraphQL:
 *
 *   50 Issues, 49 mit gemergtem PR, samt Dateien  =  2 Punkte
 *   dieselben 50 ueber REST                       = 125 Anfragen
 *
 * Das ist **62 Mal billiger**. Aus 2000 Paaren je Stunde werden rund 125000.
 *
 * Und es ist zugleich genauer: `closedByPullRequestsReferences` ist GitHubs
 * eigene Verknuepfung. Der REST-Weg musste sie aus Ereignisnamen der
 * Zeitachse erraten ("cross-referenced", "connected", "closed") und verlor
 * dabei je nach Projekt 5 bis 27 Prozent.
 *
 * ── Warum ausgewaehlt und nicht einfach alles genommen wird ──────────────
 *
 * gitea hat 5125 verknuepfte Paare, grafana 12022, home-assistant 16454.
 * Alles zu nehmen waere jetzt moeglich — und trotzdem falsch.
 *
 * Ein Paar, dessen Antwort woertlich in der Frage steht ("fix timeout in
 * deploy" zu "deploy times out"), findet JEDE Suche. Es macht die Zahlen
 * schoen und beweist nichts. Ein PR ueber 200 Dateien ist ein Umbau, keine
 * Lektion. Ein Issue ohne Rumpf ist keine Frage.
 *
 * Deshalb wird JEDES Paar bewertet und nur das obere Feld behalten. Die
 * Ablehnungen werden gezaehlt und benannt — eine Auswahl, die nicht sagt, was
 * sie weggelassen hat, ist eine Behauptung.
 *
 * ── Die Gefahr, an der alles haengt ──────────────────────────────────────
 *
 * Wenn die Lektion aus dem PR-TITEL gebaut wird und der Titel das Issue
 * wiederholt, dann steht die Antwort woertlich in der Frage. Die Suche waere
 * trivial, die Zahlen grossartig, und wir haetten nichts gelernt.
 *
 * Das ist dieselbe Fehlerklasse wie am 20.08.2026, als der Messstand eine
 * andere Anordnung mass als die ausgelieferte: +6 Punkte dort, +1 im Produkt.
 *
 * Deshalb nimmt `lektionAusPr` den Titel BEWUSST nicht auf, und
 * `zirkel-messen.ts` misst danach, was uebrig bleibt.
 *
 * Aufruf:
 *   GH_TOKEN=… npx tsx src/bench/fremdernte.ts --repo go-gitea/gitea \
 *     --anzahl 500 --nach /pfad/ernte-gitea.json
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Issue = {
  number: number;
  title: string;
  bodyText: string | null;
  createdAt: string;
  comments: { totalCount: number };
  closedByPullRequestsReferences: {
    nodes: Array<{
      number: number;
      bodyText: string | null;
      merged: boolean;
      changedFiles: number;
      files: { nodes: Array<{ path: string }> } | null;
    }>;
  } | null;
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

/**
 * Das Stundenkontingent ist AUFGEBRAUCHT.
 *
 * ── Warum das eine eigene Fehlerart ist ───────────────────────────────────
 *
 * Gemessen am 24.08.2026, ein Lauf ueber 16 Projekte: die ersten fuenf
 * lieferten 260 bis 277 Paare, die uebrigen zehn meldeten NULL — bei
 * zusammen ueber 60000 vorhandenen. Der Grund war ein leeres Kontingent.
 *
 * Gesehen hat man das nicht. Ein `catch { return null; }` machte aus jedem
 * Fehler die Aussage "dieses Issue hat keinen PR", die Ernte schrieb eine
 * gueltige leere Datei und meldete fertig.
 *
 * Das ist die Fehlerklasse, die im Haus schon sechs Mal zugeschlagen hat:
 * **es gibt keinen Zustand "nicht gemessen", also wird Stille als Null
 * gebucht.** Eine Null sieht aus wie ein Ergebnis.
 */
class KontingentLeer extends Error {
  constructor(public readonly wiederAb: Date) {
    const min = Math.max(1, Math.ceil((wiederAb.getTime() - Date.now()) / 60_000));
    super(`GitHub-Kontingent leer — wieder frei in ${min} Minuten `
      + `(${wiederAb.toISOString().slice(11, 16)} UTC)`);
    this.name = 'KontingentLeer';
  }
}

/**
 * Die Abfrage war GitHub zu schwer.
 *
 * Kein Nein und kein Fehler in der Sache — eine Zeitgrenze auf GitHubs Seite.
 * Die Antwort darauf ist nicht "aufgeben", sondern "kleiner fragen".
 */
class ZuSchwer extends Error {
  constructor(public readonly meldung: string) {
    super(`GitHub brach die Abfrage ab (zu schwer): ${meldung.slice(0, 90)}`);
    this.name = 'ZuSchwer';
  }
}

/**
 * Sagt GitHub hier "zu schwer" — egal in welcher Schreibweise?
 *
 * ── Warum das EINE Funktion ist ──────────────────────────────────────────
 *
 * GitHub meldet dieselbe Ueberlastung auf zwei Wegen:
 *
 *   im Feld `errors`   "Something went wrong while executing your query"
 *   als HTTP-Status    502 Bad Gateway (auch 500 und 504)
 *
 * Gemessen am 24.08.2026: grafana, minikube und terraform kamen ueber den
 * ersten Weg — die wurden erkannt und mit kleinerer Seite geholt.
 * microsoft/TypeScript und pytorch/pytorch kamen ueber den zweiten und
 * fielen ZWEIMAL komplett aus, weil der Waechter nur den Wortlaut kannte.
 *
 * Zwei Regeln an zwei Stellen waeren die zweite Wahrheit: man pflegt eine
 * und vergisst die andere. Deshalb steht die Frage genau einmal hier.
 */
export function istUeberlastung(meldung: string): boolean {
  if (/Something went wrong while executing your query/i.test(meldung)) return true;
  // 500, 502, 504 — Serverseite. 503 bewusst NICHT: das ist Wartung, und die
  // geht auch mit kleinerer Seite nicht weg. Die Ziffernfolge muss zu Ende
  // sein: sonst faenge "5001" mit, das es als Status gar nicht gibt.
  return /^GraphQL: 50[024]([^0-9]|$)/.test(meldung);
}

/**
 * Eine GraphQL-Abfrage, mit drei Versuchen.
 *
 * Am 23.08.2026 fielen zwei von fuenf Ernten mit "fetch failed" aus — ein
 * Netzhaenger, kein Fehler in der Sache. Ohne Wiederholung ist ein ganzer
 * Lauf verloren, und man sieht nicht einmal, dass es nur die Leitung war.
 *
 * Ein leeres Kontingent wird NICHT wiederholt — es kommt in einer Sekunde
 * genauso, und drei Versuche kosten drei Punkte aus einem Konto, das keine
 * mehr hat.
 */
async function graph<T>(abfrage: string, werte: Record<string, unknown>, versuche = 3): Promise<T> {
  let letzterFehler: unknown;
  for (let n = 1; n <= versuche; n++) {
    try {
      const antwort = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: JSON.stringify({ query: abfrage, variables: werte }),
        signal: AbortSignal.timeout(30_000),
      });
      if ((antwort.status === 403 || antwort.status === 429)
        && antwort.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(antwort.headers.get('x-ratelimit-reset') ?? '0');
        throw new KontingentLeer(new Date(reset * 1000 || Date.now() + 3_600_000));
      }
      if (!antwort.ok) {
        /*
         * ── 403 ist zweierlei, und der Unterschied kostet einen ganzen Lauf ──
         *
         * Gemessen am 24.08.2026: fuenf Ernten gleichzeitig, drei davon
         * "403 Forbidden" — deno, argo-cd, rust-analyzer. Das Kontingent war
         * zu dem Zeitpunkt bei 4060 von 5000.
         *
         * Es war GitHubs NEBENGRENZE: zu viele Anfragen gleichzeitig. Sie ist
         * eine Bitte um Geduld, keine Absage. Der erste Entwurf behandelte
         * jeden 403 als endgueltig und verlor drei Projekte an eine Pause.
         *
         * Das Merkmal ist das Kontingent selbst: steht dort noch etwas, ist
         * es die Nebengrenze. Steht dort 0, hat `KontingentLeer` oben schon
         * zugeschlagen. Bleibt der echte Fall "du darfst dieses Repo nicht
         * sehen" — der kommt beim dritten Versuch genauso und faellt dann
         * korrekt durch.
         */
        const nebengrenze = antwort.status === 403
          && antwort.headers.get('x-ratelimit-remaining') !== '0';
        if (antwort.status < 500 && antwort.status !== 429 && !nebengrenze) {
          throw new Error(`GraphQL: ${antwort.status} ${antwort.statusText}`);
        }
        letzterFehler = new Error(`GraphQL: ${antwort.status} ${antwort.statusText}`);
        // GitHub nennt die Wartezeit, wenn es eine gibt. Sonst: wachsend warten.
        const bitte = Number(antwort.headers.get('retry-after') ?? '0');
        if (bitte > 0 && bitte < 120) await new Promise((r) => { setTimeout(r, bitte * 1000); });
        else if (nebengrenze) await new Promise((r) => { setTimeout(r, 5000 * n); });
      } else {
        const d = await antwort.json() as { data?: T; errors?: Array<{ message: string; type?: string }> };
        /*
         * GraphQL antwortet mit 200 UND einer Fehlerliste. Wer nur auf
         * `antwort.ok` schaut, liest `undefined` als "keine Ergebnisse" —
         * wieder Stille, die als Null gebucht wird.
         */
        if (d.errors?.length) {
          const text = d.errors.map((e) => e.message).join(' · ');
          if (d.errors.some((e) => e.type === 'RATE_LIMITED')) {
            throw new KontingentLeer(new Date(Date.now() + 3_600_000));
          }
          /*
           * "Something went wrong while executing your query" ist GitHubs
           * eigene Zeitgrenze fuer eine zu schwere Abfrage. Gemessen am
           * 24.08.2026 traf sie grafana, minikube und terraform — alles
           * Projekte mit zehntausenden Issues, alle bei Seitengroesse 50.
           *
           * Das ist eine Ueberlastung, kein Nein. Wer sie als endgueltig
           * behandelt, verliert genau die groessten Bestaende — also die,
           * derentwegen der ganze Umbau gemacht wurde.
           */
          if (istUeberlastung(text)) {
            throw new ZuSchwer(text);
          }
          throw new Error(`GraphQL meldet: ${text}`);
        }
        if (!d.data) throw new Error('GraphQL lieferte weder Daten noch Fehler');
        return d.data;
      }
    } catch (e) {
      if (e instanceof KontingentLeer) throw e;
      if (e instanceof ZuSchwer) throw e;
      if (e instanceof Error && /^GraphQL meldet:|^GraphQL: [4]\d\d/.test(e.message)
        && !/: 429 /.test(e.message)) throw e;
      letzterFehler = e;
    }
    if (n < versuche) await new Promise((r) => { setTimeout(r, 1000 * n); });
  }
  /*
   * ── Ein hartnaeckiger 502 ist dieselbe Ueberlastung, nur anders gesagt ──
   *
   * Gemessen am 24.08.2026: microsoft/TypeScript und pytorch/pytorch fielen
   * ZWEIMAL hintereinander mit "GraphQL: 502 Bad Gateway" aus — nach allen
   * Wiederholungen. Beides Bestaende mit zehntausenden Issues, also genau
   * der Fall, fuer den `ZuSchwer` gebaut wurde.
   *
   * Nur sagt GitHub es hier nicht im Feld `errors`, sondern als HTTP-Status.
   * Dieselbe Ursache, zwei Schreibweisen — und die zweite fiel durch, weil
   * der Waechter auf den WORTLAUT sah statt auf die Bedeutung. Genau die
   * Fehlerklasse, gegen die dieser ganze Ernter umgebaut wurde.
   *
   * Erst NACH allen Wiederholungen umdeuten: ein einzelner 502 ist wirklich
   * oft ein Schluckauf. Wer beim ersten schon die Seite verkleinert, macht
   * jede Ernte langsamer, ohne etwas zu gewinnen.
   */
  if (letzterFehler instanceof Error && istUeberlastung(letzterFehler.message)) {
    throw new ZuSchwer(letzterFehler.message);
  }
  throw letzterFehler instanceof Error ? letzterFehler : new Error(String(letzterFehler));
}

/**
 * Eine Seite der Suche — Issue, verknuepfte PRs und deren Dateien in EINER
 * Abfrage.
 *
 * `first: 50` ist bewusst nicht hoeher: die Knotenzahl (50 × 3 PRs × 20
 * Dateien) bleibt damit weit unter GitHubs Grenze, und die Abfrage kostet
 * gemessen 2 Punkte.
 */
const ABFRAGE = `
query($q: String!, $nach: String, $erste: Int!) {
  rateLimit { cost remaining limit resetAt }
  search(query: $q, type: ISSUE, first: $erste, after: $nach) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        bodyText
        createdAt
        comments { totalCount }
        closedByPullRequestsReferences(first: 3, includeClosedPrs: true) {
          nodes { number bodyText merged changedFiles files(first: 20) { nodes { path } } }
        }
      }
    }
  }
}`;

type Seite = {
  rateLimit: { cost: number; remaining: number; limit: number; resetAt: string };
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Issue[];
  };
};

/** Rauschen aus einem Issue-Text entfernen, das keine Frage ist. */
export function frageAusIssue(titel: string, rumpf: string | null): string {
  const text = [titel, rumpf ?? ''].join('\n');
  return text
    // Codebloecke: sie sind Beleg, nicht Frage — und sie wuerden die
    // Ueberlappung kuenstlich hochtreiben.
    .replace(/```[\s\S]*?```/g, ' ')
    // Vorlagen-Ueberschriften ("### Steps to reproduce") tragen nichts bei.
    .replace(/^#{1,6}\s.*$/gm, ' ')
    // Ankreuzkaestchen und Zitate.
    .replace(/^\s*[-*]\s*\[[ xX]\].*$/gm, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/**
 * Die Lektion aus dem PR — BEWUSST OHNE den Titel.
 *
 * Der Titel wiederholt fast immer das Issue ("fix: …"). Wer ihn aufnimmt,
 * baut die Antwort in die Frage ein. Was bleibt, ist der Rumpf (die
 * Beschreibung dessen, WAS getan wurde) und die geaenderten Dateien.
 */
export function lektionAusPr(rumpf: string | null, dateien: string[]): string {
  const beschreibung = (rumpf ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
  return [beschreibung, dateien.slice(0, 20).join(' ')].filter(Boolean).join(' ');
}

/** Woerter ab vier Zeichen, klein, ohne Dubletten. */
function woerter(text: string): Set<string> {
  return new Set(
    text.toLowerCase().match(/[a-zäöüß][a-zäöüß0-9_-]{3,}/g) ?? [],
  );
}

/**
 * Wie viel der FRAGE steht schon in der LEKTION.
 *
 * Bewusst durch die Groesse der Frage geteilt, nicht durch die Vereinigung:
 * die Gefahr ist "die Antwort steht in der Frage", nicht "beide sind lang".
 */
export function ueberlappung(frage: string, lektion: string): number {
  const f = woerter(frage);
  const l = woerter(lektion);
  if (f.size === 0) return 0;
  let treffer = 0;
  for (const w of f) if (l.has(w)) treffer++;
  return treffer / f.size;
}

export type Bewertung = { wert: number; ablehnung?: string };

/**
 * ── Was ein SCHLUESSELPAAR ausmacht ───────────────────────────────────────
 *
 * Vier Ausschluesse und drei Pluspunkte. Die Ausschluesse sind hart, weil ein
 * solches Paar nicht "etwas weniger wert" ist, sondern die Messung VERFAELSCHT:
 *
 *   Antwort steht in der Frage   jede Suche findet es — es misst nichts
 *   Umbau statt Behebung         200 Dateien sind keine Lektion
 *   Frage ohne Rumpf             ein Titel ist keine Frage
 *   Lektion ohne Beschreibung    eine Dateiliste allein erklaert nichts
 *
 * Die Pluspunkte sagen, welches der ueberlebenden Paare SCHWERER ist —
 * und schwere Faelle sind genau die, an denen sich eine Sortierung beweist:
 *
 *   wenig Ueberlappung   die Suche muss wirklich etwas leisten
 *   wenige Dateien       eine klare, benennbare Ursache
 *   diskutiert           wo gestritten wurde, steckt Wissen
 */
export function bewertePaar(
  frage: string,
  lektion: string,
  geaenderteDateien: number,
  kommentare: number,
): Bewertung {
  const hart = pruefePaar(frage, lektion);
  if (hart) return { wert: 0, ablehnung: hart };
  if (geaenderteDateien > 40) return { wert: 0, ablehnung: 'Umbau statt Behebung' };

  const u = ueberlappung(frage, lektion);
  // Gewichte: die Ueberlappung wiegt am schwersten, weil sie der einzige
  // Punkt ist, an dem eine Messung sich selbst betruegen kann.
  const gutesMass = geaenderteDateien >= 1 && geaenderteDateien <= 12 ? 1 : 0.4;
  const gespraech = Math.min(1, Math.log1p(kommentare) / Math.log(12));
  return { wert: 2 * (1 - u) + 1 * gutesMass + 0.6 * gespraech };
}

/**
 * Die Ausschluesse, die OHNE die Daten von GitHub auskommen.
 *
 * ── Warum das eine eigene Funktion ist ────────────────────────────────────
 *
 * Ein fertiger Erntesatz enthaelt nur noch Frage und Lektion — die Zahl der
 * geaenderten Dateien und die Kommentare stehen dort nicht mehr. Wer einen
 * ALTEN Satz nachtraeglich pruefen will, kann `bewertePaar` also gar nicht
 * aufrufen.
 *
 * Gemessen am 24.08.2026: der zusammengefuehrte Fremdsatz aus 28 Projekten
 * hatte 16,8 % mittlere Ueberlappung und 13 abgeschriebene Paare — ALLE aus
 * den Ernten von gestern, die noch ohne Auswahl liefen.
 *
 * Diese Funktion ist deshalb das Tor, durch das auch alte Saetze muessen.
 * Sie ist KEINE zweite Wahrheit: `bewertePaar` ruft sie selbst auf, es gibt
 * die Regel nur einmal.
 */
export function pruefePaar(frage: string, lektion: string): string | null {
  if (frage.length < 60) return 'Frage zu duenn';
  if (lektion.length < 80) return 'Lektion zu duenn';
  if (ueberlappung(frage, lektion) > 0.6) return 'Antwort steht in der Frage';
  return null;
}

/** Zwei Lektionen, die praktisch dasselbe sagen — etwa aus einem Bot. */
function abdruck(lektion: string): string {
  return lektion.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

async function main(): Promise<void> {
  const repo = flag('repo');
  const anzahl = Number(flag('anzahl') ?? '300');
  const nach = flag('nach');
  if (!repo || !nach) {
    console.error('NICHT GEERNTET: --repo <owner/name> und --nach <datei.json> sind Pflicht.');
    process.exit(2);
  }
  if (!TOKEN) {
    console.error('NICHT GEERNTET: GH_TOKEN fehlt — ohne Token geht GraphQL gar nicht.');
    process.exit(2);
  }

  console.log(`🌾  Ernte aus ${repo} — Ziel ${anzahl} Schluesselpaare`);

  /*
   * ── Die 1000er-Grenze der Suche, und wie sie umgangen wird ──────────────
   *
   * Eine Suchabfrage liefert hoechstens 1000 Treffer, egal wie viele es gibt.
   * gitea hat 5125. Wer mehr will, muss die Abfrage ZERLEGEN.
   *
   * Zerlegt wird nach Erstelldatum: ist eine Scheibe ausgeschoepft, geht die
   * naechste bis zum aeltesten gesehenen Issue. Das ist der einzige Schnitt,
   * der garantiert ueberschneidungsfrei UND lueckenlos ist — Labels und
   * Autoren sind beides nicht.
   */
  const rohPaare: Array<{
    frage: string; lektion: string; topic: string; wert: number;
  }> = [];
  const abgelehnt = new Map<string, number>();
  const gesehen = new Set<string>();
  let issuesGeholt = 0;
  let ohneGemergtenPr = 0;
  let kosten = 0;
  let gesamtVorhanden = 0;
  let aeltestes: string | null = null;
  let punkteUebrig = Number.POSITIVE_INFINITY;

  scheiben: for (let scheibe = 0; scheibe < 20; scheibe++) {
    const bis = aeltestes ? ` created:<${aeltestes.slice(0, 10)}` : '';
    const suche = `repo:${repo} is:issue is:closed linked:pr${bis}`;
    let cursor: string | null = null;
    let inScheibe = 0;

    for (let seite = 0; seite < 20; seite++) {
      /*
       * ── Kleiner fragen statt aufgeben ────────────────────────────────────
       *
       * Gemessen am 24.08.2026: grafana, minikube und terraform brachen bei
       * Seitengroesse 50 mit "Something went wrong while executing your
       * query" ab — GitHubs eigene Zeitgrenze. Ausgerechnet die groessten
       * Bestaende, derentwegen der ganze Umbau gemacht wurde.
       *
       * Drei Groessen, in dieser Reihenfolge. 10 kostet mehr Abfragen, aber
       * eine Abfrage kostet 1 bis 2 Punkte — es geht um Zeit, nicht um das
       * Kontingent.
       */
      let d: Seite | null = null;
      for (const erste of [50, 25, 10]) {
        try {
          d = await graph<Seite>(ABFRAGE, { q: suche, nach: cursor, erste });
          if (erste !== 50) console.log(`  (Seitengroesse auf ${erste} gesenkt)`);
          break;
        } catch (e) {
          if (!(e instanceof ZuSchwer) || erste === 10) throw e;
        }
      }
      if (!d) throw new Error('unerreichbar: weder Seite noch Fehler');
      kosten += d.rateLimit.cost;
      punkteUebrig = d.rateLimit.remaining;
      if (scheibe === 0 && seite === 0) gesamtVorhanden = d.search.issueCount;

      for (const issue of d.search.nodes) {
        if (!issue?.number) continue;
        issuesGeholt++;
        inScheibe++;
        if (!aeltestes || issue.createdAt < aeltestes) aeltestes = issue.createdAt;

        const pr = (issue.closedByPullRequestsReferences?.nodes ?? []).find((p) => p.merged);
        if (!pr) { ohneGemergtenPr++; continue; }

        const dateien = (pr.files?.nodes ?? []).map((f) => f.path);
        const frage = frageAusIssue(issue.title, issue.bodyText);
        const lektion = lektionAusPr(pr.bodyText, dateien);

        const b = bewertePaar(frage, lektion, pr.changedFiles, issue.comments.totalCount);
        if (b.ablehnung) {
          abgelehnt.set(b.ablehnung, (abgelehnt.get(b.ablehnung) ?? 0) + 1);
          continue;
        }
        const schluessel = abdruck(lektion);
        if (gesehen.has(schluessel)) {
          abgelehnt.set('Dublette', (abgelehnt.get('Dublette') ?? 0) + 1);
          continue;
        }
        gesehen.add(schluessel);

        rohPaare.push({
          frage, lektion, topic: `${repo.split('/')[1]}:pr-${pr.number}`, wert: b.wert,
        });
      }

      // Genug beisammen? Dann kein weiterer Punkt.
      if (rohPaare.length >= anzahl * 1.5) break scheiben;
      if (!d.search.pageInfo.hasNextPage) break;
      cursor = d.search.pageInfo.endCursor;
    }

    // Die Scheibe war leer oder der Bestand ist erschoepft.
    if (inScheibe === 0 || issuesGeholt >= gesamtVorhanden) break;
  }

  /*
   * ── Erst melden, dann schreiben ────────────────────────────────────────
   *
   * Eine gueltige leere oder halbe Datei ist das Gefaehrlichste hier: sie
   * sieht wie ein Ergebnis aus, der naechste Lauf ueberspringt sie ("liegt
   * schon vor"), und der Zirkeltest rechnet darauf eine schoene Zahl.
   */
  if (rohPaare.length === 0) {
    console.error('');
    console.error(`  ⛔ NICHT GEERNTET: ${issuesGeholt} Issues gesehen, kein einziges Paar.`);
    console.error(`     ${ohneGemergtenPr} ohne gemergten PR`);
    for (const [grund, n] of [...abgelehnt].sort((a, b) => b[1] - a[1])) {
      console.error(`     ${String(n).padStart(5)} × ${grund}`);
    }
    console.error('  Es wird KEINE Datei geschrieben.');
    process.exit(4);
  }

  // Die besten zuerst — und nur so viele, wie verlangt waren.
  rohPaare.sort((a, b) => b.wert - a.wert);
  const genommen = rohPaare.slice(0, anzahl);

  const ergebnis = {
    name: `fremdernte-${repo.replace('/', '-')}`,
    _hinweis: 'Geerntet aus geschlossenen Issues mit verknuepftem, gemergtem PR '
      + '(GitHub GraphQL, closedByPullRequestsReferences). Die Lektion enthaelt '
      + 'BEWUSST NICHT den PR-Titel — der wiederholt fast immer das Issue und '
      + 'wuerde die Antwort in die Frage bauen. Ausgewaehlt nach bewertePaar: '
      + 'geringe Ueberlappung, wenige geaenderte Dateien, diskutiertes Issue. '
      + 'Vor jeder Nutzung mit zirkel-messen.ts pruefen.',
    lessons: genommen.map((p) => ({ topic: p.topic, what_worked: p.lektion })),
    queries: genommen.map((p) => ({ query: p.frage, relevant: [p.topic] })),
  };
  writeFileSync(resolve(nach), JSON.stringify(ergebnis, null, 1));

  const mittel = genommen.reduce((s, p) => s + p.wert, 0) / genommen.length;
  console.log(`  ${gesamtVorhanden} verknuepfte Issues vorhanden, ${issuesGeholt} angesehen`);
  console.log(`  ${genommen.length} Paare geschrieben nach ${nach}`);
  console.log(`  brauchbar waren ${rohPaare.length} · mittlerer Wert der genommenen ${mittel.toFixed(2)}`);
  console.log(`  verworfen: ${ohneGemergtenPr} ohne gemergten PR`
    + [...abgelehnt].sort((a, b) => b[1] - a[1]).map(([g, n]) => ` · ${n} ${g}`).join(''));
  console.log(`  Kosten: ${kosten} Punkte · ${punkteUebrig} von 5000 uebrig`);

  if (genommen.length < 30) {
    console.log('  ⚠️  Weniger als 30 Paare — das traegt keine Aussage.');
    process.exit(1);
  }
  console.log('');
  console.log('  Naechster Schritt — OHNE ihn ist die Ernte wertlos:');
  console.log(`    npx tsx src/bench/zirkel-messen.ts --korpus ${nach} --fragen ${nach}`);
}

if (process.argv[1]?.includes('fremdernte')) {
  main().catch((e: unknown) => {
    if (e instanceof KontingentLeer) {
      console.error('');
      console.error(`  ⛔ ${e.message}`);
      console.error('  Bis dahin ist jede weitere Ernte sinnlos. Es wird KEINE Datei geschrieben.');
      process.exit(4);
    }
    console.error('NICHT GEERNTET:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
