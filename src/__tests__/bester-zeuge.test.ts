import { describe, expect, it } from 'vitest';
import {
  bewerteTopf, GEWICHTE, inhaltsWoerter, Seltenheit, spreizeImTopf,
} from '../rangfolge.js';

/**
 * ══ Der beste Zeuge — das Maximum, das nicht weggemittelt werden kann ══════
 *
 * Naturworkshop 3 (24.08.2026): alle fuenf bisherigen Merkmale sind
 * Durchschnitte. Ein entscheidender geteilter Token wie
 * `_sync_to_local_dir_if_changed` wird von vierzig gleichgueltigen
 * Fragewoertern weggemittelt. Das Maximum nicht.
 *
 * Gemessen: @3 42,0 → 44,1 % auf 2001 Fragen aus sechs NIE gesehenen
 * Projekten (p<0,0001), Gewinn in fuenf von sechs Projekten, Zufalls-
 * kontrolle −54 Faelle. Diese Proben sichern die BAUGLEICHHEIT mit jener
 * Messung — nicht die Zahl selbst, die steht im Laufordner
 * (.agent/_naturworkshop/laeufe/2026-08-24-verfahren-suche-3/).
 */

const worte = (s: string) => inhaltsWoerter(s);

describe('Seltenheit.besterZeuge', () => {
  const texte = [
    'der deploy scheitert am fail2ban regelwerk',
    'die anmeldung braucht einen neuen schluessel',
    'der deploy braucht eine neue anmeldung',
    'ein regelwerk fuer die anmeldung',
  ];
  const s = new Seltenheit(texte);

  it('der seltenste GETEILTE Token entscheidet — nicht der Durchschnitt', () => {
    /*
     * "fail2ban" steht in genau einem Text, "deploy" in zweien. Eine Frage,
     * die beide traegt, bekommt gegen Text 0 den fail2ban-Wert — den
     * hoechsten —, egal wie viele gleichgueltige Woerter danebenstehen.
     */
    const frage = worte('warum scheitert der deploy am fail2ban und was ist heute anders als gestern ueberhaupt');
    const mitFail2ban = s.besterZeuge(frage, worte(texte[0]));
    const nurDeploy = s.besterZeuge(frage, worte(texte[2]));
    expect(mitFail2ban).toBeGreaterThan(nurDeploy);
    expect(nurDeploy).toBeGreaterThan(0);
  });

  it('kein geteiltes Wort heisst 0 — ein echter Wert, kein Ausfall', () => {
    expect(s.besterZeuge(worte('voellig anderes thema'), worte(texte[0]))).toBe(0);
  });

  it('liegt in 0..1 — normiert, damit das Gewicht uebertragbar bleibt', () => {
    for (const t of texte) {
      const z = s.besterZeuge(worte(t), worte(t));
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThanOrEqual(1);
    }
  });

  it('KONTROLLE: mehr gleichgueltige Woerter aendern das Maximum NICHT', () => {
    /*
     * Genau der Defekt der Deckung: dort druecken vierzig Fuellwoerter den
     * Wert. Das Maximum muss davon unberuehrt bleiben — sonst waere es nur
     * eine zweite Schreibweise des Anteils.
     */
    const kurz = worte('deploy fail2ban');
    const lang = worte('deploy fail2ban und noch sehr viele voellig andere gleichgueltige woerter ohne jeden treffer darin enthalten');
    const text = worte(texte[0]);
    expect(s.besterZeuge(lang, text)).toBe(s.besterZeuge(kurz, text));
    // Waehrend die Deckung genau daran faellt:
    expect(s.deckung(lang, new Set([...text]))).toBeLessThan(s.deckung(kurz, new Set([...text])));
  });
});

