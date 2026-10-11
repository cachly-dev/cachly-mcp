# cachly als Claude-Code-Plugin

Zwei Zeilen statt einer Konfigurationsdatei:

```
/plugin marketplace add cachly-dev/cachly-mcp
/plugin install cachly-brain@cachly
```

Danach fragt Claude Code nach der Brain-Kennung und dem Schlüssel. Der
MCP-Server wird nicht von Hand eingetragen — das Plugin deklariert ihn.

## Die Falle, gemessen am 28.08.2026

Der `watermarks-remover` dokumentiert für *Hooks*, dass Claude Code sie nicht
ausführt, wenn sie eine Option referenzieren, die der Nutzer nie gesetzt hat.
Ob dasselbe für **MCP-Server** gilt, stand in keiner Doku. Jetzt schon:

```
required: true,  keine Kennung gesetzt   →  claude mcp list zeigt NICHTS
required: false, keine Kennung gesetzt   →  ✔ Connected
required: true,  Kennung gesetzt         →  ✔ Connected
```

**Die Falle gilt auch für MCP-Server.** Mit `required: true` startet der
Server bei einer frischen Installation gar nicht, solange niemand
`/plugin configure` geöffnet hat. Ein Plugin, das lautlos nichts tut, ist
schlechter als gar keins.

Deshalb steht `instance_id` auf `required: false`. Der Server kommt hoch,
erscheint in `/mcp` und kann selbst sagen, was fehlt. Lautes Scheitern statt
stiller Abwesenheit.

### Noch eine Falle: `plugin details` zählt MCP-Server nicht

```
$ claude plugin details cachly-brain
  MCP servers (0)          <- sagt NICHTS über die Wirklichkeit

$ claude mcp list
  plugin:cachly-brain:cachly: npx -y @cachly-dev/mcp-server - ✔ Connected
```

Beide Ausgaben standen gleichzeitig auf dem Bildschirm. Wer mit `details`
prüft, hält ein laufendes Plugin für kaputt. **Zum Prüfen `claude mcp list`
nehmen, nie `plugin details`.**

## Wie man es selbst nachprüft

Der `claude`-Befehl liegt nicht im PATH, aber die VS-Code-Erweiterung bringt
ihn mit:

```bash
C="$HOME/.vscode/extensions/anthropic.claude-code-*-win32-x64/resources/native-binary/claude.exe"

"$C" plugin validate sdk/mcp                 # Manifeste prüfen
"$C" plugin marketplace add cachly-dev/cachly-mcp
"$C" plugin install cachly-brain@cachly -y
"$C" mcp list                                # <- die Wahrheit steht hier
```

Ein lokaler Ordner geht auch als Marktplatz: `plugin marketplace add ./sdk/mcp`.
So lässt sich eine Änderung testen, bevor sie öffentlich ist.

## Warum es hier liegt und nicht im Monorepo

`/plugin marketplace add <repo>` **klont das Repo**. Das Monorepo
`cachly-dev/cachly` ist privat — der Befehl wäre für jeden Fremden ein 404
gewesen. Aufgefallen ist das erst, als jemand nachfragte; die Manifeste selbst
sehen in beiden Fällen gleich richtig aus.

`cachly-dev/cachly-mcp` ist öffentlich und ist der Spiegel dieses
Verzeichnisses. Er entsteht von allein:

```yaml
rsync -av --delete sdk/mcp/ /tmp/mirror/     # .github/workflows/mirror-mcp.yml
```

**Nie direkt im Spiegel arbeiten.** Der Lauf hat `--delete`; alles, was dort
von Hand entsteht, ist beim nächsten Push weg. Die Quelle ist dieses
Verzeichnis.

Es ist außerdem die inhaltlich richtige Stelle: das Plugin *ist* der
MCP-Server. Ein eigenes Community-Repo wäre eine dritte Kopie derselben
Angaben gewesen.

## Die Versionsnummer wird nie von Hand gesetzt

Beide Manifeste tragen die Nummer aus `sdk/mcp/package.json`. Sie stehen in
`scripts/nummer-nachziehen.mjs` und steigen mit:

```bash
cd sdk/mcp && npm version patch
```

Eine eigene Plugin-Nummer wäre eine weitere Stelle, die jemand von Hand heben
müsste — genau der Fehler, der am 20.08.2026 zwei Veröffentlichungen gekostet
hat.

