import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Waechter: ein fremder Schluessel in der Umgebung darf die Daten nicht
 * umleiten.
 *
 * ─── DER ANLASS ─────────────────────────────────────────────────────────────
 *
 * Bis zum 23.08.2026 waehlte `detectEmbedProvider` in dieser Reihenfolge:
 * OPENAI_API_KEY, GEMINI, MISTRAL, COHERE, OLLAMA — und erst dann unser
 * eigenes Ziel. Ein Entwickler, der OPENAI_API_KEY fuer ein ANDERES Werkzeug
 * gesetzt hatte (der Normalfall), schickte damit Lektionstext und bis zu 150
 * indizierte Quelldateien in die USA. Die Auto-Indexierung ist standardmaessig
 * an, also passierte es beim ersten Werkzeugaufruf und ohne Zutun.
 *
 * Gleichzeitig sagte die Landingpage auf Deutsch: "Ausschliesslich auf
 * deutschen Servern (Hetzner), nie ausserhalb der EU." Beide Saetze lagen in
 * demselben Repo. Welcher galt, entschied eine Umgebungsvariable.
 *
 * ─── WARUM EIN WAECHTER UND NICHT NUR DIE KORREKTUR ─────────────────────────
 *
 * Die Reihenfolge in einer Funktion ist leicht wieder umzudrehen — sie sieht
 * wie eine Vorliebe aus, nicht wie eine Zusage. Diese Datei macht daraus eine
 * Zusage: wer OPENAI_API_KEY wieder nach vorn stellt, macht diese Probe rot.
 *
 * Zu jedem Waechter eine GEGENPROBE, damit er nicht trivial gruen ist.
 */

const FREMDE_SCHLUESSEL = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
] as const;

const GESICHERT: Record<string, string | undefined> = {};
const ALLE = [...FREMDE_SCHLUESSEL, 'OLLAMA_BASE_URL', 'CACHLY_JWT', 'CACHLY_EMBED_PROVIDER'];

beforeEach(() => {
  for (const k of ALLE) {
    GESICHERT[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const k of ALLE) {
    if (GESICHERT[k] === undefined) delete process.env[k];
    else process.env[k] = GESICHERT[k];
  }
});

/** Modul frisch laden — EMBED_PROVIDER wird beim Import einmal berechnet. */
async function ladeAnbieter(): Promise<string> {
  vi.resetModules();
  const m = await import('../embeddings.js');
  return m.EMBED_PROVIDER;
}

describe('Einbettung bleibt in der EU', () => {
  it.each(FREMDE_SCHLUESSEL)(
    '%s allein leitet die Daten NICHT um — der Anbieter bleibt "none"',
    async (schluessel) => {
      process.env[schluessel] = 'sk-irgendwas';
      expect(await ladeAnbieter()).toBe('none');
    },
  );

  it.each(FREMDE_SCHLUESSEL)(
    '%s schlaegt unser eigenes Ziel nicht — mit JWT bleibt es "cachly"',
    async (schluessel) => {
      process.env[schluessel] = 'sk-irgendwas';
      process.env.CACHLY_JWT = 'cky_live_test';
      expect(await ladeAnbieter()).toBe('cachly');
    },
  );

  it('alle vier fremden Schluessel gleichzeitig aendern nichts', async () => {
    for (const k of FREMDE_SCHLUESSEL) process.env[k] = 'sk-irgendwas';
    process.env.CACHLY_JWT = 'cky_live_test';
    expect(await ladeAnbieter()).toBe('cachly');
  });

  it('ein lokales Ollama darf erkannt werden — es verlaesst den Rechner nicht', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    expect(await ladeAnbieter()).toBe('ollama');
  });

  it('unser Ziel geht vor Ollama — gleiches Modell ueberall, sonst sind Vektoren unvergleichbar', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    process.env.CACHLY_JWT = 'cky_live_test';
    expect(await ladeAnbieter()).toBe('cachly');
  });

  it('GEGENPROBE: eine AUSDRUECKLICHE Wahl bleibt moeglich', async () => {
    // Ohne diese Probe koennte der Waechter oben bedeuten, dass die fremden
    // Anbieter ausgebaut wurden. Sind sie nicht — sie sind nur nicht mehr
    // versehentlich erreichbar. Wer sie will, sagt es.
    process.env.CACHLY_EMBED_PROVIDER = 'openai';
    process.env.CACHLY_JWT = 'cky_live_test';
    expect(await ladeAnbieter()).toBe('openai');
  });

  it('GEGENPROBE: ohne jede Angabe ist es "none" — die Probe misst wirklich die Schluessel', async () => {
    // Belegt, dass die erste Probe nicht deshalb "none" liefert, weil das
    // Modul immer "none" sagt.
    expect(await ladeAnbieter()).toBe('none');
  });

  it('GEGENPROBE: der Code kennt die fremden Anbieter weiterhin — sie sind nicht geloescht', async () => {
    // Beweist, dass "none" bei gesetztem OPENAI_API_KEY eine ENTSCHEIDUNG ist
    // und nicht die Folge davon, dass es den Zweig gar nicht mehr gibt.
    const quelle = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../embeddings.ts', import.meta.url), 'utf8'),
    );
    for (const anbieter of ['openai', 'gemini', 'mistral', 'cohere']) {
      expect(quelle, `${anbieter} kommt im Code nicht mehr vor`).toContain(anbieter);
    }
  });
});
