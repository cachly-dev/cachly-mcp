import { describe, it, expect } from 'vitest';
import {
  KERNWERKZEUGE,
  VERTEILER,
  sichtbareWerkzeuge,
  verteilerBeschreibung,
  type Werkzeug,
} from './werkzeug-auswahl.js';
import { TOOLS } from './tools.js';

const ALLE = TOOLS as unknown as Werkzeug[];

/*
── Was hier bewacht wird ────────────────────────────────────────────────────

Gemessen am 28.08.2026 an docs/generated/tool-specs/cachly.anthropic.json:

    vorher    123 Werkzeuge   111.014 B   ~27.754 Token
    nachher    27 Werkzeuge    32.422 B    ~8.106 Token   -71 %

Davon 1.763 B aus gekuerzten Feldbeschreibungen: die langen Fassungen
erklaerten, was wir mit dem Wert SPAETER machen ("Powers brain_service_map",
"the value only a shared brain delivers"). Das ist Architektur- und
Werbetext. Er kostete in jeder Anfrage Token und half beim Ausfuellen nicht.
Geblieben ist Zweck, Format, Beispiel und jede Bedingung. Kein Feld
entfernt.

Diese Token gehen in JEDER Anfrage mit. Bei 200k Fenster waren 14 % weg,
bevor der Nutzer ein Wort gesagt hatte.

Die gefährliche Seite der Sparsamkeit: ein Werkzeug, das aus dem Katalog
fliegt und auch nicht im Verteiler steht, ist für ein Modell nicht mehr
auffindbar — ohne dass irgendwo ein Fehler entsteht. Genau dagegen steht die
Probe "kein Werkzeug verschwindet spurlos".
*/

describe('Werkzeug-Auswahl: weniger im Katalog, nichts verloren', () => {
  it('kein Werkzeug verschwindet spurlos', () => {
    const { katalog, uebrige } = sichtbareWerkzeuge(ALLE, {});
    const sichtbar = new Set(katalog.map((w) => w.name));
    const imVerteiler = new Set(uebrige);

    const verloren = ALLE.map((w) => w.name).filter(
      (n) => !sichtbar.has(n) && !imVerteiler.has(n),
    );
    expect(
      verloren,
      'Diese Werkzeuge stehen weder im Katalog noch beim Verteiler. Ein Modell\n' +
        'kann sie nicht finden, und es entsteht dabei kein Fehler — die\n' +
        'schlimmste Sorte Verlust:\n  ' + verloren.join('\n  '),
    ).toEqual([]);
  });

  it('die Beschreibung des Verteilers nennt JEDEN uebrigen Namen', () => {
    // Die Namen sind das Einzige, was von den 98 Werkzeugen ueberbleibt.
    // Fehlt einer im Text, ist er unauffindbar.
    const { uebrige } = sichtbareWerkzeuge(ALLE, {});
    const text = verteilerBeschreibung(uebrige);
    const fehlend = uebrige.filter((n) => !text.includes(n));
    expect(fehlend, `nicht in der Beschreibung: ${fehlend.join(', ')}`).toEqual([]);
  });

  it('die Roadmap bleibt VOLLSTAENDIG eigenstaendig', () => {
    // Ausdruecklicher Wunsch, und deshalb festgenagelt: alle vier, nicht drei.
    const { katalog } = sichtbareWerkzeuge(ALLE, {});
    const drin = new Set(katalog.map((w) => w.name));
    for (const r of ['roadmap_add', 'roadmap_list', 'roadmap_next', 'roadmap_update']) {
      expect(drin.has(r), `${r} fehlt im Katalog`).toBe(true);
    }
  });

  it('was unsere eigene CLAUDE.md vorschreibt, steht eigenstaendig drin', () => {
    // Diese sechs stehen als Pflicht in jeder Sitzung. Haengt eines davon
    // hinter dem Verteiler, kostet jeder Pflichtaufruf einen Umweg.
    const { katalog } = sichtbareWerkzeuge(ALLE, {});
    const drin = new Set(katalog.map((w) => w.name));
    for (const p of [
      'session_start', 'smart_recall', 'remember_context',
      'learn_from_attempts', 'causal_trace', 'session_end',
    ]) {
      expect(drin.has(p), `${p} ist Pflicht laut CLAUDE.md, steht aber nicht im Katalog`).toBe(true);
    }
  });

  it('der Verteiler ist genau EINMAL da', () => {
    const { katalog } = sichtbareWerkzeuge(ALLE, {});
    expect(katalog.filter((w) => w.name === VERTEILER)).toHaveLength(1);
  });

  it('CACHLY_ALLE_WERKZEUGE=1 stellt den vollen Katalog her', () => {
    // Der Rueckweg. Ohne ihn waere die Sparsamkeit eine Einbahnstrasse.
    const { katalog, uebrige } = sichtbareWerkzeuge(ALLE, { CACHLY_ALLE_WERKZEUGE: '1' });
    expect(katalog).toHaveLength(ALLE.length);
    expect(uebrige).toEqual([]);
    expect(katalog.some((w) => w.name === VERTEILER)).toBe(false);
  });

  it('ein Kernname ohne Werkzeug wird GEMELDET, nicht verschluckt', () => {
    // Sonst stuende er weder eigenstaendig im Katalog noch beim Verteiler —
    // und niemand saehe, dass eine Zeile in KERNWERKZEUGE ins Leere zeigt.
    const nur = ALLE.slice(0, 3);
    const { unbekannteKernnamen } = sichtbareWerkzeuge(nur, {});
    expect(unbekannteKernnamen.length).toBeGreaterThan(0);
  });

  it('heute zeigt KEIN Kernname ins Leere', () => {
    const { unbekannteKernnamen } = sichtbareWerkzeuge(ALLE, {});
    expect(unbekannteKernnamen, `KERNWERKZEUGE nennt Werkzeuge, die es nicht gibt`).toEqual([]);
  });

  it('gaebe es nichts zu verstecken, waere der Verteiler nur Ballast', () => {
    const nurKern = ALLE.filter((w) => KERNWERKZEUGE.includes(w.name));
    const { katalog } = sichtbareWerkzeuge(nurKern, {});
    expect(katalog.some((w) => w.name === VERTEILER)).toBe(false);
  });

  /*
   * ── Die Sperrklinke ────────────────────────────────────────────────────
   *
   * Wer ein Werkzeug in KERNWERKZEUGE aufnimmt, bezahlt es in JEDER Anfrage
   * — und sieht hier, wie viel.
   *
   * Sie hat sofort funktioniert: der erste Entwurf stand auf 34.000, und die
   * Aufnahme von cache_get und cache_set (1.877 B) riss sie auf 34.185.
   *
   * DIE GRENZE WURDE DARAUFHIN ANGEHOBEN — bewusst, nicht still. Der Zweck
   * einer Sperrklinke ist, DRIFT zu verhindern, nicht Entscheidungen. Eine
   * Entscheidung mit Begruendung und gemessener Zahl darf sie bewegen; ein
   * unbemerktes Anwachsen nicht.
   *
   * Die Begruendung steht in werkzeug-auswahl.ts bei den beiden Namen: der
   * Cache ist das zweite Produkt, und ein Umweg beim naheliegendsten Satz
   * ("cache das") ist teuer erkauft.
   *
   *     34.000  erster Entwurf, 25 Werkzeuge
   *     35.000  angehoben fuer cache_get/cache_set (34.185 gemessen)
   *     33.000  jetzt, nach dem Kuerzen der Feldprosa (32.422 gemessen)
   */
  const OBERGRENZE_BYTE = 33_000;

  it('der Katalog bleibt unter der Obergrenze', () => {
    const { katalog } = sichtbareWerkzeuge(ALLE, {});
    const gross = JSON.stringify(katalog).length;
    // Der gelesene Wert steht IMMER da, nicht nur beim Scheitern — sonst
    // laesst sich die Grenze nie nachziehen.
    console.log(`[werkzeuge] ${katalog.length} im Katalog, ${gross} Byte (~${Math.round(gross / 4)} Token), Grenze ${OBERGRENZE_BYTE}`);
    expect(
      gross,
      `Der Katalog geht in JEDER Anfrage mit. Vor dem Umbau waren es 111.014 Byte\n` +
        `(~27.754 Token). Wer die Grenze anhebt, hebt die Kosten jeder Anfrage.`,
    ).toBeLessThanOrEqual(OBERGRENZE_BYTE);
  });

  it('GEGENPROBE: die Grenze wuerde den alten Katalog reissen', () => {
    // Ohne diese Zeile bewiese die Sperrklinke nichts: eine zu grosszuegige
    // Grenze ist gruen und bewacht Luft.
    expect(JSON.stringify(ALLE).length).toBeGreaterThan(OBERGRENZE_BYTE);
  });
});

