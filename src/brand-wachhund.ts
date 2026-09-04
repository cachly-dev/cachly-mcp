// Brand-Wachhund — ein Server, der ohne Arbeit einen Kern verbrennt, geht.
//
// ── Der Anlass (31.08.2026, Karte xm54lkjujmyi) ─────────────────────────────
//
// Drei verwaiste MCP-Server auf Heinrichs Laptop, jeder ein voller Kern,
// stundenlang: EIN brennender Thread, elf schlafende, null offene
// Netzverbindungen. Der Ausloeser liess sich in vier Nachstell-Szenarien
// (Leerlauf, Pipe-EOF, echter MCP-Verkehr auf 0.10.137 UND 0.10.140,
// npx-Kette mit Wrapper-Kill) NICHT reproduzieren — dort war der Server
// still (0 CPU-s/60 s) und beendete sich beim Pipe-Tod von selbst.
//
// Gegen die unbekannte Restursache steht dieser Wachhund. Er misst nicht
// die Ursache, sondern das Symptom — und das ist eindeutig:
//
//   >80 % CPU ueber ein 5-Minuten-Fenster OHNE einen einzigen
//   Werkzeugaufruf in diesem Fenster, zweimal in Folge.
//
// Einen legitimen Zustand mit diesem Profil hat der Server nicht: jede
// echte Arbeit (Suche, Einbettung, Nachtrag) laeuft INNERHALB eines
// Werkzeugaufrufs; die Hintergrund-Poller warten auf Netz und Timer, nicht
// auf der CPU. Zwei Fenster statt eins, damit ein einzelner langer Aufruf,
// der das Fenster knapp verpasst, nie zum Abgang fuehrt.
//
// Der Wachhund LOEST das Problem nicht — er begrenzt den Schaden auf
// hoechstens ~10 Minuten Kernbrand statt Stunden und hinterlaesst auf
// stderr eine Zeile, die beim naechsten Vorfall die Diagnose traegt.

export interface WachhundOptionen {
  /** Fensterlaenge in ms. 5 Minuten im Betrieb; klein in Tests. */
  fensterMs?: number;
  /** Anteil des Fensters, ab dem die CPU-Zeit als Brand gilt (0..1). */
  schwelle?: number;
  cpu?: () => { user: number; system: number }; // Mikrosekunden, wie process.cpuUsage()
  jetzt?: () => number;
  plane?: (fn: () => void, ms: number) => void;
  warne?: (zeile: string) => void;
  beende?: () => void;
}

let letzterAufruf = Number.NEGATIVE_INFINITY;

/** Vom Werkzeug-Handler bei JEDEM Aufruf gesetzt — Arbeit entlastet den Hund. */
export function merkeWerkzeugAufruf(jetzt: () => number = Date.now): void {
  letzterAufruf = jetzt();
}

/** Nur fuer Tests. */
export function _wachhundZuruecksetzen(): void {
  letzterAufruf = Number.NEGATIVE_INFINITY;
}

export function starteBrandWachhund(opt: WachhundOptionen = {}): void {
  const fensterMs = opt.fensterMs ?? 5 * 60_000;
  const schwelle = opt.schwelle ?? 0.8;
  const cpu = opt.cpu ?? (() => process.cpuUsage());
  const jetzt = opt.jetzt ?? (() => Date.now());
  const plane = opt.plane ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); });
  const warne = opt.warne ?? ((z) => process.stderr.write(z + '\n'));
  const beende = opt.beende ?? (() => process.exit(0));

  let vorher = cpu();
  let verdaechtigeFenster = 0;

  plane(() => {
    const nun = cpu();
    const verbranntMs = (nun.user + nun.system - vorher.user - vorher.system) / 1000;
    vorher = nun;
    const ohneArbeit = jetzt() - letzterAufruf >= fensterMs;
    if (verbranntMs >= schwelle * fensterMs && ohneArbeit) {
      verdaechtigeFenster++;
      warne(
        `[cachly-mcp] Brand-Wachhund: ${Math.round(verbranntMs / 1000)} CPU-s in `
        + `${Math.round(fensterMs / 1000)} s ohne Werkzeugaufruf (Fenster ${verdaechtigeFenster}/2)`,
      );
    } else {
      verdaechtigeFenster = 0;
    }
    if (verdaechtigeFenster >= 2) {
      warne('[cachly-mcp] Brand-Wachhund: zweites Fenster in Folge — Server beendet sich (Karte xm54lkjujmyi)');
      beende();
    }
  }, fensterMs);
}
