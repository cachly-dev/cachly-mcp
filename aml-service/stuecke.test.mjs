// Pruefreihe fuer die Stueckelung (kern.mjs stuecke) und den Schalter AML_STUECKE. Ohne Docker, ohne Netz.
//   node --test sdk/mcp/aml-service/stuecke.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stuecke, CHUNK_MAX, MCP, uhrzeitMarke, mitMarke } from './kern.mjs';

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

test('nutzer: Stuecke genau wie zeit, danach jede Nutzernachricht als eigener Eintrag mit teilVon', () => {
  const s = stuecke(gespraech, { art: 'nutzer' });
  assert.deepEqual(s.slice(0, 1), stuecke(gespraech, { art: 'zeit' }));
  assert.deepEqual(s.slice(1), [{
    text: '[session of 11 April 2023] User: I adopted a cat named Miso last week.',
    giltAb: new Date(TS).toISOString(), zeitMs: TS, teilVon: 0,
  }]);
});

test('nutzer: teilVon zeigt auf das Stueck, in dem der Satz wirklich steht, auch hinter einer langen Antwort', () => {
  // Erster Satz, dann eine Antwort knapp unter CHUNK_MAX, dann der zweite Satz: drei Stuecke.
  const lang = 'x'.repeat(CHUNK_MAX - 5);
  const s = stuecke([
    { role: 'user', content: 'Ich habe zwoelf Tomatenpflanzen gesetzt.', timestamp: TS },
    { role: 'assistant', content: lang, timestamp: TS },
    { role: 'user', content: 'Der Kompost kommt im Mai.', timestamp: TS },
  ], { art: 'nutzer' });
  const haupt = s.filter((x) => x.teilVon === undefined);
  const nutzer = s.filter((x) => x.teilVon !== undefined);
  assert.equal(haupt.length, 3);
  assert.deepEqual(nutzer.map((x) => x.teilVon), [0, 2]);
  assert.ok(s[nutzer[0].teilVon].text.includes('zwoelf Tomatenpflanzen'));
  assert.ok(s[nutzer[1].teilVon].text.includes('Kompost kommt im Mai'));
  // Nutzer-Eintraege stehen hinter allen Stuecken (die Nummerierung im Dienst zaehlt nur die Stuecke).
  assert.ok(s.findIndex((x) => x.teilVon !== undefined) >= haupt.length);
});

test('nutzer: Assistent bekommt keinen eigenen Eintrag, leere Nachrichten keinen', () => {
  const s = stuecke([
    { role: 'assistant', content: 'Nur die Antwort.', timestamp: TS },
    { role: 'user', content: '   ', timestamp: TS },
  ], { art: 'nutzer' });
  assert.equal(s.length, 1);
  assert.equal(s[0].teilVon, undefined);
});

test('uhrzeitMarke: Weltzeit mit Minuten und Nummer; ohne Zeitstempel nur die Nummer', () => {
  assert.equal(uhrzeitMarke(Date.UTC(2023, 4, 26, 1, 8), 273), '[2023-05-26 01:08 · #273] ');
  assert.equal(uhrzeitMarke(Date.UTC(2023, 0, 9, 23, 59), 1), '[2023-01-09 23:59 · #1] ');
  assert.equal(uhrzeitMarke(0, 7), '[#7] ');
});

test('mitMarke: ersetzt die Sitzungsmarke, sonst setzt sie die Marke davor', () => {
  assert.equal(
    mitMarke('[session of 11 April 2023] User: Hallo.', '[2023-04-11 09:30 · #3] '),
    '[2023-04-11 09:30 · #3] User: Hallo.',
  );
  assert.equal(mitMarke('User: Ohne Datum.', '[#4] '), '[#4] User: Ohne Datum.');
});

test('Dienst startet nicht mit unbekanntem AML_STUECKE (Exit 2, vor jeder Verbindung)', () => {
  const tsx = join(MCP, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const r = spawnSync(tsx, [join(HIER, 'dienst.mjs')], {
    cwd: MCP, shell: process.platform === 'win32', timeout: 60_000, encoding: 'utf8',
    env: { ...process.env, AML_MEMORY_KEY: 'test-ohne-geheimnis', AML_STUECKE: 'satz', AML_PORT: '1' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /AML_STUECKE muss zeit, nachricht oder nutzer sein/);
});

test('Dienst startet nicht mit unbekanntem AML_MARKE (Exit 2, vor jeder Verbindung)', () => {
  const tsx = join(MCP, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const r = spawnSync(tsx, [join(HIER, 'dienst.mjs')], {
    cwd: MCP, shell: process.platform === 'win32', timeout: 60_000, encoding: 'utf8',
    env: { ...process.env, AML_MEMORY_KEY: 'test-ohne-geheimnis', AML_MARKE: 'sekunde', AML_PORT: '1' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /AML_MARKE muss tag oder uhrzeit sein/);
});
