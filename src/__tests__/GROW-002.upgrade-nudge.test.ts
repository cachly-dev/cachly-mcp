// Abnahme GROW-002 — der Upgrade-Moment.
//
// Warum es diesen Test gibt: die kostenlose Abrufmenge (500/Monat,
// api/internal/handler/instance_handler.go Z.420-423) war im MCP-Server nur als
// WAND verdrahtet (gateActive = recallGate.reached, handlers/brain.ts Z.1332).
// Eine Grenze, die man erst beim Aufprall bemerkt, kostet Vertrauen und
// Umsatz gleichzeitig: der Nutzer erlebt einen Ausfall statt eines Angebots.
//
// Der Test friert drei Zusagen ein:
//   1. Ein Zahler wird nie angebettelt (limit <= 0 => null).
//   2. Unterhalb von 80 Prozent bleibt es still.
//   3. Der Hinweis nennt keine Preiszahl und keine Prozentzahl. Grund: RES-017
//      fand eine deutsche Preistabelle mit 9/29 EUR, waehrend Stripe 19/49
//      verlangte. Jede Zahl, die an zwei Orten steht, driftet auseinander.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { upgradeNudge } from '../upgrade-nudge.js';

const FREI = 500; // Freimenge je Monat, Quelle: instance_handler.go Z.420-423

describe('GROW-002: der Hinweis kommt vor der Wand, nicht danach', () => {
  it('schweigt bei unbegrenzten Abrufen (Pro und darueber, limit = -1)', () => {
    expect(upgradeNudge({ used: 99_999, limit: -1, savedMins: 5000 })).toBeNull();
  });

  it('schweigt, wenn die Grenze unbekannt ist (limit = 0 — Stats nicht erreichbar)', () => {
    expect(upgradeNudge({ used: 400, limit: 0, savedMins: 5000 })).toBeNull();
  });

  it('schweigt unterhalb von 80 Prozent — kein Genoergel bei normaler Nutzung', () => {
    expect(upgradeNudge({ used: 0, limit: FREI, savedMins: 600 })).toBeNull();
    expect(upgradeNudge({ used: 399, limit: FREI, savedMins: 600 })).toBeNull();
  });

  it('meldet sich ab 80 Prozent und nennt die gemessene Restzahl', () => {
    const text = upgradeNudge({ used: 400, limit: FREI, savedMins: 0 });
    expect(text).toBeTruthy();
    expect(text as string).toContain('100'); // 500 - 400 = 100 Abrufe uebrig
  });

  it('nennt bei aufgebrauchter Menge die Null, nicht eine negative Zahl', () => {
    const genau = upgradeNudge({ used: FREI, limit: FREI, savedMins: 0 }) as string;
    const drueber = upgradeNudge({ used: FREI + 37, limit: FREI, savedMins: 0 }) as string;
    expect(genau).toBeTruthy();
    expect(drueber).toBeTruthy();
    expect(genau).toContain('0');
    expect(drueber).not.toMatch(/-\d/);
  });

  it('fuehrt zur Preisseite, damit der naechste Schritt ein Klick ist', () => {
    const text = upgradeNudge({ used: 450, limit: FREI, savedMins: 0 }) as string;
    expect(text).toContain('cachly.dev/pricing');
  });

  it('nennt WEDER Preis NOCH Prozentzahl (Drift-Schutz, Lehre RES-017)', () => {
    for (const used of [400, 450, 500, 900]) {
      const text = upgradeNudge({ used, limit: FREI, savedMins: 3000 }) as string;
      expect(text).not.toMatch(/€|EUR|\bUSD\b|\$\d/);
      expect(text).not.toMatch(/\d+\s*%/);
    }
  });

  it('stellt den Nutzen daneben, sobald er messbar ist (>= 60 Minuten)', () => {
    const mitNutzen = upgradeNudge({ used: 450, limit: FREI, savedMins: 120 }) as string;
    expect(mitNutzen).toContain('2h');
  });

  it('behauptet keinen Nutzen, wenn keiner gemessen wurde (< 60 Minuten)', () => {
    const ohneNutzen = upgradeNudge({ used: 450, limit: FREI, savedMins: 12 }) as string;
    expect(ohneNutzen).toBeTruthy();
    expect(ohneNutzen).not.toMatch(/saved/i);
  });

  it('vertraegt kaputte Eingaben, statt die Sitzung zu sprengen', () => {
    expect(upgradeNudge({ used: Number.NaN, limit: FREI, savedMins: 0 })).toBeNull();
    expect(upgradeNudge({ used: 450, limit: Number.NaN, savedMins: 0 })).toBeNull();
    expect(() => upgradeNudge({ used: -5, limit: FREI, savedMins: -5 })).not.toThrow();
  });
});

