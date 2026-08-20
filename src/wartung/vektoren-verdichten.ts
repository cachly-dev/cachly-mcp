/**
 * Vektoren von float32 auf int8 umschreiben — der Umzug, den `packe` braucht.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Am 20.08.2026 belegte ein Bestand mit 524 Lektionen 23,6 MB von 25 MB
 * Tarifgrenze — 94 %. Davon waren 11,2 MB Vektoren: 6,0 MB Volltext und Namen,
 * 5,2 MB Eingänge. Die nächste Lektion wäre an einem Schreibfehler gescheitert.
 *
 * `packe` schreibt seither int8 statt float32 (Faktor 3,96). Neu geschriebene
 * Lektionen sind damit klein. Die BESTEHENDEN bleiben groß, bis sie einmal neu
 * gelernt werden — und die meisten werden nie neu gelernt. Dieses Werkzeug
 * holt sie ein.
 *
 * ── Was es tut, und in welcher Reihenfolge ─────────────────────────────────
 *
 * 1. Sichern: jeder betroffene Schlüssel wird VORHER in eine Datei geschrieben.
 * 2. Prüfen: die Sicherung wird zurückgelesen und muss vollständig sein.
 * 3. Umschreiben: erst danach wird der Speicher angefasst.
 *
 * Ohne Schritt 2 wäre die Sicherung eine Behauptung. Eine Sicherung, die nie
 * zurückgelesen wurde, ist keine.
 *
 * Aufruf:
 *   REDIS_URL=... npx tsx src/wartung/vektoren-verdichten.ts --sicherung <datei>
 *   REDIS_URL=... npx tsx src/wartung/vektoren-verdichten.ts --sicherung <datei> --schreiben
 *   REDIS_URL=... npx tsx src/wartung/vektoren-verdichten.ts --sicherung <datei> --zurueck
 *
 * Ohne `--schreiben` wird nur gerechnet und gemeldet. Das ist Absicht: der
 * Trockenlauf ist der Normalfall, das Schreiben ist der Sonderfall.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Redis } from 'ioredis';
import { packe, entpacke } from '../bedeutung.js';

interface Sicherung {
  werte: Record<string, string>;
  hashes: Record<string, Record<string, string>>;
}

/** Alle Schlüssel zu einem Muster, ohne KEYS (das blockiert den Server). */
export async function alleSchluessel(redis: Redis, muster: string): Promise<string[]> {
  const aus: string[] = [];
  let cursor = '0';
  do {
    const [next, gefunden] = await redis.scan(cursor, 'MATCH', muster, 'COUNT', 500);
    cursor = next;
    aus.push(...gefunden);
  } while (cursor !== '0');
  return aus;
}

/**
 * Ist dieser Wert schon im neuen Format?
 *
 * Wird gebraucht, damit ein zweiter Lauf nichts kaputt macht und nichts doppelt
 * zählt. Ein Umzug, der nur einmal laufen darf, ist ein Umzug mit einer Falle.
 */
export function istInt8(base64: string): boolean {
  const b = Buffer.from(base64, 'base64');
  return b.byteLength > 7 && b[0] === 0x01 && b.byteLength % 4 === 1;
}

export interface Bilanz {
  schluessel: number;
  felder: number;
  vorher: number;
  nachher: number;
  uebersprungen: number;
}

/** Rechnet aus, was der Umzug bringt — und schreibt nur, wenn `schreiben` gesetzt ist. */
export async function verdichte(redis: Redis, schreiben: boolean): Promise<Bilanz> {
  const b: Bilanz = { schluessel: 0, felder: 0, vorher: 0, nachher: 0, uebersprungen: 0 };

  // Einfache Werte: Volltext- und Namensvektoren.
  for (const muster of ['cachly:lesson:vec:*', 'cachly:lesson:vecname:*']) {
    for (const k of await alleSchluessel(redis, muster)) {
      const roh = await redis.get(k);
      if (!roh) continue;
      b.schluessel++;
      if (istInt8(roh)) {
        b.uebersprungen++;
        b.vorher += roh.length;
        b.nachher += roh.length;
        continue;
      }
      const v = entpacke(roh);
      if (!v) { b.uebersprungen++; continue; }
      const neu = packe(v);
      b.vorher += roh.length;
      b.nachher += neu.length;
      b.felder++;
      if (schreiben) await redis.set(k, neu);
    }
  }

  // Eingänge: ein Hash je Lektion, ein Vektor je Feld.
  for (const k of await alleSchluessel(redis, 'cachly:lesson:eing:*')) {
    const h = await redis.hgetall(k);
    const felder: string[] = [];
    b.schluessel++;
    for (const [feld, roh] of Object.entries(h)) {
      if (istInt8(roh)) {
        b.uebersprungen++;
        b.vorher += roh.length;
        b.nachher += roh.length;
        continue;
      }
      const v = entpacke(roh);
      if (!v) { b.uebersprungen++; continue; }
      const neu = packe(v);
      b.vorher += roh.length;
      b.nachher += neu.length;
      b.felder++;
      felder.push(feld, neu);
    }
    if (schreiben && felder.length > 0) await redis.hset(k, ...felder);
  }

  return b;
}

