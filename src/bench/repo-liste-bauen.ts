/**
 * ══ Die Projektliste bauen — breit, nicht nach Geschmack ═══════════════════
 *
 * ── Warum nicht von Hand ─────────────────────────────────────────────────
 *
 * Eine Liste, die ein Mensch tippt, enthaelt Projekte, die er kennt. Am
 * 24.08.2026 waren das 55 Stueck, und sie standen fast alle in zwei Ecken:
 * Infrastruktur (kubernetes, envoy, helm, consul) und Web-Rahmenwerke
 * (rails, angular, svelte, symfony).
 *
 * Wer daraus eine Zahl ueber "Software allgemein" ableitet, misst in
 * Wahrheit "Infrastruktur und Web". Genau die Fehlerklasse, die uns diese
 * Woche mehrfach getroffen hat: eine Messung, die eine andere Frage
 * beantwortet als die gestellte.
 *
 * Deshalb baut GitHub die Liste, geschichtet ueber Sprachen UND Sachgebiete.
 * Was wir nicht kennen, kommt so trotzdem hinein.
 *
 * ── Warum geschichtet und nicht "die 1000 mit den meisten Sternen" ───────
 *
 * Die 1000 sternreichsten Repos waeren zur Haelfte Sammlungen von Links,
 * Lernmaterial und Vorlagen — awesome-lists, Interview-Fragen,
 * Programmier-Kurse. Die haben keine Issues mit verknuepften PRs, und was
 * sie haetten, waere keine Lektion.
 *
 * Geschichtet heisst: je Sprache und je Sachgebiet die besten N. Damit kommt
 * Elixir genauso vor wie Python, und Bioinformatik genauso wie Web.
 *
 * ── Die Filter, und warum jeder einzelne ─────────────────────────────────
 *
 *   stars:>500        unter 500 gibt es selten genug geschlossene Issues
 *   pushed:>vor 1 J.  ein totes Projekt liefert keine neuen Lektionen
 *   is:public         selbstverstaendlich, aber es steht hier
 *   NICHT archiviert  ein Archiv wird nicht mehr korrigiert
 *
 * Was NICHT gefiltert wird: die Zahl der Issues. Das kostet eine zweite
 * Abfrage je Projekt, und die Ernte merkt es selbst — sie meldet dann
 * "12 Issues gesehen, kein einziges Paar" und das Projekt faellt heraus.
 * Lieber ein Projekt zu viel in der Liste als eine Vorauswahl, die raet.
 *
 * Aufruf:
 *   GH_TOKEN=… npx tsx src/bench/repo-liste-bauen.ts --nach repos.txt [--je 12]
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Sprachen — bewusst breit, auch die kleinen.
 *
 * Elixir und Haskell liefern weniger Projekte als Python. Genau deswegen
 * stehen sie hier: eine Rangfolge, die nur auf Python und JavaScript
 * eingestellt ist, taugt fuer eine Kanzlei-Codebasis in C# nichts.
 */
const SPRACHEN = [
  'Go', 'Python', 'Rust', 'TypeScript', 'JavaScript', 'Java', 'C++', 'C',
  'C#', 'Ruby', 'PHP', 'Kotlin', 'Swift', 'Scala', 'Elixir', 'Haskell',
  'Zig', 'Dart', 'Lua', 'Perl', 'R', 'Julia', 'OCaml', 'Clojure', 'Erlang',
  'Shell', 'PowerShell', 'HCL', 'Vue', 'Svelte',
];

/**
 * Sachgebiete — das, was Sprachen NICHT abdecken.
 *
 * "Python" sagt nichts darueber, ob ein Projekt eine Datenbank, ein
 * Messgeraet oder ein Spiel ist. Die Fehler und ihre Loesungen sehen aber je
 * Gebiet verschieden aus, und genau das wollen wir messen.
 */
const GEBIETE = [
  'database', 'machine-learning', 'compiler', 'game-engine', 'embedded',
  'security', 'cryptography', 'browser', 'mobile', 'robotics',
  'bioinformatics', 'finance', 'blockchain', 'monitoring', 'networking',
  'operating-system', 'graphics', 'audio', 'video', 'geospatial',
  'scientific-computing', 'testing', 'devops', 'cms', 'ecommerce',
  'healthcare', 'iot', 'nlp', 'computer-vision', 'data-engineering',
  'api', 'orm', 'queue', 'search', 'virtualization', 'kubernetes',
  'text-editor', 'terminal', 'package-manager', 'static-site-generator',
];

type Treffer = {
  nameWithOwner: string;
  stargazerCount: number;
  primaryLanguage: { name: string } | null;
  issues: { totalCount: number };
};

