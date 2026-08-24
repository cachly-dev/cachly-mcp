/**
 * ══ Viele Ernten zu EINEM Fremdsatz ════════════════════════════════════════
 *
 * ── Wozu ──────────────────────────────────────────────────────────────────
 *
 * `fremdernte.ts` schreibt je Projekt eine Datei. Die Verallgemeinerungsprobe
 * braucht aber EINEN Satz: nur dann steht am Ende eine Zahl, die etwas ueber
 * Software allgemein sagt und nicht ueber go-gitea.
 *
 * ── Warum das nicht "einfach zusammenkopieren" ist ────────────────────────
 *
 * Drei Dinge gehen dabei schief, und alle drei still:
 *
 *   1. **Eine leere Ernte verschwindet spurlos.** Am 24.08.2026 meldeten zehn
 *      von sechzehn Projekten null Paare (leeres Kontingent, als "kein PR"
 *      gebucht). Beim Zusammenkopieren waere davon NICHTS zu sehen gewesen —
 *      der Satz waere einfach kleiner gewesen als gedacht.
 *
 *   2. **Ein Projekt kann den Satz uebernehmen.** grafana hat 12022 Paare,
 *      nats-server 552. Wer alles nimmt, misst am Ende grafana. Deshalb gibt
 *      es eine Obergrenze JE PROJEKT.
 *
 *   3. **Dubletten ueber Projektgrenzen.** Bot-PRs ("Bump x from a to b")
 *      sehen ueberall gleich aus und wuerden mehrfach zaehlen.
 *
 * ── Was ausdruecklich NICHT passiert ─────────────────────────────────────
 *
 * Es wird nicht gemischt, nicht gekuerzt und nichts umgeschrieben. Die
 * Reihenfolge bleibt projektweise, damit man im Ergebnis noch sieht, woher
 * ein Paar kommt. Die Auswahl hat `fremdernte.ts` schon getroffen.
 *
 * Aufruf:
 *   npx tsx src/bench/ernten-zusammenfuehren.ts \
 *     --ordner ~/.cachly/bench-korpus --nach ~/.cachly/bench-korpus/ernte-fremd.json
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pruefePaar } from './fremdernte.js';

type Ernte = {
  name?: string;
  lessons: Array<{ topic: string; what_worked: string }>;
  queries: Array<{ query: string; relevant: string[] }>;
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Zwei Lektionen, die praktisch dasselbe sagen — etwa aus einem Bot. */
export function abdruck(lektion: string): string {
  return lektion.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

function main(): void {
  const ordner = flag('ordner');
  const nach = flag('nach');
  const jeProjekt = Number(flag('je-projekt') ?? '500');
  if (!ordner || !nach) {
    console.error('NICHT ZUSAMMENGEFUEHRT: --ordner <pfad> und --nach <datei.json> sind Pflicht.');
    process.exit(2);
  }

  const dateien = readdirSync(resolve(ordner))
    .filter((n) => /^ernte-.+\.json$/.test(n))
    // Das Ergebnis selbst und seine Nebendateien duerfen nicht wieder hinein.
    .filter((n) => !/^ernte-fremd(\.|-)/.test(n) && n !== 'ernte-fremd.json')
    .sort();

  if (dateien.length === 0) {
    console.error(`NICHT ZUSAMMENGEFUEHRT: keine ernte-*.json in ${ordner}.`);
    process.exit(3);
  }

  const lessons: Ernte['lessons'] = [];
  const queries: Ernte['queries'] = [];
  const gesehen = new Set<string>();
  const themen = new Set<string>();
  const bericht: Array<{ datei: string; drin: number; von: number; dublett: number; verworfen: number }> = [];
  const leere: string[] = [];
  const gruende = new Map<string, number>();

  for (const datei of dateien) {
    let e: Ernte;
    try {
      e = JSON.parse(readFileSync(join(resolve(ordner), datei), 'utf8')) as Ernte;
    } catch (err) {
      console.error(`  ⛔ ${datei} ist nicht lesbar: ${err instanceof Error ? err.message : err}`);
      process.exit(4);
    }

    const paare = (e.queries ?? []).length;
    if (paare === 0) { leere.push(datei); continue; }

    let drin = 0;
    let dublett = 0;
    let verworfen = 0;
    for (let i = 0; i < e.queries.length && drin < jeProjekt; i++) {
      const q = e.queries[i];
      const l = e.lessons[i];
      /*
       * Die beiden Listen stehen an derselben Stelle fuereinander. Stimmt das
       * nicht, waere jedes Paar falsch verbunden — und die Findequote saehe
       * trotzdem plausibel aus. Deshalb wird es geprueft, nicht angenommen.
       */
      if (!l || !q || q.relevant?.[0] !== l.topic) {
        console.error(`  ⛔ ${datei}: Frage ${i} und Lektion ${i} gehoeren nicht zusammen.`);
        console.error(`     Frage nennt ${q?.relevant?.[0] ?? '—'}, Lektion heisst ${l?.topic ?? '—'}`);
        process.exit(5);
      }
      /*
       * ── Das Tor, durch das auch ALTE Saetze muessen ────────────────────
       *
       * Die Ernten vom 23.08.2026 liefen noch ohne Auswahl. Gemessen im
       * ersten zusammengefuehrten Satz: 16,8 % mittlere Ueberlappung und 13
       * abgeschriebene Paare — alle aus jenen Ernten.
       *
       * Geprueft wird mit DERSELBEN Funktion, die `fremdernte.ts` benutzt.
       * Keine zweite Wahrheit: die Regel steht einmal, hier wird sie nur
       * noch einmal angewandt.
       */
      const hart = pruefePaar(q.query, l.what_worked);
      if (hart) {
        verworfen++;
        gruende.set(hart, (gruende.get(hart) ?? 0) + 1);
        continue;
      }
      const schluessel = abdruck(l.what_worked);
      if (gesehen.has(schluessel) || themen.has(l.topic)) { dublett++; continue; }
      gesehen.add(schluessel);
      themen.add(l.topic);
      lessons.push(l);
      queries.push(q);
      drin++;
    }
    bericht.push({ datei, drin, von: paare, dublett, verworfen });
  }

  /*
   * Erst melden, dann schreiben — und LEERE Ernten sind eine Meldung, keine
   * Kleinigkeit. Sie sind das Zeichen dafuer, dass eine Ernte abgebrochen ist.
   */
  if (leere.length > 0) {
    console.error('');
    console.error(`  ⛔ ${leere.length} Ernte(n) ohne ein einziges Paar:`);
    for (const d of leere) console.error(`     ${d}`);
    console.error('  Eine leere Ernte heisst fast immer: der Lauf ist abgebrochen.');
    console.error('  Loeschen oder neu ernten — nicht stillschweigend uebergehen.');
    process.exit(6);
  }

  console.log('');
  console.log('🧺  Ernten zusammengefuehrt');
  console.log('──────────────────────────────────────────────────────────────────────');
  for (const b of bericht) {
    const name = b.datei.replace(/^ernte-|\.json$/g, '');
    console.log(`  ${name.padEnd(18)} ${String(b.drin).padStart(5)} von ${String(b.von).padStart(5)}`
      + (b.dublett ? `  ${b.dublett} Dubletten` : '')
      + (b.verworfen ? `  ${b.verworfen} durchgefallen` : ''));
  }
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${bericht.length} Projekte · ${queries.length} Paare · Obergrenze ${jeProjekt} je Projekt`);
  if (gruende.size > 0) {
    console.log(`  durchgefallen: ${[...gruende].sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `${n} ${g}`).join(' · ')}`);
  }

  const ergebnis = {
    name: 'fremdsatz',
    _hinweis: `Zusammengefuehrt aus ${bericht.length} oeffentlichen Projekten `
      + `(${bericht.map((b) => b.datei.replace(/^ernte-|\.json$/g, '')).join(', ')}). `
      + 'Je Projekt hoechstens ' + jeProjekt + ' Paare, damit kein Projekt den Satz uebernimmt. '
      + 'Vor jeder Nutzung mit zirkel-messen.ts pruefen.',
    lessons,
    queries,
  };
  writeFileSync(resolve(nach), JSON.stringify(ergebnis, null, 1));
  console.log(`  geschrieben nach ${nach}`);
  console.log('');
  console.log('  Naechster Schritt — OHNE ihn ist der Satz wertlos:');
  console.log(`    npx tsx src/bench/zirkel-messen.ts --korpus ${nach} --fragen ${nach}`);
}

main();