describe('GROW-002: die Nahtstelle — der Hinweis haengt wirklich im Briefing', () => {
  it('brain.ts benutzt dieselbe Funktion, die dieser Test prueft (keine Zweitfassung)', () => {
    const src = readFileSync(new URL('../handlers/brain.ts', import.meta.url), 'utf8');
    expect(src).toContain('upgrade-nudge.js');
    expect(src).toContain('upgradeNudge(');
  });

  it('der Hinweis haengt GENAU EINMAL im Quelltext — nicht an mehreren Stellen', () => {
    const src = readFileSync(new URL('../handlers/brain.ts', import.meta.url), 'utf8');
    const aufrufe = (src.match(/upgradeNudge\(/g) ?? []).length;
    expect(aufrufe).toBe(1);
  });

  it('und zwar im SITZUNGSBRIEFING, nicht bei jedem einzelnen Abruf', () => {
    // KORREKTUR der ersten Fassung dieses Tests (11.08.2026): dort stand
    // src.indexOf('Brain saved you ~'). Diese Zeichenkette kommt ZWEIMAL vor —
    // zuerst im Pro-Lektion-Banner von smart_recall, erst danach im
    // Sitzungsbriefing. indexOf traf also den falschen Anker und zwang den
    // Hinweis in smart_recall. Dort haette er bei JEDEM Abruf gefeuert, sobald
    // jemand ueber 80 Prozent liegt — mit Ambient Recall also bei jedem Prompt.
    // Genau das Genoergel, das der Vertrag ausschliesst. Deshalb wird jetzt auf
    // die Zeichenkette verankert, die es NUR im Briefing gibt.
    const src = readFileSync(new URL('../handlers/brain.ts', import.meta.url), 'utf8');
    // ANKER VERSCHOBEN 22.08.2026: Der alte Satz "(time not re-researching
    // known fixes)" ist weg — die Zahl nennt jetzt ihre Grundlage. Der neue
    // Anker erfuellt dieselbe Bedingung: er kommt NUR im Briefing vor, nicht
    // im Pro-Lektion-Banner von smart_recall. Die Probe unten beweist das.
    const anker = src.indexOf('of your own lessons that already helped');
    const aufruf = src.indexOf('upgradeNudge(');
    expect(anker).toBeGreaterThan(-1);
    expect(aufruf).toBeGreaterThan(-1);
    expect(Math.abs(aufruf - anker)).toBeLessThan(2000);
  });

  it('der Anker ist EINDEUTIG — sonst zeigt indexOf wieder auf die falsche Stelle', () => {
    // Genau daran ist die Probe oben schon einmal gescheitert: sie ankerte auf
    // 'Brain saved you ~', und das steht DREIMAL in der Datei. indexOf traf den
    // ersten Treffer im smart_recall-Banner und bewies damit das Gegenteil von
    // dem, was drueberstand. Ein Anker, der mehrfach vorkommt, ist kein Anker.
    const src = readFileSync(new URL('../handlers/brain.ts', import.meta.url), 'utf8');
    const treffer = src.split('of your own lessons that already helped').length - 1;
    expect(treffer, 'Anker kommt mehrfach vor — die Probe oben wird unzuverlaessig').toBe(1);

    // Die Gegenprobe, die zeigt, dass diese Zaehlung ueberhaupt etwas findet:
    // die alte, mehrdeutige Zeichenkette steht weiterhin mehrfach da.
    const alteFalle = src.split('Brain saved you ~').length - 1;
    expect(alteFalle).toBeGreaterThan(1);
  });

  it('die reine Funktion bleibt rein — kein Netz, kein Redis, kein Dateisystem', () => {
    const src = readFileSync(new URL('../upgrade-nudge.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(|node:fs|ioredis|apiFetch/);
  });

  it('der demo-Ausgang traegt ein Quellenkennzeichen, sonst zaehlt ihn niemand', () => {
    // ANGEPASST DURCH GROW-011: geprueft wird nicht mehr die woertliche
    // Zeichenkette 'utm_source=cli-demo'. GROW-011 hat alle 38 Adressen auf die
    // gemeinsame Funktion cachlyUrl umgestellt, die das Kennzeichen zentral
    // anhaengt — die Zeichenkette steht seither in cachly-url.ts, nicht mehr an
    // der Fundstelle. Die ABSICHT bleibt und wird schaerfer geprueft als zuvor:
    // der Vorschau-Link des demo-Befehls muss die Quelle 'demo' fuehren. Eine
    // Zusicherung, die ein Refactoring bricht ohne dass sich Verhalten aendert,
    // wird angepasst — nicht der Code verbogen.
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/cachlyUrl\([^\n]*preview[^\n]*['"]demo['"]/);
  });
});
