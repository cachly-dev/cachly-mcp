// Kompatibilitäts-Einstieg: Plattformen wie Glama erzeugen ihre Build-Specs
// automatisch und starten mit `node dist/index.js`. tsc (rootDir ".") legt den
// echten Einstieg aber unter dist/src/index.js ab. Diese Datei kompiliert nach
// dist/index.js und startet dort denselben Server — der Import genügt, weil
// src/index.ts auf Modul-Ebene startet.
import './src/index.js';
