# cachly als Claude-Code-Plugin

Zwei Zeilen statt einer Konfigurationsdatei:

```
/plugin marketplace add cachly-dev/cachly-mcp
/plugin install cachly-brain@cachly
```

Danach fragt Claude Code nach der Brain-Kennung und dem Schlüssel. Der
MCP-Server wird nicht von Hand eingetragen — das Plugin deklariert ihn.

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

## Was noch NICHT bewiesen ist

**Die Falle, die den ganzen Weg wertlos machen könnte.** Der
`watermarks-remover` dokumentiert für *Hooks*:

> Claude Code refuses to run a hook that references an option the user has
> never opened `/plugin manage` to set — a declared default does not satisfy
> it — so interpolating it would mean the hook silently never runs on a fresh
> install.

Ob dasselbe für **MCP-Server-Deklarationen** gilt, steht in keiner Doku. Wenn
ja, dann startet unser Server bei einer frischen Installation **still gar
nicht** — und ein Plugin, das lautlos nichts tut, ist schlechter als gar
keins.

### Der Test, der das entscheidet

Er dauert eine Minute und braucht den Claude-Code-CLI. **Auf diesem Laptop ist
er nicht installiert** (`claude: command not found`, geprüft am 28.08.2026 —
Claude Code läuft hier als VS-Code-Erweiterung, die kein `claude` auf den PATH
legt). Zuerst also:

```bash
npm install -g @anthropic-ai/claude-code
```

Dann:

```bash
# Plugin lokal laden, OHNE vorher /plugin manage zu öffnen
claude --plugin-dir /c/Users/heinr/Documents/Development/cachly/cachly/sdk/mcp

# In der Sitzung:
/mcp
```

**Erwartung, falls die Falle NICHT gilt:** `cachly` erscheint in der Liste —
verbunden oder mit Fehler, aber vorhanden.

**Erwartung, falls die Falle GILT:** `cachly` fehlt vollständig, ohne Meldung.
Dann muss `env` ohne `${user_config...}` auskommen, und die Kennung kommt
anders herein — über eine Umgebungsvariable, die der Nutzer ohnehin setzt,
oder über einen Einrichtungs-Skill statt über die Deklaration.

Bis dieser Test gefahren ist, gilt das Plugin als **ungeprüft**. Es liegt im
Repo, es wird nicht beworben, und die Karte `ewzv4gzw3d0k` bleibt offen.

## Aufbau

```
sdk/mcp/.claude-plugin/
├── plugin.json        was das Plugin ist, inkl. mcpServers und userConfig
├── marketplace.json   was der Marktplatz zeigt
└── README.md          diese Datei
```

Beide Manifeste tragen Name, Version, Homepage, Repository und Lizenz doppelt,
die Version sogar dreifach (mit `package.json`). Damit sie nicht auseinander
laufen, prüft `scripts/plugin-manifeste-stimmen-ueberein.mjs` sie
gegeneinander — als Schritt im CI-Job `capability-drift`.

Die Beschreibung wird bewusst **nicht** verglichen: im Marktplatz steht der
Werbetext, im Plugin die technische Fassung.

## Was später dazukann

Nicht in dieser Fassung, bewusst:

- **Skills** — „was hat mein Gedächtnis zu X gelernt" als `/cachly-brain:...`
- **Hooks** — `SessionStart` holt das Briefing, statt dass es in einer
  `CLAUDE.md` steht, die jemand lesen muss
- **Agents** — ein Lese-Agent, der gegen das Gedächtnis arbeitet

Alle drei sind erst sinnvoll, wenn der MCP-Server nachweislich hochkommt.
