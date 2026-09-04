/**
 * Rüstet den vorhandenen Lektionsbestand mit Zweitmodell-Vektoren nach.
 *
 * ── Warum es dieses Werkzeug gibt ───────────────────────────────────────────
 *
 * Seit 0.10.145 schreibt `learn_from_attempts` beim Speichern einen zweiten
 * Vektor (`cachly:lesson:vec2:`, Modell ZWEIT_MODELL) — den sechsten Zeugen
 * der Sortierung, dreifach bestätigt (Zahlen an ZWEIT_MODELL in
 * rangfolge-stellschrauben.ts). Die Lektionen von davor haben keinen, und der
 * Lesepfad schaltet das Merkmal erst ab ZWEIT_MINDESTDECKUNG (80 %) scharf.
 * Bei wenigen neuen Lektionen je Woche hieße das ohne Nachrüstung: die
 * Verbesserung käme Monate später. Dieses Werkzeug holt sie heute.
 *
 * ── Was es kostet ──────────────────────────────────────────────────────────
 *
 * Genau eine Einbettung je Lektion ohne Zweitvektor. Das Zweitmodell rechnet
 * auf node-1 mit 1 bis 3 Texten je Sekunde (gemessen 01.09.2026) — für 500
 * Lektionen also wenige Minuten. Die Drosselung von 60 Anfragen je Minute
 * gilt wie überall; ohne Admin-Schlüssel zieht die Notbremse bei zehn 429ern
 * (dieselbe Lehre wie in eingaenge-nachruesten.ts: ein paralleler Lauf hat am
 * 19.08. 563 mal 429 erzeugt und den Wachhund geweckt).
 *
 * ── Was es NICHT tut ───────────────────────────────────────────────────────
 *
 * Es rührt Lektionen und Erstvektoren nicht an. Vorhandene Zweitvektoren
 * werden übersprungen — ein Abbruch mittendrin kostet nichts, der nächste
 * Lauf holt den Rest. Und es prüft VOR dem ersten Schreiben, dass der
 * Embed-Dienst wirklich das Zweitmodell liefert: ein Dienst, der das
 * `model`-Feld ignoriert, würde sonst bge-Vektoren unter dem
 * Zweit-Schlüssel ablegen und jeden Vergleich dort wertlos machen.
 *
 * Aufruf:
 *   REDIS_URL=... CACHLY_JWT=... [CACHLY_ADMIN_KEY=...] \
 *     npx tsx src/zweitvektoren-nachruesten.ts [--probe 20] [--parallel 4]
 *   npx tsx src/zweitvektoren-nachruesten.ts --selbstprobe
 */

import { Redis } from 'ioredis';
import { ZWEIT_VEKTOR_PRAEFIX, VEKTOR_PRAEFIX, packe, textFuerVektor, kosinus } from './bedeutung.js';
import { ZWEIT_MODELL } from './rangfolge-stellschrauben.js';

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
 * Die Modell-Probe: derselbe Text durch Standardmodell und Zweitmodell muss
 * ZWEI VERSCHIEDENE Vektoren geben. Liefert der Dienst zweimal dasselbe,
 * ignoriert er das model-Feld — dann bricht der Lauf ab, BEVOR er den
 * Zweit-Schlüsselraum mit Erstmodell-Vektoren vergiftet.
 */
