/**
 * Wächter für den Bedeutungsabgleich.
 *
 * Geprüft wird nicht "liefert es gute Treffer" — das misst der Bench gegen den
 * echten Bestand. Hier stehen die Zusagen, die auch mit drei Datensätzen
 * greifen und deren Bruch sonst still bliebe.
 */

import { describe, it, expect } from 'vitest';
import {
  packe, entpacke, kosinus, textFuerVektor, mischeRangfolgen, Vektorbestand, VEKTOR_PRAEFIX,
} from './bedeutung.js';

describe('Vektoren packen und entpacken', () => {
  // Bis 20.08.2026 stand hier `toBeCloseTo(v[i], 5)` — also float32-Genauigkeit
  // als Bedingung. Das ist keine Anforderung, das war eine Beschreibung des
  // damaligen Formats. Seit der Umstellung auf int8 prüft dieser Block, was
  // wirklich gebraucht wird: die RICHTUNG des Vektors, denn nur die geht in den
  // Kosinus ein. Ein Test, der die Genauigkeit einer Zahl bewacht, hätte die
  // Speicherersparnis verboten, ohne je einen Nutzerschaden zu belegen.

  it('behält die Richtung — Kosinus zum Original über 0,9999', () => {
    const v = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.7);
    const zurueck = entpacke(packe(v));
    expect(zurueck).not.toBeNull();
    expect(zurueck).toHaveLength(1024);
    // Das ist die einzige Eigenschaft, an der die Suche hängt.
    expect(kosinus(v, zurueck!)).toBeGreaterThan(0.9999);
  });

  it('hält den Fehler je Zahl unter einer halben Stufe', () => {
    const v = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.7);
    const zurueck = entpacke(packe(v))!;
    // Skala = groesster Betrag / 127, also ist der groesste zulaessige Fehler
    // eine halbe Stufe. Als Zahl statt als Nachkommastelle, damit die Grenze
    // aus der Rechnung kommt und nicht aus einem Gefuehl.
    const groesstes = Math.max(...v.map(Math.abs));
    const grenze = groesstes / 127 / 2 * 1.001;
    for (let i = 0; i < v.length; i++) {
      expect(Math.abs(zurueck[i] - v[i])).toBeLessThanOrEqual(grenze);
    }
  });

  it('GEGENPROBE: ein grob verfaelschter Vektor faellt durch dieselbe Pruefung', () => {
    // Ohne sie waere die Kosinus-Schwelle oben auch dann gruen, wenn packe
    // etwas voellig anderes zurueckgaebe.
    const v = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.7);
    const kaputt = v.map((x, i) => (i % 3 === 0 ? -x : x));
    expect(kosinus(v, kaputt)).toBeLessThan(0.9999);
  });

  it('liest das ALTE float32-Format weiter', () => {
    // 507 Vektoren lagen am Umstellungstag im echten Bestand. Wer sie nicht mehr
    // lesen kann, schaltet den Bedeutungsabgleich still ab — und still ist die
    // schlimmste Art, das zu tun.
    const v = Array.from({ length: 1024 }, (_, i) => Math.cos(i) * 0.4);
    const f = new Float32Array(v);
    const altBase64 = Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
    const zurueck = entpacke(altBase64);
    expect(zurueck).not.toBeNull();
    expect(zurueck).toHaveLength(1024);
    for (let i = 0; i < v.length; i++) expect(zurueck![i]).toBeCloseTo(v[i], 5);
  });

  it('spart gegenüber float32 rund den Faktor vier', () => {
    // Der Anlass: von 23,6 MB im echten Bestand waren 11,2 MB Vektoren, bei
    // 25 MB Tarifgrenze. Gemessen: 5 464 Zeichen als float32-base64 gegen
    // 1 380 als int8-base64.
    const v = Array.from({ length: 1024 }, () => 0.123456789);
    const f = new Float32Array(v);
    const alsFloat32 = Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
    expect(packe(v).length).toBeLessThan(alsFloat32.length / 3.5);
  });

  it('gibt bei Unsinn null zurück statt zu raten', () => {
    expect(entpacke('')).toBeNull();
    expect(entpacke('abc')).toBeNull(); // keine durch 4 teilbare Länge
  });

  it('verwechselt die beiden Formate nicht', () => {
    // Die Kennung 0x01 allein reicht nicht: ein float32 darf zufaellig mit
    // 0x01 anfangen. Deshalb muss AUSSERDEM die Laenge stimmen. Hier ein
    // float32-Block, dessen erstes Byte 0x01 ist.
    const b = Buffer.alloc(4096);
    b.writeUInt8(0x01, 0);
    b.writeUInt8(0x02, 1);
    const zurueck = entpacke(b.toString('base64'));
    expect(zurueck).not.toBeNull();
    expect(zurueck).toHaveLength(1024); // als float32 gelesen, nicht als int8
  });
});