const mb = (zeichen: number): string => `${(zeichen / 1024 / 1024).toFixed(2)} MB`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const url = process.env.CACHLY_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) { console.error('NICHT GELAUFEN: REDIS_URL fehlt.'); process.exit(2); }
  const sicherungsPfad = flag('sicherung');
  if (!sicherungsPfad) { console.error('NICHT GELAUFEN: --sicherung <datei> fehlt.'); process.exit(2); }
  const schreiben = argv.includes('--schreiben');
  const zurueck = argv.includes('--zurueck');

  const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
  try {
    if (zurueck) {
      if (!existsSync(sicherungsPfad)) {
        console.error(`NICHT GELAUFEN: Sicherung fehlt (${sicherungsPfad}).`);
        process.exit(2);
      }
      const s = JSON.parse(readFileSync(sicherungsPfad, 'utf8')) as Sicherung;
      let n = 0;
      for (const [k, v] of Object.entries(s.werte)) { await redis.set(k, v); n++; }
      for (const [k, h] of Object.entries(s.hashes)) {
        const felder = Object.entries(h).flat();
        if (felder.length === 0) continue;
        await redis.del(k);
        await redis.hset(k, ...felder);
        n++;
      }
      console.log(`ZURUECKGESPIELT: ${n} Schluessel aus ${sicherungsPfad}`);
      return;
    }

    // 1. Sichern — immer, auch im Trockenlauf.
    const werte: Record<string, string> = {};
    const hashes: Record<string, Record<string, string>> = {};
    for (const muster of ['cachly:lesson:vec:*', 'cachly:lesson:vecname:*']) {
      for (const k of await alleSchluessel(redis, muster)) {
        const roh = await redis.get(k);
        if (roh) werte[k] = roh;
      }
    }
    for (const k of await alleSchluessel(redis, 'cachly:lesson:eing:*')) {
      hashes[k] = await redis.hgetall(k);
    }
    writeFileSync(sicherungsPfad, JSON.stringify({ werte, hashes }), { encoding: 'utf8' });

    // 2. Sicherung zurueckLESEN und pruefen. Ungeprueft ist sie keine.
    const probe = JSON.parse(readFileSync(sicherungsPfad, 'utf8')) as Sicherung;
    const wSoll = Object.keys(werte).length;
    const wIst = Object.keys(probe.werte).length;
    const hSoll = Object.keys(hashes).length;
    const hIst = Object.keys(probe.hashes).length;
    if (wSoll !== wIst || hSoll !== hIst || wSoll === 0) {
      console.error(`ABBRUCH: Sicherung unvollstaendig (${wIst}/${wSoll} Werte, ${hIst}/${hSoll} Hashes).`);
      process.exit(3);
    }
    console.log(`Sicherung geprueft: ${wIst} Werte + ${hIst} Hashes in ${sicherungsPfad}`);

    // 3. Erst jetzt rechnen bzw. schreiben.
    const b = await verdichte(redis, schreiben);
    console.log('');
    console.log(`  Schluessel angesehen  : ${b.schluessel}`);
    console.log(`  Vektoren umgeschrieben: ${b.felder}`);
    console.log(`  uebersprungen         : ${b.uebersprungen} (schon int8 oder unlesbar)`);
    console.log(`  vorher                : ${mb(b.vorher)}`);
    console.log(`  nachher               : ${mb(b.nachher)}`);
    console.log(`  gespart               : ${mb(b.vorher - b.nachher)}  (Faktor ${(b.vorher / Math.max(1, b.nachher)).toFixed(2)})`);
    console.log('');
    console.log(schreiben ? '  GESCHRIEBEN.' : '  TROCKENLAUF — nichts veraendert. Mit --schreiben ausfuehren.');
  } finally {
    redis.disconnect();
  }
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/vektoren-verdichten.ts');
if (direktGestartet) main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
