#!/usr/bin/env node
/**
 * ══ Wie oft enthaelt Top-k BEIDE Seiten eines Widerspruchs? ═══════════════
 *
 * ── Das oeffentliche Versprechen (Karte mco8r4god525) ─────────────────────
 *
 * Aus dem Izgorodin-Faden (25.08.2026): bevor wir den Antwort-Typ um
 * Widerspruchs-KANTEN erweitern, messen wir, ob das Problem ueberhaupt im
 * FORMAT der Antwort liegt — oder in der ZUTEILUNG, weil der Verlierer es
 * gar nicht erst in die Liste schafft. Steht die widerlegte Seite selten
 * genug neben der gueltigen, ist die Kanten-Debatte fuers echte Verhalten
 * zweitrangig: Zuteilung zuerst.
 *
 * ── Woher die Paare kommen ────────────────────────────────────────────────
 *
 * Aus der Korrektur-Historie des LIVE-Bestands: Lektionen mit
 * `ersetzt_durch` (die alte, widerlegte Seite) und ihrem Nachfolger.
 * Das sind AUSDRUECKLICHE Widersprueche — ein Mensch hat entschieden,
 * dass die eine Fassung die andere abloest.
 *
 * ── Die Frage traegt die Woerter des THEMAS, nicht der Antwort ────────────
 *
 * Je Paar wird die Frage aus dem Themennamen der ALTEN Fassung gebaut
 * (deploy:cache-npm -> "deploy cache npm"). Eine Frage aus dem Lektionstext
 * waere Selbstbetrug: sie truege die Woerter der Antwort, und jede
 * Rangfolge faende sie (Regel aus korpus-aus-brain.ts).
 *
 * ── Gemessen wird die AUSGELIEFERTE Sortierung ────────────────────────────
 *
 * Derselbe Weg wie echter-korpus.ts: eingefrorene Lektionen + Vektoren,
 * messe() mit Produktions-Topf und -Tueren. Nur die Fragen sind neu und
 * werden mit demselben Modell eingebettet wie der Korpus (bge-m3).
 *
 * WICHTIG: die VERDRAENGUNG aus dem Produktionspfad (ersetzte Fassung wird
 * aus der Liste genommen und als Notiz genannt) laeuft NACH der Sortierung
 * in handlers/brain.ts. Dieser Messstand misst die Sortierung DAVOR — also
 * genau die Zuteilungsfrage der Karte: schafft es der Verlierer ueberhaupt
 * in den Topf und nach vorne?
 *
 * Aufruf:
 *   REDIS_URL=... npx tsx src/bench/widerspruch-in-topk.ts \
 *     [--ollama http://10.8.0.1:11434] [--modell bge-m3]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import Redis from 'ioredis';
import { MiniRedis } from './mini-redis.js';
import { baueBestand, type Korpus, type Vektoren } from './echter-korpus.js';
import { messe, type Frage } from './auswertung.js';
import { buendelEinbetten } from './einbetten-schnell.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { SINN_TOPF, EINGANG_SCHWELLE, EINGANG_SORTIER_GEWICHT } from '../rangfolge-stellschrauben.js';

type Paar = { alt: string; neu: string };

/** Frage aus dem Themennamen: Trenner werden Leerzeichen, sonst nichts. */
export function frageAusThema(topic: string): string {
  return topic.replace(/[:\-_/.]+/g, ' ').trim();
}

/** Zaehlt je Paar, wer in den ersten k steht. */
export function urteil(rang: string[], paar: Paar, k: number):
  'beide' | 'nur-sieger' | 'nur-verlierer' | 'keiner' {
  const kopf = new Set(rang.slice(0, k));
  const sieger = kopf.has(paar.neu);
  const verlierer = kopf.has(paar.alt);
  if (sieger && verlierer) return 'beide';
  if (sieger) return 'nur-sieger';
  if (verlierer) return 'nur-verlierer';
  return 'keiner';
}

async function paareAusLive(url: string): Promise<Paar[]> {
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 15000 });
  await redis.connect();
  const paare: Paar[] = [];
  let cursor = '0';
  do {
    const [next, schluessel] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 500);
    cursor = next;
    if (schluessel.length === 0) continue;
    const werte = await redis.mget(...schluessel);
    for (const [i, roh] of werte.entries()) {
      if (!roh) continue;
      try {
        const l = JSON.parse(roh) as { ersetzt_durch?: string };
        if (l.ersetzt_durch) {
          paare.push({ alt: schluessel[i].replace('cachly:lesson:best:', ''), neu: l.ersetzt_durch });
        }
      } catch { /* kaputte Zeile ist ein doctor-Thema */ }
    }
  } while (cursor !== '0');
  await redis.quit();
  return paare;
}

