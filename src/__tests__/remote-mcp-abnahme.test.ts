/**
 * Nachtraege aus der Sicherheitsabnahme von #1120 (18.11.2026).
 *
 * Fund 1: recall_best_solution las im Mehrmandanten-Modus package.json und
 *         node_modules im Arbeitsordner des SERVERS und nannte die Versionen.
 * Fund 4: Node behaelt bei zwei Authorization-Koepfen nur den ersten; erst
 *         req.headersDistinct zeigt, dass es zwei waren.
 * (Fund 3, der Einbettungs-Merker je Mandant, haengt am Schluessel-Hash und
 *  ist ueber den Code-Pfad in embeddings.ts abgedeckt.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { leseBearer, setzeMehrmandant } from '../remote-zugang.js';
import { leseProjektVersionen } from '../gueltigkeit-version.js';

const KEY_A = 'cky_' + 'a'.repeat(40);
const KEY_B = 'cky_' + 'b'.repeat(40);

afterEach(() => setzeMehrmandant(false));

describe('Fund 1: Server-Platte im Mehrmandanten-Modus', () => {
  it('liest keine Versionen aus dem Arbeitsordner des Servers', () => {
    // Gegenprobe: im stdio-Modus findet der Leser dieses Paket (vitest liegt in node_modules).
    const lokal = leseProjektVersionen(process.cwd(), { ablageOrdner: null });
    expect(lokal.suche('npm', 'vitest')).not.toBeNull();

    setzeMehrmandant(true);
    const remote = leseProjektVersionen(process.cwd(), { ablageOrdner: null });
    expect(remote.suche('npm', 'vitest')).toBeNull();
    expect(remote.suche(null, 'ioredis')).toBeNull();
    expect(remote.ordner).toBe('');
  });
});

describe('Fund 4: Authorization als Liste (req.headersDistinct)', () => {
  it('ein Kopf in der Liste gilt', () => {
    expect(leseBearer([`Bearer ${KEY_A}`])).toEqual({ art: 'ok', schluessel: KEY_A });
  });

  it('zwei Koepfe werden abgelehnt, auch wenn der erste gueltig ist', () => {
    expect(leseBearer([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`])).toEqual({ art: 'abgelehnt', grund: 'mehrfach' });
  });

  it('leere Liste heisst "fehlt"', () => {
    expect(leseBearer([])).toEqual({ art: 'fehlt' });
  });
});
