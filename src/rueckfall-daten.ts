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
 * zahlen: NUR Arten, die auf zwei unabhaengigen Datensaetzen Faktor >= 2
 *   hielten (Regel vorab festgelegt). Nur fuer sie gibt es einen Hinweis.
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
      "projekte": 162,
      "fenster_tage": 90,
      "folgen": 427,
      "wiederkehr": 78,
      "zufall_quote": 0.062,
      "faktor": 2.95,
      "rat": "Worth adding a test with a second time zone and a daylight-saving date.",
      "beispiel": {
        "repo": "AppFlowy-IO/AppFlowy",
        "issue": 1942,
        "folge_issue": 1993,
        "tage": 4,
        "datei": "frontend/appflowy_flutter/lib/plugins/database_view/calendar/application/calendar_bloc.dart"
      }
    },
    "dateien-upload": {
      "name": "file upload/download",
      "projekte": 162,
      "fenster_tage": 90,
      "folgen": 377,
      "wiederkehr": 42,
      "zufall_quote": 0.04,
      "faktor": 2.76,
      "rat": "Worth adding a test with a large file, an unusual file type and a file name with special characters.",
      "beispiel": {
        "repo": "AppFlowy-IO/AppFlowy",
        "issue": 4591,
        "folge_issue": 4790,
        "tage": 24,
        "datei": "frontend/appflowy_flutter/lib/shared/appflowy_network_image.dart"
      }
    }
  },
  "_gemessen": "08.11.2026, 162 Projekte (Folgen-Ernte 40 + 200), Fenster 90 Tage; Abhaengigkeiten fiel weg (Faktor 3,0 und 1,84)."
} /* JSON-END */ as const;
