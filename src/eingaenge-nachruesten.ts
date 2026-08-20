/**
 * Rüstet den vorhandenen Lektionsbestand mit Eingängen und Namensvektoren nach.
 *
 * ── Warum es dieses Werkzeug gibt ───────────────────────────────────────────
 *
 * Seit dem 20.08.2026 schreibt `learn_from_attempts` die Fehlertext-Eingänge
 * beim Speichern mit. Die Lektionen, die vorher entstanden sind, haben keine —
 * und ohne Nachrüstung wirkt die Verbesserung nur für alles, was ab heute
 * gelernt wird. Bei 501 vorhandenen und wenigen neuen Lektionen je Woche wäre
 * das praktisch keine Wirkung.
 *
 * ── Was es kostet ──────────────────────────────────────────────────────────
 *
 * Rund 1,3 Einbettungen je Lektion (nicht jede trägt einen Fehlertext).
 * Gemessen am 20.08.: 1440 Einbettungen in 406 s mit Admin-Schlüssel, das sind
 * 3,5 je Sekunde. Für 501 Lektionen also wenige Minuten.
 *
 * OHNE Admin-Schlüssel greift die Drosselung von 60 Anfragen je Minute
 * (api/cmd/server/routes.go). Ein paralleler Lauf hat am 19.08. 563 mal
 * HTTP 429 erzeugt, eine Wachhund-Warnung mit unserer eigenen Adresse
 * ausgelöst und eine automatische Hochskalierung angestoßen. Deshalb die
 * Notbremse.
 *
 * ── Was es NICHT tut ───────────────────────────────────────────────────────
 *
 * Es rührt die Lektionen selbst nicht an und schreibt keine Vektoren. Fällt es
 * mittendrin aus, ist der Bestand in demselben Zustand wie vorher, nur mit
 * weniger Eingängen — ein zweiter Lauf holt den Rest.
 *
 * Aufruf:
 *   REDIS_URL=... CACHLY_JWT=... CACHLY_ADMIN_KEY=... \
 *     npx tsx src/eingaenge-nachruesten.ts [--probe 20] [--parallel 6]
 *   npx tsx src/eingaenge-nachruesten.ts --selbstprobe
 */

import { Redis } from 'ioredis';
import { schreibeEingaenge, fehlertexteAus, eingangsText, EINGANG_PRAEFIX } from './eingaenge.js';
import {
  NAME_VEKTOR_PRAEFIX, VEKTOR_PRAEFIX, packe, textFuerNamensVektor, textFuerVektor,
} from './bedeutung.js';

const LEKTION_PRAEFIX = 'cachly:lesson:best:';

/** Zählt die 429er. Bei zehn ist Schluss — lieber abgebrochen als ein Vorfall. */
class Notbremse {
  private zaehler = 0;
  constructor(private readonly grenze = 10) {}
  melde429(): void { this.zaehler++; }
  get gezogen(): boolean { return this.zaehler >= this.grenze; }
  get stand(): number { return this.zaehler; }
}

/**
 * Wie viele Lektionen überhaupt einen Eingang bekommen könnten.
 *
 * Wird VOR dem ersten Netzaufruf gerechnet und gemeldet: wer die Zahl vorher
 * kennt, merkt sofort, wenn am Ende viel weniger herauskommt.
 */
