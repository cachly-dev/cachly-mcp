/**
 * Versionswaechter: kein Merge an sdk/mcp/src ohne Versionssprung.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Gemessen am 20.08.2026:
 *
 *   Repo         sdk/mcp/package.json                        0.10.124
 *   Installiert  ~/.cachly-mcp/.../@cachly-dev/mcp-server    0.10.124
 *   Der installierte dist/ enthielt den Code aus dem Repo NICHT.
 *
 * Zwei verschiedene Bauten trugen dieselbe Nummer. Deshalb gab
 * `get_connection_string` eine Adresse ohne Passwort zurueck, obwohl der
 * Handler im Repo das Passwort seit Tagen korrekt holt. Der Handler war nie
 * kaputt — er lief nur nicht. Ein Tag Suche nach einem Fehler, den es im Code
 * nicht gab.
 *
 * Der Bauabdruck (`src/bauabdruck.ts`) macht sichtbar, WELCHER Stand laeuft.
 * Dieser Waechter sorgt dafuer, dass verschiedene Staende auch verschiedene
 * Nummern tragen. Beide zusammen loesen den Fall; einer allein nicht.
 *
 * ── Die bewusst gezogene Grenze ─────────────────────────────────────────────
 *
 * Aenderungen an Tests erzwingen keinen Sprung. Sie landen nicht im Paket.
 *
 * Eine reine Kommentaraenderung in `src/` erzwingt dagegen SEHR WOHL einen
 * Sprung. Der Waechter kann Kommentar und Code nicht unterscheiden, ohne zu
 * raten — und ein Waechter, der raet, sagt irgendwann faelschlich Ja. Ein
 * Sprung zu viel kostet einen Befehl. Ein Sprung zu wenig kostet einen Tag.
 */

import { readFileSync } from 'node:fs';

/** Dateien, deren Aenderung im veroeffentlichten Paket landet. */
const QUELLE = /^sdk\/mcp\/src\/.+\.tsx?$/;

/** Tests landen nicht im Paket. Auch nicht die Hilfsdateien daneben. */
const TEST = /(\.test\.tsx?|\.spec\.tsx?)$/;

/**
 * Muss die Version steigen, weil diese Dateien geaendert wurden?
 *
 * @param {string[]} dateien Pfade ab Repo-Wurzel
 * @returns {string[]} die Dateien, die einen Sprung verlangen (leer = keiner)
 */
export function verlangenSprung(dateien) {
  return dateien.filter((d) => QUELLE.test(d) && !TEST.test(d));
}

/**
 * Vergleicht zwei Versionen nach Zahlenteilen.
 *
 * Bewusst kein semver-Paket: eine neue Abhaengigkeit fuer drei Zahlen waere
 * teurer als die zehn Zeilen hier. Vorabkennungen ("1.2.3-rc1") werden am
 * Bindestrich abgeschnitten — wer eine Vorabfassung baut, hat die Zahl davor
 * bereits erhoeht.
 *
 * @returns {number} negativ wenn a < b, 0 bei Gleichheit, positiv wenn a > b
 */
export function vergleicheVersionen(a, b) {
  const teile = (v) => String(v).split('-')[0].split('.').map((x) => Number(x) || 0);
  const [ax, bx] = [teile(a), teile(b)];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const d = (ax[i] ?? 0) - (bx[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Das Urteil.
 *
 * @param {{basisVersion: string, neueVersion: string, dateien: string[]}} lage
 * @returns {{ok: boolean, meldung: string}}
 */
export function pruefe(lage) {
  const { basisVersion, neueVersion, dateien } = lage;
  const betroffen = verlangenSprung(dateien);

  if (betroffen.length === 0) {
    return { ok: true, meldung: 'Keine Quelldatei unter sdk/mcp/src geaendert — kein Sprung noetig.' };
  }

  const d = vergleicheVersionen(neueVersion, basisVersion);
  if (d > 0) {
    return {
      ok: true,
      meldung: `${betroffen.length} Quelldatei(en) geaendert, Version ${basisVersion} -> ${neueVersion}.`,
    };
  }

  // Die Meldung nennt beide Nummern und den Befehl, der es behebt. Eine
  // Fehlermeldung, die nur "failed" sagt, kostet den naechsten Menschen
  // dieselbe Viertelstunde noch einmal.
  const liste = betroffen.slice(0, 8).map((f) => `    ${f}`).join('\n');
  const rest = betroffen.length > 8 ? `\n    ... und ${betroffen.length - 8} weitere` : '';
  const grund = d === 0
    ? `Die Version steht unveraendert auf ${neueVersion}.`
    : `Die Version ist von ${basisVersion} auf ${neueVersion} GESUNKEN.`;

  return {
    ok: false,
    meldung: [
      'Zwei verschiedene Staende wuerden dieselbe Nummer tragen.',
      '',
      grund,
      '',
      'Geaenderte Quelldateien:',
      liste + rest,
      '',
      'Behebung — im Verzeichnis sdk/mcp:',
      '    npm version patch --no-git-tag-version',
      '',
      'Hintergrund: am 20.08.2026 trugen ein alter und ein neuer Build beide',
      '0.10.124. get_connection_string lieferte deshalb eine Adresse ohne',
      'Passwort, obwohl der Code im Repo richtig war. Der Handler war nie',
      'kaputt, er lief nur nicht.',
    ].join('\n'),
  };
}

/** Liest die Version aus einer package.json. Fehlt sie, ist das ein Fehler. */
export function versionAus(json, woher) {
  let daten;
  try {
    daten = JSON.parse(json);
  } catch {
    throw new Error(`${woher}: keine gueltige JSON`);
  }
  if (typeof daten.version !== 'string' || daten.version.length === 0) {
    throw new Error(`${woher}: kein Feld "version"`);
  }
  return daten.version;
}

// ── Aufruf aus der CI ────────────────────────────────────────────────────────
//
// Die Angaben kommen als Umgebungsvariablen, damit dieses Modul weder Netz
// noch GitHub kennt. Es entscheidet, es beschafft nicht.
//
//   BASIS_PACKAGE_JSON  Inhalt der package.json aus dem Zielzweig
//   DATEIEN             geaenderte Pfade, einer je Zeile

const direktGestartet = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (direktGestartet) {
  const basisJson = process.env.BASIS_PACKAGE_JSON ?? '';
  const dateien = (process.env.DATEIEN ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

  if (!basisJson) {
    // Ohne Vergleichsstand kann nichts entschieden werden. Das ist KEIN
    // stilles Gruen: der Lauf faellt, damit niemand glaubt, es sei geprueft.
    console.error('Versionswaechter: BASIS_PACKAGE_JSON fehlt — nichts zu vergleichen.');
    process.exit(1);
  }

  const eigen = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const urteil = pruefe({
    basisVersion: versionAus(basisJson, 'Zielzweig'),
    neueVersion: versionAus(eigen, 'dieser Zweig'),
    dateien,
  });

  console.log(urteil.meldung);
  process.exit(urteil.ok ? 0 : 1);
}
