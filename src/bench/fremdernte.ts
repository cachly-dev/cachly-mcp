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
 * Also: **eine Verallgemeinerungsprobe, keine Datenquelle.**
 *
 * ── Woher die Etiketten kommen ───────────────────────────────────────────
 *
 * Ein geschlossenes Issue mit verknuepftem, gemergtem PR ist genau unser
 * Paar: ein Mensch beschreibt in eigenen Worten, dass etwas nicht geht
 * (die Frage), und der PR ist, was es geloest hat (die Lektion).
 *
 * Gemessen am 23.08.2026, nur drei Repos:
 *   grafana/loki 1345 · caddyserver/caddy 619 · traefik/traefik 461
 *
 * ── Die Gefahr, an der alles haengt ──────────────────────────────────────
 *
 * Wenn die Lektion aus dem PR-TITEL gebaut wird und der Titel das Issue
 * wiederholt ("fix: timeout in deploy" zu "deploy times out"), dann steht die
 * Antwort woertlich in der Frage. Die Suche waere trivial, die Zahlen
 * grossartig, und wir haetten nichts gelernt.
 *
 * Das ist dieselbe Fehlerklasse wie am 20.08.2026, als der Messstand eine
 * andere Anordnung mass als die ausgelieferte: +6 Punkte dort, +1 im Produkt.
 *
 * Deshalb misst dieses Werkzeug die Ueberlappung MIT und meldet sie, statt
 * sie zu verschweigen. `zirkel-messen.ts` entscheidet danach, ob der
 * geerntete Satz taugt.
 *
 * Aufruf:
 *   GH_TOKEN=… npx tsx src/bench/fremdernte.ts --repo caddyserver/caddy \
 *     --anzahl 100 --nach /pfad/ernte-caddy.json
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Issue = { number: number; title: string; body: string | null };
type Zeitpunkt = {
  event: string;
  source?: { issue?: { number: number; pull_request?: unknown } };
  commit_id?: string | null;
};
type Pr = { number: number; body: string | null; merged_at: string | null };

/**
 * Mehrere Anfragen gleichzeitig, aber nicht unbegrenzt.
 *
 * GitHub erlaubt 5000 Anfragen je Stunde mit Token; die Grenze ist nicht das
 * Kontingent, sondern die Hoeflichkeit. Sechs gleichzeitig holen 200 Paare in
 * gut einer Minute statt in zehn.
 */
async function parallel<T, R>(werte: T[], breite: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const aus: R[] = new Array(werte.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(breite, werte.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= werte.length) return;
      aus[k] = await fn(werte[k]);
    }
  }));
  return aus;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

/**
 * Eine Anfrage, mit drei Versuchen.
 *
 * Am 23.08.2026 fielen zwei von fuenf Ernten mit "fetch failed" aus — ein
 * Netzhaenger, kein Fehler in der Sache. Ohne Wiederholung ist ein ganzer
 * Lauf verloren, und man sieht nicht einmal, dass es nur die Leitung war.
 *
 * Wiederholt wird NUR bei Netzfehlern und bei 429/5xx. Ein 404 wird nicht
 * wiederholt: der kommt beim naechsten Mal genauso.
 */
