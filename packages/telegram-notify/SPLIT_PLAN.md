# telegram-notify: Monorepo → Post-Split Strategy (Option B)

## Situation

`telegram-notify` is a shared package living at `packages/telegram-notify/` in the
`cachly-dev/cachly-mcp` monorepo. It is consumed by:

- **cachly-mcp** (TypeScript) — imports `packages/telegram-notify/client.ts` directly
- **travel-chaos-organizer** (Python) — installs via `pip install /packages/telegram-notify`
  inside the Docker build

When TCO moves to its own repository, the shared path no longer exists. This document
describes **Option B**: keep the package in the cachly-mcp repo and reference it via git.

---

## Option B: Git Subdirectory Dependency

The package stays at `cachly-dev/cachly-mcp/packages/telegram-notify/`. Both consumers
point to it by git URL with a `subdirectory=` specifier. No separate PyPI publish needed.

### Python (TCO requirements.txt)

```
# During monorepo phase (current)
telegram-notify @ file:///packages/telegram-notify

# After TCO moves to its own repo — replace the line above with:
telegram-notify @ git+https://github.com/cachly-dev/cachly-mcp.git@main#subdirectory=packages/telegram-notify
```

Pin a specific commit or tag for stability:

```
telegram-notify @ git+https://github.com/cachly-dev/cachly-mcp.git@v0.1.0#subdirectory=packages/telegram-notify
```

### TypeScript (cachly-mcp)

No change needed — `client.ts` is already a local file inside the same repo.

If cachly-mcp ever needs to reference it externally (e.g. a second TS consumer in a
separate repo), add it to `package.json`:

```json
"telegram-notify": "github:cachly-dev/cachly-mcp#path:packages/telegram-notify"
```

---

## Versioning

| Trigger | Action |
|---------|--------|
| Breaking API change | Bump `version` in `pyproject.toml`, push a git tag (`v0.2.0`) |
| Emoji / copy change | No version bump needed |
| New event key | Minor bump (`v0.1.1`) |

TCO pins to a tag in `requirements.txt`. Update the pin whenever you want to pull in
new functionality.

```bash
# In the TCO repo, after a new tag is pushed to cachly-mcp:
pip install "telegram-notify @ git+https://github.com/cachly-dev/cachly-mcp.git@v0.2.0#subdirectory=packages/telegram-notify"
# Then update requirements.txt accordingly
```

---

## Environment Variables

Both apps use the same bot token but separate chat IDs:

| Variable | Required by | Purpose |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | cachly-mcp, TCO backend | Shared bot token from @BotFather |
| `CACHLY_TELEGRAM_CHAT_ID` | cachly-mcp | Admin channel for Cachly MCP events |
| `TCO_TELEGRAM_CHAT_ID` | TCO backend | Admin channel for TCO backend events |
| `TELEGRAM_CHAT_ID` | both (fallback) | Optional catch-all if app-specific var not set |

The `notify(app, event, payload)` function derives the chat ID from
`{APP_UPPER}_TELEGRAM_CHAT_ID` automatically — no code change needed when apps diverge.

---

## Migration Checklist (when TCO splits)

- [ ] Create a new TCO repo
- [ ] In TCO `requirements.txt`: replace `file:///packages/telegram-notify` with the
      `git+https://…` URL pinned to the latest tag
- [ ] In TCO `.env.example`: document `TELEGRAM_BOT_TOKEN` and `TCO_TELEGRAM_CHAT_ID`
- [ ] Add `TELEGRAM_BOT_TOKEN` and `TCO_TELEGRAM_CHAT_ID` as secrets in the TCO repo's
      CI/CD (GitHub Actions, Fly.io, etc.)
- [ ] Update TCO Dockerfile: remove the `COPY packages/telegram-notify` block and the
      separate `pip install` step — the `git+https://` URL in `requirements.txt` handles it
- [ ] Verify `telegram_notify` import works in a clean Docker build in the new repo
- [ ] Tag the cachly-mcp commit that TCO depends on (e.g. `git tag v0.1.0`)

---

## Why Not Option A (publish to PyPI / npm)?

Publishing requires a release pipeline, package namespacing, and credentials. For an
internal package shared between two controlled repos, a git URL with subdirectory is
simpler, keeps the source co-located with the cachly-mcp codebase, and requires no
external registry accounts. Revisit PyPI if a third consumer appears.
