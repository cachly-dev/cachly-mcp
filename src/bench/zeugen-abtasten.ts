/**
 * Wie gross ist `besterZeuge` bei einer Frage, die NICHT im Bestand steht?
 *
 * ── Warum diese Messung (27.08.2026, Karte bninni0fimfy) ──────────────────
 *
 * Die Zurueckhaltung im Abruf urteilt bisher ueber `wortBelege` — die ANZAHL
 * der getippten Woerter, die im Treffer stehen. Eine Anzahl kennt aber keinen
 * Unterschied zwischen einem seltenen und einem alltaeglichen Wort.
 *
 * Gemessen am lebenden Bestand: die Frage "Wie stelle ich den Vergaser eines
 * Zweitaktmotors auf Winterbetrieb um" lieferte 98 Treffer. Der beste passte
 * ueber das Wort "stelle". Ein Wort, das in jeder zweiten Lektion steht, sagt
 * ueber DIESE Lektion nichts — die Zurueckhaltung haette greifen muessen.
 *
 * `besterZeuge` (rangfolge.ts) misst genau das Richtige: die Seltenheit des
 * SELTENSTEN geteilten Wortes, normiert auf 0..1. Es steht seit Wochen im
 * Haus und wird von `bewerteTopf` mit −0,6 gewichtet.
 *
 * Diese Datei tastet ab, WO die Grenze liegt: welchen Zeugenwert erreichen
 * Fragen, die eine Antwort haben — und welchen die, die keine haben? Ohne
 * diese Zahlen waere jede Schwelle geraten.
 *
 * ── DAS ERGEBNIS: besterZeuge TRENNT NICHT (27.08.2026) ──────────────────
 *
 * Gemessen am eingefrorenen Bestand, 499 Lektionen:
 *
 *     mit Antwort:  0.564 bis 0.823
 *     ohne Antwort: 0.266 bis 0.823
 *     Ueberlappung: 0.259
 *
 * "Welches Futter braucht ein Wellensittich im Winter" erreicht 0.823 — den
 * HOECHSTEN Wert im ganzen Versuch, gleichauf mit der besten echten Frage.
 * Grund: ein einziges seltenes Wort, das zufaellig irgendwo vorkommt, genuegt.
 * Das Mass fragt nach dem SELTENSTEN geteilten Wort, nicht danach, ob die
 * Frage und der Text vom Selben handeln.
 *
 * FOLGE: die Zurueckhaltung bekommt dieses Mass NICHT. Eine Schwelle darauf
 * wuerde entweder echte Treffer fressen oder den Muell durchlassen — es gibt
 * keinen Wert dazwischen.
 *
 * Der Befund bleibt hier stehen, damit ihn niemand ein zweites Mal sucht. Er
 * ist die Unterscheidbarkeits-Probe (Gabriel Abreu): beweise, dass ein Muster
 * ueberhaupt trennt, BEVOR du dich darauf verlaesst. Hier hat sie eine
 * plausible, gut begruendete Idee widerlegt, bevor sie ausgeliefert wurde.
 *
 * OFFEN BLEIBT: die Zurueckhaltung greift bei Fragen mit alltaeglichen
 * Woertern nicht ("stelle" traf exakt und zaehlt als Beleg). Der naechste
 * Kandidat waere die Bedeutungsnaehe ALLEIN, wo sie vorliegt — also nicht
 * "EIN Beleg genuegt", sondern "ein klar niedriger Kosinus schlaegt einen
 * schwachen Wortbeleg". Das braucht eine eigene Messung.
 *
 * Aufruf:  npx tsx src/bench/zeugen-abtasten.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Seltenheit, inhaltsWoerter, grobStamm } from '../rangfolge.js';

const HIER = dirname(fileURLToPath(import.meta.url));

/** Der Bestand, mit dem auch `npm run bench` misst. */
function ladeBestand(): { topic: string; text: string }[] {
  for (const rel of ['korpus/korpus.json', 'korpus.json', 'daten/korpus.json']) {
    try {
      const roh = JSON.parse(readFileSync(join(HIER, rel), 'utf8')) as unknown;
      const liste = Array.isArray(roh) ? roh : (roh as { lektionen?: unknown[] }).lektionen;
      if (!Array.isArray(liste)) continue;
      return liste.map((l) => {
        const o = l as Record<string, unknown>;
        const s = (v: unknown) => (typeof v === 'string' ? v : '');
        return {
          topic: s(o.topic),
          text: [s(o.topic), s(o.what_worked), s(o.what_failed)].filter(Boolean).join(' '),
        };
      });
    } catch {
      // naechster Kandidat
    }
  }
  return [];
}