async function main(): Promise<void> {
  const flag = (n: string, standard: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? standard : process.argv[i + 1];
  };
  const url = process.env.REDIS_URL ?? process.env.CACHLY_REDIS_URL;
  if (!url) { console.error('NICHT GEMESSEN: REDIS_URL fehlt.'); process.exit(2); }

  const hier = dirname(fileURLToPath(import.meta.url));
  const korpus = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus.json'), 'utf8')) as Korpus;
  const v = JSON.parse(readFileSync(join(hier, 'korpus', 'korpus-vektoren.json'), 'utf8')) as Vektoren;
  const imKorpus = new Set(korpus.lektionen.map((l) => l.topic));

  const alle = await paareAusLive(url);
  const paare = alle.filter((p) => imKorpus.has(p.alt) && imKorpus.has(p.neu));
  console.log(`\n${alle.length} Korrektur-Paare im Live-Bestand, ${paare.length} davon vollstaendig im eingefrorenen Korpus.`);
  if (paare.length === 0) { console.error('NICHT GEMESSEN: kein Paar im Korpus.'); process.exit(2); }

  // Fragen einbetten — dasselbe Modell wie der Korpus (bge-m3), sonst
  // misst der Lauf eine andere Suchmaschine als die ausgelieferte.
  const fragenText = paare.map((p) => frageAusThema(p.alt));
  const vektoren = await buendelEinbetten(
    flag('ollama', 'http://10.8.0.1:11434'), flag('modell', 'bge-m3'), fragenText, 7, 'ollama',
  );
  if (!vektoren || vektoren.length !== fragenText.length) {
    console.error('NICHT GEMESSEN: Einbetten fehlgeschlagen.');
    process.exit(2);
  }

  const redis: MiniRedis = baueBestand(korpus, v);
  const vektorbestand = new Vektorbestand();
  const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
  const eingangsbestand = new Eingangsbestand();
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await eingangsbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);
  const bestaende = { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand };

  const fragen: Frage[] = paare.map((p, i) => ({
    query: fragenText[i],
    // relevant traegt BEIDE Seiten — der Platz interessiert hier nicht,
    // nur die Rangliste aus der Senke.
    relevant: [p.neu, p.alt],
  }));
  const frageVektor = (q: Frage): number[] | null =>
    vektoren[fragenText.indexOf(q.query)] ?? null;

  const raenge = new Map<string, string[]>();
  await messe(redis, fragen, frageVektor, bestaende, {
    pool: SINN_TOPF,
    zusatzMerkmal: {
      werte: (fv, topic) => {
        const n = eingangsbestand.besteNaehe(fv, topic);
        return n >= EINGANG_SCHWELLE ? n : -2;
      },
      gewicht: EINGANG_SORTIER_GEWICHT,
    },
    rangSenke: (q, rang) => { raenge.set(q.query, rang); },
  });

  console.log(`\n  k     beide   nur Sieger   nur Verlierer   keiner   (${paare.length} Paare)`);
  for (const k of [3, 5, 10]) {
    const z = { 'beide': 0, 'nur-sieger': 0, 'nur-verlierer': 0, 'keiner': 0 };
    for (const [i, p] of paare.entries()) {
      const rang = raenge.get(fragenText[i]) ?? [];
      z[urteil(rang, p, k)]++;
    }
    const pct = (n: number) => `${String(Math.round((100 * n) / paare.length)).padStart(3)} %`;
    console.log(`  ${String(k).padStart(2)}   ${pct(z.beide)}      ${pct(z['nur-sieger'])}          ${pct(z['nur-verlierer'])}      ${pct(z.keiner)}`);
  }

  console.log(`
LESEHILFE (Messplan der Karte): Liegt "beide" bei k=3 unter ~20 %, ist die
Debatte um Widerspruchs-Kanten im ANTWORTFORMAT fuers echte Verhalten
zweitrangig — der Verlierer schafft es meist gar nicht erst in die Liste,
und der Hebel liegt in der ZUTEILUNG.

Gemessen ist die Sortierung VOR der Verdraengung (handlers/brain.ts nimmt
die ersetzte Fassung nachtraeglich aus der Liste und nennt sie als Notiz —
im Produkt sieht der Nutzer "beide" daher ohnehin nur als Notiz).`);
}

// Nur beim direkten Aufruf laufen — die Proben importieren frageAusThema
// und urteil, und ein main() beim Import wuerde im Testlauf exit(2) rufen
// (genau so fiel die CI von PR #539 um).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
