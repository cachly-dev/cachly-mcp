/**
 * Friert den echten Bestand als Messstand ein — Lektionen, Fragen, Vektoren.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Der ausgelieferte Messstand hatte 17 Lektionen und 13 Fragen. Am 20.08.2026
 * liess sich zeigen, dass er die beiden Rangfolge-Formeln GENAU VERKEHRT HERUM
 * einsortiert: 92,3 gegen 69,2 Prozent fuer die Fassung, die auf 498 echten
 * Lektionen 15 statt 30 Prozent erreichte.
 *
 * Ein Messstand, dessen Zahl sich entgegengesetzt zur Wirklichkeit bewegt, ist
 * schlimmer als keiner. Er belohnt die Verschlechterung.
 *
 * Der grosse Korpus lag laengst vor — 499 Lektionen, 100 von Hand geschriebene
 * Fragen. Er konnte nur nicht ins Repo, weil die Vektoren als JSON-Zahlenlisten
 * 22,9 MB gross waren. Seit `packe` int8 schreibt, sind es 2,8 MB.
 *
 * ── Was hier NICHT passiert ─────────────────────────────────────────────────
 *
 * Es werden keine Fragen erzeugt. Die 100 Fragen hat ein Mensch geschrieben,
 * ohne die Lektion abzuschreiben — sonst misst der Messstand sich selbst. Diese
 * Datei friert nur ein, was es gibt.
 *
 * Aufruf (die Quellen liegen ausserhalb des Repos, sie sind der Rohstoff):
 *   npx tsx src/bench/korpus-einfrieren.ts \
 *     --pruefsatz ~/.cachly/bench-korpus/pruefsatz-frisch.json \
 *     --vektoren  ~/.cachly/bench-korpus/eingaenge-b.vektoren.json \
 *     --nach      src/bench/korpus
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { packe, textFuerVektor, textFuerNamensVektor } from '../bedeutung.js';
import { fehlertexteAus, eingangsText } from '../eingaenge.js';
import { schluessel } from './eingaenge-einbetten.js';

interface Lektion { topic: string; [k: string]: unknown }
interface Frage { query: string; relevant: string[]; art?: string }

export interface Korpus {
  _hinweis: string;
  lektionen: Lektion[];
  fragen: Frage[];
}

export interface Vektoren {
  _hinweis: string;
  /** Themenname → gepackter Volltextvektor. */
  volltext: Record<string, string>;
  /** Themenname → gepackter Namensvektor. */
  name: Record<string, string>;
  /** Themenname → { Fehlertext → gepackter Vektor }. */
  eingaenge: Record<string, Record<string, string>>;
  /** Fragetext → gepackter Fragevektor. */
  fragen: Record<string, string>;
}

/**
 * Baut die beiden Dateien aus den Rohdaten.
 *
 * Getrennt von `main`, damit die Zuordnung Text → Vektor pruefbar ist, ohne
 * Dateien anzufassen.
 */