## Aufbau

```
sdk/mcp/.claude-plugin/
├── plugin.json        was das Plugin ist, inkl. mcpServers und userConfig
├── marketplace.json   was der Marktplatz zeigt
└── README.md          diese Datei

sdk/mcp/hooks/         ERZEUGT — nie von Hand ändern
├── hooks.json                       lädt Claude Code von selbst
└── cachly-ambient-einblendung.mjs   das Hook-Bündel: eine Datei, kein npx
```

Beide Manifeste tragen Name, Version, Homepage, Repository und Lizenz doppelt,
die Version sogar dreifach (mit `package.json`). Damit sie nicht auseinander
laufen, prüft `scripts/plugin-manifeste-stimmen-ueberein.mjs` sie
gegeneinander — als Schritt im CI-Job `capability-drift`.

Die Beschreibung wird bewusst **nicht** verglichen: im Marktplatz steht der
Werbetext, im Plugin die technische Fassung.

## Hooks: seit 11.10.2026 dabei

Vorher brachte das Plugin nur den MCP-Server mit. Die Einblendung vor jedem
Prompt bekam nur, wer `init`, `setup` oder `autopilot` laufen ließ. Wer über
den Marktplatz kam, bekam sie nie.

Das Plugin liefert `SessionStart` (Sitzungs-Briefing), `UserPromptSubmit`
(Einblendung) und `Stop` (Schreibbeleg und Auto-Lernen). Jeder Hook ruft das
Bündel direkt:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/cachly-ambient-einblendung.mjs" UserPromptSubmit --plugin
```

Das Bündel entsteht per esbuild aus `src/ambient-hook-start.ts`. Es ist eine
Datei ohne `node_modules`. Dieselbe Datei kopiert `installAmbientHooks` in
Projekte nach `.claude/hooks/`. Neu schreiben und prüfen:

```bash
cd sdk/mcp && npm run plugin-hooks:write          # schreibt hooks/
cd sdk/mcp && npm run plugin-hooks:write -- --pruefen
```

Der Wächter `src/__tests__/plugin-hooks.test.ts` vergleicht die Dateien
byteweise mit der Quelle.

Was ein Lauf mit `--plugin` tut:

1. **Nie doppelt.** Steht für dasselbe Ereignis schon ein
   `cachly-ambient-`-Hook in `.claude/settings.json`,
   `.claude/settings.local.json` oder `~/.claude/settings.json`, endet der
   Plugin-Lauf sofort. Claude Code führt Plugin- und Einstellungs-Hooks
   getrennt aus; ohne diese Prüfung käme die Einblendung zweimal.
2. **Schlüssel und Instanz** sucht er in dieser Reihenfolge: Plugin-Option
   (`CLAUDE_PLUGIN_OPTION_API_KEY` / `_INSTANCE_ID`), Umgebung,
   `~/.cachly/credentials.json`, dann `mcpServers.cachly.env` in
   `~/.claude/mcp.json`, `.mcp.json` im Projekt, Cursor und Windsurf.
3. **Ohne Schlüssel oder ohne Instanz** endet er mit Exit 0 und ohne Ausgabe.

Kein `${user_config...}` im Hook-Befehl: so läuft der Hook auch, wenn der
Nutzer die Optionen leer lässt (siehe die Falle oben).

`PreToolUse` liefert das Plugin bewusst nicht mit. Das wäre ein weiterer
Hook-Lauf vor jeder Dateiänderung.

## Was später dazukann

Nicht in dieser Fassung, bewusst:

- **Skills** — „was hat mein Gedächtnis zu X gelernt" als `/cachly-brain:...`
- **Agents** — ein Lese-Agent, der gegen das Gedächtnis arbeitet

## Aktualisierung kommt nicht von allein

Claude Code aktualisiert Plugins aus fremden Marktplätzen standardmäßig
**nicht**. Automatisch geht das nur bei Anthropics eigenen Marktplätzen.
Wer `cachly` hinzugefügt hat, bleibt auf der installierten Fassung, bis er
`/plugin` → Marketplaces → „Enable auto-update“ einschaltet oder
`claude plugin update cachly-brain@cachly` ausführt. Beleg vom 11.10.2026:
Eine Installation vom 28.08. stand noch auf 0.10.138, der Marktplatz auf
0.10.174.
Quelle: https://code.claude.com/docs/en/plugins/loading#versions-and-updates