async function gh<T>(pfad: string, versuche = 3): Promise<T> {
  let letzterFehler: unknown;
  for (let n = 1; n <= versuche; n++) {
    try {
      const antwort = await fetch(`https://api.github.com/${pfad}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (antwort.ok) return antwort.json() as Promise<T>;
      if (antwort.status !== 429 && antwort.status < 500) {
        throw new Error(`${pfad}: ${antwort.status} ${antwort.statusText}`);
      }
      letzterFehler = new Error(`${pfad}: ${antwort.status} ${antwort.statusText}`);
    } catch (e) {
      // Ein Abbruch aus dem Aufruf oben ist ein endgueltiger Fehler und
      // darf nicht als Netzhaenger durchgehen.
      if (e instanceof Error && /: [45]\d\d /.test(e.message) && !/: (429|5\d\d) /.test(e.message)) throw e;
      letzterFehler = e;
    }
    if (n < versuche) await new Promise((r) => { setTimeout(r, 1000 * n); });
  }
  throw letzterFehler instanceof Error ? letzterFehler : new Error(String(letzterFehler));
}

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

async function main(): Promise<void> {
  const repo = flag('repo');
  const anzahl = Number(flag('anzahl') ?? '100');
  const nach = flag('nach');
  if (!repo || !nach) {
    console.error('NICHT GEERNTET: --repo <owner/name> und --nach <datei.json> sind Pflicht.');
    process.exit(2);
  }
  if (!TOKEN) {
    console.error('NICHT GEERNTET: GH_TOKEN fehlt — ohne Token sind es 60 Anfragen je Stunde.');
    process.exit(2);
  }

  console.log(`🌾  Ernte aus ${repo} — bis zu ${anzahl} Paare`);

  // Die Suche liefert hoechstens 100 je Seite. Fuer mehr: mehrere Seiten.
  const seiten = Math.ceil(Math.min(anzahl, 300) / 100);
  const issues: Issue[] = [];
  let gesamt = 0;
  for (let seite = 1; seite <= seiten; seite++) {
    const t = await gh<{ items: Issue[]; total_count: number }>(
      `search/issues?q=${encodeURIComponent(`repo:${repo} is:issue is:closed linked:pr`)}`
      + `&per_page=100&page=${seite}`,
    );
    gesamt = t.total_count;
    issues.push(...t.items);
    if (t.items.length < 100) break;
  }
  console.log(`  ${gesamt} Paare vorhanden, ${issues.length} Issues geholt`);

  const lektionen: Array<{ topic: string; what_worked: string }> = [];
  const queries: Array<{ query: string; relevant: string[] }> = [];
  let ohneBezug = 0;
  let zuKurz = 0;

  /*
   * ── Warum die Zeitachse und nicht die Suche ────────────────────────────
   *
   * Der erste Entwurf suchte nach der Issue-Nummer im PR-Text. Das verlor
   * 34 von 60 Paaren: die Nummer steht oft gar nicht im Text, sondern die
   * Verknuepfung entsteht ueber ein Ereignis ("closed by", "connected").
   *
   * Die Zeitachse eines Issues nennt genau diese Ereignisse. Gleiche Kosten,
   * verlaesslich statt geraten.
   */
  const roh = await parallel(issues, 6, async (issue) => {
    try {
      const zeitachse = await gh<Zeitpunkt[]>(
        `repos/${repo}/issues/${issue.number}/timeline?per_page=100`,
      );
      const nummern = zeitachse
        .filter((e) => (e.event === 'cross-referenced' || e.event === 'connected' || e.event === 'closed')
          && e.source?.issue?.pull_request)
        .map((e) => e.source!.issue!.number);
      if (nummern.length === 0) return null;

      // Der erste GEMERGTE PR gewinnt — ein geschlossener ohne Merge hat das
      // Problem nicht geloest.
      for (const n of nummern.slice(0, 4)) {
        const pr = await gh<Pr>(`repos/${repo}/pulls/${n}`).catch(() => null);
        if (!pr?.merged_at) continue;
        const f = await gh<Array<{ filename: string }>>(
          `repos/${repo}/pulls/${n}/files?per_page=30`,
        ).catch(() => [] as Array<{ filename: string }>);
        return { issue, pr, dateien: f.map((x) => x.filename) };
      }
      return null;
    } catch { return null; }
  });

  for (const eintrag of roh) {
    if (!eintrag) { ohneBezug++; continue; }
    const { issue, pr, dateien } = eintrag;
    const frage = frageAusIssue(issue.title, issue.body);
    const lektion = lektionAusPr(pr.body, dateien);
    if (frage.length < 40 || lektion.length < 40) { zuKurz++; continue; }
    const topic = `${repo.split('/')[1]}:pr-${pr.number}`;
    lektionen.push({ topic, what_worked: lektion });
    queries.push({ query: frage, relevant: [topic] });
  }

  const ergebnis = {
    name: `fremdernte-${repo.replace('/', '-')}`,
    _hinweis: 'Geerntet aus geschlossenen Issues mit verknuepftem, gemergtem PR. '
      + 'Die Lektion enthaelt BEWUSST NICHT den PR-Titel — der wiederholt fast '
      + 'immer das Issue und wuerde die Antwort in die Frage bauen. '
      + 'Vor jeder Nutzung mit zirkel-messen.ts pruefen.',
    lessons: lektionen,
    queries,
  };
  writeFileSync(resolve(nach), JSON.stringify(ergebnis, null, 1));

  console.log(`  ${queries.length} Paare geschrieben nach ${nach}`);
  console.log(`  verworfen: ${ohneBezug} ohne PR-Bezug · ${zuKurz} zu kurz`);
  if (queries.length < 30) {
    console.log('  ⚠️  Weniger als 30 Paare — das traegt keine Aussage.');
    process.exit(1);
  }
  console.log('');
  console.log('  Naechster Schritt — OHNE ihn ist die Ernte wertlos:');
  console.log(`    npx tsx src/bench/zirkel-messen.ts --korpus ${nach} --fragen ${nach}`);
}

main().catch((e) => {
  console.error('NICHT GEERNTET:', e instanceof Error ? e.message : String(e));
  process.exit(4);
});
