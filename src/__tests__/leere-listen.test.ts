import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');

/**
 * Startet den Server als echten Prozess und schickt ihm JSON-RPC-Zeilen.
 *
 * Warum nicht die Handler direkt aufrufen: Der Fehler, um den es geht,
 * entstand NICHT in einem Handler, sondern davor — das SDK lehnt eine Methode
 * ab, deren Faehigkeit nicht angekuendigt ist. Ein Test, der die Funktion
 * direkt aufruft, haette den Fehler nie gesehen und trotzdem gruen gemeldet.
 */
async function frage(methoden: string[]): Promise<Map<number, any>> {
  const zeilen = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
    ...methoden.map((m, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: m, params: {} })),
  ];

  const kind = spawn(process.execPath, [require.resolve('tsx/cli'), einstieg], {
    // Ohne Anmeldung starten: die drei Listen-Methoden brauchen keine, und so
    // misst der Test den Server, nicht das Netz.
    env: { ...process.env, CACHLY_JWT: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const antworten = new Map<number, any>();
  let puffer = '';
  kind.stdout.on('data', (c) => {
    puffer += c.toString();
    let nl;
    while ((nl = puffer.indexOf('\n')) >= 0) {
      const z = puffer.slice(0, nl).trim();
      puffer = puffer.slice(nl + 1);
      if (!z.startsWith('{')) continue;
      try {
        const j = JSON.parse(z);
        if (typeof j.id === 'number') antworten.set(j.id, j);
      } catch {
        /* Teilzeile, kommt beim naechsten Mal vollstaendig */
      }
    }
  });

  kind.stdin.write(zeilen.join('\n') + '\n');

  const erwartet = methoden.length + 1;
  const bis = Date.now() + 45000;
  while (antworten.size < erwartet && Date.now() < bis) {
    await new Promise((r) => setTimeout(r, 100));
  }
  kind.kill();
  return antworten;
}

describe('leere Listen statt "Method not found"', () => {
  // Gemessen am 18.08.2026 im Scan-Protokoll von Smithery:
  //   Warning: Failed to list resources: MCP error -32601: Method not found
  // Die Antwort war formal richtig und stand trotzdem als Fehler im Bericht.
  it(
    'resources/list, resources/templates/list und prompts/list antworten mit leeren Listen',
    async () => {
      const a = await frage(['resources/list', 'resources/templates/list', 'prompts/list']);

      expect(a.get(0)?.result, 'initialize hat nicht geantwortet').toBeDefined();

      expect(a.get(1)?.error, 'resources/list meldet weiter einen Fehler').toBeUndefined();
      expect(a.get(1)?.result?.resources).toEqual([]);

      expect(a.get(2)?.error, 'resources/templates/list meldet weiter einen Fehler').toBeUndefined();
      expect(a.get(2)?.result?.resourceTemplates).toEqual([]);

      expect(a.get(3)?.error, 'prompts/list meldet weiter einen Fehler').toBeUndefined();
      expect(a.get(3)?.result?.prompts).toEqual([]);
    },
    60000
  );

  // GEGENPROBE. Ohne sie koennte der Test oben auch dann gruen sein, wenn er
  // in Wahrheit gar nichts misst — etwa weil der Prozess nie startet und
  // "kein Fehler" mit "keine Antwort" verwechselt wird. Eine erfundene
  // Methode MUSS -32601 bekommen.
  it(
    'eine wirklich unbekannte Methode bekommt weiterhin -32601',
    async () => {
      const a = await frage(['gibt/es/nicht']);
      expect(a.get(0)?.result, 'initialize hat nicht geantwortet').toBeDefined();
      expect(a.get(1)?.error?.code, 'der Server verschluckt unbekannte Methoden').toBe(-32601);
    },
    60000
  );

  // Die angekuendigten Faehigkeiten und die beantworteten Methoden muessen
  // zusammenpassen. Wer eine Faehigkeit ankuendigt und dann -32601 liefert,
  // ist schlimmer dran als vorher.
  it(
    'initialize kuendigt resources und prompts an',
    async () => {
      const a = await frage([]);
      const caps = a.get(0)?.result?.capabilities;
      expect(caps?.tools, 'tools nicht angekuendigt').toBeDefined();
      expect(caps?.resources, 'resources nicht angekuendigt').toBeDefined();
      expect(caps?.prompts, 'prompts nicht angekuendigt').toBeDefined();
    },
    60000
  );
});
