#!/usr/bin/env node
/**
 * ══ Zipf-Mandelbrot-Seltenheit (K3, Naturworkshop 4) — der Messlauf ═══════
 *
 * Karte sfxbkf8yfugz. Vorregistrierung: VORREGISTRIERUNG-mandelbrot.md
 * (Erwartungen standen VOR der ersten Zahl fest).
 *
 * Mandelbrot 1953: Worthäufigkeit folgt `f ∝ 1/(rang+B)^a`, nicht Zipf pur.
 * Als Gewichtskurve über df: `wert = [log((N+1)/(df+B))]^a`. Status quo ist
 * exakt (B=1, a=1). Die Kurve wird in die AUSGELIEFERTE Seltenheit-Klasse
 * injiziert — eine deckung()-Logik, keine Kopie.
 *
 * Messstand wie bei der Längenkorrektur: die gespeicherten Töpfe je Frage
 * (merkmale-fremd-A.jsonl), die Deckung je (Frage, Kandidat) aus den TEXTEN
 * neu gerechnet, dann der ausgelieferte bewerteTopf. Sanity-Tor: F0 muss
 * die gespeicherten Deckungen reproduzieren, sonst wird NICHTS gefolgert.
 *
 * ── DAS URTEIL (31.08.2026, Haelfte A, 1999 Fragen): GEMESSEN_FALSCH ─────
 *
 *   Variante              P@1      @3      Delta @3
 *   F0 heute (B=1,a=1)    43,5 %   57,1 %  —
 *   B=5 / B=20 / B=100    43,6/43,5/43,1   57,0/56,9/56,4  (faellt monoton)
 *   a=0,75 / a=1,25       43,6/43,6        56,9/57,4       (+0,3 = beste)
 *
 * KEINE Variante erreicht die vorregistrierte Schwelle (+0,5 @3);
 * Haelfte B wurde NICHT angefasst. Sanity-Tor byte-genau (0,00000 nach
 * Volltext-Angleich und Norm-Rueckrechnung).
 *
 * EINORDNUNG, ehrlich: Das ist eine unbeabsichtigte REPLIKATION. K3 war
 * am 25.08. bereits mit einer RANG-basierten ZM-Kurve gemessen und
 * gemessen_falsch (befund-K2-K3.md: "Rang ordinal, log kardinal";
 * Lektion sortierer:alte-meister-serie-bilanz). Der Recall VOR dem Bau
 * haette das gezeigt — 40 Minuten Lehrgeld. Als Zweitlauf mit anderer
 * Parametrisierung (df-Verschiebung + Exponent statt Rang) im
 * Topf-Messstand bestaetigt er das Urteil unabhaengig: die log-IDF-Kurve
 * ist an dieser Front ausgereizt.
 *
 * Aufruf:
 *   npx tsx src/bench/mandelbrot-messen.ts
 *     [--merkmale <jsonl>]  Vorgabe: merkmale-fremd-A.jsonl (Hälfte A)
 *     [--satz <json>]       Vorgabe: fremdsatz-teil.json
 *     [--nur <name>]        Bestätigungslauf auf B: NUR F0 + diese Variante
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { bewerteTopf, GEWICHTE, Seltenheit, inhaltsWoerter, grobStamm } from '../rangfolge.js';
import { SELTENHEIT_LAENGE_B } from '../rangfolge-stellschrauben.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; relevant: string[]; topf: Kandidat[] };
type Lektion = { topic: string; what_worked?: string; what_failed?: string };

/** Die Kurvenfamilie der Vorregistrierung. (B=1, a=1) ist der Status quo. */
export function zipfMandelbrotKurve(B: number, a: number): (df: number, anzahl: number) => number {
  return (df, anzahl) => {
    const roh = Math.log((anzahl + 1) / (df + B));
    // Unter B > 1 kann der Logarithmus fuer sehr haeufige Woerter negativ
    // werden (df + B > N + 1) — ein negatives Seltenheitsgewicht wuerde
    // Treffer BESTRAFEN. Die Kurve klemmt bei 0: haeufiger als "traegt
    // nichts" gibt es nicht.
    return Math.max(0, roh) ** a;
  };
}

