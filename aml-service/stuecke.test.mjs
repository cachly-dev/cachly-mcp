// Pruefreihe fuer die Stueckelung (kern.mjs stuecke) und den Schalter AML_STUECKE. Ohne Docker, ohne Netz.
//   node --test sdk/mcp/aml-service/stuecke.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stuecke, CHUNK_MAX, MCP } from './kern.mjs';

const HIER = dirname(fileURLToPath(import.meta.url));
const TS = Date.UTC(2023, 3, 11, 9, 30);
const gespraech = [
  { role: 'user', content: 'I adopted a cat named Miso last week.', timestamp: TS },
  { role: 'assistant', content: 'Congratulations on adopting Miso! Here are some tips for the first weeks.', timestamp: TS },
];

test('zeit (Vorgabe): Nachrichten eines Zeitstempels in einem Stueck, ohne Rolle, wie bis 14.11.2026', () => {
  const s = stuecke(gespraech);
  assert.equal(s.length, 1);
  assert.equal(s[0].text, '[session of 11 April 2023] Original dialogue: I adopted a cat named Miso last week. '
    + 'Congratulations on adopting Miso! Here are some tips for the first weeks.');
  assert.deepEqual(stuecke(gespraech, { art: 'zeit' }), s);
});

test('nachricht: ein Eintrag je Nachricht, Rolle hinter der Sitzungsmarke, Zeit wie bei zeit', () => {
  const s = stuecke(gespraech, { art: 'nachricht' });
  assert.deepEqual(s.map((x) => x.text), [
    '[session of 11 April 2023] User: I adopted a cat named Miso last week.',
    '[session of 11 April 2023] Assistant: Congratulations on adopting Miso! Here are some tips for the first weeks.',
  ]);
  for (const x of s) {
    assert.equal(x.giltAb, new Date(TS).toISOString());
    assert.equal(x.zeitMs, TS);
  }
});

test('nachricht: lange Nachricht wird geteilt, jedes Teil traegt Marke und Rolle, kein Wort geht verloren', () => {
  const woerter = Array.from({ length: 900 }, (_, i) => `wort${i}`);
  const s = stuecke([{ role: 'assistant', content: woerter.join(' '), timestamp: TS }], { art: 'nachricht' });
  assert.ok(s.length >= 2, `nur ${s.length} Teil(e)`);
  const kopf = '[session of 11 April 2023] Assistant: ';
  for (const x of s) {
    assert.ok(x.text.startsWith(kopf), x.text.slice(0, 60));
    assert.ok(x.text.length - kopf.length <= CHUNK_MAX);
  }
  assert.deepEqual(s.map((x) => x.text.slice(kopf.length)).join(' ').split(' '), woerter);
});

test('nachricht: leere Nachrichten fallen weg; ohne Zeitstempel keine Marke und keine Zeit', () => {
  const s = stuecke([
    { role: 'user', content: '   ' },
    { role: 'user', content: 'Kein Datum hier.' },
  ], { art: 'nachricht' });
  assert.deepEqual(s, [{ text: 'User: Kein Datum hier.', giltAb: '', zeitMs: 0 }]);
});

test('unbekannte Stueckelung wirft', () => {
  assert.throws(() => stuecke(gespraech, { art: 'satz' }), /unbekannte Stueckelung/);
});

test('Dienst startet nicht mit unbekanntem AML_STUECKE (Exit 2, vor jeder Verbindung)', () => {
  const tsx = join(MCP, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const r = spawnSync(tsx, [join(HIER, 'dienst.mjs')], {
    cwd: MCP, shell: process.platform === 'win32', timeout: 60_000, encoding: 'utf8',
    env: { ...process.env, AML_MEMORY_KEY: 'test-ohne-geheimnis', AML_STUECKE: 'satz', AML_PORT: '1' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /AML_STUECKE muss zeit oder nachricht sein/);
});