export function modellprobeBestanden(erst: number[] | null, zweit: number[] | null): boolean {
  if (!erst?.length || !zweit?.length) return false;
  if (erst.length !== zweit.length) return true; // verschiedene Dimensionen: sicher verschieden
  return kosinus(erst, zweit) < 0.999; // praktisch identisch = dasselbe Modell
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };
  p('zwei verschiedene Vektoren bestehen', modellprobeBestanden([1, 0, 0], [0.5, 0.5, 0.7]));
  p('identische Vektoren fallen durch', !modellprobeBestanden([1, 0, 0], [1, 0, 0]));
  p('fehlender Erstvektor faellt durch', !modellprobeBestanden(null, [1, 0]));
  p('fehlender Zweitvektor faellt durch', !modellprobeBestanden([1, 0], null));
  p('verschiedene Dimensionen bestehen', modellprobeBestanden([1, 0], [1, 0, 0]));
  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes('--selbstprobe')) selbstprobe();

  const url = process.env.REDIS_URL;
  const JWT = process.env.CACHLY_JWT;
  const API = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
  const ADMIN = process.env.CACHLY_ADMIN_KEY;
  if (!url || !JWT) {
    console.error('REDIS_URL und CACHLY_JWT sind Pflicht.');
    process.exit(2);
  }
  const flag = (n: string): string | undefined => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const probe = Number(flag('probe') ?? '0');
  const parallel = Number(flag('parallel') ?? '4');
  const bremse = new Notbremse();

  const einbetten = async (text: string, modell?: string): Promise<number[] | null> => {
    for (let versuch = 0; versuch < 4; versuch++) {
      if (bremse.gezogen) return null;
      try {
        const kopf: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` };
        if (ADMIN) kopf['X-Admin-Key'] = ADMIN;
        const body: Record<string, string> = { text: text.slice(0, 2000) };
        if (modell) body.model = modell;
        const r = await fetch(`${API}/api/v1/embed`, {
          method: 'POST', headers: kopf, body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (r.status === 429) {
          bremse.melde429();
          await new Promise((f) => setTimeout(f, 2000 * (versuch + 1)));
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { embedding?: number[] };
        return j.embedding ?? null;
      } catch {
        await new Promise((f) => setTimeout(f, 1500 * (versuch + 1)));
      }
    }
    return null;
  };

  const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 8000 });
  try {
    // Bestand einsammeln: alle Lektionen, vorhandene Zweitvektoren.
    const topics: string[] = [];
    let cursor = '0';
    do {
      const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${LEKTION_PRAEFIX}*`, 'COUNT', 500);
      cursor = next;
      topics.push(...gefunden.map((k) => k.slice(LEKTION_PRAEFIX.length)));
    } while (cursor !== '0');

    const zweitDa = new Set<string>();
    cursor = '0';
    do {
      const [next, gefunden] = await redis.scan(cursor, 'MATCH', `${ZWEIT_VEKTOR_PRAEFIX}*`, 'COUNT', 500);
      cursor = next;
      for (const k of gefunden) zweitDa.add(k.slice(ZWEIT_VEKTOR_PRAEFIX.length));
    } while (cursor !== '0');

    let offen = topics.filter((t) => !zweitDa.has(t));
    console.log(`${topics.length} Lektionen, ${zweitDa.size} Zweitvektoren vorhanden, ${offen.length} offen.`);
    if (probe > 0) {
      offen = offen.slice(0, probe);
      console.log(`--probe: nur die ersten ${offen.length}.`);
    }
    if (offen.length === 0) { console.log('Nichts zu tun.'); return; }

    // Die Modell-Probe am ersten offenen Topic — gegen den stillen Dienst,
    // der das model-Feld verwirft (siehe Kopfkommentar).
    const ersterRoh = await redis.get(`${LEKTION_PRAEFIX}${offen[0]}`);
    const ersterText = textFuerVektor(JSON.parse(ersterRoh ?? '{}') as Record<string, unknown>);
    const [probeErst, probeZweit] = await Promise.all([
      einbetten(ersterText),
      einbetten(ersterText, ZWEIT_MODELL),
    ]);
    if (!modellprobeBestanden(probeErst, probeZweit)) {
      console.error('ABBRUCH: der Embed-Dienst liefert fuer das Zweitmodell denselben Vektor wie fuer das '
        + 'Standardmodell — das model-Feld kommt nicht an. NICHTS geschrieben.');
      process.exit(3);
    }
    console.log('Modell-Probe bestanden: Zweitmodell liefert eigene Vektoren.');

    // Als Gegenstueck zur Probe direkt verwerten: der erste Vektor ist ja da.
    if (probeZweit?.length) await redis.set(`${ZWEIT_VEKTOR_PRAEFIX}${offen[0]}`, packe(probeZweit));
    const rest = offen.slice(1);

    let geschrieben = probeZweit?.length ? 1 : 0;
    let fertig = 0;
    let naechster = 0;
    const arbeiter = Array.from({ length: parallel }, async () => {
      for (;;) {
        const i = naechster++;
        if (i >= rest.length || bremse.gezogen) return;
        const roh = await redis.get(`${LEKTION_PRAEFIX}${rest[i]}`);
        if (!roh) continue;
        const v = await einbetten(textFuerVektor(JSON.parse(roh) as Record<string, unknown>), ZWEIT_MODELL);
        if (v?.length) {
          await redis.set(`${ZWEIT_VEKTOR_PRAEFIX}${rest[i]}`, packe(v));
          geschrieben++;
        }
        if (++fertig % 50 === 0) console.log(`  ${fertig}/${rest.length}`);
      }
    });
    await Promise.all(arbeiter);

    if (bremse.gezogen) {
      console.error(`NOTBREMSE nach ${bremse.stand} Drosselungen — ${geschrieben} geschrieben, `
        + 'der naechste Lauf holt den Rest.');
      process.exit(4);
    }
    // Der Deckungs-Stand entscheidet, ob der Lesepfad scharf ist — er gehoert
    // in die Abschlusszeile, nicht in eine zweite Abfrage.
    const erstGesamt = await (async () => {
      let n = 0;
      let c = '0';
      do {
        const [next, gefunden] = await redis.scan(c, 'MATCH', `${VEKTOR_PRAEFIX}*`, 'COUNT', 500);
        c = next;
        n += gefunden.length;
      } while (c !== '0');
      return n;
    })();
    const deckung = erstGesamt > 0 ? (zweitDa.size + geschrieben) / erstGesamt : 0;
    console.log(`FERTIG: ${geschrieben} Zweitvektoren geschrieben. `
      + `Deckung jetzt ${(deckung * 100).toFixed(0)} % von ${erstGesamt} Erstvektoren `
      + `(Lesepfad ab 80 %).`);
  } finally {
    redis.disconnect();
  }
}

const istHauptmodul = process.argv[1]?.replace(/\\/g, '/').endsWith('zweitvektoren-nachruesten.ts');
if (istHauptmodul) {
  main().catch((e) => {
    console.error('FEHLER:', e?.message ?? e);
    process.exit(1);
  });
}