export function wieVieleTragen(lektionen: Array<Record<string, unknown>>): number {
  return lektionen.filter((l) => fehlertexteAus(eingangsText(l)).length > 0).length;
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  const mit = { what_worked: 'Der Worker meldete "No space left on device".' };
  const ohne = { what_worked: 'Wir haben die Reihenfolge der Schritte getauscht.' };
  p('zählt nur Lektionen mit Fehlertext', wieVieleTragen([mit, ohne, mit]) === 2);
  p('leerer Bestand ergibt null', wieVieleTragen([]) === 0);

  const b = new Notbremse(3);
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const url = process.env.CACHLY_REDIS_URL ?? process.env.REDIS_URL;
  const API = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
  const JWT = process.env.CACHLY_JWT ?? '';
  const ADMIN = process.env.CACHLY_ADMIN_KEY ?? '';
  if (!url) { console.error('NICHT GELAUFEN: CACHLY_REDIS_URL oder REDIS_URL fehlt.'); process.exit(2); }
  if (!JWT) { console.error('NICHT GELAUFEN: CACHLY_JWT fehlt.'); process.exit(2); }

  const probe = Number(flag('probe') ?? '0');
  const parallel = Number(flag('parallel') ?? (ADMIN ? '6' : '2'));
  const bremse = new Notbremse(10);

  const einbetten = async (text: string): Promise<number[] | null> => {
    for (let versuch = 0; versuch < 4; versuch++) {
      if (bremse.gezogen) return null;
      try {
        const kopf: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` };
        if (ADMIN) kopf['X-Admin-Key'] = ADMIN;
        const r = await fetch(`${API}/api/v1/embed`, {
          method: 'POST', headers: kopf,
          body: JSON.stringify({ text: text.slice(0, 2000) }),
          signal: AbortSignal.timeout(60_000),
        });
        if (r.status === 429) {
          bremse.melde429();
          await new Promise((f) => setTimeout(f, 2000 * (versuch + 1)));
          continue;
        }
        if (!r.ok) return null;
        const j = await r.json() as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
        return j.embedding ?? j.data?.[0]?.embedding ?? null;
      } catch {
        await new Promise((f) => setTimeout(f, 800 * (versuch + 1)));
      }
    }
    return null;
  };

  const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
  try {
    const schluessel: string[] = [];
    let cursor = '0';
    do {
      const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${LEKTION_PRAEFIX}*`, 'COUNT', 500);
      cursor = next;
      schluessel.push(...gefunden);
    } while (cursor !== '0');

    if (schluessel.length === 0) {
      console.error(`NICHT GELAUFEN: keine Lektionen unter ${LEKTION_PRAEFIX}* — falsche Instanz?`);
      process.exit(3);
    }

    const lektionen: Array<{ topic: string; inhalt: Record<string, unknown> }> = [];
    for (let i = 0; i < schluessel.length; i += 100) {
      const block = schluessel.slice(i, i + 100);
      const werte = await redis.mget(...block);
      for (const [j, roh] of werte.entries()) {
        if (!roh) continue;
        try {
          const o = JSON.parse(roh) as Record<string, unknown>;
          const topic = typeof o.topic === 'string' && o.topic ? o.topic : block[j].slice(LEKTION_PRAEFIX.length);
          if (topic) lektionen.push({ topic, inhalt: o });
        } catch { /* eine kaputte Zeile ist ein Thema fuer doctor */ }
      }
    }

    // Was schon da ist, wird übersprungen — ein zweiter Lauf ist billig.
    const schonDa = async (praefix: string): Promise<Set<string>> => {
      const menge = new Set<string>();
      let c = '0';
      do {
        const [next, gefunden] = await redis.scan(c, 'MATCH', `${praefix}*`, 'COUNT', 500);
        c = next;
        for (const k of gefunden) menge.add(k.slice(praefix.length));
      } while (c !== '0');
      return menge;
    };
    let fertigNamen = 0;
    const vorhanden = await schonDa(EINGANG_PRAEFIX);
    const namenDa = await schonDa(NAME_VEKTOR_PRAEFIX);
    const volltextDa = await schonDa(VEKTOR_PRAEFIX);

    // ── Volltextvektoren ─────────────────────────────────────────────────────
    //
    // Gemessen am 20.08.2026 gegen die Produktion: `cachly:lesson:vec:*` war
    // LEER — bei 506 Lektionen kein einziger Vektor. Damit lief der
    // Bedeutungsabgleich dort nie: `vektorbestand.groesse === 0` steigt in
    // brain.ts sofort aus und faellt auf den reinen Wortabgleich zurueck.
    //
    // Das ist die Grundlage von allem anderen. Ohne diese Vektoren nuetzen
    // weder Namensvektoren noch Eingaenge etwas.
    const ohneVolltext = lektionen.filter((l) => !volltextDa.has(l.topic));
    console.log(`${volltextDa.size} Lektionen haben einen Volltextvektor, ${ohneVolltext.length} fehlen.`);
    if (ohneVolltext.length > 0) {
      let n = 0;
      let fertigVoll = 0;
      let naechsterVoll = 0;
      const vollArbeiter = Array.from({ length: parallel }, async () => {
        for (;;) {
          const i = naechsterVoll++;
          if (i >= ohneVolltext.length || bremse.gezogen) return;
          const v = await einbetten(textFuerVektor(ohneVolltext[i].inhalt));
          if (v?.length) {
            await redis.set(`${VEKTOR_PRAEFIX}${ohneVolltext[i].topic}`, packe(v));
            n++;
          }
          if (++fertigVoll % 100 === 0) console.log(`  Volltext ${fertigVoll}/${ohneVolltext.length}`);
        }
      });
      await Promise.all(vollArbeiter);
      console.log(`${n} Volltextvektoren geschrieben.`);
    }

    // ── Namensvektoren zuerst ────────────────────────────────────────────────
    //
    // Sie sind die Voraussetzung dafür, dass der Sortierer aus rangfolge.ts
    // überhaupt greifen kann: ohne sie ist `naeheThema` für jede Lektion -2,
    // und ein Merkmal mit Gewicht 0,6 trägt dann nichts bei.
    const ohneNamen = lektionen.filter((l) => !namenDa.has(l.topic));
    console.log(`${namenDa.size} Lektionen haben einen Namensvektor, ${ohneNamen.length} fehlen.`);
    if (ohneNamen.length > 0) {
      let n = 0;
      let naechsterName = 0;
      const namensArbeiter = Array.from({ length: parallel }, async () => {
        for (;;) {
          const i = naechsterName++;
          if (i >= ohneNamen.length || bremse.gezogen) return;
          const v = await einbetten(textFuerNamensVektor(ohneNamen[i].topic));
          if (v?.length) {
            await redis.set(`${NAME_VEKTOR_PRAEFIX}${ohneNamen[i].topic}`, packe(v));
            n++;
          }
          if (++fertigNamen % 100 === 0) console.log(`  Namen ${fertigNamen}/${ohneNamen.length}`);
        }
      });
      await Promise.all(namensArbeiter);
      console.log(`${n} Namensvektoren geschrieben.`);
    }

    let offen = lektionen.filter((l) => !vorhanden.has(l.topic));
    const koennten = wieVieleTragen(offen.map((l) => l.inhalt));
    if (probe > 0) offen = offen.slice(0, probe);

    console.log(`${lektionen.length} Lektionen, ${vorhanden.size} haben schon Eingänge.`);
    console.log(`${offen.length} offen, davon tragen ${koennten} einen Fehlertext.`);
    console.log(ADMIN
      ? `Admin-Schlüssel gesetzt — ${parallel} gleichzeitig, Notbremse bei 10x 429.`
      : `KEIN Admin-Schlüssel — gedrosselt mit ${parallel} gleichzeitig. Das dauert.`);

    let fertig = 0; let geschrieben = 0; let leer = 0;
    const begonnen = Date.now();
    let naechster = 0;
    const arbeiter = Array.from({ length: parallel }, async () => {
      for (;;) {
        const i = naechster++;
        if (i >= offen.length || bremse.gezogen) return;
        const l = offen[i];
        try {
          const n = await schreibeEingaenge(redis, l.topic, l.inhalt, einbetten);
          if (n > 0) geschrieben += n; else leer++;
        } catch { leer++; }
        fertig++;
        if (fertig % 50 === 0) {
          const proSek = fertig / ((Date.now() - begonnen) / 1000);
          console.log(`  ${fertig}/${offen.length}  (${proSek.toFixed(1)}/s, 429er: ${bremse.stand})`);
        }
      }
    });
    await Promise.all(arbeiter);

    const dauer = ((Date.now() - begonnen) / 1000).toFixed(0);
    console.log(`Fertig in ${dauer} s. ${geschrieben} Eingänge für ${offen.length - leer} Lektionen.`);
    console.log(`${leer} Lektionen tragen keinen Fehlertext — die bleiben ohne Eingang.`);
    if (bremse.gezogen) {
      console.error(`NOTBREMSE: ${bremse.stand} mal HTTP 429 — abgebrochen. Ein zweiter Lauf holt den Rest.`);
      process.exit(4);
    }
  } finally {
    redis.disconnect();
  }
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/eingaenge-nachruesten.ts');
if (direktGestartet && process.argv.includes('--selbstprobe')) selbstprobe();
else if (direktGestartet) void main();