/**
 * Ist das ueberhaupt Software — oder eine Sammlung?
 *
 * ── Der Befund, an der eigenen Liste ─────────────────────────────────────
 *
 * Die erste Fassung sortierte nach Sternen. Oben standen dann:
 *
 *   public-apis/public-apis            469746   eine Linksammlung
 *   EbookFoundation/free-programming-books 395144   eine Buchliste
 *   donnemartin/system-design-primer    365757   Lernmaterial
 *   matteocrippa/awesome-swift           26223   eine Sammlung
 *
 * Der Kommentar oben in dieser Datei warnte woertlich davor — und die
 * Fassung tat es trotzdem. Eine Begruendung im Text ist keine Regel im Code.
 *
 * Solche Projekte haben Issues und gemergte PRs (jemand traegt einen Link
 * nach), aber die PRs beheben nichts. Die Ernte laeuft dort ins Leere und
 * verbraucht Kontingent.
 *
 * ── Zwei Sichten, weil eine nicht reicht ─────────────────────────────────
 *
 * Der Name allein waere zu grob: es gibt ernsthafte Projekte mit "docs" im
 * Namen. Die Zahl geschlossener Issues allein auch: eine grosse Sammlung
 * kommt auf tausende.
 *
 * Deshalb beides — und der Name schlaegt nur bei den eindeutigen Mustern zu.
 */
export function istSammlung(name: string): boolean {
  const n = name.toLowerCase();
  return /(^|[/_-])awesome([_-]|$)/.test(n)
    || /free[_-]programming/.test(n)
    || /(^|[/_-])(books?|list|lists|roadmap|roadmaps|curriculum|handbook|cheatsheet|cheatsheets)([_-]|$)/.test(n)
    || /(interview|tutorial|tutorials|course|courses|learn|learning|primer|guide|guides|examples?|demos?|boilerplate|starter|template|templates|resources)([_-]|$)/.test(n)
    || /(^|\/)(docs?|documentation|blog|website|homepage|papers?|notes?)$/.test(n);
}

/** So viele geschlossene Issues muss ein Projekt haben, damit sich die Ernte lohnt. */
export const MIN_GESCHLOSSENE_ISSUES = 200;

const ABFRAGE = `
query($q: String!, $erste: Int!) {
  search(query: $q, type: REPOSITORY, first: $erste) {
    nodes {
      ... on Repository {
        nameWithOwner
        stargazerCount
        primaryLanguage { name }
        issues(states: CLOSED) { totalCount }
      }
    }
  }
  rateLimit { remaining cost }
}`;

async function suche(q: string, erste: number): Promise<{ treffer: Treffer[]; uebrig: number }> {
  for (let n = 1; n <= 3; n++) {
    try {
      const r = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: JSON.stringify({ query: ABFRAGE, variables: { q, erste } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        if (r.status < 500 && r.status !== 429 && r.status !== 403) {
          throw new Error(`GitHub ${r.status} ${r.statusText}`);
        }
        await new Promise((f) => { setTimeout(f, 3000 * n); });
        continue;
      }
      const j = await r.json() as {
        data?: { search: { nodes: Treffer[] }; rateLimit: { remaining: number } };
        errors?: Array<{ message: string }>;
      };
      if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join(' · '));
      if (!j.data) throw new Error('weder Daten noch Fehler');
      return { treffer: j.data.search.nodes.filter(Boolean), uebrig: j.data.rateLimit.remaining };
    } catch (e) {
      if (n === 3) throw e;
      await new Promise((f) => { setTimeout(f, 2000 * n); });
    }
  }
  throw new Error('unerreichbar');
}

