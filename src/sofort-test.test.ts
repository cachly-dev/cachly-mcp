import { describe, it, expect, beforeEach } from 'vitest';
import {
  userAgent,
  sofortTestUrl,
  leseAntwort,
  holeSofortTest,
  _sperreZuruecksetzen,
} from './sofort-test.js';

describe('Sofort-Test: der neue Nutzer hat nach der Installation keinen Schritt mehr', () => {
  beforeEach(() => _sperreZuruecksetzen());

  describe('Herkunft im User-Agent', () => {
    // Die Gegenstelle nimmt das ERSTE Feld des User-Agent und legt es als
    // tenants.signup_client ab (model.ClientAusUserAgent). Steht die Herkunft
    // in einem Klammerzusatz, ist sie fuer die Auswertung unsichtbar.
    it('das erste Feld traegt die Herkunft, nicht ein Zusatz', () => {
      const ua = userAgent('0.10.138', { CACHLY_QUELLE: 'claude-code-plugin' });
      expect(ua.split(' ')[0]).toBe('cachly-claude-plugin/0.10.138'.replace('claude-plugin', 'claude-code-plugin'));
    });

    it('ohne gesetzte Quelle bleibt es der nackte MCP-Server', () => {
      expect(userAgent('1.2.3', {})).toBe('cachly-mcp/1.2.3');
    });

    // IstEigenerClient im API erkennt eigene Werkzeuge am Vorsatz "cachly-".
    // Faellt der weg, zaehlt jede Selbsteinrichtung als fremde Anmeldung —
    // und die Anmeldezahl im Bericht waere ploetzlich ein Verkaufssignal,
    // das keines ist.
    it('der Vorsatz cachly- steht immer davor', () => {
      for (const q of [undefined, 'claude-code-plugin', 'vscode', 'intellij']) {
        expect(userAgent('9.9.9', { CACHLY_QUELLE: q })).toMatch(/^cachly-/);
      }
    });

    it('eine erfundene Quelle mit Sonderzeichen wird nicht uebernommen', () => {
      // Sonst stuende fremder Text im signup_client und damit in einer
      // Telegram-Meldung.
      expect(userAgent('1.0.0', { CACHLY_QUELLE: 'boese quelle; DROP' })).toBe('cachly-mcp/1.0.0');
      expect(userAgent('1.0.0', { CACHLY_QUELLE: 'x'.repeat(80) })).toBe('cachly-mcp/1.0.0');
    });
  });

  describe('Adresse', () => {
    it('haengt den Pfad an, ohne doppelten Schraegstrich', () => {
      expect(sofortTestUrl('https://api.cachly.dev')).toBe('https://api.cachly.dev/auth/instant-trial');
      expect(sofortTestUrl('https://api.cachly.dev/')).toBe('https://api.cachly.dev/auth/instant-trial');
    });
  });

  describe('Antwort lesen', () => {
    it('nimmt eine vollstaendige Antwort an', () => {
      const t = leseAntwort({ api_key: 'cky_trial_x', instance_id: 'uuid-1', trial_ends_at: '2026-09-11T00:00:00Z' });
      expect(t).toEqual({ apiKey: 'cky_trial_x', instanzId: 'uuid-1', tarifEndetAm: '2026-09-11T00:00:00Z' });
    });

    // Eine halbe Antwort ist kein Zugang. Ein leerer String als Kennung waere
    // genau die stille Null, gegen die der ganze Weg gebaut ist: der Server
    // liefe, jeder Aufruf ginge ins Leere, und niemand saehe einen Fehler.
    it('eine Antwort ohne Kennung ist KEIN Zugang', () => {
      expect(leseAntwort({ api_key: 'cky_trial_x' })).toBeNull();
      expect(leseAntwort({ api_key: 'cky_trial_x', instance_id: '' })).toBeNull();
    });

    it('eine Antwort ohne Schluessel ist KEIN Zugang', () => {
      expect(leseAntwort({ instance_id: 'uuid-1' })).toBeNull();
    });

    it('Unsinn faellt durch', () => {
      for (const x of [null, undefined, 'text', 42, []]) expect(leseAntwort(x)).toBeNull();
    });
  });

  describe('Holen', () => {
    const antwortMit = (koerper: unknown, ok = true) =>
      (async () => ({ ok, json: async () => koerper })) as unknown as typeof fetch;

    it('speichert den Schluessel und gibt die Kennung zurueck', async () => {
      const gespeichert: string[] = [];
      const t = await holeSofortTest({
        apiUrl: 'https://api.test',
        version: '1.0.0',
        holen: antwortMit({ api_key: 'cky_trial_a', instance_id: 'uuid-a' }),
        speichern: (k) => gespeichert.push(k),
      });
      expect(t?.instanzId).toBe('uuid-a');
      expect(gespeichert).toEqual(['cky_trial_a']);
    });

    it('speichert NICHTS, wenn die Antwort unvollstaendig ist', async () => {
      const gespeichert: string[] = [];
      const t = await holeSofortTest({
        apiUrl: 'https://api.test',
        version: '1.0.0',
        holen: antwortMit({ api_key: 'cky_trial_a' }),
        speichern: (k) => gespeichert.push(k),
      });
      expect(t).toBeNull();
      expect(gespeichert).toEqual([]);
    });

    it('ein Fehler der Gegenstelle wirft nicht, er gibt null', async () => {
      const t = await holeSofortTest({
        apiUrl: 'https://api.test',
        version: '1.0.0',
        holen: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
        speichern: () => {},
      });
      expect(t).toBeNull();
    });

    it('HTTP 429 gibt null, nicht eine halbe Einrichtung', async () => {
      const t = await holeSofortTest({
        apiUrl: 'https://api.test',
        version: '1.0.0',
        holen: antwortMit({ error: 'rate limited' }, false),
        speichern: () => {},
      });
      expect(t).toBeNull();
    });

    /*
     * Die Gegenstelle laesst 5 Versuche je IP und Stunde zu. Ein Werkzeugaufruf
     * im Sekundentakt haette die Grenze in einer Minute gerissen — und danach
     * fuer eine Stunde JEDEN echten Nutzer hinter derselben Adresse mitgesperrt.
     * Ein Firmennetz hat eine Adresse.
     */
    it('versucht es hoechstens EINMAL je Prozess', async () => {
      let rufe = 0;
      const holen = (async () => { rufe++; throw new Error('offline'); }) as unknown as typeof fetch;
      for (let i = 0; i < 5; i++) {
        await holeSofortTest({ apiUrl: 'https://api.test', version: '1.0.0', holen, speichern: () => {} });
      }
      expect(rufe).toBe(1);
    });

    it('die Herkunft steht wirklich im abgeschickten Kopf', async () => {
      let gesehen = '';
      const holen = (async (_u: string, init: RequestInit) => {
        gesehen = String((init.headers as Record<string, string>)['User-Agent']);
        return { ok: true, json: async () => ({ api_key: 'k', instance_id: 'i' }) };
      }) as unknown as typeof fetch;
      await holeSofortTest({
        apiUrl: 'https://api.test',
        version: '0.10.138',
        holen,
        speichern: () => {},
        env: { CACHLY_QUELLE: 'claude-code-plugin' },
      });
      expect(gesehen).toBe('cachly-claude-code-plugin/0.10.138');
    });
  });
});
