/**
 * Tuersteher-Messung (Abhakliste 4.4, erster Teil, ohne Modell).
 *
 *   npm run bench:tuersteher
 *   npm run bench:tuersteher -- --proben <giftproben.jsonl> --haus <korpus-gross.json>
 *
 * Misst, was der Schreibweg (Geheimnis-Filter + Tuersteher) mit den 100
 * Giftproben tut: je Art, wie viele Giftproben erkannt werden und wie viele
 * harmlose Proben falschen Alarm ausloesen. Dazu die Gegenprobe auf den 499
 * Hauslektionen des Bench-Korpus: jeder Treffer dort ist vermutlich Fehlalarm.
 *
 * ── Keine Ueberanpassung ────────────────────────────────────────────────────
 *
 * Die Proben werden mit fester Saat in zwei Haelften geteilt (tuersteher-kern.ts).
 * Regeln werden nur an der EINSTELLHAELFTE gebaut; Einzelheiten (welche Probe
 * verpasst wurde) zeigt das Skript nur dafuer. Die Zahlen fuer die PRUEFHAELFTE
 * sind die, die gelten. `--pruef-einzeln` schaltet die Einzelheiten dafuer frei —
 * wer damit Regeln baut, hat keine Pruefhaelfte mehr.
 *
 * Die Probendatei liegt ausserhalb des Repos (Claude-erzeugter Text, nicht zur
 * Veroeffentlichung). Fehlt sie, misst das Skript die kleine, erfundene
 * Teilmenge aus api/internal/tuersteher/testdata/faelle.json und sagt das.
 *
 * "Vorher" steht in tuersteher-vorher.json: gemessen mit dem Filter von
 * origin/main (nur Geheimnisse), neu schreiben mit `--als-vorher` auf altem Stand.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schwaerze } from '../geheimnis-filter.js';
import { pruefeMitStelle } from '../tuersteher.js';
import { MUSTER_ARTEN, SAAT, messe, summe, teile, urteil, type ArtZahl, type Probe } from './tuersteher-kern.js';

const HIER = dirname(fileURLToPath(import.meta.url));
const VORHER_DATEI = join(HIER, 'tuersteher-vorher.json');
const KLEIN_DATEI = resolve(HIER, '..', '..', '..', '..', 'api', 'internal', 'tuersteher', 'testdata', 'faelle.json');
const ARTEN = ['prompt_injektion', 'befehl_einschleusung', 'geheimnis_klartext', 'falschaussage'];

interface Vorher {
  stand: string;
  probenSumme: string;
  einstell: Record<string, ArtZahl>;
  pruef: Record<string, ArtZahl>;
  haus: { lektionen: number; treffer: number };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hat = (name: string) => process.argv.includes(name);

function ladeProben(): { proben: Probe[]; quelle: string; voll: boolean; summe: string } {
  const pfad = arg('--proben') ?? process.env.TUERSTEHER_PROBEN ?? join(homedir(), '.cachly', 'entscheider', 'trainingssatz-v1', 'giftproben-v1.jsonl');
  if (existsSync(pfad)) {
    const roh = readFileSync(pfad, 'utf8');
    const proben = roh.trim().split('\n').map((l) => JSON.parse(l) as Probe);
    return { proben, quelle: pfad, voll: true, summe: createHash('sha256').update(roh).digest('hex') };
  }
  const klein = JSON.parse(readFileSync(KLEIN_DATEI, 'utf8')) as { proben: Array<{ art: string; label: 'gift' | 'harmlos'; text: string }> };
  const proben = klein.proben.map((p, i) => ({ id: `klein-${String(i + 1).padStart(3, '0')}`, ...p }));
  return { proben, quelle: `${KLEIN_DATEI} (kleine erfundene Teilmenge; ${pfad} nicht gefunden)`, voll: false, summe: '' };
}

function zeile(art: string, z: ArtZahl | undefined, v: ArtZahl | undefined): string {
  if (!z) return `  ${art.padEnd(26)}-`;
  const g = v ? `${v.giftErkannt} -> ${z.giftErkannt}` : `${z.giftErkannt}`;
  const h = v ? `${v.harmlosAlarm} -> ${z.harmlosAlarm}` : `${z.harmlosAlarm}`;
  return `  ${art.padEnd(26)}Gift ${g.padEnd(9)} von ${String(z.gift).padEnd(3)} falscher Alarm ${h.padEnd(8)} von ${z.harmlos}`;
}

function tabelle(titel: string, n: number, z: Record<string, ArtZahl>, v: Record<string, ArtZahl> | undefined): void {
  console.log(`\n${titel} (${n} Proben)`);
  for (const art of ARTEN.filter((a) => MUSTER_ARTEN.includes(a))) console.log(zeile(art, z[art], v?.[art]));
  console.log(zeile('Summe Muster-Arten', summe(z, MUSTER_ARTEN), v ? summe(v, MUSTER_ARTEN) : undefined));
  console.log(zeile('falschaussage (Modell)', z.falschaussage, v?.falschaussage));
  console.log(zeile('alle vier Arten', summe(z), v ? summe(v) : undefined));
}

function einzeln(titel: string, proben: Probe[]): void {
  console.log(`\n${titel}`);
  for (const p of proben.sort((a, b) => a.id.localeCompare(b.id))) {
    const u = urteil(p.text);
    if (p.label === 'gift' && !u.erkannt) console.log(`  VERPASST  ${p.id} ${p.art}`);
    if (p.label === 'harmlos' && u.erkannt) {
      const was = [...u.geheimnis, ...u.verdacht.map((f) => `${f.art}/${f.regel}`)].join(', ');
      console.log(`  ALARM     ${p.id} ${p.art}: ${was}`);
    }
  }
}

function hauslektionen(pfad: string, zeigen: boolean, mitTuersteher = true): { lektionen: number; treffer: number } | undefined {
  if (!existsSync(pfad)) {
    console.log(`\nHauslektionen: ${pfad} nicht gefunden, uebersprungen.`);
    return undefined;
  }
  const k = JSON.parse(readFileSync(pfad, 'utf8')) as { lessons: Array<Record<string, unknown>> };
  let treffer = 0;
  for (const l of k.lessons) {
    const felder: Array<[string, string]> = [];
    for (const f of ['topic', 'what_worked', 'what_failed', 'context']) if (typeof l[f] === 'string') felder.push([f, l[f] as string]);
    for (const f of ['commands', 'file_paths']) if (Array.isArray(l[f])) for (const x of l[f] as unknown[]) if (typeof x === 'string') felder.push([f, x]);
    let diese = 0;
    for (const [feld, text] of felder) {
      const geheim = schwaerze(text);
      for (const f of geheim.funde) {
        diese++;
        if (zeigen) {
          const i = geheim.text.indexOf('[GESCHWAERZT]');
          console.log(`  HAUS ${String(l.topic).slice(0, 60)} [${feld}] ${f}: ...${geheim.text.slice(Math.max(0, i - 50), i + 30).replace(/\s+/g, ' ')}...`);
        }
      }
      for (const f of mitTuersteher ? pruefeMitStelle(text) : []) {
        diese++;
        if (zeigen) console.log(`  HAUS ${String(l.topic).slice(0, 60)} [${feld}] ${f.art}/${f.regel}: ${f.stelle.slice(0, 110).replace(/\s+/g, ' ')}`);
      }
    }
    if (diese > 0) treffer++;
  }
  return { lektionen: k.lessons.length, treffer };
}

function main(): void {
  const saat = Number(arg('--saat') ?? SAAT);
  const { proben, quelle, voll, summe: pruefsumme } = ladeProben();
  const { einstell, pruef } = teile(proben, saat);
  const mitTuersteher = !hat('--als-vorher');

  console.log(`Tuersteher-Messung  Saat ${saat}${voll ? '' : '  (NUR KLEINE TEILMENGE)'}\nProben: ${quelle}`);
  const gift = proben.filter((p) => p.label === 'gift').length;
  console.log(`${proben.length} Proben (${gift} Gift, ${proben.length - gift} harmlos), Einstellhaelfte ${einstell.length}, Pruefhaelfte ${pruef.length}`);

  const hausPfad = arg('--haus') ?? join(homedir(), '.cachly', 'bench-korpus', 'korpus-gross.json');

  if (hat('--als-vorher')) {
    const haus = hauslektionen(hausPfad, false, false);
    const v: Vorher = {
      stand: arg('--stand') ?? 'origin/main vor dem Tuersteher',
      probenSumme: pruefsumme,
      einstell: messe(einstell, false),
      pruef: messe(pruef, false),
      haus: haus ?? { lektionen: 0, treffer: 0 },
    };
    writeFileSync(VORHER_DATEI, JSON.stringify(v, null, 2) + '\n');
    console.log(`\nVorher geschrieben: ${VORHER_DATEI}`);
    return;
  }

  let vorher: Vorher | undefined;
  if (existsSync(VORHER_DATEI)) {
    vorher = JSON.parse(readFileSync(VORHER_DATEI, 'utf8')) as Vorher;
    if (voll && vorher.probenSumme && vorher.probenSumme !== pruefsumme) {
      console.log('\nHinweis: "vorher" wurde mit einer anderen Probendatei gemessen (Pruefsumme verschieden) und gilt nur zum Anhalt.');
      vorher = undefined;
    }
    if (!voll) vorher = undefined; // Vorher gilt nur fuer die volle Datei.
  }

  tabelle('EINSTELLHAELFTE (daran werden Regeln gebaut)', einstell.length, messe(einstell, mitTuersteher), vorher?.einstell);
  tabelle('PRUEFHAELFTE (diese Zahlen gelten)', pruef.length, messe(pruef, mitTuersteher), vorher?.pruef);

  if (hat('--einstell-einzeln')) einzeln('Einstellhaelfte, Einzelheiten', einstell);
  if (hat('--pruef-einzeln')) einzeln('Pruefhaelfte, Einzelheiten (damit keine Regeln bauen!)', pruef);

  const haus = hauslektionen(hausPfad, hat('--haus-einzeln'));
  if (haus) {
    const vor = vorher ? ` (vorher ${vorher.haus.treffer})` : '';
    console.log(`\nHauslektionen: ${haus.lektionen}, davon mit Treffer: ${haus.treffer}${vor}. Jeder Treffer ist vermutlich Fehlalarm.`);
  }
  console.log('\nFalschaussagen sind Text ohne Merkmal; sie bleiben dem Entscheider (Abhakliste 4.3) ueberlassen.');
}

main();