async function main(): Promise<void> {
  const flag = (n: string, standard: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? standard : process.argv[i + 1];
  };
  const merkmalePfad = flag('merkmale', 'C:/Users/heinr/.cachly/bench-korpus/merkmale-fremd-A.jsonl');
  const satzPfad = flag('satz', 'C:/Users/heinr/.cachly/bench-korpus/fremdsatz-teil.json');
  for (const [was, p] of [['Merkmale', merkmalePfad], ['Satz', satzPfad]] as const) {
    if (!existsSync(p)) { console.error(`NICHT GEMESSEN: ${was} fehlt (${p}).`); process.exit(2); }
  }

  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as { lessons: Lektion[] };
  const texte = new Map<string, string>();
  for (const l of satz.lessons) {
    // Derselbe Volltext wie beim Einfrieren der Merkmale (findequote-messen):
    // topic + what_worked + what_failed — das Topic traegt Staemme!
    texte.set(l.topic, [l.topic, l.what_worked, l.what_failed].filter(Boolean).join(' '));
  }
  const alleTexte = [...texte.values()];

  const zeilen: Zeile[] = [];
  const rl = createInterface({ input: createReadStream(merkmalePfad) });
  for await (const z of rl) {
    if (!z.trim()) continue;
    try { zeilen.push(JSON.parse(z) as Zeile); } catch { /* kaputte Zeile */ }
  }
  console.log(`${zeilen.length} Fragen, ${alleTexte.length} Lektionstexte.`);

  const textWoerter = new Map<string, Set<string>>();
  for (const [topic, text] of texte) {
    textWoerter.set(topic, new Set([...inhaltsWoerter(text)].map(grobStamm)));
  }

  // ── Sanity-Tor: F0 reproduziert die gespeicherten Deckungen ────────────
  const f0 = new Seltenheit(alleTexte);
  // Die Merkmale wurden VOR der Laengenkorrektur eingefroren; die heutige
  // deckung() teilt bereits durch den Laengenfaktor. Fuer die Sanity wird
  // die Norm ZURUECKGERECHNET — dann muss die Rohdeckung byte-genau der
  // gespeicherten entsprechen.
  const avgW = f0.mittlereStammzahl;
  const faktor = (w: number) => 1 - SELTENHEIT_LAENGE_B + (SELTENHEIT_LAENGE_B * w) / avgW;
  let maxAbweichung = 0;
  let geprueft = 0;
  for (const z of zeilen) {
    const fw = new Set(inhaltsWoerter(z.query));
    for (const k of z.topf ?? []) {
      const tw = textWoerter.get(k.t);
      if (!tw) continue;
      const d = Math.abs(f0.deckung(fw, tw) * faktor(tw.size) - k.sD);
      if (d > maxAbweichung) maxAbweichung = d;
      geprueft++;
    }
  }
  console.log(`Sanity: ${geprueft} Deckungen nachgerechnet, groesste Abweichung ${maxAbweichung.toFixed(5)}`);
  if (maxAbweichung >= 0.001) {
    console.error('NICHT GEMESSEN: F0 weicht von den gespeicherten Deckungen ab — der Messstand rechnet eine andere Deckung. Sanity-Tor der Vorregistrierung verletzt; es wird NICHTS gefolgert.');
    process.exit(3);
  }

  // ── Die vorregistrierten Varianten — keine Nachschuebe ─────────────────
  const nur = flag('nur', '');
  const alle: Array<{ name: string; B: number; a: number }> = [
    { name: 'F0 heute (B=1, a=1)', B: 1, a: 1 },
    { name: 'B=5', B: 5, a: 1 },
    { name: 'B=20', B: 20, a: 1 },
    { name: 'B=100', B: 100, a: 1 },
    { name: 'a=0.75', B: 1, a: 0.75 },
    { name: 'a=1.25', B: 1, a: 1.25 },
  ];
  const varianten = nur
    ? alle.filter((v) => v.name.startsWith('F0') || v.name === nur)
    : alle;

  console.log('\n  Variante                P@1      @3');
  for (const v of varianten) {
    const s = v.B === 1 && v.a === 1 ? f0 : new Seltenheit(alleTexte, zipfMandelbrotKurve(v.B, v.a));
    let p1 = 0; let p3 = 0;
    for (const z of zeilen) {
      if (!z.topf?.length || !z.relevant?.length) continue;
      const fw = new Set(inhaltsWoerter(z.query));
      const bewertbar = z.topf.map((k) => ({
        naeheText: k.nT,
        naeheThema: k.nTh,
        naeheRueckkopplung: k.nR,
        seltenheitsDeckung: (() => {
          const tw = textWoerter.get(k.t);
          return tw ? s.deckung(fw, tw) : k.sD;
        })(),
        besterEingang: k.bE,
      }));
      const punkte = bewerteTopf(bewertbar, GEWICHTE);
      const reihenfolge = punkte
        .map((p, i) => ({ p, t: z.topf[i].t }))
        .sort((x, y) => y.p - x.p);
      const platz = reihenfolge.findIndex((r) => z.relevant.includes(r.t)) + 1;
      if (platz === 1) p1++;
      if (platz >= 1 && platz <= 3) p3++;
    }
    const n = zeilen.length;
    console.log(`  ${v.name.padEnd(22)} ${(100 * p1 / n).toFixed(1)} %   ${(100 * p3 / n).toFixed(1)} %`);
  }
  console.log('\nErwartung der Vorregistrierung: aussichtsreich ab +0,5 Punkten @3 gegen F0');
  console.log('ohne P@1-Verlust ueber 0,3. Nur die beste Variante darf auf Haelfte B — einmal.');
}

// Nur beim direkten Aufruf laufen — zipfMandelbrotKurve wird von Proben importiert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('NICHT GEMESSEN:', (e as Error).message); process.exit(1); });
}
