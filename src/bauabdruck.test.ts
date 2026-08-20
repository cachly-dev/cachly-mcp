import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALTER_SCHWELLE_TAGE, RUECKFALL_BAUABDRUCK,
  formatiereBauabdruck, istAlt, ladeBauabdruck,
} from './bauabdruck.js';
import { baueDaten, ermittleCommit, ermittleVersion } from '../scripts/bauabdruck.mjs';

describe('ermittleCommit — der Abdruck-Erzeuger kommt ohne .git aus', () => {
  it('gibt "unbekannt" zurueck, wenn das Verzeichnis kein Git-Repo ist — kein Absturz', () => {
    const leeresVerzeichnis = mkdtempSync(join(tmpdir(), 'bauabdruck-ohne-git-'));
    try {
      expect(ermittleCommit(leeresVerzeichnis)).toBe('unbekannt');
    } finally {
      rmSync(leeresVerzeichnis, { recursive: true, force: true });
    }
  });

  it('baueDaten uebernimmt das "unbekannt" und liefert trotzdem Version und Zeitstempel', () => {
    const leeresVerzeichnis = mkdtempSync(join(tmpdir(), 'bauabdruck-ohne-git-'));
    try {
      writeFileSync(join(leeresVerzeichnis, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf-8');
      const jetzt = new Date('2026-08-20T00:00:00.000Z');
      const daten = baueDaten(leeresVerzeichnis, jetzt);
      expect(daten).toEqual({ version: '9.9.9', commit: 'unbekannt', gebautAm: '2026-08-20T00:00:00.000Z' });
    } finally {
      rmSync(leeresVerzeichnis, { recursive: true, force: true });
    }
  });

  it('ermittleVersion liest die eine Quelle, die es schon gibt: package.json', () => {
    const verzeichnis = mkdtempSync(join(tmpdir(), 'bauabdruck-version-'));
    try {
      writeFileSync(join(verzeichnis, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf-8');
      expect(ermittleVersion(verzeichnis)).toBe('1.2.3');
    } finally {
      rmSync(verzeichnis, { recursive: true, force: true });
    }
  });
});

describe('istAlt — die Altersschwelle', () => {
  const jetzt = new Date('2026-08-20T12:00:00.000Z');

  it('greift bei 15 Tagen: gelb', () => {
    const vor15Tagen = new Date(jetzt.getTime() - 15 * 86_400_000).toISOString();
    expect(istAlt(vor15Tagen, jetzt)).toBe(true);
  });

  it('greift NICHT bei 1 Tag — Gegenprobe: der Waechter kann auch Nein sagen', () => {
    // Ohne diesen Test waere eine gruene Zeile kein Beweis: "istAlt" koennte
    // immer "true" liefern und der 15-Tage-Test bliebe trotzdem gruen.
    const vor1Tag = new Date(jetzt.getTime() - 1 * 86_400_000).toISOString();
    expect(istAlt(vor1Tag, jetzt)).toBe(false);
  });

  it('die Schwelle liegt bei genau 14 Tagen', () => {
    expect(ALTER_SCHWELLE_TAGE).toBe(14);
  });

  it('"unbekannt" gilt nicht als alt — ein nie gebauter Server ist ein anderer Zustand', () => {
    expect(istAlt('unbekannt', jetzt)).toBe(false);
  });
});

describe('ladeBauabdruck — faellt zurueck, wenn nichts generiert wurde', () => {
  it('liefert RUECKFALL_BAUABDRUCK, wenn die Datei fehlt', () => {
    const leeresVerzeichnis = mkdtempSync(join(tmpdir(), 'bauabdruck-lade-'));
    try {
      expect(ladeBauabdruck(leeresVerzeichnis)).toEqual(RUECKFALL_BAUABDRUCK);
    } finally {
      rmSync(leeresVerzeichnis, { recursive: true, force: true });
    }
  });

  it('liefert RUECKFALL_BAUABDRUCK, wenn die Datei kaputtes JSON enthaelt', () => {
    const verzeichnis = mkdtempSync(join(tmpdir(), 'bauabdruck-kaputt-'));
    try {
      writeFileSync(join(verzeichnis, 'bauabdruck-daten.generiert.json'), '{ kaputt', 'utf-8');
      expect(ladeBauabdruck(verzeichnis)).toEqual(RUECKFALL_BAUABDRUCK);
    } finally {
      rmSync(verzeichnis, { recursive: true, force: true });
    }
  });

  it('liest eine echte Datei korrekt ein', () => {
    const verzeichnis = mkdtempSync(join(tmpdir(), 'bauabdruck-echt-'));
    try {
      const daten = { version: '1.0.0', commit: 'abc1234', gebautAm: '2026-08-19T10:00:00.000Z' };
      writeFileSync(join(verzeichnis, 'bauabdruck-daten.generiert.json'), JSON.stringify(daten), 'utf-8');
      expect(ladeBauabdruck(verzeichnis)).toEqual(daten);
    } finally {
      rmSync(verzeichnis, { recursive: true, force: true });
    }
  });
});

describe('formatiereBauabdruck — die Zeile fuer brain_doctor', () => {
  const jetzt = new Date('2026-08-20T12:00:00.000Z');

  it('zeigt Version, Commit und Baudatum bei einem frischen Bauabdruck', () => {
    const zeile = formatiereBauabdruck(
      { version: '0.10.124', commit: 'a1b2c3d', gebautAm: new Date(jetzt.getTime() - 86_400_000).toISOString() },
      jetzt,
    );
    expect(zeile).toContain('0.10.124');
    expect(zeile).toContain('a1b2c3d');
    expect(zeile).toContain('✅');
    expect(zeile).not.toContain('🟡');
  });

  it('markiert einen 15 Tage alten Bauabdruck mit 🟡', () => {
    const zeile = formatiereBauabdruck(
      { version: '0.10.124', commit: 'a1b2c3d', gebautAm: new Date(jetzt.getTime() - 15 * 86_400_000).toISOString() },
      jetzt,
    );
    expect(zeile).toContain('🟡');
    expect(zeile).toContain('laenger als 14 Tage');
  });

  it('sagt "unbekannt", wenn noch nie gebaut wurde — statt etwas zu erfinden', () => {
    const zeile = formatiereBauabdruck(RUECKFALL_BAUABDRUCK, jetzt);
    expect(zeile).toContain('unbekannt');
    expect(zeile).not.toContain('🟡');
    expect(zeile).not.toContain('✅');
  });
});
