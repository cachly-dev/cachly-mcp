import { describe, expect, it } from 'vitest';
import {
  fehlertexteAus, ohneMarkierungen, eingangsText, schreibeEingaenge,
  Eingangsbestand, EINGANG_PRAEFIX, EINGAENGE_JE_LEKTION, EINGANG_GEWICHT,
  beurteileDeckung,
} from './eingaenge.js';
import { packe } from './bedeutung.js';

/**
 * Ein Speicher-Ersatz, der genau das kann, was `schreibeEingaenge` und
 * `Eingangsbestand` von Redis verlangen. Bewusst klein: ein echter Redis im
 * Test wuerde die Zusicherung nicht schaerfer machen, nur langsamer.
 */
class MiniRedis {
  hashes = new Map<string, Record<string, string>>();
  geloescht: string[] = [];

  async del(k: string): Promise<number> {
    this.geloescht.push(k);
    return this.hashes.delete(k) ? 1 : 0;
  }

  async hset(k: string, ...felder: string[]): Promise<number> {
    const h = this.hashes.get(k) ?? {};
    for (let i = 0; i < felder.length; i += 2) h[felder[i]] = felder[i + 1];
    this.hashes.set(k, h);
    return felder.length / 2;
  }

  async hgetall(k: string): Promise<Record<string, string>> {
    return this.hashes.get(k) ?? {};
  }

  async scan(_c: string, _m: string, muster: string, ..._r: unknown[]): Promise<[string, string[]]> {
    const p = muster.replace('*', '');
    return ['0', [...this.hashes.keys()].filter((k) => k.startsWith(p))];
  }
}

describe('fehlertexteAus — die eine Tuer, die traegt', () => {
  it('findet eine Meldung in Anfuehrungszeichen', () => {
    const aus = fehlertexteAus('Der Deploy brach ab mit "No space left on device" und der Runner stand.');
    expect(aus).toContain('No space left on device');
  });

  it('findet eine Fehlerklasse samt Umfeld', () => {
    const aus = fehlertexteAus('Es kam ein UnknownHostException: postgres und jeder Login war tot.');
    expect(aus.some((x) => x.startsWith('UnknownHostException'))).toBe(true);
  });

  it('nimmt ein Systemkuerzel nur MIT Umfeld', () => {
    const aus = fehlertexteAus('Der Runner starb mit EACCES beim Schreiben.');
    expect(aus.some((x) => x.startsWith('EACCES '))).toBe(true);
    // "EACCES" allein waere sechs Zeichen und als Vektor fast blind.
    expect(aus).not.toContain('EACCES');
  });

  it('findet den grossgeschriebenen Kernsatz am Anfang', () => {
    const aus = fehlertexteAus('DIE PLATTE WAR VOLL UND DER DEPLOY HING. Danach lief alles wieder.');
    expect(aus.some((x) => x.includes('DIE PLATTE WAR VOLL'))).toBe(true);
  });

  it('sagt Nein, wenn kein Fehlertext drinsteht', () => {
    expect(fehlertexteAus('Wir haben die Reihenfolge der Schritte getauscht und es lief.')).toEqual([]);
  });

  it('haelt die Obergrenze ein — mehr Tueren kosten Decke', () => {
    const viel = 'ERSTE GROSSE AUSSAGE HIER. "meldung eins hier" "meldung zwei hier" '
      + '"meldung drei hier" "meldung vier hier" TypeError: kaputt EACCES beim Schreiben';
    expect(fehlertexteAus(viel).length).toBeLessThanOrEqual(EINGAENGE_JE_LEKTION);
  });

  it('wirft die Feldmarkierungen weg, bevor es sucht', () => {
    expect(ohneMarkierungen('a </what_worked>\n<what_failed> b')).toBe('a b');
  });

  it('liest what_worked UND what_failed', () => {
    const t = eingangsText({ what_worked: 'behoben', what_failed: '"connection refused" blieb' });
    expect(fehlertexteAus(t).some((x) => x.includes('connection refused'))).toBe(true);
  });
});

