/**
 * Das cachly-Logo (helles "c." mit gruenem Punkt) fuer den Remote-MCP-Server.
 * Claude.ai zeigt beim Connector das Bild aus serverInfo.icons bzw. aus
 * <Host>/favicon.ico. Der SVG-Inhalt ist identisch mit https://cachly.dev/favicon.svg.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const LOGO_SVG =
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <rect width="32" height="32" rx="8" fill="#dcf5e8"/>
  <path d="M18.8 11.19A6.8 6.8 0 1 0 18.8 20.81" stroke="#061521" stroke-width="4.8" stroke-linecap="round"/>
  <circle cx="24" cy="23.6" r="2.4" fill="#14b86e"/>
</svg>
`;

/** serverInfo fuer initialize: Name, Fassung, Anzeigename, Webseite, Logo (MCP Implementation). */
export function serverInfo(version: string) {
  return {
    name: 'cachly-mcp',
    version,
    title: 'cachly',
    websiteUrl: 'https://cachly.dev',
    icons: [{ src: 'https://cachly.dev/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  };
}

/** Beantwortet GET/HEAD /favicon.svg (200) und /favicon.ico (301 auf .svg). true = erledigt. */
export function beantworteLogo(req: IncomingMessage, res: ServerResponse, pfad: string): boolean {
  if (pfad !== '/favicon.svg' && pfad !== '/favicon.ico') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  if (pfad === '/favicon.ico') {
    res.writeHead(301, { Location: '/favicon.svg', 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
  res.end(req.method === 'HEAD' ? undefined : LOGO_SVG);
  return true;
}
