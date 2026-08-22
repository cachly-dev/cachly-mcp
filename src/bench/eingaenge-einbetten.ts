/**
 * Bettet die Eingaenge einer Variante ein — mit Notbremse und Wiederaufnahme.
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Am 19.08.2026 hat ein paralleler Einbettungslauf 563 mal HTTP 429 erzeugt,
 * eine Wachhund-Warnung mit unserer eigenen Adresse ausgeloest und eine
 * automatische Hochskalierung angestossen. Der Grund: /api/v1/embed ist auf
 * 60 Anfragen je Minute begrenzt.
 *
 * Seit PR #417 (ausgerollt 19.08. 21:08) kennen alle zehn Rate-Limiter den
 * Kopf `X-Admin-Key`. Mit ihm faellt die Drosselung weg. Dieses Werkzeug
 * benutzt ihn — aber es VERTRAUT ihm nicht: eine Notbremse zaehlt die 429er
 * und haelt bei zehn an. Lieber ein abgebrochener Lauf als noch ein Vorfall.
 *
 * ── Was NICHT neu eingebettet wird ──────────────────────────────────────────
 *
 * Der Bench-Korpus hat 42 MB Vektoren, 40 Minuten Rechenzeit. Zwei der fuenf
 * Eingangsarten liegen darin schon vor:
 *   `volltext` = Sicht A (korpus-gross.einbettungen.json)
 *   `name`     = Sicht C (korpus-gross.sicht-c.json)
 * Beide werden ueber die POSITION der Lektion im Korpus zugeordnet, so wie es
 * alles-zusammen.ts tut. Wer den Korpus umsortiert, macht diese Zuordnung
 * falsch — deshalb prueft das Werkzeug die Laenge und meldet "nicht gemessen",
 * wenn sie nicht passt.
 *
 * Aufruf:
 *   CACHLY_JWT=... CACHLY_ADMIN_KEY=... npx tsx src/bench/eingaenge-einbetten.ts \
 *     --eingaenge <eingaenge-b.json> --korpus <korpus-gross.json> \
 *     --out <eingaenge-b.vektoren.json> [--parallel 8] [--probe 30]
 *   npx tsx src/bench/eingaenge-einbetten.ts --selbstprobe
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Eingang } from './eingaenge-b.js';

interface Lektionseingaenge { topic: string; eingaenge: Eingang[] }

/** Ein Eingang wird ueber seinen INHALT wiedererkannt, nicht ueber seine Nummer. */
export function schluessel(art: string, text: string): string {
  return `${art}:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
}

/**
 * Die Notbremse.
 *
 * Sie zaehlt nicht Fehler allgemein, sondern nur 429 — den Zustand, in dem der
 * Server sagt "du bist zu schnell". Alles andere (Zeitueberschreitung, 500)
 * darf wiederholt werden; zu schnell zu sein darf man nicht wiederholen.
 */
export class Notbremse {
  private zaehler = 0;
  constructor(private readonly grenze = 10) {}
  melde429(): void { this.zaehler++; }
  get gezogen(): boolean { return this.zaehler >= this.grenze; }
  get stand(): number { return this.zaehler; }
}

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

// ── Selbstprobe ─────────────────────────────────────────────────────────────

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  p('gleicher Text, gleicher Schluessel',
    schluessel('erstsatz', 'abc') === schluessel('erstsatz', 'abc'));
  p('andere Art, anderer Schluessel',
    schluessel('erstsatz', 'abc') !== schluessel('fehlertext', 'abc'));
  p('anderer Text, anderer Schluessel',
    schluessel('erstsatz', 'abc') !== schluessel('erstsatz', 'abd'));

  const b = new Notbremse(3);
  p('Bremse haelt anfangs still', !b.gezogen);
  b.melde429(); b.melde429();
  p('zwei von drei reichen nicht', !b.gezogen);
  b.melde429();
  p('drei ziehen die Bremse', b.gezogen);

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

// ── Hauptteil ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const eingPfad = resolve(flag('eingaenge') ?? '');
  const korpusPfad = resolve(flag('korpus') ?? '');
  const ziel = resolve(flag('out') ?? eingPfad.replace(/\.json$/, '.vektoren.json'));
  const probe = flag('probe') ? Number(flag('probe')) : 0;

  const API = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
  const JWT = process.env.CACHLY_JWT ?? '';
  const ADMIN = process.env.CACHLY_ADMIN_KEY ?? '';
  if (!JWT) fehlt('CACHLY_JWT', '(Umgebungsvariable)');
  if (!existsSync(eingPfad)) fehlt('Eingangsdatei', eingPfad);
  if (!existsSync(korpusPfad)) fehlt('Korpus', korpusPfad);

  const parallel = Number(flag('parallel') ?? (ADMIN ? '8' : '2'));
  console.log(ADMIN
    ? `Admin-Schluessel gesetzt — ${parallel} gleichzeitig, Notbremse bei 10x 429.`
    : `KEIN Admin-Schluessel — gedrosselt mit ${parallel} gleichzeitig. Das dauert.`);

  const { lektionen } = JSON.parse(readFileSync(eingPfad, 'utf8')) as { lektionen: Lektionseingaenge[] };
  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as { lessons: Array<{ topic: string }>; queries: Array<{ query: string }> };

  // Vorhandene Vektoren uebernehmen (Sicht A = Volltext, Sicht C = Name).
  const ladeSicht = (endung: string): Array<number[] | null> => {
    const p = korpusPfad.replace(/\.json$/, endung);
    if (!existsSync(p)) fehlt(`Vektordatei ${endung}`, p);
    const roh = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Array<number[] | null>>;
    return roh.lektionen ?? roh.alle ?? [];
  };
  const sichtA = ladeSicht('.einbettungen.json').slice(0, korpus.lessons.length);
  const sichtC = ladeSicht('.sicht-c.json').slice(0, korpus.lessons.length);
  if (sichtA.length !== korpus.lessons.length || sichtC.length !== korpus.lessons.length) {
    console.error(`NICHT GEMESSEN: Vektorzahl passt nicht zum Korpus (A=${sichtA.length}, C=${sichtC.length}, Lektionen=${korpus.lessons.length}).`);
    process.exit(3);
  }
  const platz = new Map(korpus.lessons.map((l, i) => [l.topic, i]));

  // Was schon berechnet ist, wird nicht noch einmal berechnet.
  const vektoren: Record<string, number[]> = existsSync(ziel)
    ? (JSON.parse(readFileSync(ziel, 'utf8')) as { vektoren: Record<string, number[]> }).vektoren
    : {};
  const vorherSchon = Object.keys(vektoren).length;

  // Uebernahme aus den vorhandenen Sichten.
  let uebernommen = 0;
  for (const l of lektionen) {
    const i = platz.get(l.topic);
    if (i === undefined) continue;
    for (const e of l.eingaenge) {
      const k = schluessel(e.art, e.text);
      if (vektoren[k]) continue;
      const v = e.art === 'volltext' ? sichtA[i] : e.art === 'name' ? sichtC[i] : null;
      if (v) { vektoren[k] = v; uebernommen++; }
    }
  }

  // Was jetzt noch fehlt, muss ueber das Netz.
  const offen = new Map<string, string>();
  for (const l of lektionen) {
    for (const e of l.eingaenge) {
      const k = schluessel(e.art, e.text);
      if (!vektoren[k]) offen.set(k, e.text);
    }
  }

  // Die Fragen des Pruefsatzes kommen in dieselbe Datei — sie werden mit
  // demselben Modell und demselben Zuschnitt eingebettet wie die Eingaenge.
  // Zwei Dateien fuer denselben Zweck waeren zwei Wahrheiten.
  const fragenPfad = flag('fragen');
  if (fragenPfad) {
    const p = resolve(fragenPfad);
    if (!existsSync(p)) fehlt('Pruefsatz', p);
    const satz = JSON.parse(readFileSync(p, 'utf8')) as { queries: Array<{ query: string }> };
    let neu = 0;
    for (const q of satz.queries) {
      const k = schluessel('frage', q.query);
      if (!vektoren[k]) { offen.set(k, q.query); neu++; }
    }
    console.log(`Pruefsatz: ${satz.queries.length} Fragen, davon ${neu} neu.`);
  }
  let liste = [...offen.entries()];
  if (probe > 0) liste = liste.slice(0, probe);

  console.log(`${vorherSchon} schon da, ${uebernommen} aus Sicht A/C uebernommen, ${liste.length} neu einzubetten.`);
  if (liste.length === 0) {
    writeFileSync(ziel, JSON.stringify({ vektoren }), 'utf8');
    console.log(`Nichts zu tun. ${Object.keys(vektoren).length} Vektoren in ${ziel}`);
    return;
  }

  const bremse = new Notbremse(10);
  const gruende = new Map<string, number>();
  const merke = (g: string): void => { gruende.set(g, (gruende.get(g) ?? 0) + 1); };
  let fertig = 0;
  const begonnen = Date.now();

  const einbette = async (text: string): Promise<number[] | null> => {
    for (let versuch = 0; versuch < 4; versuch++) {
      if (bremse.gezogen) return null;
      try {
        const kopf: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${JWT}`,
        };
        if (ADMIN) kopf['X-Admin-Key'] = ADMIN;
        const r = await fetch(`${API}/api/v1/embed`, {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ text: text.slice(0, 2000) }),
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) {
          if (r.status === 429) {
            bremse.melde429();
            merke('HTTP 429');
            await new Promise((f) => setTimeout(f, 2000 * (versuch + 1)));
            continue;
          }
          if (r.status >= 500) {
            merke(`HTTP ${r.status}`);
            await new Promise((f) => setTimeout(f, 1000 * (versuch + 1)));
            continue;
          }
          merke(`HTTP ${r.status}`);
          return null;
        }
        const j = await r.json() as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
        const v = j.embedding ?? j.data?.[0]?.embedding;
        if (v?.length) return v;
        merke('Antwort ohne Vektor');
        return null;
      } catch (e) {
        merke(e instanceof Error ? e.name : 'Ausnahme');
        await new Promise((f) => setTimeout(f, 800 * (versuch + 1)));
      }
    }
    return null;
  };

  let naechster = 0;
  const arbeiter = Array.from({ length: parallel }, async () => {
    for (;;) {
      const i = naechster++;
      if (i >= liste.length || bremse.gezogen) return;
      const [k, text] = liste[i];
      const v = await einbette(text);
      if (v) vektoren[k] = v;
      fertig++;
      if (fertig % 100 === 0) {
        const proSek = fertig / ((Date.now() - begonnen) / 1000);
        console.log(`  ${fertig}/${liste.length}  (${proSek.toFixed(1)}/s, 429er: ${bremse.stand})`);
        writeFileSync(ziel, JSON.stringify({ vektoren }), 'utf8');
      }
    }
  });
  await Promise.all(arbeiter);

  writeFileSync(ziel, JSON.stringify({ vektoren }), 'utf8');
  const dauer = ((Date.now() - begonnen) / 1000).toFixed(0);
  console.log(`Fertig in ${dauer} s. ${Object.keys(vektoren).length} Vektoren in ${ziel}`);
  if (gruende.size) console.log('Fehlgruende:', [...gruende.entries()].map(([g, n]) => `${g}=${n}`).join(' '));
  if (bremse.gezogen) {
    // Die Bremse verhindert den Vorfall vom 19.08. (563 x 429). Sie verhindert
    // NICHT, was am 22.08. passiert ist: schon 16 abgewiesene Anfragen liessen
    // fail2ban auf node-1 unsere oeffentliche Adresse sperren — in den Jails
    // cachly-api UND cachly-admin, und der Bann gilt fuer ALLE Ports. Damit
    // starben WireGuard (UDP 51820) und SSH gleichzeitig, und der Weg zurueck
    // fuehrte ueber node-3 als Sprungrechner. Wer das hier liest, weiss also
    // schon, warum gleich nichts mehr geht.
    console.error(`NOTBREMSE: ${bremse.stand} mal HTTP 429 — Lauf abgebrochen.`);
    console.error('ACHTUNG: Abgewiesene Anfragen sperren die eigene Adresse auf node-1 (fail2ban,');
    console.error('  Jails cachly-api und cachly-admin, alle Ports — Tunnel und SSH sterben mit).');
    console.error('  Entsperren ueber node-3 als Sprungrechner:');
    console.error('  ssh -i ~/.ssh/cachly-deploy -o "ProxyCommand=ssh -i ~/.ssh/cachly-deploy \\');
    console.error('    -p 2222 -W %h:%p root@89.167.65.29" -p 2222 root@10.8.0.1 \\');
    console.error('    "fail2ban-client set cachly-api unbanip $(curl -s https://api.ipify.org)"');
    console.error('RICHTIG WEITER: export CACHLY_ADMIN_KEY="$X_ADMIN_KEY" — dann faellt die Drossel weg');
    console.error('  (gemessen: 11,8 Einbettungen je Sekunde, null 429er). Ohne Schluessel: --parallel 2.');
    process.exit(4);
  }
  const fehlend = liste.filter(([k]) => !vektoren[k]).length;
  if (fehlend > 0) console.error(`WARNUNG: ${fehlend} Eingaenge ohne Vektor — die Messung ist unvollstaendig.`);
}

// Nur ausfuehren, wenn DIESE Datei gestartet wurde. Ohne diese Bremse loest
// jeder Import von `schluessel` den ganzen Hauptteil aus — und die Selbstprobe
// eines anderen Werkzeugs meldet dann die Ergebnisse DIESES Werkzeugs.
const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/eingaenge-einbetten.ts');

if (direktGestartet && process.argv.includes('--selbstprobe')) selbstprobe();
else if (direktGestartet) void main();