/**
 * Fragen, die im Bestand eine Antwort HABEN, und solche, die keine haben.
 *
 * Die zweite Gruppe ist der eigentliche Punkt: sie muss deutlich niedrigere
 * Zeugenwerte erreichen, sonst trennt das Mass nicht — und dann waere jede
 * Schwelle darauf eine Behauptung (Unterscheidbarkeits-Probe).
 */
const OHNE_ANTWORT = [
  'Wie stelle ich den Vergaser eines Zweitaktmotors auf Winterbetrieb um',
  'Welches Futter braucht ein Wellensittich im Winter',
  'Wie lange muss ein Rinderbraten im Ofen bleiben',
  'Wann bluehen Tulpen in Norddeutschland',
  'Wie wechsle ich die Saiten einer Konzertgitarre',
];

const MIT_ANTWORT = [
  'deploy schlaegt fehl auf node-3',
  'redis maxmemory policy setzen',
  'mcp version erhoehen',
  'docker layer cache nutzen',
  'wireguard tunnel steht nicht',
];

function main() {
  const bestand = ladeBestand();
  if (bestand.length === 0) {
    console.error(
      'KEIN BESTAND GEFUNDEN — gesucht wurde neben src/bench/ nach korpus.json.\n' +
        'Ohne Bestand misst diese Datei nichts, und eine leere Messung ist kein Ergebnis.',
    );
    process.exit(2);
  }

  const seltenheit = new Seltenheit(bestand.map((b) => b.text));
  const texte = bestand.map((b) => ({
    topic: b.topic,
    woerter: new Set([...inhaltsWoerter(b.text)].map(grobStamm)),
  }));

  const besterFuer = (frage: string) => {
    const frageW = new Set(inhaltsWoerter(frage));
    let best = 0;
    let wo = '';
    for (const t of texte) {
      const z = seltenheit.besterZeuge(frageW, t.woerter);
      if (z > best) {
        best = z;
        wo = t.topic;
      }
    }
    return { best, wo };
  };

  console.log(`\nBestand: ${bestand.length} Lektionen\n`);
  console.log('── Fragen MIT Antwort im Bestand ─────────────────────────────');
  const mit: number[] = [];
  for (const f of MIT_ANTWORT) {
    const { best, wo } = besterFuer(f);
    mit.push(best);
    console.log(`  ${best.toFixed(3)}  "${f}"  -> ${wo}`);
  }

  console.log('\n── Fragen OHNE Antwort im Bestand ────────────────────────────');
  const ohne: number[] = [];
  for (const f of OHNE_ANTWORT) {
    const { best, wo } = besterFuer(f);
    ohne.push(best);
    console.log(`  ${best.toFixed(3)}  "${f}"  -> ${wo}`);
  }

  const min = (a: number[]) => Math.min(...a);
  const max = (a: number[]) => Math.max(...a);

  console.log('\n── Trennt das Mass? ──────────────────────────────────────────');
  console.log(`  mit Antwort:  ${min(mit).toFixed(3)} bis ${max(mit).toFixed(3)}`);
  console.log(`  ohne Antwort: ${min(ohne).toFixed(3)} bis ${max(ohne).toFixed(3)}`);

  if (max(ohne) < min(mit)) {
    const mitte = (max(ohne) + min(mit)) / 2;
    console.log(`  TRENNT SAUBER. Eine Schwelle bei ${mitte.toFixed(3)} liegt zwischen beiden.`);
  } else {
    console.log(
      `  UEBERLAPPT um ${(max(ohne) - min(mit)).toFixed(3)}. ` +
        'Eine Schwelle wuerde hier zwangslaeufig Treffer fressen oder Muell durchlassen.',
    );
  }
}

main();
