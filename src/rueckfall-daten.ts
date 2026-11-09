/**
 * Rueckfall-Hinweis: Muster und Zahlen — EINE Quelle fuer Produkt und Messung.
 *
 * Zwischen den Marken JSON-BEGIN und JSON-END steht reines JSON. Die Messung
 * (forge-foundry .agent/cachly/messungen/rueckfall_zahlen.py) liest genau
 * diesen Block, damit die Zahlen den Erkenner beschreiben, den das Produkt
 * benutzt. Eine eigene .json-Datei ginge nicht: das npm-Paket liefert nur
 * dist/**\/*.js aus.
 *
 * arten: regulaere Ausdruecke, case-insensitiv, nur Bausteine, die JavaScript
 *   und Python gleich lesen. Art = meiste Treffer in den ersten 600 Zeichen,
 *   Gleichstand -> frueher genannte Art, ohne Treffer 'sonstiges'.
 * pruef_arten: die Arten, deren Wiederkehr gemessen wird.
 * zahlen: NUR Arten, die auf mindestens zwei von drei unabhaengigen
 *   Datensaetzen Faktor >= 2 hielten, zusammen >= 2 und >= 300 Folgen (Regel
 *   vorab festgelegt, forge-foundry rueckfall_drei.py). Nur fuer sie gibt es
 *   einen Hinweis. zufall_quote = Erwartungswert: Anteil derselben Art unter
 *   allen Issues desselben Projekts im selben Fenster.
 * beispiel: beide Issue-Titel gehoeren selbst zur Art, von Hand gelesen.
 * dazu: was zur Reparatur SELBST gehoerte (Messung M4, forge-foundry
 *   was_gehoerte_dazu.py): eine Dateisorte, die eine Reparatur dieser Art
 *   oefter aenderte als andere Reparaturen desselben Projekts. Regel vorab:
 *   >= 1,5-fach und >= 10 Punkte ueber dem Erwartungswert je Projekt, >= 100
 *   Paare, auf zwei von drei Datensaetzen. Es hielt nur sicherheit ->
 *   Abhaengigkeitsdatei (A 33,8 % gegen 20,5 %, C 59,1 % gegen 24,8 %; B
 *   11,9 % gegen 5,9 %, also 2,0-fach, aber nur 6 Punkte). muster ist der
 *   Ausdruck der Messung; sie verglich den Pfad in Kleinbuchstaben.
 */