describe('bewerteTopf verrechnet den Zeugen exakt wie der Messstand', () => {
  const topf = [
    { naeheText: 0.61, naeheThema: 0.3, naeheRueckkopplung: 0.60, seltenheitsDeckung: 0.10, besterZeuge: 0.9 },
    { naeheText: 0.64, naeheThema: 0.3, naeheRueckkopplung: 0.66, seltenheitsDeckung: 0.12, besterZeuge: 0.1 },
    { naeheText: 0.52, naeheThema: 0.2, naeheRueckkopplung: 0.50, seltenheitsDeckung: 0.05, besterZeuge: 0.4 },
  ];

  it('identisch mit: Grundpunkte + 0,5 · spreizeImTopf(zeuge)', () => {
    /*
     * So wurde gemessen (messung-bester-zeuge.mjs): erst bewerteTopf OHNE
     * den Zeugen, dann LAM · spreizeImTopf dazu. Der Einbau zieht das INS
     * bewerteTopf — die Punktzahlen muessen bitgenau uebereinstimmen, sonst
     * liefern wir etwas anderes aus, als die 44,1 % belegt haben.
     */
    /*
     * Die Basis MIT Gewicht 0 rechnen, nicht mit weggelassenem Feld: bei
     * weggelassenem Feld spreizt der Topf lauter Nullen zu lauter 0,5 und
     * addiert eine Konstante — die Rangfolge bleibt, die Punktzahl nicht.
     * Das Messskript hatte den Zeugen-Term schlicht nicht; Gewicht 0 ist
     * die bitgenaue Entsprechung.
     */
    const ohne = bewerteTopf(topf, { ...GEWICHTE, zeuge: 0 } as typeof GEWICHTE);
    const gespreizt = spreizeImTopf(topf.map((k) => k.besterZeuge));
    const soll = ohne.map((p, i) => p + GEWICHTE.zeuge * gespreizt[i]);
    const ist = bewerteTopf(topf, GEWICHTE);
    for (let i = 0; i < soll.length; i++) expect(ist[i]).toBeCloseTo(soll[i], 12);
  });

  it('ohne das Feld aendert sich KEINE Rangfolge — alte Aufrufer laufen weiter', () => {
    const alt = topf.map(({ besterZeuge: _weg, ...rest }) => rest);
    const punkteAlt = bewerteTopf(alt, GEWICHTE);
    // Dieselben Kandidaten mit besterZeuge ueberall 0 — die Topf-Spreizung
    // sieht lauter Gleiche und darf nur eine KONSTANTE addieren.
    const punkteNull = bewerteTopf(alt.map((k) => ({ ...k, besterZeuge: 0 })), GEWICHTE);
    const ordnung = (p: number[]) => p.map((x, i) => [x, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    expect(ordnung(punkteNull)).toEqual(ordnung(punkteAlt));
  });

  it('KONTROLLE: ein fehlendes Gewicht macht keine NaN-Punkte', () => {
    /*
     * Vergleichswerkzeuge bauen Gewichts-Objekte aus Zeichenketten und
     * kennen `zeuge` womoeglich nicht. Undefined · Zahl waere NaN, und NaN
     * sortiert still falsch — der schlimmste aller Ausgaenge.
     */
    const ohneZeuge = { text: 1, thema: 0, rueckkopplung: 0.3, seltenheit: 1.3 } as unknown as typeof GEWICHTE;
    for (const p of bewerteTopf(topf, ohneZeuge)) expect(Number.isFinite(p)).toBe(true);
  });

  it('KONTROLLE: der Zeuge kann eine Rangfolge wirklich drehen', () => {
    // Sonst waere alles oben gruen, weil das Merkmal nie etwas tut.
    const ordnung = (p: number[]) => p.map((x, i) => [x, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    const mit = ordnung(bewerteTopf(topf, GEWICHTE));
    const ohne = ordnung(bewerteTopf(topf.map(({ besterZeuge: _weg, ...rest }) => rest), GEWICHTE));
    expect(mit).not.toEqual(ohne);
    // Und zwar zugunsten des Kandidaten mit dem starken Zeugen (Index 0).
    expect(mit[0]).toBe(0);
  });
});
