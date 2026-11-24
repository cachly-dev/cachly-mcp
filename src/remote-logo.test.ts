import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serverInfo, beantworteLogo, LOGO_SVG } from './remote-logo.js';

async function mitServer<T>(fn: (basis: string) => Promise<T>): Promise<T> {
  const s = createServer((req, res) => {
    const pfad = new URL(req.url ?? '/', 'http://x').pathname;
    if (!beantworteLogo(req, res, pfad)) { res.writeHead(404); res.end('weiter'); }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${(s.address() as AddressInfo).port}`); }
  finally { s.close(); }
}

describe('Connector-Logo', () => {
  it('serverInfo hat icons, title und websiteUrl', () => {
    const i = serverInfo('1.2.3');
    expect(i).toMatchObject({ name: 'cachly-mcp', version: '1.2.3', title: 'cachly', websiteUrl: 'https://cachly.dev' });
    expect(i.icons[0]).toMatchObject({ src: 'https://cachly.dev/favicon.svg', mimeType: 'image/svg+xml' });
  });
  it('GET /favicon.svg: 200, image/svg+xml, orange', async () => {
    await mitServer(async (b) => {
      const r = await fetch(b + '/favicon.svg');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/svg+xml');
      expect(r.headers.get('cache-control')).toContain('max-age=86400');
      const t = await r.text();
      expect(t).toBe(LOGO_SVG);
      expect(t).toContain('#F59E0B');
    });
  });
  it('GET /favicon.ico: 301 auf /favicon.svg', async () => {
    await mitServer(async (b) => {
      const r = await fetch(b + '/favicon.ico', { redirect: 'manual' });
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe('/favicon.svg');
    });
  });
  it('Gegenprobe: POST /favicon.svg ist 405, / und /mcp bleiben unberuehrt', async () => {
    await mitServer(async (b) => {
      expect((await fetch(b + '/favicon.svg', { method: 'POST' })).status).toBe(405);
      for (const p of ['/', '/mcp', '/favicon.png']) {
        const r = await fetch(b + p);
        expect(r.status).toBe(404);
        expect(await r.text()).toBe('weiter');
      }
    });
  });
});
describe('Quelltext', () => {
  it('index.ts nutzt serverInfo an beiden Stellen und beantworteLogo im Handler', async () => {
    const { readFileSync } = await import('node:fs');
    const q = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(q.match(/serverInfo\(CURRENT_VERSION\)/g)?.length).toBe(2);
    expect(q).toContain('beantworteLogo(req, res, url.pathname)');
    expect(q).not.toContain("{ name: 'cachly-mcp', version: CURRENT_VERSION }");
  });
});