export const RUECKFALL = /* JSON-BEGIN */ {
  "_arten_pruefsumme": "60279054dc2fdc4b",
  "pruef_arten": [
    "zeit-datum",
    "abhaengigkeiten",
    "dateien-upload"
  ],
  "arten": {
    "absturz": "crash|panic|segfault|segmentation|traceback|stack ?trace|fatal error|uncaught|exception",
    "leistung": "\\bslow|performance|\\blag\\b|high cpu|latency|takes too long|freez|hang",
    "speicher": "memory leak|out of memory|\\boom\\b|memory usage|heap",
    "anmeldung-rechte": "\\blogin|log in|sign in|\\bauth|oauth|\\btoken|permission|unauthori|forbidden|\\bsso\\b|session",
    "dateien-upload": "upload|download|attachment|\\bpdf\\b|file size|drag and drop|hochlad|herunterlad|dateianhang|anhaenge|dateigroesse|dateigröße",
    "zeichen-kodierung": "unicode|utf-?8|encoding|emoji|special character|\\blocale",
    "zeit-datum": "timezone|time zone|\\bdst\\b|timestamp|\\bdate\\b|calendar|datetime|zeitzone|sommerzeit|winterzeit|zeitstempel|\\bdatum\\b|\\bdatums|kalender|uhrzeit",
    "uebersetzung": "translat|\\bi18n|localiz|language",
    "bauen-installieren": "\\bbuild|compil|cmake|webpack|\\bvite\\b|bundl|\\binstall",
    "abhaengigkeiten": "dependenc|upgrade|\\bbump|deprecat|breaking change|incompatib|abhaengigkeit|abhängigkeit|versionssprung|inkompatib|nicht mehr kompatibel",
    "betriebssystem": "windows|macos|mac os|\\blinux|\\bwsl\\b|\\bios\\b|android",
    "oberflaeche": "\\bui\\b|button|layout|\\bcss\\b|dark mode|\\btheme|render|display|scroll|tooltip|modal",
    "barrierefreiheit": "accessib|screen reader|\\baria|keyboard nav|a11y",
    "netzwerk": "network|timeout|timed out|proxy|\\bssl\\b|\\btls\\b|certificate|connection|websocket|\\bcors\\b",
    "datenbank": "database|\\bsql|migration|postgres|mysql|sqlite|mongodb|\\bquery",
    "zwischenspeicher": "\\bcache|stale|invalidat",
    "konfiguration": "\\bconfig|setting|environment variable|\\benv\\b|\\bflag\\b|option",
    "container-ausrollen": "docker|kubernetes|\\bk8s\\b|\\bhelm\\b|container|\\bdeploy",
    "tests-ci": "\\btest|\\bci\\b|flaky|github actions|pipeline",
    "doku": "\\bdocs?\\b|documentation|readme|\\btypo",
    "sicherheit": "security|vulnerab|\\bxss\\b|csrf|injection|\\bcve-"
  },
  "zahlen": {
    "zeit-datum": {
      "name": "time/date",
      "projekte": 289,
      "fenster_tage": 90,
      "folgen": 791,
      "wiederkehr": 148,
      "zufall_quote": 0.042,
      "faktor": 4.43,
      "rat": "Worth adding a test with a second time zone and a daylight-saving date.",
      "beispiel": {
        "repo": "AppFlowy-IO/AppFlowy",
        "issue": 2408,
        "folge_issue": 2466,
        "tage": 2,
        "datei": "frontend/appflowy_flutter/lib/plugins/database_view/calendar/presentation/calendar_page.dart"
      }
    },
    "abhaengigkeiten": {
      "name": "dependency",
      "projekte": 289,
      "fenster_tage": 90,
      "folgen": 1408,
      "wiederkehr": 223,
      "zufall_quote": 0.069,
      "faktor": 2.31,
      "rat": "Worth pinning the version and running the tests against the next major version.",
      "beispiel": {
        "repo": "apache/rocketmq",
        "issue": 7636,
        "folge_issue": 7680,
        "tage": 7,
        "datei": "pom.xml"
      }
    }
  },
  "dazu": {
    "sicherheit": {
      "name": "security",
      "sorte": "dependency file (manifest or lock file)",
      "muster": "(^|/)(package\\.json|package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|[^/]*\\.lock|requirements[^/]*\\.txt|pyproject\\.toml|go\\.(mod|sum)|cargo\\.toml|pom\\.xml|gemfile|composer\\.json|build\\.gradle[^/]*|[^/]*\\.csproj)$",
      "projekte": 289,
      "fixes": 1127,
      "datensaetze": [
        { "fixes": 157, "anteil": 0.338, "erwartet": 0.205 },
        { "fixes": 412, "anteil": 0.119, "erwartet": 0.059 },
        { "fixes": 558, "anteil": 0.591, "erwartet": 0.248 }
      ],
      "rat": "If this fix also needs a version bump, add that file to the lesson."
    }
  },
  "_gemessen": "08.11.2026, 289 Projekte in drei unabhaengigen Datensaetzen (32 + 130 + 127), Fenster 90 Tage, Zufall als Erwartungswert. Upload fiel weg (zusammen 1,73), Anmeldung/Rechte (1,88) und Zeichenkodierung (nur einmal >= 2 mit Einzelziehung) ebenso."
} /* JSON-END */ as const;