export function friereEin(
  lektionen: Lektion[],
  fragen: Frage[],
  roh: Record<string, number[]>,
  ausSpeicher?: { volltext: Record<string, string>; name: Record<string, string> },
): { korpus: Korpus; vektoren: Vektoren; fehlend: string[] } {
  const fehlend: string[] = [];
  const hol = (art: string, text: string): string | null => {
    const v = roh[schluessel(art, text)];
    if (!v) { fehlend.push(`${art}: ${text.slice(0, 50)}`); return null; }
    return packe(v);
  };

  const volltext: Record<string, string> = {};
  const name: Record<string, string> = {};
  const eingaenge: Record<string, Record<string, string>> = {};

  for (const l of lektionen) {
    // Volltext- und Namensvektor kommen bevorzugt aus dem echten Speicher.
    //
    // Warum nicht aus der Rohdatei: die dort abgelegten Volltextvektoren wurden
    // aus einem AELTEREN `textFuerVektor` berechnet, ihre Pruefsumme passt heute
    // nicht mehr. Aus dem Speicher kommt genau der Vektor, mit dem die
    // Produktion gerade arbeitet — das ist die treuere Quelle, nicht nur die
    // bequemere.
    const vt = ausSpeicher?.volltext[l.topic] ?? hol('volltext', textFuerVektor(l));
    if (vt) volltext[l.topic] = vt;
    const nv = ausSpeicher?.name[l.topic] ?? hol('name', textFuerNamensVektor(l.topic));
    if (nv) name[l.topic] = nv;

    const texte = fehlertexteAus(eingangsText(l));
    const tueren: Record<string, string> = {};
    for (const t of texte) {
      const ev = hol('fehlertext', t);
      // Der Schluessel wird auf 200 Zeichen gekuerzt — genau wie beim Schreiben
      // in den echten Speicher (schreibeEingaenge). Waere das hier anders, haette
      // der Messstand andere Tueren als das Produkt.
      if (ev) tueren[t.slice(0, 200)] = ev;
    }
    if (Object.keys(tueren).length > 0) eingaenge[l.topic] = tueren;
  }

  const fragenVek: Record<string, string> = {};
  for (const q of fragen) {
    const fv = hol('frage', q.query);
    if (fv) fragenVek[q.query] = fv;
  }

  return {
    korpus: {
      _hinweis: 'Lektionen aus einem echten Bestand. Die Fragen hat ein Mensch geschrieben, ohne die Lektion abzuschreiben — sonst misst der Messstand sich selbst.',
      lektionen,
      fragen,
    },
    vektoren: {
      _hinweis: 'Vektoren als int8-base64 (siehe packe/entpacke in bedeutung.ts). Als float32-JSON waeren dieselben Daten 22,9 MB.',
      volltext,
      name,
      eingaenge,
      fragen: fragenVek,
    },
    fehlend,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const satzPfad = resolve(flag('pruefsatz') ?? '');
  const vekPfad = resolve(flag('vektoren') ?? '');
  const ziel = resolve(flag('nach') ?? '');
  for (const [was, p] of [['Pruefsatz', satzPfad], ['Vektoren', vekPfad]] as const) {
    if (!existsSync(p)) { console.error(`NICHT GELAUFEN: ${was} fehlt (${p}).`); process.exit(2); }
  }

  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as { lessons: Lektion[]; queries: Frage[] };
  const roh = (JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> }).vektoren;

  // Optional: die aktuellen Vektoren aus einem laufenden Speicher holen.
  let ausSpeicher: { volltext: Record<string, string>; name: Record<string, string> } | undefined;
  const url = process.env.CACHLY_REDIS_URL ?? process.env.REDIS_URL;
  if (url) {
    const { Redis } = await import('ioredis');
    const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
    try {
      const themen = satz.lessons.map((l) => l.topic);
      const volltext: Record<string, string> = {};
      const name: Record<string, string> = {};
      for (let i = 0; i < themen.length; i += 100) {
        const block = themen.slice(i, i + 100);
        const vs = await redis.mget(...block.map((t) => `cachly:lesson:vec:${t}`));
        const ns = await redis.mget(...block.map((t) => `cachly:lesson:vecname:${t}`));
        for (const [j, v] of vs.entries()) if (v) volltext[block[j]] = v;
        for (const [j, v] of ns.entries()) if (v) name[block[j]] = v;
      }
      ausSpeicher = { volltext, name };
      console.log(`  aus dem Speicher: ${Object.keys(volltext).length} Volltext- und ${Object.keys(name).length} Namensvektoren`);
    } finally {
      redis.disconnect();
    }
  }

  const { korpus, vektoren, fehlend } = friereEin(satz.lessons, satz.queries, roh, ausSpeicher);

  mkdirSync(ziel, { recursive: true });
  const kPfad = join(ziel, 'korpus.json');
  const vPfad = join(ziel, 'korpus-vektoren.json');
  writeFileSync(kPfad, `${JSON.stringify(korpus, null, 1)}\n`, { encoding: 'utf8' });
  writeFileSync(vPfad, `${JSON.stringify(vektoren)}\n`, { encoding: 'utf8' });

  const groesse = (p: string): string => `${(readFileSync(p).length / 1024 / 1024).toFixed(2)} MB`;
  console.log(`  Lektionen : ${korpus.lektionen.length}`);
  console.log(`  Fragen    : ${korpus.fragen.length}`);
  console.log(`  Volltext  : ${Object.keys(vektoren.volltext).length}`);
  console.log(`  Namen     : ${Object.keys(vektoren.name).length}`);
  console.log(`  Eingaenge : ${Object.values(vektoren.eingaenge).reduce((n, t) => n + Object.keys(t).length, 0)} in ${Object.keys(vektoren.eingaenge).length} Lektionen`);
  console.log(`  Fragevekt.: ${Object.keys(vektoren.fragen).length}`);
  console.log('');
  console.log(`  ${kPfad}  ${groesse(kPfad)}`);
  console.log(`  ${vPfad}  ${groesse(vPfad)}`);
  if (fehlend.length > 0) {
    console.error('');
    console.error(`  WARNUNG: ${fehlend.length} Vektoren fehlten in der Quelle. Erste drei:`);
    for (const f of fehlend.slice(0, 3)) console.error(`    ${f}`);
  }
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/korpus-einfrieren.ts');
if (direktGestartet) main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
