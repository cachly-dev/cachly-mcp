/**
 * impfziele.ts — welche Lektionen bekommen im Minimaltest eine Fragewolke?
 *
 * ── Warum nicht einfach alle ────────────────────────────────────────────────
 *
 * Alle 499 zu impfen kostet ~1850 Einbettungen. Bevor das jemand ausgibt,
 * soll ein scharfer kleiner Test die Richtung zeigen. Scharf heisst hier:
 * er darf das Ergebnis nicht schoenrechnen.
 *
 * ── Die Falle, gegen die dieser Aufbau gebaut ist ───────────────────────────
 *
 * Impft man NUR die Lektionen, die von Pruef-Fragen getroffen werden, bekommen
 * genau die richtigen Antworten ein Merkmal, das alle Ablenker nicht haben.
 * Das Merkmal misst dann nicht Passung, sondern Zugehoerigkeit zur richtigen
 * Antwortmenge — und das Ergebnis waere grossartig und wertlos.
 *
 * Deshalb: zu jeder Ziel-Lektion kommt ein zufaelliger ABLENKER dazu, der
 * dieselbe Behandlung bekommt. Nur so misst der Test, ob die Wolke die
 * richtige Lektion nach vorne bringt — und nicht, ob eine Wolke vorhanden ist.
 *
 * Die Ablenker werden deterministisch gezogen (fester Startwert), damit zwei
 * Laeufe dieselbe Menge liefern.
 *
 * Aufruf: npx tsx src/bench/impfziele.ts [--anzahl 20]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, type Frage } from './auswertung.js';
import { SINN_TOPF, EINGANG_SCHWELLE, EINGANG_SORTIER_GEWICHT } from '../rangfolge-stellschrauben.js';

interface Lektion { topic: string; what_worked?: string; what_failed?: string }
interface Korpus { lektionen: Lektion[]; fragen: Frage[] }
interface Vektoren { fragen: Record<string, string>; eingaenge: Record<string, Record<string, string>> }

const POOL = SINN_TOPF;


/** Deterministischer Zufall — zwei Laeufe, dieselbe Auswahl. */
function mische<T>(liste: T[], startwert = 20260821): T[] {
  let s = startwert;
  const a = [...liste];
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--anzahl');
  const anzahl = i > -1 ? Number(process.argv[i + 1]) : 20;

  const hier = dirname(fileURLToPath(import.meta.url));
  const korpus = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus.json'), 'utf8')) as Korpus;
  const v = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus-vektoren.json'), 'utf8')) as Vektoren;

  const redis = baueBestand(korpus as never, v as never);
  const vektorbestand = new Vektorbestand();
  const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
  const eingangsbestand = new Eingangsbestand();
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await eingangsbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);
  const bestaende = { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand };
  const fvVon = (q: Frage): number[] | null => {
    const g = v.fragen[q.query];
    return g ? entpacke(g) : null;
  };

  // Der ausgelieferte Stand, damit die Sortierfehler bekannt sind.
  const m = await messe(redis, korpus.fragen, fvVon, bestaende, {
    pool: POOL,
    zusatzMerkmal: {
      werte: (fv, topic) => {
        const n = eingangsbestand.besteNaehe(fv, topic);
        return n >= EINGANG_SCHWELLE ? n : -2;
      },
      gewicht: EINGANG_SORTIER_GEWICHT,
    },
  });

  const mitVektor = korpus.fragen.filter((q) => fvVon(q));
  // Sortierfehler: im Topf, aber nicht in den Top 3 — das ist heute der
  // Engpass (42 von 100). Topf-Verfehlungen (Platz 0) bleiben aussen vor:
  // die haben ein anderes Problem.
  const fehler = mitVektor
    .map((q, idx) => ({ q, platz: m.plaetze[idx] }))
    .filter((x) => x.platz > 3);

  console.log(`Sortierfehler (im Topf, nicht in Top 3): ${fehler.length}`);

  const ziele: string[] = [];
  for (const f of fehler) {
    for (const t of f.q.relevant) if (!ziele.includes(t)) ziele.push(t);
    if (ziele.length >= anzahl) break;
  }
  const zielMenge = ziele.slice(0, anzahl);

  // Gleich viele Ablenker, deterministisch gezogen, ohne Ueberschneidung.
  const rest = korpus.lektionen.map((l) => l.topic).filter((t) => !zielMenge.includes(t));
  const ablenker = mische(rest).slice(0, anzahl);

  const nachTopic = new Map(korpus.lektionen.map((l) => [l.topic, l]));
  const zeigen = (liste: string[], art: string): void => {
    for (const t of liste) {
      const l = nachTopic.get(t);
      console.log(JSON.stringify({
        topic: t,
        art,
        what_worked: (l?.what_worked ?? '').replace(/\s+/g, ' ').slice(0, 400),
        what_failed: (l?.what_failed ?? '').replace(/\s+/g, ' ').slice(0, 250),
      }));
    }
  };

  console.log(`\n--- ZIELE (${zielMenge.length}) und ABLENKER (${ablenker.length}) als JSONL ---`);
  zeigen(zielMenge, 'ziel');
  zeigen(ablenker, 'ablenker');
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
