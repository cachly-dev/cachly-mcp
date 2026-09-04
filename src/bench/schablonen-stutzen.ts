#!/usr/bin/env node
/**
 * ══ Schablonen-Token aus den FRAGEN streichen, vor dem Einbetten ══════════
 *
 * ── Der vorregistrierte Hebel (Karte nuryz7a1bb8z, Naturworkshop 3) ───────
 *
 * Der Wellenphysiker: Schablonenwörter (reproduce, version, failed …)
 * tragen ~10 % der Seltenheitsmasse einer Frage, aber ~36 % ihrer TOKEN —
 * und die Einbettung mittelt sie voll mit. Der Fragevektor zeigt dadurch
 * mehr auf "Issue-Formular" als auf den Fehler.
 *
 * WIDERLEGUNG (stand vor dem Lauf in der Karte): unter +2 Punkten @3 auf
 * Satz B, ODER die wortarme Hälfte fällt, ODER die mittlere
 * Kosinus-Verschiebung liegt unter 0,03 — dann ist der Hebel widerlegt.
 *
 * ── Warum die Liste aus den FRAGEN kommt, nicht aus einer Meinung ─────────
 *
 * Schablone ist, was in vielen Fragen steht: die Dokumenthäufigkeit über
 * die Fragen der EINSTELLHÄLFTE entscheidet. Kein handgepflegtes
 * Wörterbuch — das wäre die QUELLENMUSTER-Falle (Punkte-Verbot) in neu.
 *
 * ── Die drei Schritte ─────────────────────────────────────────────────────
 *
 *   bauen      Liste + Statistik aus Hälfte A (prüft auch die 36 %/10 %-
 *              Behauptung der Karte nach)
 *   einbetten  gestutzte Fragen einbetten, Vektordatei-KOPIE schreiben
 *              (frage:-Schlüssel der ORIGINALFRAGE → Vektor des Stutzens)
 *   saetze     Satz-A/B-Dateien schreiben (Fragen laut merkmale-fremd-*)
 *
 * Danach misst findequote-messen unverändert: --pruefsatz satz-A.json
 * --vektoren <kopie> gegen die Original-Vektoren. Hälfte B genau EINMAL.
 *
 * ── DAS URTEIL (31.08.2026, Hälfte A, 1999 Fragen): WIDERLEGT ─────────────
 *
 *                    Grundlinie   df>=20% (19% Token)   df>=10% (29% Token)
 *   Platz 1          923 (46,2%)  907  (−16)            906  (−17)
 *   Findequote@3    1210 (60,5%)  1186 (−24)            1178 (−32)
 *   Vorauswahl      1748 (87,4%)  1720 (−28)            1708 (−40)
 *   MRR             55,5 %        54,4                  54,2
 *
 *   MONOTON schlechter, je mehr gestutzt wird — auf allen vier Kennzahlen,
 *   und schon die DECKE fällt: das Stutzen schadet bereits der
 *   Sinn-Nominierung, nicht erst der Sortierung. Die vorregistrierte
 *   Widerlegung (unter +2 Punkten @3) ist damit klar erfüllt; Hälfte B
 *   wurde NICHT angefasst (es gab keinen Kandidaten zu bestätigen).
 *
 *   Die Lehre: der Wellenphysiker-Mechanismus (Token-Masse erdrückt
 *   Seltenheitsmasse) beschreibt Wortstatistik — eine
 *   Transformer-Einbettung (bge-m3) mittelt Formular-Töne offenbar nicht
 *   schädlich, sie NUTZT sie als Kontext. NICHT WIEDERHOLEN; der Hebel
 *   gegen die 60 % Text-Verluste muss woanders liegen (Symptomfeld,
 *   andere Türen, andere Einbettung).
 */

import { readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { inhaltsWoerter, grobStamm, Seltenheit } from '../rangfolge.js';
import { buendelEinbetten, schluessel } from './einbetten-schnell.js';

const BASIS = 'C:/Users/heinr/.cachly/bench-korpus';

type Frage = { query: string; relevant: string[] };
type Satz = { name?: string; lessons: Array<{ topic: string; what_worked?: string; what_failed?: string }>; queries: Frage[] };

/** Fragenmenge einer Merkmals-Hälfte (die Datei IST der Schnitt). */
async function fragenVon(pfad: string): Promise<Set<string>> {
  const raus = new Set<string>();
  const rl = createInterface({ input: createReadStream(pfad) });
  for await (const zeile of rl) {
    if (!zeile.trim()) continue;
    try { raus.add((JSON.parse(zeile) as Frage).query); } catch { /* kaputt */ }
  }
  return raus;
}

/**
 * Die Schablonen-Liste: Stämme, die in mindestens `anteil` der A-Fragen
 * stehen. Der Wert ist ein Einstell-Parameter — Hälfte A wählt ihn.
 */
export function bauListe(fragen: string[], anteil: number): Set<string> {
  const df = new Map<string, number>();
  for (const q of fragen) {
    const staemme = new Set([...inhaltsWoerter(q)].map(grobStamm));
    for (const s of staemme) df.set(s, (df.get(s) ?? 0) + 1);
  }
  const schwelle = anteil * fragen.length;
  return new Set([...df.entries()].filter(([, n]) => n >= schwelle).map(([s]) => s));
}

/** Die Frage ohne Schablonen-Token — Wortkanal bleibt unberührt. */
export function stutze(query: string, liste: Set<string>): string {
  const woerter = query.split(/\s+/);
  const uebrig = woerter.filter((w) => {
    const inhalt = [...inhaltsWoerter(w)];
    if (inhalt.length === 0) return false; // reine Satzzeichen fallen mit
    return !inhalt.every((iw) => liste.has(grobStamm(iw)));
  });
  // Eine ganz leergestutzte Frage waere ein Nullvektor-Kandidat — dann
  // lieber das Original: kein Signal ist schlechter als das alte.
  return uebrig.length > 0 ? uebrig.join(' ') : query;
}

async function main(): Promise<void> {
  const modus = process.argv[2];
  const flag = (n: string, standard: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? standard : process.argv[i + 1];
  };
  const satzPfad = flag('satz', `${BASIS}/fremdsatz-teil.json`);
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Satz;

  if (modus === 'saetze') {
    for (const h of ['A', 'B'] as const) {
      const menge = await fragenVon(`${BASIS}/merkmale-fremd-${h}.jsonl`);
      const teil: Satz = {
        name: `${satz.name ?? 'fremdsatz'}-${h}`,
        lessons: satz.lessons,
        queries: satz.queries.filter((q) => menge.has(q.query)),
      };
      const ziel = `${BASIS}/fremdsatz-haelfte-${h}.json`;
      writeFileSync(ziel, JSON.stringify(teil));
      console.log(`${ziel}: ${teil.queries.length} Fragen (Merkmale: ${menge.size})`);
    }
    return;
  }

  if (modus === 'bauen') {
    const menge = await fragenVon(`${BASIS}/merkmale-fremd-A.jsonl`);
    const aFragen = satz.queries.filter((q) => menge.has(q.query)).map((q) => q.query);
    const anteil = Number(flag('anteil', '0.05'));
    const liste = bauListe(aFragen, anteil);

    // Die Behauptung der Karte nachrechnen: wieviel Token-Masse und wieviel
    // Seltenheitsmasse streicht die Liste?
    const volltext = (l: Satz['lessons'][0]) => [l.topic, l.what_worked, l.what_failed].filter(Boolean).join(' ');
    const seltenheit = new Seltenheit(satz.lessons.map(volltext));
    let tokenAlle = 0; let tokenWeg = 0; let masseAlle = 0; let masseWeg = 0;
    for (const q of aFragen) {
      for (const w of q.split(/\s+/)) {
        const inhalt = [...inhaltsWoerter(w)];
        if (inhalt.length === 0) continue;
        tokenAlle++;
        const g = Math.max(...inhalt.map((iw) => seltenheit.wert(iw)));
        masseAlle += g;
        if (inhalt.every((iw) => liste.has(grobStamm(iw)))) { tokenWeg++; masseWeg += g; }
      }
    }
    writeFileSync(`${BASIS}/schablonen-liste.json`,
      JSON.stringify({ anteil, staemme: [...liste].sort() }, null, 1));
    console.log(`Liste: ${liste.size} Staemme (df >= ${(anteil * 100).toFixed(0)} % von ${aFragen.length} A-Fragen)`);
    console.log(`Gestrichen wuerden ${(100 * tokenWeg / tokenAlle).toFixed(1)} % der Token`);
    console.log(`mit ${(100 * masseWeg / masseAlle).toFixed(1)} % der Seltenheitsmasse`);
    console.log('(Karte behauptet ~36 % Token / ~10 % Masse — Abweichung ist ein Befund, kein Fehler.)');
    return;
  }

  if (modus === 'einbetten') {
    const liste = new Set(
      (JSON.parse(readFileSync(`${BASIS}/schablonen-liste.json`, 'utf8')) as { staemme: string[] }).staemme,
    );
    const vekPfad = flag('vektoren', `${BASIS}/fremdsatz-teil.vektoren.json`);
    const roh = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[] | string> };
    const gestutzt = satz.queries.map((q) => ({ original: q.query, kurz: stutze(q.query, liste) }));
    const geaendert = gestutzt.filter((g) => g.kurz !== g.original);
    console.log(`${geaendert.length} von ${gestutzt.length} Fragen veraendert — bette ein …`);

    const ollama = flag('ollama', 'http://10.8.0.1:11434');
    const modell = flag('modell', 'bge-m3');
    let fertig = 0;
    for (let i = 0; i < gestutzt.length; i += 16) {
      const block = gestutzt.slice(i, i + 16);
      const vs = await buendelEinbetten(ollama, modell, block.map((b) => b.kurz), 7, 'ollama');
      if (!vs) { console.error(`NICHT GEMESSEN: Einbetten scheiterte bei Block ${i}.`); process.exit(2); }
      for (const [j, b] of block.entries()) {
        // ROHE Arrays, kein packe(): die Vektordatei des Fremdsatzes
        // traegt Float-Arrays, und findequote-messen liest sie unentpackt.
        // Die erste Fassung schrieb int8-Strings hinein — der Messlauf
        // starb an frage.map (30.08., Lauf bg9qgt8qd).
        roh.vektoren[schluessel('frage', b.original)] = vs[j];
      }
      fertig += block.length;
      if (fertig % 320 === 0) console.log(`  ${fertig}/${gestutzt.length}`);
    }
    const ziel = flag('nach', `${BASIS}/fremdsatz-teil.vektoren.gestutzt.json`);
    writeFileSync(ziel, JSON.stringify(roh));
    console.log(`Geschrieben: ${ziel}`);
    return;
  }

  console.error('Aufruf: schablonen-stutzen.ts saetze|bauen|einbetten [--anteil 0.05] [--satz ...]');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
