/**
 * Die Bedeutungssuche haengt am Schluessel, nicht an der Umgebungsvariable.
 *
 * Gemessen am 11.10.2026 mit 0.10.175, frischer Start ohne Schluessel: der
 * Sofort-Test legte das Test-Brain in 0,4 s an, aber EMBED_PROVIDER war beim
 * Import schon auf 'none' festgelegt (kein CACHLY_JWT in process.env). Die ganze
 * erste Sitzung lief nur ueber Woerter. Dasselbe traf jeden, dessen Schluessel
 * aus ~/.cachly/credentials.json kommt statt aus der Umgebung.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ALLE = ['CACHLY_JWT', 'CACHLY_EMBED_PROVIDER', 'OLLAMA_BASE_URL'] as const;
const GESICHERT: Record<string, string | undefined> = {};

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

async function frisch() {
  vi.resetModules();
  return import('../embeddings.js');
}

describe('Einbettung mit einem Schluessel, der nicht aus der Umgebung kommt', () => {
  it('ohne Schluessel beim Start: aus, und nach setEmbedJwt an (cachly)', async () => {
    const m = await frisch();
    expect(m.EMBED_PROVIDER).toBe('none');
    expect(m.hasEmbedProvider()).toBe(false);

    m.setEmbedJwt('cky_live_sofort_test');

    expect(m.EMBED_PROVIDER).toBe('cachly');
    expect(m.hasEmbedProvider()).toBe(true);
  });

  it('ein leerer Schluessel schaltet nichts ein', async () => {
    const m = await frisch();
    m.setEmbedJwt('');
    expect(m.EMBED_PROVIDER).toBe('none');
    expect(m.hasEmbedProvider()).toBe(false);
  });

  it('ein ausdruecklich gewaehlter Anbieter bleibt, auch wenn ein Schluessel kommt', async () => {
    process.env.CACHLY_EMBED_PROVIDER = 'none';
    const m = await frisch();
    m.setEmbedJwt('cky_live_sofort_test');
    expect(m.EMBED_PROVIDER).toBe('none');
    expect(m.hasEmbedProvider()).toBe(false);
  });

  it('ein lokales Ollama wird nicht durch den Schluessel ersetzt', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const m = await frisch();
    m.setEmbedJwt('cky_live_sofort_test');
    expect(m.EMBED_PROVIDER).toBe('ollama');
  });

  it('ein nicht ersetzter Plugin-Platzhalter wird durch den echten (leeren) Wert ueberschrieben', async () => {
    process.env.CACHLY_JWT = '${user_config.api_key}';
    const m = await frisch();
    // index.ts ruft beim Start setEmbedJwt(resolveApiKey() ?? ''); resolveApiKey
    // laesst den Platzhalter fallen. Ohne gespeicherten Schluessel kommt '' an.
    m.setEmbedJwt('');
    expect(m.hasEmbedProvider()).toBe(false);
  });
});
