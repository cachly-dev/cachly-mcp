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
    nachher    25 Werkzeuge    32.011 B    ~8.003 Token   -71 %

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

  // ── Die Sperrklinke ─────────────────────────────────────────────────────
  //
  // Sie darf nur FALLEN. Wer ein Werkzeug in KERNWERKZEUGE aufnimmt,
  // bezahlt es in jeder Anfrage — und sieht hier, wie viel.
  const OBERGRENZE_BYTE = 34_000;

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