describe('Kosinus', () => {
  it('ist 1 für denselben Vektor und 0 für senkrechte', () => {
    expect(kosinus([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(kosinus([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
  });

  it('meldet verschiedene Längen als unähnlich statt still zu rechnen', () => {
    // Ein Modellwechsel ändert die Vektorlänge. Ohne diese Prüfung würden alte
    // und neue Vektoren stillschweigend gemischt und lieferten Unsinn, der wie
    // ein Ergebnis aussieht.
    expect(kosinus([1, 0], [1, 0, 0])).toBe(-1);
  });
});

describe('Text für den Vektor', () => {
  it('nimmt Thema, Lösung und Fehlversuch — nicht das rohe JSON', () => {
    const t = textFuerVektor({
      topic: 'ci:platte-voll', what_worked: 'Runner neu starten',
      what_failed: 'cancel reichte nicht', recall_count: 12, ts: '2026-08-19',
      audit_trail: [{ at: 'x' }],
    });
    expect(t).toContain('ci:platte-voll');
    expect(t).toContain('Runner neu starten');
    expect(t).toContain('cancel reichte nicht');
    expect(t).not.toContain('recall_count');
    expect(t).not.toContain('audit_trail');
  });

  it('kürzt bei 2000 Zeichen', () => {
    // Nicht aus Sparsamkeit: gemessen am 19.08.2026 liefert der Dienst für
    // 2000, 4000 und 6000 Zeichen DENSELBEN Vektor. Was dahinter steht,
    // existiert für ihn nicht — also soll es auch nicht so aussehen, als würde
    // es mitgeschickt.
    const t = textFuerVektor({ topic: 'x', what_worked: 'A'.repeat(5000) });
    expect(t.length).toBeLessThanOrEqual(2000);
  });
});

describe('Rangfolgen mischen', () => {
  it('bringt nach vorn, was in BEIDEN Listen weit oben steht', () => {
    // Die eigentliche Zusage: gut in beiden schlaegt erster in einem.
    //
    // `A` steht bei den Woertern auf 1 und bei der Bedeutung auf 2.
    // `E` steht bei der Bedeutung auf 1, bei den Woertern aber ganz hinten.
    // A muss gewinnen — sonst waere die Mischung nur die staerker gewichtete
    // Liste mit Umweg.
    //
    // Die erste Fassung dieses Falls benutzte drei umgedrehte Eintraege und
    // erwartete den mittleren. Nachgerechnet lagen dort alle drei innerhalb von
    // 0,00021 — der Test haette eine Muenze geprueft.
    // Das Gewicht steht hier AUSDRUECKLICH auf 0,5. Der Fall prueft den
    // Mechanismus, nicht die gewaehlte Einstellung.
    const gemischt = mischeRangfolgen(
      ['A', 'B', 'C', 'D', 'E'],
      ['E', 'A', 'C', 'D', 'B'],
      0.5,
    );
    expect(gemischt[0]).toBe('A');
  });

  it('bei unserem Gewicht 0,1 entscheidet die Bedeutung', () => {
    // Die ehrliche Kehrseite der gemessenen Einstellung: mit 10 Prozent
    // Wortgewicht kann ein Wort-Treffer eine Bedeutungs-Rangfolge kaum noch
    // drehen. Wer WORT_GEWICHT anhebt, aendert genau das — und soll es hier
    // sehen statt es zu entdecken.
    const gemischt = mischeRangfolgen(
      ['A', 'B', 'C', 'D', 'E'],
      ['E', 'A', 'C', 'D', 'B'],
    );
    expect(gemischt[0]).toBe('E');
  });

  it('braucht keine gemeinsame Einheit', () => {
    // Der eigentliche Punkt. BM25-Punkte sind nach oben offen, ein Kosinus
    // liegt zwischen -1 und 1. Gemischt wird über die PLATZIERUNG — deshalb
    // hängt das Ergebnis nicht davon ab, wie groß die Zahlen waren.
    const a = ['x', 'y', 'z'];
    const b = ['z', 'y', 'x'];
    expect(mischeRangfolgen(a, b)).toEqual(mischeRangfolgen(a, b, 0.3));
  });

  it('verliert keinen Eintrag, den nur eine Liste kennt', () => {
    const gemischt = mischeRangfolgen(['nur-wort'], ['nur-sinn']);
    expect(gemischt).toContain('nur-wort');
    expect(gemischt).toContain('nur-sinn');
  });
});

// ── Vektorbestand ────────────────────────────────────────────────────────────

class RedisAttrappe {
  store = new Map<string, string>();
  scans = 0;
  async scan(cursor: string, _m: string, muster: string, _c: string, _n: number) {
    this.scans++;
    const p = muster.replace('*', '');
    return ['0', [...this.store.keys()].filter((k) => k.startsWith(p))] as [string, string[]];
  }
  async mget(...k: string[]) { return k.map((x) => this.store.get(x) ?? null); }
}

describe('Vektorbestand', () => {
  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];

  it('lädt und findet den ähnlichsten', async () => {
    const r = new RedisAttrappe();
    r.store.set(`${VEKTOR_PRAEFIX}a:eins`, packe(v1));
    r.store.set(`${VEKTOR_PRAEFIX}b:zwei`, packe(v2));

    const b = new Vektorbestand();
    await b.aktualisiere(r as never);
    expect(b.groesse).toBe(2);
    expect(b.aehnlichste([1, 0, 0], 1)[0].topic).toBe('a:eins');
  });

  it('lädt nicht bei jeder Frage neu', async () => {
    // Der Grund, warum es diesen Bestand gibt. 500 Vektoren sind rund 2 MB;
    // die bei jeder Frage zu holen wäre langsamer als der Wortabgleich, den
    // wir gerade ersetzen.
    const r = new RedisAttrappe();
    r.store.set(`${VEKTOR_PRAEFIX}a:eins`, packe(v1));
    const b = new Vektorbestand(60_000);
    await b.aktualisiere(r as never, 1000);
    await b.aktualisiere(r as never, 2000);
    await b.aktualisiere(r as never, 3000);
    expect(r.scans).toBe(1);
  });

  it('holt nach Ablauf der Frist neue Lektionen dazu', async () => {
    const r = new RedisAttrappe();
    r.store.set(`${VEKTOR_PRAEFIX}a:eins`, packe(v1));
    const b = new Vektorbestand(60_000);
    await b.aktualisiere(r as never, 1000);
    r.store.set(`${VEKTOR_PRAEFIX}b:zwei`, packe(v2));
    await b.aktualisiere(r as never, 1000 + 61_000);
    expect(b.groesse).toBe(2);
  });

  it('vergisst gelöschte Lektionen', async () => {
    // Ohne das bliebe eine geloeschte Lektion im Arbeitsspeicher und taeuchte
    // weiter in Antworten auf — ein Datenschutzproblem, kein Schoenheitsfehler.
    const r = new RedisAttrappe();
    r.store.set(`${VEKTOR_PRAEFIX}a:eins`, packe(v1));
    r.store.set(`${VEKTOR_PRAEFIX}b:zwei`, packe(v2));
    const b = new Vektorbestand(0);
    await b.aktualisiere(r as never, 1000);
    expect(b.groesse).toBe(2);

    r.store.delete(`${VEKTOR_PRAEFIX}b:zwei`);
    await b.aktualisiere(r as never, 2000);
    expect(b.groesse).toBe(1);
    expect(b.aehnlichste([0, 1, 0], 5).map((x) => x.topic)).not.toContain('b:zwei');
  });

  it('übersteht einen kaputten Eintrag, statt alles fallen zu lassen', async () => {
    const r = new RedisAttrappe();
    r.store.set(`${VEKTOR_PRAEFIX}a:eins`, packe(v1));
    r.store.set(`${VEKTOR_PRAEFIX}b:kaputt`, 'kein base64 float');
    const b = new Vektorbestand();
    await b.aktualisiere(r as never);
    expect(b.groesse).toBe(1);
  });
});
