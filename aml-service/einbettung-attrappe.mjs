// Einbettungs-Attrappe: antwortet wie der Messdienst auf POST /api/v1/embed, ohne Netz und ohne Modell.
// Vektor = gehashte Wortzaehler (1024 Stellen, auf Laenge 1 gebracht), deterministisch aus dem Text.
// Umgebung: ATTRAPPE_PORT (8791), ATTRAPPE_VERZOEGERUNG_MS (0, kuenstliche Wartezeit je Anfrage).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DIM = 1024;

export function vektor(text) {
  const v = new Array(DIM).fill(0);
  for (const w of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const h = createHash('sha1').update(w).digest();
    const stelle = h.readUInt32BE(0) % DIM;
    v[stelle] += 1; // Wortzaehler: gemeinsame Woerter ergeben Aehnlichkeit
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function starteAttrappe({ port = 0, verzoegerungMs = 0 } = {}) {
  const stat = { anfragen: 0, gleichzeitigMax: 0, jetzt: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.method === 'GET' && req.url === '/stat') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stat)); }
    if (req.method !== 'POST' || req.url !== '/api/v1/embed') { res.writeHead(404); return res.end(); }
    const teile = []; for await (const c of req) teile.push(c);
    let body; try { body = JSON.parse(Buffer.concat(teile).toString('utf8')); } catch { res.writeHead(400); return res.end('{"error":"json"}'); }
    stat.anfragen++; stat.jetzt++; stat.gleichzeitigMax = Math.max(stat.gleichzeitigMax, stat.jetzt);
    if (verzoegerungMs) await new Promise((r) => setTimeout(r, verzoegerungMs));
    stat.jetzt--;
    if (typeof body.text !== 'string' || !body.text) { res.writeHead(400); return res.end('{"error":"text"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embedding: vektor(body.text), dimensions: DIM, model: body.model || 'attrappe', provider: 'attrappe' }));
  });
  server.keepAliveTimeout = 60_000;
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, port: server.address().port, stat })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const a = await starteAttrappe({ port: Number(process.env.ATTRAPPE_PORT ?? 8791), verzoegerungMs: Number(process.env.ATTRAPPE_VERZOEGERUNG_MS ?? 0) });
  console.log(`Attrappe lauscht auf 127.0.0.1:${a.port}`);
}