describe('schreibeEingaenge', () => {
  const einbetten = async (): Promise<number[]> => [1, 0, 0];

  it('legt je Fehlertext ein Feld an', async () => {
    const r = new MiniRedis();
    const n = await schreibeEingaenge(r as never, 'ci:platte',
      { what_worked: 'Der Worker meldete "No space left on device".' }, einbetten);
    expect(n).toBe(1);
    expect(Object.keys(r.hashes.get(`${EINGANG_PRAEFIX}ci:platte`) ?? {})).toHaveLength(1);
  });

  it('loescht den alten Hash, bevor es neu schreibt', async () => {
    const r = new MiniRedis();
    await schreibeEingaenge(r as never, 't', { what_worked: '"alter fehler hier" stand da' }, einbetten);
    await schreibeEingaenge(r as never, 't', { what_worked: '"neuer fehler hier" steht da' }, einbetten);
    const felder = Object.keys(r.hashes.get(`${EINGANG_PRAEFIX}t`) ?? {});
    expect(felder).toHaveLength(1);
    expect(felder[0]).toContain('neuer fehler');
    // Sonst blieben die Fehlertexte einer alten Fassung neben der neuen stehen —
    // eine zweite Wahrheit ueber denselben Text.
    expect(r.geloescht).toContain(`${EINGANG_PRAEFIX}t`);
  });

  it('legt gar nichts an, wenn die Lektion keinen Fehlertext traegt', async () => {
    const r = new MiniRedis();
    const n = await schreibeEingaenge(r as never, 't',
      { what_worked: 'Wir haben die Reihenfolge getauscht.' }, einbetten);
    expect(n).toBe(0);
    expect(r.hashes.has(`${EINGANG_PRAEFIX}t`)).toBe(false);
  });

  it('schreibt nichts, wenn das Einbetten ausfaellt', async () => {
    const r = new MiniRedis();
    const n = await schreibeEingaenge(r as never, 't',
      { what_worked: '"no such file" kam zurueck' }, async () => null);
    expect(n).toBe(0);
  });
});

describe('Eingangsbestand — der beste Eingang zaehlt', () => {
  const bestandMit = async (eintraege: Record<string, number[][]>): Promise<Eingangsbestand> => {
    const r = new MiniRedis();
    for (const [topic, vs] of Object.entries(eintraege)) {
      const felder: string[] = [];
      vs.forEach((v, i) => felder.push(`text-${i}`, packe(v)));
      if (felder.length) await r.hset(`${EINGANG_PRAEFIX}${topic}`, ...felder);
    }
    const b = new Eingangsbestand();
    await b.aktualisiere(r as never);
    return b;
  };

  it('nimmt das Maximum, nicht den Mittelwert', async () => {
    // "b" hat eine perfekt passende Tuer und drei schlechte. Beim Mittelwert
    // laege "a" vorn — genau der Fall, um den es geht.
    const b = await bestandMit({
      a: [[0.5, 0.4, 0]],
      b: [[0.95, 0.1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
    });
    const frage = [1, 0, 0];
    expect(b.besteNaehe(frage, 'b')).toBeGreaterThan(b.besteNaehe(frage, 'a'));
    expect(b.aehnlichste(frage, 1)[0].topic).toBe('b');
  });

  it('meldet -2 fuer eine Lektion ohne Eingang', async () => {
    const b = await bestandMit({ a: [[1, 0, 0]] });
    expect(b.besteNaehe([1, 0, 0], 'gibtsnicht')).toBe(-2);
  });

  it('zaehlt Lektionen und Eingaenge getrennt', async () => {
    const b = await bestandMit({ a: [[1, 0, 0], [0, 1, 0]], c: [[0, 0, 1]] });
    expect(b.groesse).toBe(2);
    expect(b.anzahlEingaenge).toBe(3);
  });

  it('das Gewicht steht im flachen Bereich der Messung', () => {
    // 0,3 / 0,5 / 0,8 / 1,3 ergaben 57 / 58 / 57 / 57 Prozent. Wer diesen Wert
    // aus dem Bereich schiebt, verlaesst das, was gemessen wurde.
    expect(EINGANG_GEWICHT).toBeGreaterThanOrEqual(0.3);
    expect(EINGANG_GEWICHT).toBeLessThanOrEqual(1.3);
  });
});

describe('beurteileDeckung — der Waechter, der Null von Fast-Alles trennt', () => {
  it('sagt AUS, wenn kein einziger Vektor da ist', () => {
    // Der echte Fall vom 20.08.2026: 506 Lektionen, 0 Vektoren.
    expect(beurteileDeckung(506, 0)).toBe('aus');
  });

  it('sagt LUECKE bei einer echten Luecke', () => {
    expect(beurteileDeckung(100, 80)).toBe('luecke');
    expect(beurteileDeckung(100, 89)).toBe('luecke');
  });

  it('sagt GUT ab 90 Prozent — einzelne Aussetzer sind kein Systemfehler', () => {
    // Gemessen: 7 von 507 fehlten nach dem ersten Lauf, alle beim zweiten geholt.
    expect(beurteileDeckung(507, 500)).toBe('gut');
    expect(beurteileDeckung(100, 90)).toBe('gut');
    expect(beurteileDeckung(100, 100)).toBe('gut');
  });

  it('ein leeres Brain ist nicht krank', () => {
    expect(beurteileDeckung(0, 0)).toBe('gut');
  });

  it('Gegenprobe: das Urteil unterscheidet AUS von LUECKE', () => {
    // Waeren beide gleich, koennte der Doktor nicht sagen, ob die Suche
    // ausgeschaltet ist oder nur ein paar Lektionen fehlen — und genau dieser
    // Unterschied war am 20.08. die ganze Nachricht.
    expect(beurteileDeckung(500, 0)).not.toBe(beurteileDeckung(500, 400));
  });
});
