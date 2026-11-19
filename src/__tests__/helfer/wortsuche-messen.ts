import { bestandAusDokumenten, keywordSearchMitBestand } from '../../search.js';
import { erzeugeLektionen, PROBEFRAGEN } from './wortsuche-korpus.js';

const n = Number(process.argv[2] ?? 1600);
const t0 = performance.now();
const b = bestandAusDokumenten(erzeugeLektionen(n))!;
console.log('bestand', n, 'docs', b.docs.length, 'vocab', b.docFreq.size, 'bau ms', (performance.now() - t0).toFixed(0));
process.env.CACHLY_RECALL_NUR_LESEN = '1';
keywordSearchMitBestand(b, 'warmup', 1); // baut den Index, wie bestandNeuBauen es beim Bauen tut
const rund = Number(process.argv[3] ?? 1);
for (let r = 0; r < rund; r++) {
  const ges = performance.now();
  const je: Array<[number, string]> = [];
  for (const q of PROBEFRAGEN) {
    const s = performance.now();
    keywordSearchMitBestand(b, q, 25);
    je.push([performance.now() - s, q]);
  }
  const summe = performance.now() - ges;
  console.log('Runde', r, 'gesamt ms', summe.toFixed(0), 'je Frage', (summe / PROBEFRAGEN.length).toFixed(0));
  if (r === 0) console.log(je.sort((a, b) => b[0] - a[0]).slice(0, 8).map(([t, q]) => `${t.toFixed(0)} ms  ${q}`).join('\n'));
}
