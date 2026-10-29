// Rauchtest gegen einen laufenden AML-Dienst.
//   AML_URL=https://aml.cachly.dev AML_MEMORY_KEY=... node sdk/mcp/aml-service/rauch.mjs
// Der Schluessel wird nie ausgegeben. Endet mit Exit-Code 0 (alles ok) oder 1 (mindestens eine Pruefung rot).
const BASIS = (process.env.AML_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.AML_MEMORY_KEY ?? '';
if (!BASIS || !KEY) { console.error('AML_URL und AML_MEMORY_KEY muessen in der Umgebung stehen.'); process.exit(2); }

const LAUF = 'rauch' + Date.now().toString(36);
const USER = `eval:${LAUF}:wegwerf`;
let rot = 0;
const pruefe = (name, ok, info = '') => { if (!ok) rot++; console.log(`${ok ? 'OK ' : 'ROT'} ${name}${info ? '  ' + info : ''}`); return ok; };

async function ruf(pfad, body, { key = KEY } = {}) {
  const t0 = Date.now();
  const r = await fetch(BASIS + pfad, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(1_800_000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, json, text, sek: ((Date.now() - t0) / 1000).toFixed(1) };
}
const addBody = (rid, msgs) => ({ request_id: rid, user_id: USER, session_id: 'rauch-s1', messages: msgs });
const nichtLeer = (x) => typeof x === 'string' && x.trim() !== '';

const h = await ruf('/health', undefined, { key: null });
pruefe('health ohne Schluessel -> 200', h.status === 200, `HTTP ${h.status}`);
const ohne = await ruf('/v1/memory/search', { query: 'x', user_id: USER, top_k: 1 }, { key: null });
pruefe('search ohne Schluessel -> 401', ohne.status === 401, `HTTP ${ohne.status}`);

const m1 = [
  { role: 'user', content: 'Mein Hund heisst Brezel und mag Leberwurst.' },
  { role: 'assistant', content: 'Brezel klingt nach einem guten Namen fuer einen Hund.' },
];
const m2 = [{ role: 'user', content: 'Am Dienstag fahre ich nach Lissabon zum Zahnarzt.', timestamp: 1700000000 }];
const a1 = await ruf('/v1/memory/add', addBody(`${LAUF}-a1`, m1));
const a2 = await ruf('/v1/memory/add', addBody(`${LAUF}-a2`, m2));
for (const [n, a, rid] of [['add 1', a1, `${LAUF}-a1`], ['add 2 (mit timestamp)', a2, `${LAUF}-a2`]]) {
  pruefe(`${n} -> 200 mit success`, a.status === 200 && a.json?.success === true, `HTTP ${a.status}, ${a.sek} s`);
  pruefe(`${n}: request_id/user_id/session_id zurueck`, a.json?.request_id === rid && a.json?.user_id === USER && a.json?.session_id === 'rauch-s1');
}

const s = await ruf('/v1/memory/search', { query: 'Wie heisst der Hund und was frisst er?', user_id: USER, top_k: 5 });
const data = s.json?.data;
pruefe('search -> 200 mit data-Array', s.status === 200 && Array.isArray(data), `HTTP ${s.status}, ${s.sek} s`);
if (Array.isArray(data)) {
  pruefe('mindestens 1 Treffer (add war synchron)', data.length >= 1, `${data.length} Treffer`);
  pruefe('hoechstens top_k Treffer', data.length <= 5);
  pruefe('jeder Treffer hat id und content (nicht leer)', data.every((d) => nichtLeer(d?.id) && nichtLeer(d?.content)));
  pruefe('ids sind eindeutig', new Set(data.map((d) => d.id)).size === data.length);
  pruefe('Treffer enthaelt "Brezel"', data.some((d) => /Brezel/.test(d.content)));
}
const s1 = await ruf('/v1/memory/search', { query: 'Wohin faehrt er am Dienstag?', user_id: USER, top_k: 1 });
pruefe('top_k=1 -> genau 1 Treffer', s1.status === 200 && s1.json?.data?.length === 1, `HTTP ${s1.status}`);

// Gleiche Abfrage zweimal: dieselben ids in derselben Schreibweise (byte-genau)
const vor = await ruf('/v1/memory/search', { query: 'Hund Brezel Lissabon', user_id: USER, top_k: 100 });
const idsVor = (vor.json?.data ?? []).map((d) => d.id);
const wieder = await ruf('/v1/memory/add', addBody(`${LAUF}-a1`, m1));
pruefe('gleicher Add nochmal -> 200', wieder.status === 200 && wieder.json?.success === true, `HTTP ${wieder.status}, ${wieder.sek} s`);
const nach = await ruf('/v1/memory/search', { query: 'Hund Brezel Lissabon', user_id: USER, top_k: 100 });
const idsNach = (nach.json?.data ?? []).map((d) => d.id);
pruefe('kein Doppel: gleiche Zahl Treffer', idsVor.length > 0 && idsVor.length === idsNach.length, `${idsVor.length} vorher, ${idsNach.length} nachher`);
pruefe('ids byte-genau gleich', JSON.stringify([...idsVor].sort()) === JSON.stringify([...idsNach].sort()));

const fremd = await ruf('/v1/memory/search', { query: 'Brezel', user_id: `eval:${LAUF}:niemand`, top_k: 5 });
pruefe('anderer Nutzer sieht nichts', fremd.status === 200 && Array.isArray(fremd.json?.data) && fremd.json.data.length === 0);

console.log(`\n${rot === 0 ? 'ALLES OK' : rot + ' Pruefung(en) ROT'}  (Basis ${BASIS}, Nutzer ${USER})`);
console.log('Testdaten loeschen (auf dem Rechner des Dienstes, Name des Valkey-Containers anpassen):');
console.log(`  DB=$(docker exec aml-valkey-prod valkey-cli HGET aml:dbmap '${USER}')`);
console.log(`  docker exec aml-valkey-prod valkey-cli -n "$DB" FLUSHDB && docker exec aml-valkey-prod valkey-cli HDEL aml:dbmap '${USER}'`);
console.log('Oder alles auf einmal (nur vor dem echten Lauf sinnvoll): docker exec aml-valkey-prod valkey-cli FLUSHALL');
process.exit(rot === 0 ? 0 : 1);
