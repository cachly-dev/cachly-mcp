// Abnahme GROW-011 — jeder Weg auf die Webseite wird zaehlbar.
//
// Warum es diesen Test gibt: sdk/mcp/src enthielt 39 Adressen auf cachly.dev,
// und genau ZWEI trugen ein Quellenkennzeichen. Die haeufigsten waren blind —
// /setup-ai zwoelfmal, /instances achtmal, /billing zweimal. Bei 68 npm-
// Downloads und 7 Web-Besuchern am Tag (erste Messung 11.08.) konnte niemand
// sagen, welcher Befehl die sieben bringt. Ohne Kennzeichen bleibt jede
// Verbesserung Raten.
//
// Der Test friert vier Zusagen ein:
//   1. Das Kennzeichen ist einheitlich, damit Plausible gruppieren kann.
//   2. Vorhandene Abfrageteile ueberleben — kein zweites Fragezeichen.
//   3. Kein Kennzeichen wird doppelt vergeben.
//   4. Nichts Personenbezogenes im Kennzeichen: nur der Befehlsname.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cachlyUrl } from '../cachly-url.js';

describe('GROW-011: die Adresse sagt, aus welchem Befehl sie kam', () => {
  it('haengt das Kennzeichen an eine einfache Adresse', () => {
    const url = cachlyUrl('/setup-ai', 'autopilot');
    expect(url).toContain('https://cachly.dev/setup-ai');
    expect(url).toContain('utm_source=');
    expect(url).toContain('autopilot');
  });

  it('erhaelt vorhandene Abfrageteile und erzeugt kein zweites Fragezeichen', () => {
    const url = cachlyUrl('/preview?repo=demo&commits=42', 'demo');
    expect(url).toContain('repo=demo');
    expect(url).toContain('commits=42');
    expect(url).toContain('utm_source=');
    expect((url.match(/\?/g) ?? []).length).toBe(1);
  });

  it('vergibt das Kennzeichen genau einmal, auch wenn schon eines dasteht', () => {
    const url = cachlyUrl('/instances?utm_source=alt', 'health');
    expect((url.match(/utm_source=/g) ?? []).length).toBe(1);
  });

  it('baut fuer verschiedene Befehle unterscheidbare Kennzeichen', () => {
    const a = cachlyUrl('/instances', 'digest');
    const b = cachlyUrl('/instances', 'invite');
    expect(a).not.toBe(b);
    expect(a).toContain('digest');
    expect(b).toContain('invite');
  });

  it('vertraegt einen Pfad ohne fuehrenden Schraegstrich', () => {
    expect(cachlyUrl('instances', 'setup')).toContain('https://cachly.dev/instances');
  });

  it('traegt NICHTS Personenbezogenes — nur den Befehlsnamen', () => {
    const url = cachlyUrl('/instances/8e03addd-a2d9-406e-bcbb-d6d8c938a3d0', 'briefing');
    // Die Instanz darf im PFAD stehen (sie gehoert zur Adresse), aber niemals
    // im Kennzeichen: sonst wandert eine Kennung in fremde Statistik.
    const kennzeichen = url.slice(url.indexOf('utm_source='));
    expect(kennzeichen).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(kennzeichen).not.toMatch(/cky_/);
  });

  it('liefert eine gueltige Adresse, die sich auswerten laesst', () => {
    const u = new URL(cachlyUrl('/billing', 'upgrade'));
    expect(u.hostname).toBe('cachly.dev');
    expect(u.pathname).toBe('/billing');
    expect(u.searchParams.get('utm_source')).toBeTruthy();
  });
});

describe('GROW-011: die Nahtstelle — es bleibt keine blinde Adresse uebrig', () => {
  it('index.ts baut seine Adressen ueber die Funktion', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).toContain('cachly-url.js');
    expect(src).toContain('cachlyUrl(');
  });

  it('in index.ts steht keine blinde cachly.dev-Adresse mehr', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    // Erlaubt ist die Adresse nur noch als Argument der Funktion oder als
    // reiner Text ohne Klick-Absicht. Verboten ist die alte Form: eine
    // vollstaendige Adresse mit Pfad, direkt in eine Ausgabe geschrieben.
    const blind = src.match(/https:\/\/cachly\.dev\/[a-z][a-z0-9/-]*/g) ?? [];
    expect(blind).toEqual([]);
  });

  it('doctor.ts und auth.ts ebenso', () => {
    for (const datei of ['../doctor.ts', '../auth.ts']) {
      const src = readFileSync(new URL(datei, import.meta.url), 'utf8');
      const blind = src.match(/https:\/\/cachly\.dev\/[a-z][a-z0-9/-]*/g) ?? [];
      expect(blind).toEqual([]);
    }
  });

  it('die Funktion bleibt rein — kein Netz, kein Zustand, kein Dateisystem', () => {
    const src = readFileSync(new URL('../cachly-url.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(|node:fs|ioredis|apiFetch|process\.env/);
  });

  it('das Vokabular der Quellen ist festgeschrieben, nicht frei erfunden', () => {
    // NACHTRAG nach der ersten Runde: der Erbauer hatte die Namen von Hand
    // zugeordnet, und zwei davon waren irrefuehrend — ein Doku-Link in der
    // Cache-Statistik hiess 'digest', eine Fusszeile in einem erzeugten README
    // hiess 'setup'. Falsche Etiketten verschmutzen genau die Auswertung, fuer
    // die dieses Paket gebaut wird. Deshalb ein geschlossenes Vokabular: was
    // nicht darin steht, faellt beim Typecheck auf, nicht erst in Plausible.
    const src = readFileSync(new URL('../cachly-url.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/export type\s+\w*Quelle\w*\s*=/);
  });

  it('die Quelle beschreibt den ORT, nicht einen geratenen Befehl', () => {
    const cache = readFileSync(new URL('../handlers/cache.ts', import.meta.url), 'utf8');
    const team = readFileSync(new URL('../handlers/team.ts', import.meta.url), 'utf8');
    // Diese beiden Stellen sind keine CLI-Befehle: die eine ist ein Doku-Link
    // in der Cache-Statistik, die andere eine Fusszeile in einem erzeugten
    // README. Sie duerfen nicht als 'digest' bzw. 'setup' gezaehlt werden.
    expect(cache).not.toMatch(/cachlyUrl\([^)]*['"]digest['"]\)/);
    expect(team).not.toMatch(/cachlyUrl\(\s*['"]\/['"]\s*,\s*['"]setup['"]\s*\)/);
  });
});
