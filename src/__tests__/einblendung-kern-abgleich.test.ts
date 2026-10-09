/**
 * Der Waechter gegen die zweite Wahrheit.
 *
 * Die automatische Einblendung (`tools/ambient-recall/`) sortiert mit
 * denselben Bausteinen wie `smart_recall`. Damit es sie nur EINMAL gibt, wird
 * `src/einblendung-kern.ts` nach
 * `tools/ambient-recall/einblendung-kern.gen.mjs` gebuendelt und eingecheckt.
 *
 * Eine eingecheckte Erzeugnisdatei ist genau so lange wahr, wie jemand sie
 * nachzieht. Am 20.08.2026 hat uns dieselbe Klasse Fehler Wochen gekostet:
 * der Messstand sortierte mit `bewerteTopf`, der ausgelieferte Pfad mit
 * `mischeRangfolgen` — zwei Maschinen, eine Zahl. Deshalb prueft dieser
 * Waechter beides:
 *
 *   1. das Erzeugnis stimmt mit der Quelle ueberein (byteweise),
 *   2. und der Hook, der es benutzt, verhaelt sich wie erwartet.
 *
 * Faellt (1), lautet die Abhilfe:
 *   cd sdk/mcp && node scripts/einblendung-kern-buendeln.mjs
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { erzeuge } from '../../scripts/einblendung-kern-buendeln.mjs';
import { Einblendbestand, torWoerter, zaehleBelege } from '../einblendung-kern.js';

const ZIEL = resolve(__dirname, '..', '..', '..', '..', 'tools', 'ambient-recall', 'einblendung-kern.gen.mjs');

describe('einblendung-kern.gen.mjs — Erzeugnis und Quelle', () => {
  it('ist vorhanden', () => {
    expect(existsSync(ZIEL), `${ZIEL} fehlt — buendeln laufen lassen`).toBe(true);
  });

  it('stimmt mit der TypeScript-Quelle ueberein', async () => {
    const neu = await erzeuge();
    const alt = readFileSync(ZIEL, 'utf8').replace(/\r\n/g, '\n');
    // Nicht nur die Laenge vergleichen: eine geaenderte Zahl bei gleicher
    // Laenge waere sonst unsichtbar — und eine falsche Zahl ist genau das,
    // was dieser Waechter verhindern soll.
    expect(alt).toBe(neu);
  });

  it('traegt keine Abhaengigkeit hinein — der Hook laeuft ohne node_modules', () => {
    const inhalt = readFileSync(ZIEL, 'utf8');
    // Node-Bordmittel (`node:fs`, `node:crypto` …) sind erlaubt — sie kommen
    // mit Node selbst, nicht aus node_modules.
    expect(inhalt).not.toMatch(/^import .* from ['"](?!node:)[^.]/m);
    expect(inhalt).not.toMatch(/\brequire\(/);
  });
});

describe('Einblendbestand — Tor und Sortierung sind zwei Fragen', () => {
  const lektionen = [
    {
      topic: 'betrieb:fail2ban-bannt-den-deploy-kanal',
      what_worked: 'fail2ban auf node-1 bannte 10.8.0.6 und der Deploy meldete refused. '
        + 'Abhilfe: ignoreip 10.8.0.0/24 in jail.local eintragen und fail2ban neu starten.',
      outcome: 'success',
      severity: 'critical',
      recall_count: 3,
    },
    {
      topic: 'docker:layer-cache',
      what_worked: 'Paketmanifeste vor dem restlichen Quelltext kopieren, damit der '
        + 'Abhaengigkeitsschritt im Zwischenspeicher bleibt.',
      outcome: 'success',
      recall_count: 900,
    },
    {
      topic: 'kanzlei:keycloak-dns-alias',
      what_worked: 'Der Anmeldedienst fand postgres nicht, weil der Netzwerk-Alias fehlte.',
      what_failed: 'KC_DB_URL umzustellen half nicht.',
      outcome: 'success',
      recall_count: 1,
    },
  ];

  it('findet die passende Lektion zur Frage', () => {
    const b = new Einblendbestand(lektionen);
    const treffer = b.sortiere('deploy meldet refused, fail2ban hat die ip gebannt');
    expect(treffer.length).toBeGreaterThan(0);
    expect(treffer[0].lektion.topic).toBe('betrieb:fail2ban-bannt-den-deploy-kanal');
  });

  it('laesst die vielabgerufene Lektion NICHT gewinnen, wenn sie nicht passt', () => {
    // `docker:layer-cache` hat 900 Abrufe. Bis zum 06.09.2026 sortierte die
    // Einblendung faktisch nach Abrufzahl und blendete genau solche
    // Dauerbrenner ein, egal was gefragt war.
    const b = new Einblendbestand(lektionen);
    const treffer = b.sortiere('der anmeldedienst findet postgres nicht');
    expect(treffer[0].lektion.topic).toBe('kanzlei:keycloak-dns-alias');
  });

  it('sucht auch in what_failed — nicht nur in what_worked', () => {
    const b = new Einblendbestand(lektionen);
    const treffer = b.sortiere('KC_DB_URL umstellen');
    expect(treffer[0]?.lektion.topic).toBe('kanzlei:keycloak-dns-alias');
  });

  it('meldet fuer einen belanglosen Prompt keine Belege', () => {
    const tokens = torWoerter('danke, ja mach das bitte');
    const b = new Einblendbestand(lektionen);
    for (const t of b.sortiere('danke, ja mach das bitte')) {
      expect(t.belege).toBeLessThan(2);
    }
    // Und das Tor selbst zaehlt nichts: alle Woerter sind Stoppwoerter oder
    // zu kurz.
    expect(zaehleBelege(tokens, 'fail2ban bannt den kanal')).toBe(0);
  });
});
