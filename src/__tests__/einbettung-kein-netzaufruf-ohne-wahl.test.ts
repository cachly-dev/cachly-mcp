import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Waechter auf der Netz-Ebene: ein Schluessel in der Umgebung loest keinen
 * Aufruf an einen Fremdanbieter aus.
 *
 * ─── DER ANLASS ─────────────────────────────────────────────────────────────
 *
 * Eine Brain-Notiz sagte: "Ein OPENAI_API_KEY in der Umgebung schickt
 * Lektionstext und bis zu 150 Quelldateien in die USA, ungefragt." Das stimmte
 * bis zum 23.08.2026 (detectEmbedProvider waehlte openai vor allem anderen).
 * Seitdem waehlt ein Fremdschluessel keinen Anbieter mehr; das haelt
 * einbettung-bleibt-in-der-eu.test.ts fest — aber auf der Ebene "welcher
 * Name steht in EMBED_PROVIDER". Hier wird die Ebene darunter geprueft: was
 * geht WIRKLICH ueber fetch hinaus. Ein Waechter auf dem Namen merkt nicht,
 * wenn jemand an anderer Stelle einen zweiten Weg baut.
 *
 * ─── WAS DIE PROBEN ZEIGEN ──────────────────────────────────────────────────
 *
 *   1. Nur Fremdschluessel, kein JWT: kein einziger fetch-Aufruf, die
 *      Einbettung scheitert sauber (die Aufrufer fallen auf Woerter zurueck).
 *   2. Fremdschluessel und JWT: genau ein Aufruf, und zwar an unsere API.
 *   3. Der Quelltext: nur embeddings.ts kennt die Adressen der Fremdanbieter.
 *
 * GEGENPROBEN: eine ausdrueckliche Wahl (CACHLY_EMBED_PROVIDER=openai) ruft
 * openai.com weiter (dokumentierte Kundeneinstellung, README.md "Embedding
 * providers"), sonst waeren die Proben oben trivial gruen, weil die Attrappe
 * nie etwas sieht.
 *
 * Es geht nichts ins Netz: fetch ist ersetzt, CACHLY_API_URL zeigt auf einen
 * Port, hinter dem nichts lauscht.
 */

const FREMD = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'COHERE_API_KEY', 'MISTRAL_API_KEY'] as const;
const ALLE = [...FREMD, 'CACHLY_JWT', 'CACHLY_EMBED_PROVIDER', 'OLLAMA_BASE_URL', 'CACHLY_API_URL', 'CACHLY_EMBED_MODEL'];
const GESICHERT: Record<string, string | undefined> = {};
const URLS: string[] = [];
const FETCH_ALT = globalThis.fetch;

beforeEach(() => {
  for (const k of ALLE) {
    GESICHERT[k] = process.env[k];
    delete process.env[k];
  }
  URLS.length = 0;
  process.env.CACHLY_API_URL = 'http://127.0.0.1:9';
  globalThis.fetch = vi.fn(async (eingabe: string | URL | Request) => {
    URLS.push(typeof eingabe === 'string' ? eingabe : eingabe instanceof URL ? eingabe.href : eingabe.url);
    return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3], dimensions: 3, data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  vi.resetModules();
});

afterEach(() => {
  for (const k of ALLE) {
    if (GESICHERT[k] === undefined) delete process.env[k];
    else process.env[k] = GESICHERT[k];
  }
  globalThis.fetch = FETCH_ALT;
});

async function frisch() {
  vi.resetModules();
  return import('../embeddings.js');
}

const FREMDE_ADRESSEN = /openai\.com|cohere\.com|googleapis\.com|mistral\.ai|typesafe\.ai/;

describe('Fremdschluessel loesen keinen Netzaufruf aus', () => {
  it.each(FREMD)('%s allein: null fetch-Aufrufe, die Einbettung scheitert sauber', async (schluessel) => {
    process.env[schluessel] = 'sk-nur-ein-test';
    const m = await frisch();
    expect(m.hasEmbedProvider()).toBe(false);
    await expect(m.computeEmbedding('Der Deploy-Timeout lag an DNS.')).rejects.toThrow();
    expect(URLS).toEqual([]);
  });

  it('alle vier Fremdschluessel zusammen: null fetch-Aufrufe', async () => {
    for (const k of FREMD) process.env[k] = 'sk-nur-ein-test';
    const m = await frisch();
    await expect(m.computeEmbedding('Quelltext einer Datei')).rejects.toThrow();
    await expect(m.computeEmbedding('noch eine Datei', { geduld: 'lang' })).rejects.toThrow();
    expect(URLS).toEqual([]);
  });

  it('Fremdschluessel UND JWT: genau ein Aufruf, und der geht an unsere API', async () => {
    for (const k of FREMD) process.env[k] = 'sk-nur-ein-test';
    process.env.CACHLY_JWT = 'cky_live_test';
    const m = await frisch();
    const v = await m.computeEmbedding('Der Deploy-Timeout lag an DNS.');
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(URLS).toEqual(['http://127.0.0.1:9/api/v1/embed']);
    expect(URLS.join(' ')).not.toMatch(FREMDE_ADRESSEN);
  });

  it('GEGENPROBE: eine AUSDRUECKLICHE Wahl ruft den Fremdanbieter — die Attrappe sieht solche Aufrufe', async () => {
    process.env.CACHLY_EMBED_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-nur-ein-test';
    const m = await frisch();
    await m.computeEmbedding('Der Deploy-Timeout lag an DNS.');
    expect(URLS).toEqual(['https://api.openai.com/v1/embeddings']);
  });
});

describe('Quelltext: wer kennt die Adressen der Fremdanbieter', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));

  function dateien(ordner: string): string[] {
    const aus: string[] = [];
    for (const name of readdirSync(ordner)) {
      if (name === '__tests__' || name === 'node_modules') continue;
      const pfad = join(ordner, name);
      if (statSync(pfad).isDirectory()) aus.push(...dateien(pfad));
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) aus.push(pfad);
    }
    return aus;
  }

  const ADRESSE = /api\.openai\.com|api\.cohere\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.typesafe\.ai/;

  it('nur embeddings.ts nennt sie — kein zweiter Weg an anderer Stelle', () => {
    const treffer = dateien(SRC)
      .filter((d) => ADRESSE.test(readFileSync(d, 'utf8')))
      .map((d) => relative(SRC, d).split('\\').join('/'));
    expect(treffer).toEqual(['embeddings.ts']);
  });

  it('die ausgelieferten Hook-Pakete tragen keine dieser Adressen', () => {
    const hook = join(SRC, '..', 'hooks', 'cachly-ambient-einblendung.mjs');
    expect(ADRESSE.test(readFileSync(hook, 'utf8'))).toBe(false);
  });
});