/** Ein Jahr zurueck, als Datum fuer die Suche. */
function vorEinemJahr(heute: Date): string {
  const d = new Date(heute.getTime() - 365 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const nach = flag('nach');
  if (!nach) {
    console.error('NICHT GEBAUT: --nach <datei.txt> ist Pflicht.');
    process.exit(2);
  }
  if (!TOKEN) {
    console.error('NICHT GEBAUT: GH_TOKEN fehlt. Ohne Token gibt GitHub 60 Anfragen/Stunde.');
    process.exit(2);
  }
  const je = Number(flag('je') ?? '12');
  const stichtag = vorEinemJahr(new Date());

  const gefunden = new Map<string, { sterne: number; woher: string; issues: number }>();
  let abfragen = 0;
  let uebrig = 0;
  let alsSammlung = 0;
  let zuWenigIssues = 0;

  const sammle = async (q: string, woher: string): Promise<void> => {
    const { treffer, uebrig: u } = await suche(q, je);
    abfragen++;
    uebrig = u;
    for (const t of treffer) {
      if (gefunden.has(t.nameWithOwner)) continue;
      if (istSammlung(t.nameWithOwner)) { alsSammlung++; continue; }
      if ((t.issues?.totalCount ?? 0) < MIN_GESCHLOSSENE_ISSUES) { zuWenigIssues++; continue; }
      gefunden.set(t.nameWithOwner, {
        sterne: t.stargazerCount, woher, issues: t.issues.totalCount,
      });
    }
  };

  console.log('');
  console.log('🗂️  Projektliste bauen');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${SPRACHEN.length} Sprachen + ${GEBIETE.length} Gebiete · je ${je} · Stichtag ${stichtag}`);

  const gemein = `stars:>500 pushed:>${stichtag} is:public archived:false sort:stars-desc`;

  for (const s of SPRACHEN) {
    try {
      await sammle(`language:${s} ${gemein}`, `sprache:${s}`);
      process.stdout.write('.');
    } catch (e) {
      // LAUT, nicht still. Eine uebersprungene Sprache faellt sonst nie auf.
      console.log(`\n  ⚠️  Sprache ${s}: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (const g of GEBIETE) {
    try {
      await sammle(`topic:${g} ${gemein}`, `gebiet:${g}`);
      process.stdout.write('.');
    } catch (e) {
      console.log(`\n  ⚠️  Gebiet ${g}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log('');

  // Schon Geerntetes bleibt drin — die Ernte ueberspringt es selbst und sagt
  // das laut. Eine Liste, die je nach Stand des Ordners anders aussieht,
  // waere nicht reproduzierbar.
  const zeilen = [...gefunden.entries()]
    /*
     * ── Nach ISSUES sortieren, nicht nach Sternen ────────────────────────
     *
     * Gemessen am 24.08.2026 auf node-3: die ersten beiden Eintraege der
     * sterngeordneten Liste waren `public-apis` und `freeCodeCamp`. Beide
     * scheiterten, je zehn Minuten, und haetten je fuenf Versuche gekostet,
     * bevor die Maschine sie aufgibt.
     *
     * Sterne messen Beruehmtheit. Geschlossene Issues messen, wie viel in
     * einem Projekt tatsaechlich BEHOBEN wurde — und genau danach suchen
     * wir. Eine Linksammlung kann eine halbe Million Sterne haben und
     * trotzdem kaum etwas, das jemand repariert hat.
     *
     * Dieselbe Fehlerklasse wie so oft heute: die Zahl, die am leichtesten
     * zu haben ist, beantwortet eine andere Frage als die gestellte.
     */
    .sort((a, b) => b[1].issues - a[1].issues)
    .map(([name, d]) => [name, d.sterne, d.issues, d.woher].join('\t'));

  const kopf = [
    '# Projektliste fuer die Dauerernte.',
    `# Gebaut am ${new Date().toISOString().slice(0, 10)} aus ${abfragen} GitHub-Abfragen.`,
    `# ${SPRACHEN.length} Sprachen + ${GEBIETE.length} Sachgebiete, je die besten ${je}.`,
    '# Spalten: repo, Sterne, geschlossene Issues, woher (welche Schicht).',
    `# Aussortiert: Sammlungen und Lernmaterial, sowie alles unter ${MIN_GESCHLOSSENE_ISSUES} geschlossenen Issues.`,
    '#',
    '# Geschichtet, NICHT "die 1000 mit den meisten Sternen": das waeren zur',
    '# Haelfte Link-Sammlungen und Lernmaterial ohne Issues mit PRs.',
    '',
  ].join('\n');

  writeFileSync(resolve(nach), kopf + zeilen.join('\n') + '\n', 'utf8');

  const jeGebiet = new Map<string, number>();
  for (const d of gefunden.values()) {
    const art = d.woher.split(':')[0];
    jeGebiet.set(art, (jeGebiet.get(art) ?? 0) + 1);
  }

  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${gefunden.size} Projekte · ${abfragen} Abfragen · ${uebrig} Punkte uebrig`);
  console.log(`  aussortiert: ${alsSammlung} Sammlungen · ${zuWenigIssues} unter ${MIN_GESCHLOSSENE_ISSUES} Issues`);
  for (const [art, n] of jeGebiet) console.log(`    ${n} zuerst gefunden ueber ${art}`);
  console.log(`  geschrieben nach ${nach}`);

  if (gefunden.size < SPRACHEN.length * 2) {
    // Eine kurze Liste ist fast immer ein abgebrochener Lauf, kein Ergebnis.
    console.error('');
    console.error(`  ⛔ Nur ${gefunden.size} Projekte — das sind zu wenige.`);
    console.error('     Vermutlich hat die Haelfte der Abfragen nicht geklappt.');
    process.exit(3);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
