# cachly add/search service (AML memory-api-v1.1)

A small HTTP service in front of a cachly Brain. It speaks the Agent Memory
Leaderboard contract `memory-api-v1.1` and is the service the OmniMemEval
`cachly` adapter talks to. Storing and searching run through the same code as
the MCP server in this package: `learn_from_attempts` and `smart_recall` from
`src/handlers/brain.ts`.

| Route | Request | Response |
| --- | --- | --- |
| `GET /health` | | `{"status": "ok"}` (no key needed) |
| `POST /v1/memory/add` | `request_id`, `user_id`, `session_id`, `messages[]` (`role`, `content`, optional `timestamp` in Unix ms) | `success`, `request_id`; returns once every stored record is searchable |
| `POST /v1/memory/search` | `query`, `user_id`, `top_k` (1-1000) | `data[]` with `id` and `content` |
| `POST /v1/memory/delete` | `user_id` | `deleted`; an unknown user is not an error |

All `POST` routes need `Authorization: Bearer <AML_MEMORY_KEY>`.

## Behaviour

- Each `user_id` gets its own Valkey database. A search only reads that database.
- `add` groups the messages by timestamp, splits them into pieces of bounded length, stores each piece as one
  record with the session date in front, and waits until all vectors are written.
  A repeated add with the same `request_id` stores nothing new.
- `search` calls `smart_recall` with `limit = top_k`. cachly caps one search at
  20 records, so `top_k` above 20 returns at most 20. Each record comes back as
  full text, in ranking order.
- When `CACHLY_JWT` is set, `smart_recall` also asks the API's cross-encoder
  reranker (`POST /api/v1/rerank`) to reorder the top 25 candidates. If it does
  not answer within `CACHLY_LESER_ZEITLIMIT_MS`, the order without it stands.
  `CACHLY_LESER=off` switches it off, for example for runs that should use
  public models only.
- `delete` empties the user's database and frees it for reuse.

## Run it

Requirements: Node 22, Docker (for Valkey), and a cachly API for embeddings.
The API embeds with `bge-m3` (query and records) and `qwen3-embedding:0.6b`
(second record vector). Point `CACHLY_API_URL` at the hosted API `https://api.cachly.dev`
and set `CACHLY_JWT` to the API key of your cachly account.

```bash
docker run -d --name aml-valkey -p 127.0.0.1:6391:6379 valkey/valkey:8-alpine \
  valkey-server --databases 16384 --save '' --appendonly no
npm ci                         # package root: cachly-mcp, or sdk/mcp in the monorepo
export AML_MEMORY_KEY=...      # bearer key callers must send; keep it out of files
export CACHLY_API_URL=https://api.cachly.dev
export CACHLY_JWT=...          # API key of your cachly account
node_modules/.bin/tsx aml-service/dienst.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `AML_MEMORY_KEY` | required | Bearer key of the service. |
| `AML_PORT` / `AML_HOST` | `8780` / `127.0.0.1` | Where the service listens. |
| `AML_REDIS_URL` | `redis://127.0.0.1:6391` | Valkey with enough databases (one per `user_id`). |
| `AML_MAX_ADD` | `16` | Adds running at the same time; the rest wait in line. |
| `AML_ADD_ZEIT_MS` | `1500000` | Time limit of one add. |
| `AML_MAX_DB` | `16384` | Highest database number handed out. |
| `CACHLY_EMBED_TIMEOUT_MS` | `30000` | Time limit of one embedding call; raise it on a slow CPU host. |
| `CACHLY_LESER` | on | `off` (or `0`, `false`) switches the reranker off. |
| `CACHLY_LESER_ZEITLIMIT_MS` | `2500` | Time limit of one reranker call (1 to 120000). |

`node aml-service/loeschen.mjs --ja` empties every database of the local
test Valkey on port 6391.

## Contract tests

```bash
node --test aml-service/vertrag.test.mjs
```

The suite starts Valkey (container `aml-valkey`), an embedding stub and the
service itself. It needs no network and no account.