/*
── Die erzeugten Anleitungen duerfen nur Kernwerkzeuge nennen ───────────────

Ein Werkzeug, das nicht in tools/list steht, bekommt das MODELL gar nicht
angeboten — der Server wuerde es zwar bedienen, aber niemand ruft es. Nennt
unsere erzeugte CLAUDE.md also einen Namen, der aus dem Katalog geflogen ist,
dann steht dort eine Anweisung, die nicht ausfuehrbar ist.

Das faellt nirgends auf: keine Fehlermeldung, kein roter Lauf. Nur eine
Pflicht, die still nicht mehr erfuellt wird.

Geprueft wird der Text, den buildClaudeMdBlock wirklich erzeugt — nicht eine
Liste daneben, die auseinanderlaufen kann.
*/
describe('Erzeugte Anleitungen nennen nur Werkzeuge, die im Katalog stehen', async () => {
  const { buildClaudeMdBlock } = await import('./index.js');

  it('jeder genannte Werkzeugname ist ein Kernwerkzeug', () => {
    const text = buildClaudeMdBlock('00000000-0000-0000-0000-000000000000');
    const alleNamen = new Set(ALLE.map((w) => w.name));
    const kern = new Set(KERNWERKZEUGE);

    // Nur echte Werkzeugnamen, nicht jedes Wort mit Unterstrich.
    const genannt = [...new Set(
      (text.match(/\b[a-z][a-z0-9_]{4,}\b/g) ?? []).filter((n) => alleNamen.has(n)),
    )];

    expect(genannt.length, 'die Anleitung nennt gar kein Werkzeug — dann prueft dieser Test nichts')
      .toBeGreaterThan(3);

    const unerreichbar = genannt.filter((n) => !kern.has(n));
    expect(
      unerreichbar,
      'Diese Namen stehen in der erzeugten Anleitung, aber nicht im Katalog.\n' +
        'Das Modell bekommt sie nicht angeboten — die Anweisung ist tot, ohne\n' +
        'dass irgendwo ein Fehler entsteht. Entweder in KERNWERKZEUGE aufnehmen\n' +
        'oder die Anleitung auf cachly_tool umstellen:\n  ' + unerreichbar.join('\n  '),
    ).toEqual([]);
  });
});
