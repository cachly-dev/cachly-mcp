/**
 * wolken-einbetten.ts — Fragewolken einbetten und in den Korpus legen.
 *
 * ── Was es tut ──────────────────────────────────────────────────────────────
 *
 * Liest eine JSONL-Datei mit {topic, frage}, bettet jede Frage ein und legt
 * die Vektoren in die Eingaenge-Struktur des eingefrorenen Korpus. Von dort
 * liest der Eingangsbestand sie ohne jede weitere Aenderung — die Fragewolke
 * benutzt denselben Kanal wie die Fehlertext-Tueren, nur mit besserem Inhalt.
 *
 * ── Die Drosselung, und warum sie hier ernst genommen wird ──────────────────
 *
 * /api/v1/embed ist auf 60 Anfragen je Minute begrenzt. Ein paralleler Lauf
 * hat am 19.08.2026 genau hier 563 mal HTTP 429 erzeugt, eine
 * Wachhund-Warnung mit unserer eigenen Adresse ausgeloest und eine
 * automatische Hochskalierung angestossen.
 *
 * Mit `CACHLY_ADMIN_KEY` (Kopf `X-Admin-Key`, seit PR #417 an allen zehn
 * Begrenzern) faellt die Drosselung weg. OHNE den Schluessel laeuft dieses
 * Werkzeug bewusst langsam und sagt das auch — lieber zehn Minuten warten als
 * die eigene Produktion anstossen.
 *
 * ── Wie man merkt, dass der Schluessel der FALSCHE ist ─────────────────────
 *
 * Am 21.08.2026 gemessen: 65 Aufrufe mit gesetztem X-Admin-Key ergaben genau
 * 60 mal 200 und 5 mal 429 — der Bypass wirkte nicht.
 *
 * Die erste Schlussfolgerung war falsch ("der Bypass ist am embed-Endpunkt
 * nicht angeschlossen"). Nachgesehen: `Next: middleware.IsAdminBypass` steht
 * dort seit PR #417, die Middleware ist VOR allen Limitern registriert
 * (cmd/server/middleware.go:174), und der Code ist seit dem 20.08. mehrfach
 * ausgerollt.
 *
 * Der Grund war der Schluessel selbst. `AdminBypass` lehnt einen falschen
 * Schluessel NICHT ab — es setzt nur kein Flag und laesst die Anfrage normal
 * weiterlaufen. Ein falscher Schluessel ist damit von gar keinem Schluessel
 * nicht zu unterscheiden. Genau deshalb sah es wie ein Codefehler aus.
 *
 * Der Ein-Zeilen-Test, bevor man einen langen Lauf startet:
 *
 *   curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" \
 *     https://api.cachly.dev/api/admin/brain/vector-coverage
 *
 * 200 = richtiger Schluessel. 401 = falscher. Dieses Werkzeug macht den Test
 * beim Start selbst.
 *
 * ── Die Pruefung VOR dem Geldausgeben ───────────────────────────────────────
 *
 * Vor dem ersten Aufruf wird die Wort-Ueberlappung gemessen (fragewolke.ts).
 * Liegt sie deutlich ueber der der echten Fragen, bricht der Lauf ab: eine
 * Wolke, die den Text abschreibt, misst nur den Volltext-Vektor doppelt, und
 * das ist keine 2000 Einbettungen wert. `--trotzdem` hebt die Sperre auf.
 *
 * Aufruf:
 *   CACHLY_JWT=... CACHLY_ADMIN_KEY=... npx tsx src/bench/wolken-einbetten.ts \
 *     --wolken wolken.jsonl --ziel src/bench/korpus/korpus-vektoren.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { packe } from '../bedeutung.js';
import { wortUeberlappung, type Wolkenzeile } from './fragewolke.js';

interface Lektion { topic: string; what_worked?: string; what_failed?: string }
interface Korpus { lektionen: Lektion[]; fragen: Array<{ query: string; relevant: string[] }> }

const API = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
const JWT = process.env.CACHLY_JWT ?? '';
const ADMIN = process.env.CACHLY_ADMIN_KEY ?? '';

/** Ein Einbettungsaufruf. Wirft mit lesbarem Grund. */
async function bette(text: string): Promise<number[]> {
  const kopf: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${JWT}`,
  };
  if (ADMIN) kopf['X-Admin-Key'] = ADMIN;
  const r = await fetch(`${API}/api/v1/embed`, {
    method: 'POST',
    headers: kopf,
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { embedding: number[] };
  if (!j.embedding?.length) throw new Error('Antwort ohne embedding');
  return j.embedding;
}

const schlafe = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function main(): Promise<void> {
  const arg = (n: string, s = ''): string => {
    const i = process.argv.indexOf(n);
    return i > -1 ? (process.argv[i + 1] ?? s) : s;
  };
  const wolkenDatei = arg('--wolken');
  const hier = dirname(fileURLToPath(import.meta.url));
  const zielDatei = arg('--ziel', join(hier, 'korpus', 'korpus-vektoren.json'));
  const trotzdem = process.argv.includes('--trotzdem');

  if (!wolkenDatei || !JWT) {
    console.error('Aufruf: CACHLY_JWT=... [CACHLY_ADMIN_KEY=...] wolken-einbetten.ts --wolken <datei.jsonl> [--ziel <vektoren.json>] [--trotzdem]');
    process.exit(2);
  }

  const zeilen = readFileSync(wolkenDatei, 'utf8').split('\n').filter(Boolean)
    .map((z) => JSON.parse(z) as Wolkenzeile);
  const korpus = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus.json'), 'utf8')) as Korpus;
  const nachTopic = new Map(korpus.lektionen.map((l) => [l.topic, l]));

  // ── Die Pruefung vor dem Geldausgeben ────────────────────────────────────
  let summe = 0; let n = 0;
  for (const z of zeilen) {
    const l = nachTopic.get(z.topic);
    if (!l) continue;
    summe += wortUeberlappung(z.frage, l); n++;
  }
  const wolkeUe = summe / Math.max(n, 1);

  let eSumme = 0; let eN = 0;
  for (const q of korpus.fragen) {
    for (const t of q.relevant) {
      const l = nachTopic.get(t);
      if (!l) continue;
      eSumme += wortUeberlappung(q.query, l); eN++;
    }
  }
  const echtUe = eSumme / Math.max(eN, 1);

  console.log(`Wolke: ${zeilen.length} Fragen · Ueberlappung ${(wolkeUe * 100).toFixed(1)} % gegen ${(echtUe * 100).toFixed(1)} % bei echten Fragen`);
  if (wolkeUe > echtUe * 1.6 && !trotzdem) {
    console.error('\nABBRUCH: die Wolke ist deutlich naeher am Text als echte Fragen.');
    console.error('Sie wuerde nur den Volltext-Vektor ein zweites Mal messen.');
    console.error('Das ist kein Fehler dieses Werkzeugs, sondern ein Ergebnis: mit --trotzdem erzwingbar.');
    process.exit(1);
  }

  if (!ADMIN) {
    console.log(`\nOHNE CACHLY_ADMIN_KEY: gedrosselt, ~1 s Abstand — geschaetzt ${Math.ceil(zeilen.length / 60)} Minuten.`);
    console.log('Mit gueltigem Schluessel (X-Admin-Key) faellt die Drosselung weg.\n');
  } else {
    // Ein falscher Schluessel ist von gar keinem nicht zu unterscheiden:
    // AdminBypass lehnt ihn nicht ab, es setzt nur kein Flag. Deshalb wird er
    // hier EINMAL geprueft, bevor jemand eine Stunde auf einen Lauf wartet,
    // der die ganze Zeit gedrosselt war.
    try {
      const r = await fetch(`${API}/api/admin/brain/vector-coverage`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        console.log('\nAdmin-Schluessel gueltig — die Drosselung sollte entfallen.\n');
      } else {
        console.log(`\nACHTUNG: der Admin-Schluessel ist NICHT gueltig (HTTP ${r.status} am Admin-Endpunkt).`);
        console.log('Der Lauf laeuft trotzdem, aber gedrosselt. Ein falscher Schluessel wirkt wie gar keiner.\n');
      }
    } catch {
      console.log('\nAdmin-Schluessel nicht pruefbar (Admin-Endpunkt nicht erreichbar) — Lauf bleibt gebremst.\n');
    }
  }

  const ziel = existsSync(zielDatei)
    ? JSON.parse(readFileSync(zielDatei, 'utf8')) as { eingaenge?: Record<string, Record<string, string>> }
    : {};
  ziel.eingaenge ??= {};

  let fertig = 0; let fehler = 0; let schon = 0;
  for (const z of zeilen) {
    // Schon vorhanden? Nicht neu einbetten. Ein Wiederanlauf nach einer
    // Drosselung darf nicht bei null anfangen — sonst verbrennt jeder Versuch
    // dasselbe Kontingent erneut.
    if (ziel.eingaenge[z.topic]?.[z.frage]) { schon++; continue; }

    // Bis zu drei Anlaeufe je Frage, mit wachsender Pause. Ein 429 ist keine
    // Absage, sondern ein "spaeter" — wer daraufhin weiterrast, macht es
    // schlimmer (Beleg 19.08.2026: 563 mal 429, Wachhund-Warnung,
    // automatische Hochskalierung).
    let geschafft = false;
    for (let versuch = 1; versuch <= 3 && !geschafft; versuch++) {
      try {
        const v = await bette(z.frage);
        (ziel.eingaenge[z.topic] ??= {})[z.frage] = packe(v);
        fertig++;
        geschafft = true;
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        if (text.includes('429') && versuch < 3) {
          const warte = 62_000; // eine Minute plus Sicherheit: das Fenster ist minuetlich
          console.log(`  gedrosselt — warte ${Math.round(warte / 1000)} s (Versuch ${versuch}/3)`);
          writeFileSync(zielDatei, JSON.stringify(ziel), 'utf8');
          await schlafe(warte);
          continue;
        }
        fehler++;
        console.error(`  FEHLER bei "${z.frage.slice(0, 50)}": ${text.slice(0, 120)}`);
        break;
      }
    }

    if (fertig % 25 === 0 && fertig > 0) {
      console.log(`  ${fertig} neu · ${schon} schon da · ${fehler} Fehler`);
      writeFileSync(zielDatei, JSON.stringify(ziel), 'utf8');
    }
    // Auch mit Schluessel bremsen. Grund: ein FALSCHER Schluessel wirkt wie
    // gar keiner (siehe Dateikopf), und ohne Bremse laeuft der Lauf dann in
    // 563 mal 429 — genau der Vorfall vom 19.08.2026. Die Pruefung oben sagt,
    // ob der Schluessel taugt; die Bremse ist die Versicherung dagegen, dass
    // sie sich irrt.
    await schlafe(1050);
  }
  console.log(`  ${schon} Fragen waren schon eingebettet und wurden uebersprungen.`);

  writeFileSync(zielDatei, JSON.stringify(ziel), 'utf8');
  console.log(`\nFertig: ${fertig} eingebettet, ${fehler} Fehler. Geschrieben nach ${zielDatei}`);
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
