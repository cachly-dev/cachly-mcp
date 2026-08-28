// ── Tool definitions (schema only, no handler logic) ─────────────────────────

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  // ── Instance Management ──────────────────────────────────────────────────
  {
    name: 'list_instances',
    description:
      'List all your cachly cache instances with their status and connection details. ' +
      'Read-only. Returns an array of instance objects — each with id, name, tier, status, region, RAM, ' +
      'and redis:// connection string. Returns an empty array if no instances exist. ' +
      'No pagination: all instances are returned in one call (typical accounts have < 20). ' +
      'Use this first to discover instance UUIDs required by get_instance, cache_get, cache_set, ' +
      'and all other cache tools. Use get_instance to retrieve full metadata for a single instance.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_instance',
    description:
      'Create a new managed Valkey/Redis cache instance on cachly.dev. ' +
      'Free tier provisions in ~30 seconds. Paid tiers return a Stripe checkout URL. ' +
      'Available tiers: free (25 MB), dev (200 MB, €19/mo), pro (900 MB, €49/mo), ' +
      'speed (900 MB Dragonfly + Semantic Cache, €79/mo), business (7 GB, €199/mo).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for the instance (min 3 chars)' },
        tier: {
          type: 'string',
          enum: ['free', 'dev', 'pro', 'speed', 'business'],
          description: 'Pricing tier. Start with "free" for testing.',
        },
      },
      required: ['name', 'tier'],
    },
  },
  {
    name: 'get_instance',
    description:
      'Get full metadata for a specific cache instance: name, tier, status (provisioning / running / paused), ' +
      'region, RAM limit, Redis connection string, created_at, and expiry. Read-only. ' +
      'Returns an error if the instance_id is not found or belongs to another account. ' +
      'Call list_instances first to discover valid UUIDs. ' +
      'Use get_connection_string instead if you only need the redis:// URL for your app config.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance (from list_instances)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'get_connection_string',
    description:
      'Get the Redis/Valkey connection string (redis:// URL) for a running instance. ' +
      'Use this to configure your application or set environment variables.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'delete_instance',
    description:
      'Permanently delete a cache instance. Deprovisions the Kubernetes workload and removes all data. ' +
      'This action is irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance to delete' },
        confirm: { type: 'boolean', description: 'Must be true to confirm deletion' },
      },
      required: ['instance_id', 'confirm'],
    },
  },

  // ── Live Cache Operations ────────────────────────────────────────────────
  {
    name: 'cache_get',
    description:
      'Get a value from a running cache instance by key. ' +
      'Returns the stored value (string or deserialized JSON object) or null if the key does not exist or has expired. ' +
      'Read-only — no side effects. ' +
      'Use cache_mget when you need multiple keys in one round-trip. ' +
      'Use cache_exists to check existence without retrieving the value. ' +
      'Use semantic_search when you need fuzzy/vector search across stored values.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance' },
        key: { type: 'string', description: 'Cache key to retrieve' },
        org_id: { type: 'string', description: 'Optional org ID — if the direct key misses, falls back to the shared org namespace org:{org_id}:sem:{key}' },
      },
      required: ['instance_id', 'key'],
    },
  },
  {
    name: 'cache_set',
    description:
      'Set a key-value pair in a running cache instance. ' +
      'Overwrites any existing value at the key — not idempotent for new data. ' +
      'Returns "OK" on success; returns an error if the instance_id is invalid or the instance is paused. ' +
      'Value can be a string or a JSON-serialized object. Optionally set a TTL in seconds (omit for no expiry). ' +
      'Use cache_mset instead for setting multiple keys in a single pipeline round-trip. ' +
      'Use cache_stream_set instead for caching LLM token streams (ordered string chunks).',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
        key: { type: 'string', description: 'Cache key' },
        value: { type: 'string', description: 'Value to store (string or JSON)' },
        ttl: { type: 'number', description: 'Time-to-live in seconds (optional, omit for no expiry)' },
        org_id: { type: 'string', description: 'Optional org ID — also writes the key to the shared org namespace org:{org_id}:sem:{key} with the same TTL' },
      },
      required: ['instance_id', 'key', 'value'],
    },
  },
  {
    name: 'cache_delete',
    description:
      'Permanently delete one or more keys from a running cache instance (uses Redis DEL). ' +
      'This operation is destructive and irreversible — deleted keys cannot be recovered. ' +
      'Deleting a non-existent key is safe and returns 0 for that key (no error). ' +
      'Returns the count of keys that were actually deleted (existing keys only). ' +
      'Use this to explicitly remove stale entries; prefer cache_set with a short TTL for auto-expiring data. ' +
      'Do NOT use this to clear an entire instance — use the dashboard or delete_instance for that.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance to delete keys from (get from list_instances)' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more cache keys to delete. Accepts exact keys only (no glob patterns — use cache_keys to list first).',
        },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'cache_exists',
    description:
      'Check whether one or more keys exist in a running cache instance (uses Redis EXISTS). ' +
      'Read-only — no side effects. Returns the count of keys that currently exist (integer 0 to N). ' +
      'If none of the keys exist, returns 0. If all exist, returns the total key count passed in. ' +
      'Duplicate keys in the input array are each counted separately (Redis behavior). ' +
      'Use this to check presence before a cache_get to avoid null handling, or to verify a cache warm-up completed. ' +
      'Use cache_get instead if you also need the value; use cache_ttl if you need expiry info.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance to check (get from list_instances)' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys to check for existence. Accepts exact keys only (no glob patterns).' },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'cache_ttl',
    description:
      'Get the remaining time-to-live (TTL) of a key in seconds. ' +
      'Returns -1 if the key exists but has no expiry, -2 if the key does not exist. ' +
      'Read-only — no side effects. ' +
      'Use cache_set with a ttl parameter to set or update the expiry.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
        key: { type: 'string', description: 'Cache key to inspect' },
      },
      required: ['instance_id', 'key'],
    },
  },
  {
    name: 'cache_keys',
    description:
      'List keys in a cache instance matching an optional glob pattern (e.g. "user:*", "session:*"). ' +
      'Uses SCAN to avoid blocking the server. Returns at most `count` keys.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        pattern: { type: 'string', description: 'Glob pattern (default: *)' },
        count: { type: 'number', description: 'Max keys to return (default: 50, max: 500)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'cache_stats',
    description:
      'Get real-time stats for a cache instance: memory usage, hit/miss rate, commands/sec, ' +
      'connected clients, keyspace info, and uptime. Read-only — no side effects. ' +
      'The instance_id identifies the target instance (obtain from list_instances). ' +
      'Use this for monitoring, capacity planning, or debugging performance issues — ' +
      'not for reading cached values (use cache_get for that). ' +
      'Use cache_exists or cache_ttl if you only need key-level information.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'semantic_search',
    description:
      'Find cached entries that are semantically similar to a natural-language query. ' +
      'Read-only — no side effects. ' +
      'Returns an array of objects, each with: key, value, similarity_score (0–1), and namespace. ' +
      'Returns an empty array if no entries meet the similarity threshold. ' +
      'Requires OPENAI_API_KEY (or compatible provider) and the Speed/Business tier with CACHLY_VECTOR_URL. ' +
      'Embeddings are computed server-side and never leave Germany (pgvector HNSW index). ' +
      'Example: "find all cached responses about password reset" or "what did we answer about pricing?". ' +
      'Use cache_get for exact key lookup; use smart_recall for brain lessons.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
        query: { type: 'string', description: 'Natural-language query to find similar cached content' },
        threshold: {
          type: 'number',
          description: 'Minimum cosine similarity 0–1 (default: 0.82). Lower = broader matches.',
        },
        namespace: {
          type: 'string',
          description: 'Semantic namespace to search in (default: cachly:sem)',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
        },
        use_hybrid: {
          type: 'boolean',
          description:
            'Enable Hybrid BM25+Vector RRF fusion search. ' +
            'Passes `hybrid: true` and the query text to the pgvector API for higher precision on named entities. ' +
            'Default: false.',
        },
        auto_namespace: {
          type: 'boolean',
          description:
            'Auto-detect the namespace from the query text using text heuristics ' +
            'instead of using the `namespace` parameter. ' +
            'Returns results only from the matching domain (code/translation/summary/qa/creative).',
        },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'detect_namespace',
    description:
      'Classify a prompt into one of 5 semantic namespaces using text heuristics. ' +
      'Overhead: <0.1 ms, no embedding required. ' +
      'Useful to understand which namespace cachly will use for a given prompt. ' +
      'Returns one of: cachly:sem:code, cachly:sem:translation, cachly:sem:summary, ' +
      'cachly:sem:qa, cachly:sem:creative.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt to classify into a semantic namespace' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'cache_warmup',
    description:
      'Pre-warm the semantic cache with a list of prompt/value pairs. ' +
      'For each entry: computes an embedding, checks if a similar entry already exists ' +
      '(similarity ≥ 0.98), and writes new entries to Valkey + pgvector index. ' +
      'Use this to seed FAQ responses, product descriptions, or known-good LLM answers ' +
      'before the first real user traffic. Requires OPENAI_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        entries: {
          type: 'array',
          description: 'List of prompt/value pairs to pre-warm into the cache',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'The query or question to cache' },
              value: { type: 'string', description: 'The answer or response to store for this prompt' },
              namespace: { type: 'string', description: 'Optional per-entry namespace override' },
            },
            required: ['prompt', 'value'],
          },
        },
        namespace: {
          type: 'string',
          description: 'Default namespace for all entries (default: cachly:sem)',
        },
        ttl: {
          type: 'number',
          description: 'Time-to-live in seconds for warmed entries (omit for no expiry)',
        },
        auto_namespace: {
          type: 'boolean',
          description:
            'Auto-detect the namespace per prompt using text heuristics. ' +
            'Overrides `namespace` when no per-entry namespace is set.',
        },
      },
      required: ['instance_id', 'entries'],
    },
  },
  {
    name: 'index_project',
    description:
      'Index local source files into the cachly semantic cache so AI assistants can use ' +
      'semantic_search to find relevant files instead of re-reading the whole codebase every time. ' +
      'Walks a directory recursively, reads each matching file, and stores a summary + path ' +
      'as a semantic cache entry (prompt = file path + content excerpt, value = relative path). ' +
      'Requires an embedding provider (OPENAI_API_KEY or CACHLY_EMBED_PROVIDER + key). ' +
      'Run once, then re-run after major refactors. TTL=86400 (24h) keeps entries fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cachly instance' },
        dir: {
          type: 'string',
          description: 'Absolute path to the directory to index (e.g. /Users/you/myproject/src)',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'File extensions to include (default: ["ts","js","go","py","java","rs","md","kt","swift"])',
        },
        max_files: {
          type: 'number',
          description: 'Maximum number of files to index (default: 100)',
        },
        ttl: {
          type: 'number',
          description: 'TTL in seconds for indexed entries (default: 86400 = 24 h)',
        },
        summary_chars: {
          type: 'number',
          description: 'Characters to use as summary per file (default: 1200)',
        },
        namespace: {
          type: 'string',
          description: 'Semantic namespace to store under (default: cachly:sem:code)',
        },
      },
      required: ['instance_id', 'dir'],
    },
  },
  // ── Bulk operations ──────────────────────────────────────────────────────
  {
    name: 'cache_mset',
    description:
      'Set multiple key-value pairs in a single pipeline round-trip. ' +
      'Supports per-key TTL – unlike native MSET. ' +
      'Uses one TCP round-trip for N keys via Redis pipeline. ' +
      'Each item overwrites any existing value for that key. ' +
      'On partial failure the successfully pipelined keys are committed; a per-key error list is returned for any that failed. ' +
      'Returns a summary: { set: N, errors: [...] }. ' +
      'Use cache_set for a single key; use cache_stream_set for large streaming payloads.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        items: {
          type: 'array',
          description: 'Key-value pairs to set',
          items: {
            type: 'object',
            properties: {
              key:   { type: 'string',  description: 'Cache key' },
              value: {                  description: 'Value to store (JSON-serialised)' },
              ttl:   { type: 'number',  description: 'Per-key TTL in seconds (optional)' },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['instance_id', 'items'],
    },
  },
  {
    name: 'cache_mget',
    description:
      'Retrieve multiple keys in one round-trip using native Redis MGET. ' +
      'Returns values in the same order as the keys array; missing keys are null.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string',  description: 'UUID of the cache instance' },
        keys:        { type: 'array', items: { type: 'string' }, description: 'List of keys to fetch' },
      },
      required: ['instance_id', 'keys'],
    },
  },
  // ── Distributed lock ──────────────────────────────────────────────────────
  {
    name: 'cache_lock_acquire',
    description:
      'Acquire a distributed lock using Redis SET NX PX (Redlock-lite). ' +
      'Returns a fencing token on success. The lock auto-expires after ttl_ms to prevent deadlocks. ' +
      'Use cache_lock_release to free the lock early.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:    { type: 'string', description: 'UUID of the cache instance' },
        key:            { type: 'string', description: 'Lock resource identifier' },
        ttl_ms:         { type: 'number', description: 'Safety TTL in milliseconds (e.g. 5000)' },
        retries:        { type: 'number', description: 'Max acquire attempts (default: 3)' },
        retry_delay_ms: { type: 'number', description: 'Milliseconds between retries (default: 50)' },
      },
      required: ['instance_id', 'key', 'ttl_ms'],
    },
  },
  {
    name: 'cache_lock_release',
    description:
      'Release a previously acquired distributed lock. ' +
      'Uses a Lua script for atomic release – only deletes the key if the fencing token matches.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key:         { type: 'string', description: 'Lock resource identifier (same as in cache_lock_acquire)' },
        token:       { type: 'string', description: 'Fencing token returned by cache_lock_acquire' },
      },
      required: ['instance_id', 'key', 'token'],
    },
  },
  // ── Auth & API-Status ─────────────────────────────────────────────────────
  {
    name: 'get_api_status',
    description:
      'Full diagnostic for your cachly Brain — call this FIRST whenever anything is not working. ' +
      'Returns: API reachability, JWT validity + expiry, your user ID, ' +
      'all Brain instances with live status (🟢 running / 🟡 provisioning / 🔴 stopped), ' +
      'Redis ping on the active connection, and actionable fix steps for every issue found. ' +
      'Workflow: run get_api_status → read the issue it flags → fix it → retry your tool.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // ── Thinking/Context Cache (for AI assistants) ────────────────────────────
  {
    name: 'remember_context',
    description:
      'Save context information to the cache so you can recall it later without re-computing. ' +
      'Perfect for caching: codebase overviews, file summaries, project structure, ' +
      'frequently-accessed data, or "thinking" results like dependency analysis. ' +
      'The AI assistant can use this to avoid re-reading the entire codebase every time. ' +
      'Overwrites any existing value stored under the same key. ' +
      'Returns { key, stored_at, ttl } confirming the saved context. ' +
      'Example: remember_context("project overview", "This is a Next.js app with...") ' +
      'then later: recall_context("project overview"). ' +
      'Use recall_context to retrieve; use list_remembered to see all stored keys.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key: { type: 'string', description: 'Descriptive key like "project_overview", "auth_architecture", "file:src/index.ts"' },
        content: { type: 'string', description: 'The context/summary/analysis to remember' },
        category: {
          type: 'string',
          enum: ['overview', 'architecture', 'file_summary', 'dependency', 'thinking', 'custom'],
          description: 'Category for organization (default: custom)',
        },
        ttl: { type: 'number', description: 'Time-to-live in seconds (default: 86400 = 24h, use 0 for no expiry)' },
      },
      required: ['instance_id', 'key', 'content'],
    },
  },
  {
    name: 'recall_context',
    description:
      'Retrieve previously saved context from the cache. ' +
      'Returns the saved content or null if not found. ' +
      'Use this at the START of any task to check if you already have relevant context cached, ' +
      'before doing expensive operations like reading many files. ' +
      'Supports glob patterns: "file:*" matches all file summaries, "arch*" matches architecture-related keys.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key: { type: 'string', description: 'The key to look up (supports glob pattern like "file:*")' },
      },
      required: ['instance_id', 'key'],
    },
  },
  {
    name: 'list_remembered',
    description:
      'List all cached context entries for this project. ' +
      'Shows what knowledge the AI assistant has already cached, so you can decide ' +
      'whether to recall existing context or refresh it. ' +
      'Returns: key, category, size, TTL remaining, and a content preview.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        category: {
          type: 'string',
          enum: ['overview', 'architecture', 'file_summary', 'dependency', 'thinking', 'custom', 'all'],
          description: 'Filter by category (default: all)',
        },
        limit: { type: 'number', description: 'Max entries to return (default: 50)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'forget_context',
    description:
      'Delete one or more cached context entries. ' +
      'Use when context is stale or you want to force a fresh analysis. ' +
      'Supports glob patterns: "file:*" deletes all file summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys to delete (supports glob)' },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'learn_from_attempts',
    description:
      'Store a lesson learned from a failed or successful attempt. ' +
      'Call this AFTER completing any non-trivial task (deploy, debug, fix, architecture decision). ' +
      'The lesson will be recalled automatically in future sessions via recall_best_solution. ' +
      'Fields: topic (short slug like "deploy:web"), outcome ("success"|"failure"), ' +
      'what_worked (what solved it), what_failed (what did NOT work), context (extra details). ' +
      'Supports structured metadata: severity, file_paths (files involved), commands (working commands), tags. ' +
      'Deduplication: if a lesson for this topic already exists, it is updated with full audit trail — ' +
      'an UPDATE then REQUIRES the field `grund` (one line: WHY the previous version was wrong); without it the update is rejected. ' +
      'Contradiction detection: warns if new outcome conflicts with existing lesson outcome. ' +
      'Confidence: lesson starts at 1.0, decays after 5d (→0.7) and 10d (→0.5) without recall. ' +
      'Example: learn_from_attempts(topic="deploy:api", outcome="success", what_worked="nohup docker compose up -d --build", what_failed="docker compose up hangs on SSH timeout", severity="critical", commands=["nohup docker compose up -d --build"])',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:        { type: 'string', description: 'Short slug, e.g. "deploy:web", "debug:redis-tls", "fix:generate-series"' },
        outcome:      { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Did it work?' },
        what_worked:  { type: 'string', description: 'What solved the problem or what approach succeeded' },
        what_failed:  { type: 'string', description: 'What did NOT work (optional but valuable)' },
        context:      { type: 'string', description: 'Additional context, error messages, root cause (optional)' },
        severity: {
          type: 'string',
          enum: ['critical', 'major', 'minor'],
          description: 'Impact severity: critical (blocks work/deploy), major (significant slowdown), minor (nice to know). Default: major.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files involved in this lesson (e.g. ["infra/deploy.sh", ".env"])',
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commands that worked or failed (e.g. ["rsync -avz ...", "docker compose up -d"])',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topic tags for filtering (e.g. ["bash", "deploy", "env"])',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Prerequisites, e.g. ["node:>=20", "docker:running"]. A stale one flags dependent lessons for review.',
        },
        author: {
          type: 'string',
          description: 'Who is storing this lesson, e.g. "alice". Enables cross-author reuse tracking.',
        },
        grund: {
          type: 'string',
          description: 'One line: WHY the previous version was wrong, like a commit message. REQUIRED when the topic already exists; optional on first write.',
        },
        ersetzt: {
          type: 'string',
          description: 'Topic slug of an OLDER lesson this one refutes. The old one is suppressed in smart_recall and shows a "superseded" banner.',
        },
        visibility: {
          type: 'string',
          enum: ['team', 'private', 'public'],
          description: 'Who can see it: "team" (default) = all members, "private" = only via exact recall_best_solution, "public" = same as team for now.',
        },
        service: {
          type: 'string',
          description: 'Service or system this lesson concerns, e.g. "prometheus", "auth-service".',
        },
        service_kind: {
          type: 'string',
          enum: ['service', 'system'],
          description: '"service" (default) for an application, "system" for infrastructure like prometheus or redis.',
        },
        group: {
          type: 'string',
          description: 'Optional sub-team scope, e.g. "backend". Only that group and admins see it. Independent of visibility.',
        },
      },
      required: ['instance_id', 'topic', 'outcome', 'what_worked'],
    },
  },
  {
    name: 'recall_best_solution',
    description:
      'Recall the best known solution for a topic from past lessons. ' +
      'Call this BEFORE attempting any task that might have been done before. ' +
      'Returns the most recent successful lesson for the topic, with confidence indicator. ' +
      '⚠️ badge = lesson is >5d old (verify before applying). 🔴 = >10d old (likely stale!). ' +
      'Recalling a lesson resets its confidence clock to 1.0 (marks as recently verified). ' +
      'Example: recall_best_solution(topic="deploy:web") → returns the working deploy command.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:        { type: 'string', description: 'Topic slug to look up, e.g. "deploy:web". Supports partial match.' },
        author:       { type: 'string', description: 'Who is asking (optional). Required to read a group-scoped lesson: without it, group-scoped lessons answer like "not found". Team-wide lessons need no author.' },
      },
      required: ['instance_id', 'topic'],
    },
  },
  {
    name: 'recall_feedback',
    description:
      'Tell the Brain whether a recalled lesson ACTUALLY SOLVED your problem. ' +
      'This is the one signal the Brain cannot infer: recall_count only means "it was shown". ' +
      'Call it right after a lesson helped you — or after you solved something the Brain should have found. ' +
      'IMPORTANT: rank=0 means the lesson was NOT in the answer at all. That is the most valuable feedback ' +
      'there is, because it says the ranking never surfaced it. ' +
      'Example: recall_feedback(query="why does the deploy abort", topic="ci:timeout-reports-cancelled", helped=true, rank=0)',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        query: {
          type: 'string',
          description: 'The question you asked, as you asked it. Not a summary — the ranking has to learn from the real wording.',
        },
        topic: {
          type: 'string',
          description: 'Topic of the lesson this is about. May be a lesson that was NOT returned (then set rank=0).',
        },
        helped: {
          type: 'boolean',
          description: 'Did it solve your problem? true or false. There is deliberately no "not sure" — a guessed value is worse than none.',
        },
        rank: {
          type: 'number',
          description: 'Where it stood in the answer, 1-based. 0 = it was NOT in the answer at all (the most valuable case).',
        },
        note: { type: 'string', description: 'Optional: what was missing, or why it did not fit.' },
        author: { type: 'string', description: 'Optional: your handle.' },
      },
      required: ['instance_id', 'query', 'topic', 'helped', 'rank'],
    },
  },
  {
    name: 'smart_recall',
    description:
      'Semantically search cached context using natural language. ' +
      'Instead of exact key matching, finds context by meaning. ' +
      'Example: smart_recall("how does authentication work") → returns cached auth architecture summary. ' +
      'Falls back to remember_context keys if no semantic match is found.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        query: { type: 'string', description: 'Natural language query to find relevant cached context' },
        threshold: { type: 'number', description: 'Similarity threshold 0-1 (default: 0.78)' },
        author: { type: 'string', description: 'Who is recalling (optional). Counts cross-author reuse.' },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files you are working on, e.g. ["src/auth/service.ts"]. Lessons learned around these files rank higher.',
        },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'session_start',
    description:
      'Single-call session briefing. Call this at the START of every session INSTEAD of multiple separate smart_recall/recall_best_solution calls. ' +
      'Returns: last session summary, recent lessons sorted by recency, relevant lessons for your focus area, ' +
      'open failures (topics with only failure outcomes), brain health stats, team telepathy (what teammates learned this week), ' +
      'predictive pre-warnings (if your focus area has known failure patterns), and memory crystals (compressed wisdom from old sessions). ' +
      'Also saves a session start marker so session_end can compute duration.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        focus: {
          type: 'string',
          description: 'Keywords for what you plan to work on today (e.g. "deploy infra api"). Used to surface relevant lessons at the top.',
        },
        author: {
          type: 'string',
          description: 'Your name or handle (e.g. "alice"). Enables Team Telepathy — filters YOUR lessons vs TEAM lessons from past 7 days.',
        },
        provider: {
          type: 'string',
          description: 'Current AI provider (e.g. "claude-code", "copilot", "cursor", "windsurf"). Shown in the briefing header and saved so the next provider can see who was last active.',
        },
        workspace_path: {
          type: 'string',
          description: 'Absolute path to the project root. If no session_end was found (e.g. context limit hit), reads git log to reconstruct what happened since last session.',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'session_start_summary',
    description:
      'Focused session briefing for large brains. Returns only the top-N most relevant lessons for the given focus topic, ' +
      'scored by relevance, recall count, severity, recency, and outcome. ' +
      'Ideal when session_start returns too many lessons to fit in context (1000+ lesson brains). ' +
      'Use session_start for the full briefing including handoffs, streak, roadmap, and team telepathy.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        focus: {
          type: 'string',
          description: 'The topic or task you are about to work on (e.g. "deploy infra", "api auth"). Used to score and rank lessons by relevance.',
        },
        top_n: {
          type: 'number',
          description: 'Number of lessons to return (default 10, max 25). Lessons are ranked by relevance to focus.',
        },
        author: {
          type: 'string',
          description: 'Your name or handle (optional). Same as session_start — used for team lesson filtering.',
        },
      },
      required: ['instance_id', 'focus'],
    },
  },
  {
    name: 'session_end',
    description:
      'Save a session summary when you finish working. ' +
      'Records what was accomplished, files changed, and lesson count. ' +
      'The next session_start will show this summary as "Last session". ' +
      'Call this when ending a work session, before going idle, or before summarizing. ' +
      'Ambient Learning: if workspace_path is provided, reads git log since session start and auto-learns from commits.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished this session (2-3 sentences)',
        },
        files_changed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key files changed this session (optional)',
        },
        lessons_learned: {
          type: 'number',
          description: 'Number of new lessons stored this session (optional)',
        },
        workspace_path: {
          type: 'string',
          description: 'Absolute path to the project root (e.g. "/Users/you/myproject"). Enables Ambient Learning — reads git log since session start and auto-learns from commit messages.',
        },
      },
      required: ['instance_id', 'summary'],
    },
  },
  // ── Session Handoff — cross-window continuity ─────────────────────────────
  {
    name: 'session_handoff',
    description:
      'Save a detailed handoff for the NEXT chat window / session. ' +
      'Stores: current progress, TODO list (done + remaining), changed files with descriptions, ' +
      'instructions for the next assistant, and any incomplete work. ' +
      'The next session_start automatically includes this handoff so the new window knows EXACTLY what happened and what remains. ' +
      'Call this BEFORE closing a chat window, especially if work is incomplete. ' +
      'This prevents the "continue" problem where new windows lose context, skip tasks, or produce broken code.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        completed_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tasks that were fully completed (e.g. "Implemented brainSearch() in JS SDK")',
        },
        remaining_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tasks NOT yet done — the next window MUST pick these up',
        },
        files_changed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to project root' },
              status: { type: 'string', enum: ['complete', 'partial', 'broken'], description: 'State of this file' },
              description: { type: 'string', description: 'What was changed and what still needs work' },
            },
            required: ['path', 'status'],
          },
          description: 'Changed files with their current state — marks partial/broken files so next window knows to fix them',
        },
        instructions: {
          type: 'string',
          description: 'Free-form instructions for the next assistant. Be specific: what to do next, what to avoid, what broke.',
        },
        context_summary: {
          type: 'string',
          description: 'Brief summary of what happened this session (architecture decisions, key findings, blockers)',
        },
        blocked_on: {
          type: 'string',
          description: 'If work is blocked, describe what is needed to unblock (e.g. "waiting for API deploy", "needs user input on design")',
        },
      },
      required: ['instance_id', 'completed_tasks', 'remaining_tasks'],
    },
  },
  // ── session_ping — lightweight in-session checkpoint ─────────────────────
  {
    name: 'session_ping',
    description:
      'Lightweight checkpoint — call this every ~5 tool calls or whenever you complete a significant step. ' +
      'Stores the current task + files touched so session_start on the NEXT provider can reconstruct what happened ' +
      'even if session_end was never called (e.g. Claude context limit hit, window crashed). ' +
      'This solves the provider-switching problem: Claude → Copilot → Cursor all see the same last checkpoint. ' +
      'Extremely fast — one Redis SET, no blocking operations.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        task: {
          type: 'string',
          description: 'What you are currently working on (e.g. "Implementing invite handler in handler/invite.go")',
        },
        files_touched: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files modified so far this session',
        },
        next_step: {
          type: 'string',
          description: 'What the NEXT step is after this checkpoint (helps next provider resume immediately)',
        },
        provider: {
          type: 'string',
          description: 'Current AI provider (e.g. "claude-code", "copilot", "cursor", "windsurf")',
        },
      },
      required: ['instance_id', 'task'],
    },
  },
  // ── AI Brain — Extended features ─────────────────────────────────────────
  {
    name: 'auto_learn_session',
    description:
      'Auto-learn from a list of session observations WITHOUT explicit learn_from_attempts calls. ' +
      'Pass what happened (commands run, errors seen, solutions found) and the brain classifies and stores lessons automatically. ' +
      'Use at session_end to capture everything you did, even if you forgot to call learn_from_attempts. ' +
      'Returns a summary of what was auto-stored.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        observations: {
          type: 'array',
          description: 'List of observations from this session',
          items: {
            type: 'object',
            properties: {
              action:   { type: 'string', description: 'What was tried (command, approach, code change)' },
              outcome:  { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Result' },
              details:  { type: 'string', description: 'Error message, output, or explanation' },
              topic:    { type: 'string', description: 'Optional topic key (auto-generated if omitted)' },
              severity: { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Severity (default: minor)' },
            },
            required: ['action', 'outcome'],
          },
        },
      },
      required: ['instance_id', 'observations'],
    },
  },
  {
    name: 'brain_who_knows',
    description:
      'Find who in your team has the most expertise on a given topic. ' +
      'Queries the org-wide knowledge graph (built automatically from learn_from_attempts author fields) ' +
      'and returns a ranked list of contributors whose lessons match the query, ordered by lesson count and confidence. ' +
      'Use to find the right person to ask before starting a task, or to understand knowledge distribution. ' +
      'Example: brain_who_knows(topic="kubernetes deployment") → "🥇 alice — 5 lessons, 94% confidence".',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:       { type: 'string', description: 'Topic or question to find experts for' },
        limit:       { type: 'number', description: 'Max number of experts to return (default: 10)' },
      },
      required: ['instance_id', 'topic'],
    },
  },
  {
    name: 'brain_file_map',
    description:
      'Show what cachly knows about a list of files — experts + related lessons per file. ' +
      'Call this before starting work on unfamiliar files, or in sync_file_changes to see what knowledge exists. ' +
      'For each file path: shows who has previously touched it (from learn_from_attempts author+file_paths) ' +
      'and which lessons reference it. ' +
      'Example: brain_file_map(file_paths=["src/auth/jwt.ts"]) → "🥇 alice (3× · today) — related: fix:jwt-expiry".',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to look up (max 10)',
        },
      },
      required: ['instance_id', 'file_paths'],
    },
  },
  {
    name: 'team_expertise_map',
    description:
      'Full team expertise overview — who knows what, at a glance. ' +
      'Returns a ranked table of all contributors with their lesson count, top domains, and last-active date. ' +
      'Use for onboarding (who to ask about X?), retrospectives, or to find knowledge gaps. ' +
      'Built automatically from learn_from_attempts(author=...) calls — no setup needed.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        top_n: { type: 'number', description: 'Max contributors to show (default: 20)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_collab_pairs',
    description:
      'Show the Person↔Person Collaboration Graph for your team (W5). ' +
      'Lists every pair of contributors who have worked together — either by touching the same files in learn_from_attempts ' +
      'or by recalling each other\'s lessons via smart_recall(requester=...). ' +
      'Each pair includes a "Frag @X und @Y" routing suggestion — ideal for onboarding and bus-factor analysis. ' +
      'Also flags solo contributors whose knowledge no teammate has yet recalled (bus-factor risk). ' +
      'Example: brain_collab_pairs() → "@alice ↔ @bob — 12 events · ask them together about auth/payments".',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        min_weight:  { type: 'number', description: 'Minimum collaboration events to show a pair (default: 1)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_portability',
    description:
      'Bring your own model, keep your brain: the same memory in every AI editor. ' +
      'Returns your Brain ID plus ready-to-paste MCP config snippets for every compatible AI client: ' +
      'Claude Code, Cursor, Windsurf, GitHub Copilot (VS Code), Cline, Zed, Continue. ' +
      'All 7 clients connect to the same Brain — same lessons, crystals, predictions, and team data. ' +
      'Use autopilot to configure all detected editors in one command. ' +
      'Example: brain_portability() → config blocks for 7 clients + model-neutrality proof table.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'skill_gaps',
    description:
      'Show knowledge blind spots in your Brain — domains with unresolved failures, ' +
      'lessons with missing attribution, and areas where brain_who_knows cannot help. ' +
      'Run periodically to find where to focus knowledge capture effort. ' +
      'Returns a prioritized list: 🔴 critical (failures with no solutions) → 🟡 warn → 🔵 info. ' +
      'Pairs with brain_coverage for a full knowledge-health picture.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the cache instance' },
        min_failures: { type: 'number', description: 'Min failure count to flag a domain as a gap (default: 1)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_coverage',
    description:
      'Knowledge-coverage health score for your codebase — scored 0-100. ' +
      'Reports: total lessons, success ratio, attribution completeness, team engagement, and file coverage vs git ls-files. ' +
      'Run after brain_from_git or periodically to track knowledge-capture progress. ' +
      'Use skill_gaps to find what to fix. ' +
      'Example: brain_coverage() → "🟢 Overall score: 78/100 · 42 lessons · 6 contributors · 31% files covered".',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        repo_path:   { type: 'string', description: 'Path to the git repository (default: current directory)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_metrics',
    description:
      'Report the three decisive Brain metrics: (1) time-to-first-recall (onboarding friction), ' +
      '(2) recall-lift vs. raw BM25 (the moat proof, from Cachly-Bench), and ' +
      '(3) team-knowledge-reuse — what % of proven recalls used a teammate\'s lesson. ' +
      'Use to track whether the Brain is delivering its core value. ' +
      'Pass author="handle" to smart_recall so cross-author reuse can be measured.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_changelog',
    description:
      'Generate a human-readable Markdown changelog of lessons learned in the last N days. ' +
      'Groups lessons by topic category, annotates with author, recall count and confidence. ' +
      'Ideal for weekly standups, sprint retros, or async team updates — share the output directly in Slack or a doc. ' +
      'Example: brain_changelog(instance_id="...", days=7) → grouped Markdown changelog of the week\'s learning.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        days: { type: 'number', description: 'How many days back to include (default: 7)' },
        max_lessons: { type: 'number', description: 'Maximum number of lessons to include (default: 30)' },
        include_failures: { type: 'boolean', description: 'Include failure-outcome lessons (default: true)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_service_map',
    description:
      'Map everything the Brain knows about a running service or system: who operates it, ' +
      'which files run in it, every known failure, and every proven fix. ' +
      'Built from lessons tagged with `service="..."` in learn_from_attempts. ' +
      'Ideal for incident triage — when a service is misbehaving (e.g. a restarting pod), ' +
      'instantly surface who knows it and what has gone wrong with it before. ' +
      'Example: brain_service_map(service="prometheus") → operators, known OOM failures, and the fixes that worked.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        service: { type: 'string', description: 'Name of the service/system to map (e.g. "prometheus", "cachly-web", "auth-service"). Matches the `service` tag on stored lessons.' },
      },
      required: ['instance_id', 'service'],
    },
  },
  {
    name: 'sync_file_changes',
    description:
      'Associate recent file changes with brain knowledge. ' +
      'Pass a list of changed file paths (from `git diff --stat`). ' +
      'Returns lessons relevant to those files, and records the file changes in session history. ' +
      'Call this after commits so the brain tracks what changed and why.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:   { type: 'string', description: 'UUID of the cache instance' },
        changed_files: { type: 'array', items: { type: 'string' }, description: 'List of changed file paths' },
        git_diff_stat: { type: 'string', description: 'Output of `git diff --stat` (optional)' },
        commit_msg:    { type: 'string', description: 'Commit message (optional)' },
      },
      required: ['instance_id', 'changed_files'],
    },
  },
  {
    name: 'team_learn',
    description:
      'Store a lesson in a shared team brain so all team members benefit. ' +
      'Like learn_from_attempts, but REQUIRES an author name for attribution. ' +
      'Shows up in team_recall with "by <author>" so the team knows who learned it.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the shared team brain instance' },
        author:       { type: 'string', description: 'Your name or handle (required for team attribution)' },
        topic:        { type: 'string', description: 'Topic in category:keyword format (e.g. "deploy:api")' },
        outcome:      { type: 'string', enum: ['success', 'failure', 'partial'], description: 'What happened' },
        what_worked:  { type: 'string', description: 'What worked (the solution)' },
        what_failed:  { type: 'string', description: 'What did NOT work (avoid this)' },
        severity:     { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Impact level' },
        file_paths:   { type: 'array', items: { type: 'string' }, description: 'Relevant file paths' },
        commands:     { type: 'array', items: { type: 'string' }, description: 'Commands that worked' },
        tags:         { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['instance_id', 'author', 'topic', 'outcome', 'what_worked'],
    },
  },
  {
    name: 'team_confirm',
    description:
      'Endorse (review-confirm) a team lesson so trusted, human-reviewed knowledge ranks above unreviewed auto-learned entries. ' +
      'A senior review weighs more than a peer review; distinct endorsements add a small boost. ' +
      'Confirmed lessons surface higher in smart_recall and team_recall and carry a 🛡️/✔️ badge. ' +
      'Use this in code review or knowledge reviews to bless the canonical solution for a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        topic:       { type: 'string', description: 'Topic slug of the lesson to confirm (e.g. "deploy:api")' },
        reviewer:    { type: 'string', description: 'Your name or handle (the reviewer endorsing this lesson)' },
        level:       { type: 'string', enum: ['senior', 'peer'], description: 'Review weight — "senior" ranks higher than "peer" (default: peer)' },
        note:        { type: 'string', description: 'Optional review note (kept in the lesson audit trail)' },
      },
      required: ['instance_id', 'topic', 'reviewer'],
    },
  },
  {
    name: 'team_assign_role',
    description:
      'Assign a role (admin | reviewer | contributor | viewer) to a team member on a shared brain instance. ' +
      'Roles control what each person can do: admin can manage roles and delete lessons; reviewer can senior-review ' +
      '(🛡️ badge, stronger recall boost); contributor can store lessons and peer-review (✔️ badge); viewer is read-only. ' +
      'First call bootstraps governance (no auth required when no admins exist yet). ' +
      'After that, only an admin can assign or change roles. ' +
      'Example: team_assign_role(handle="alice", role="reviewer", assigned_by="bob") — bob must be an admin.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the shared team brain instance' },
        handle:       { type: 'string', description: 'Handle or name of the team member to assign a role to' },
        role: {
          type: 'string',
          enum: ['admin', 'reviewer', 'contributor', 'viewer'],
          description: 'Role to assign. admin: manage roles + all actions. reviewer: senior-review (🛡️). contributor: store + peer-review. viewer: read-only.',
        },
        assigned_by:  { type: 'string', description: 'Handle of the admin performing the assignment (required after governance bootstrap)' },
      },
      required: ['instance_id', 'handle', 'role'],
    },
  },
  {
    name: 'team_whoami',
    description:
      'Show your own role and capabilities on a shared brain instance. ' +
      'Tells you what you can do (store, review, manage roles) and who to contact if you need a higher role. ' +
      'Run this after onboarding to confirm your role was set correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        handle:      { type: 'string', description: 'Your handle or name' },
      },
      required: ['instance_id', 'handle'],
    },
  },
  {
    name: 'team_roster',
    description:
      'Show all team members and their assigned roles on a shared brain instance. ' +
      'Returns a table of handles, roles (👑 admin · 🛡️ reviewer · ✏️ contributor · 👁️ viewer), and capabilities. ' +
      'Use during onboarding to see who can do what, or to verify role assignments.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'team_audit',
    description:
      'View the governance audit log for a shared brain — an immutable trail of who changed roles and who confirmed which lessons, with timestamps. ' +
      'Essential for enterprise compliance and security reviews. ' +
      'Admin-only once governance is active (an admin has been assigned). ' +
      'Events are recorded automatically on team_assign_role and team_confirm — no setup. ' +
      'Example: team_audit(requester="alice") → "👑 role: bob set carol viewer → contributor · ✅ confirm: dave confirmed auth:jwt-skew (senior)".',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        requester:   { type: 'string', description: 'Your handle — must be an admin once governance is active' },
        limit:       { type: 'number', description: 'Max events to show, newest first (default: 50, max: 200)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'team_grant_scope',
    description:
      'Add or remove a team member to/from a named group (sub-team) on a shared brain. ' +
      'Group-scoped lessons (stored with group="...") only surface in smart_recall for members of that group (and admins). ' +
      'This is team-level visibility, orthogonal to lesson-level private. ' +
      'Admin-gated after the role model is bootstrapped. ' +
      'Example: team_grant_scope(handle="alice", group="security", assigned_by="bob") — bob must be admin.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        handle:      { type: 'string', description: 'Handle of the team member to add/remove' },
        group:       { type: 'string', description: 'Group/sub-team name (e.g. "backend", "security", "platform")' },
        action:      { type: 'string', enum: ['add', 'remove'], description: 'add (default) or remove the member from the group' },
        assigned_by: { type: 'string', description: 'Handle of the admin performing the change (required after governance bootstrap)' },
      },
      required: ['instance_id', 'handle', 'group'],
    },
  },
  {
    name: 'team_scopes',
    description:
      'List team groups and their members, or the groups a specific person belongs to. ' +
      'Pass handle to see one person\'s scopes; omit it to see all groups on the instance. ' +
      'Use to audit who can see group-scoped lessons.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        handle:      { type: 'string', description: 'Optional — show only this person\'s group memberships' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'team_recall',
    description:
      'Recall lessons from a shared team brain, showing who learned what. ' +
      'Works on any shared instance (all team members using the same instance_id). ' +
      'Shows author, recency, and severity for each lesson. ' +
      'Use this to onboard new team members or find who knows about a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        topic:       { type: 'string', description: 'Topic or keyword to filter lessons (optional)' },
        author:      { type: 'string', description: 'Filter by author name (optional)' },
        limit:       { type: 'number', description: 'Max lessons to return (default: 10)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'team_synthesize',
    description:
      'Team Brain Synthesis — merge multiple contributors\' lessons on the same topic into one canonical version. ' +
      'When 2+ developers store lessons for the same topic with different details, this proposes the best merged version. ' +
      'Shows: all contributions by author, what worked (consensus), what failed (union), canonical lesson to store. ' +
      'Use this when onboarding new team members or before documenting a process.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        topic:       { type: 'string', description: 'Topic slug to synthesize (e.g. "deploy:api")' },
      },
      required: ['instance_id', 'topic'],
    },
  },
  {
    name: 'memory_crystalize',
    description:
      'Compress the last 30-50 sessions and auto-learned lessons into a dense Memory Crystal. ' +
      'A crystal is a compact, structured summary of everything the brain learned — grouped by category (deploy, fix, debug, …). ' +
      'Crystals survive session cleanup and appear in session_start once enough sessions have accumulated. ' +
      'Run this monthly or after a big milestone to preserve institutional knowledge. ' +
      'Returns a digest of what was crystallized.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        label: {
          type: 'string',
          description: 'Optional label for this crystal (e.g. "Q1 2026", "v2 launch"). Auto-generated from date if omitted.',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'team_crystallize',
    description:
      'Create a Team Crystal — the team-wide, causal counterpart to memory_crystalize. ' +
      'Where memory_crystalize compresses ONE brain by category, team_crystallize surfaces what a per-user ' +
      'memory structurally cannot: which fixes solved structurally SIMILAR problems across MULTIPLE people. ' +
      'A pattern only crystallizes when 2+ distinct authors independently converged on it — that cross-person ' +
      'signal is the moat against single-user "Dreaming"-style memory. ' +
      'Needs attributed lessons (learn_from_attempts(author=...) / team_learn). Surfaces in crystal_view. ' +
      'Example: team_crystallize() → "🧩 pool — 3 people converged (alice, bob, carol): bounded pool + timeout".',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        min_authors: { type: 'number', description: 'Min distinct authors that must converge for a pattern to crystallize (default: 2, min: 2)' },
        label:       { type: 'string', description: 'Optional label (e.g. "Q1 2026"). Auto-generated from date if omitted.' },
      },
      required: ['instance_id'],
    },
  },
  // ── Roadmap — Persistent project plan tracker ───────────────────────────
  {
    name: 'roadmap_add',
    description:
      'Add a new item to the persistent project roadmap stored in the Brain. ' +
      'Items survive across sessions and editors — the roadmap is always up to date. ' +
      'Use for features, bugs, refactors, or any planned work. ' +
      'Call roadmap_list to see all open items, roadmap_next to get the next actionable item.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        title: { type: 'string', description: 'Short title of the task/feature (3–10 words)' },
        description: { type: 'string', description: 'What needs to be done, acceptance criteria, context' },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Priority level (default: medium)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for filtering (e.g. ["api", "web", "sdk", "infra"])',
        },
        milestone: { type: 'string', description: 'Milestone/epic this belongs to (optional)' },
      },
      required: ['instance_id', 'title'],
    },
  },
  {
    name: 'roadmap_update',
    description:
      'Update the status, priority, or details of a roadmap item. ' +
      'Use to move items through the lifecycle: planned → in-progress → done (or blocked/cancelled). ' +
      'Also use to add notes/findings while working on an item.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        id: { type: 'string', description: 'Item ID returned by roadmap_add or roadmap_list' },
        status: {
          type: 'string',
          enum: ['planned', 'in-progress', 'done', 'blocked', 'cancelled'],
          description: 'New status for the item',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Updated priority (optional)',
        },
        notes: { type: 'string', description: 'Progress notes, findings, or blockers (appended to existing notes)' },
        title: { type: 'string', description: 'Updated title (optional)' },
        description: { type: 'string', description: 'Updated description (optional)' },
      },
      required: ['instance_id', 'id'],
    },
  },
  {
    name: 'roadmap_list',
    description:
      'List all roadmap items, optionally filtered by status, priority, tag, or milestone. ' +
      'Returns items sorted by priority then creation date. ' +
      'Called automatically by session_start to show open work.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        status: {
          type: 'string',
          enum: ['planned', 'in-progress', 'done', 'blocked', 'cancelled', 'open'],
          description: 'Filter by status. Use \'open\' to see planned+in-progress+blocked (default: open)',
        },
        tag: { type: 'string', description: 'Filter by tag (optional)' },
        milestone: { type: 'string', description: 'Filter by milestone (optional)' },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Filter by minimum priority (optional)',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'roadmap_next',
    description:
      'Get the single most important next actionable roadmap item. ' +
      'Returns the highest-priority in-progress item first, then planned items, sorted by priority. ' +
      'Call at session start to immediately know what to work on next.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        tag: { type: 'string', description: 'Filter by tag (optional)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_doctor',
    description:
      'Check the health of your AI Brain and get actionable recommendations. ' +
      'Reports: lesson count, context entries, last session age, open failures, quality score, effective IQ boost, stale index. ' +
      'Returns a prioritized list of issues with fix instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        workspace_path: {
          type: 'string',
          description: 'Absolute path to workspace root — enables package.json analysis for openclaw cross-promo (optional)',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_hygiene',
    description:
      'Autonomously sweep and maintain your Brain — flags stale lessons as provisional, archives long-dormant ones, ' +
      'and resolves contradictions where success clearly dominates failure. ' +
      'Safe to run on a schedule (weekly CI job) or on-demand before a big release. ' +
      'Lesson state lifecycle: active → provisional (confidence < threshold) → archived (stale + low-recall + old). ' +
      'Archived lessons are excluded from smart_recall but preserved for audit. ' +
      'dry_run=true (default false) shows what would change without writing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'UUID of the cache instance',
        },
        dry_run: {
          type: 'boolean',
          description: 'Report changes without applying them (default false)',
        },
        provisional_threshold: {
          type: 'number',
          description: 'Confidence below which a lesson is flagged provisional (default 0.5)',
        },
        archive_days: {
          type: 'number',
          description: 'Days after which a provisional low-recall lesson is archived (default 30)',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'global_learn',
    description:
      'Store a lesson that applies across ALL your projects (cross-project knowledge). ' +
      'Idempotent: if a lesson with the same topic already exists, it is updated in place — no duplicates are created. ' +
      'Returns a confirmation with the stored lesson key. No rate limits. ' +
      'Global lessons are stored with the prefix cachly:global:lesson: and recalled from any instance via global_recall. ' +
      'Use for tool preferences, personal workflows, platform quirks, and universal gotchas. ' +
      'Example: global_learn(topic="bash:macos-arrays", lesson="Arrays work differently on macOS bash 3.2"). ' +
      'Use learn_from_attempts for project-specific session lessons; use team_learn to share lessons with your team.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (used for connection)' },
        topic:       { type: 'string', description: 'Topic key in format "category:keyword"' },
        lesson:      { type: 'string', description: 'The lesson content' },
        severity:    { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Severity (default: minor)' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['instance_id', 'topic', 'lesson'],
    },
  },
  {
    name: 'global_recall',
    description:
      'Read-only retrieval of cross-project lessons stored via global_learn. No side effects. ' +
      'Returns a list of matching global lesson objects, each with topic, lesson text, severity, and tags. ' +
      'If no topic is provided, returns all global lessons (up to 50). ' +
      'If topic is provided, returns all lessons whose topic key contains that string (partial match). ' +
      'Use this for lessons that apply universally across all projects (tool quirks, shell gotchas, platform behavior). ' +
      'Use recall_best_solution instead for project-specific lessons; use team_recall for org-scoped lessons.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (used for connection)' },
        topic:       { type: 'string', description: 'Topic or keyword filter (optional)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'publish_lesson',
    description:
      'Publish a lesson to the Cachly Public Brain (anonymized community knowledge base). ' +
      'Published lessons can be imported by other developers via import_public_brain. ' +
      'PII is stripped automatically. Visible under the framework/category tag. ' +
      'Returns { lesson_id, topic, framework, published_at } confirming the publish. ' +
      'Irreversible — once published to the public brain, lessons cannot be deleted via the MCP interface. ' +
      'Use learn_from_attempts or global_learn for private lessons; ' +
      'use syndicate for anonymized global sharing without framework tagging.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:       { type: 'string', description: 'Topic key (used as public category)' },
        lesson:      { type: 'string', description: 'Lesson to publish (PII will be stripped)' },
        framework:   { type: 'string', description: 'Framework/platform tag (nextjs, fastapi, go, docker, etc.)' },
        severity:    { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Severity' },
      },
      required: ['instance_id', 'topic', 'lesson'],
    },
  },
  {
    name: 'import_public_brain',
    description:
      'Import community lessons from the Cachly Public Brain for a framework. ' +
      'Non-destructive: existing lessons with the same topic key are not overwritten. ' +
      'Returns the count of lessons imported and their topic slugs. ' +
      'Available frameworks: nextjs, fastapi, go, docker, kubernetes, react, typescript, python, rust, laravel, rails, spring. ' +
      'Use this to bootstrap a new brain with battle-tested community knowledge before your first session_start. ' +
      'Use publish_lesson to contribute your own lessons to the Public Brain; ' +
      'use learn_from_attempts for storing lessons from your own sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance to import into' },
        framework:   { type: 'string', description: 'Framework/platform to import lessons for' },
        limit:       { type: 'number', description: 'Max lessons to import (default: 20)' },
      },
      required: ['instance_id', 'framework'],
    },
  },
  // ── Brain Archaeology + Causal Chain ────────────────────────────────────
  {
    name: 'recall_at',
    description:
      'Brain Archaeology — see what a lesson looked like at a specific point in time. ' +
      '"What did we know about deployments 3 months ago?" ' +
      'Returns the history of a topic filtered to entries before the given date. ' +
      'Shows how the lesson evolved: failure → partial → success. ' +
      'Also useful to understand WHY old code decisions were made.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:       { type: 'string', description: 'Topic slug to look up, e.g. "deploy:api"' },
        date:        { type: 'string', description: 'ISO date string (e.g. "2026-01-15") — returns entries stored BEFORE this date' },
      },
      required: ['instance_id', 'topic', 'date'],
    },
  },
  {
    name: 'trace_dependency',
    description:
      'Causal Chain — find all lessons that depend on a given prerequisite. ' +
      '"What lessons are affected if node version changes?" ' +
      'When a dependency changes (new version, different provider, new OS), call this to see which lessons need review. ' +
      'Lessons store dependencies via the depends_on field in learn_from_attempts.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        dependency:  { type: 'string', description: 'Dependency to trace (e.g. "node:>=20", "docker:running", "wireguard:active")' },
        mark_review: { type: 'boolean', description: 'If true, marks all dependent lessons as needs_review (default: false)' },
      },
      required: ['instance_id', 'dependency'],
    },
  },
  // ── Team / Org Management ────────────────────────────────────────────────
  {
    name: 'list_orgs',
    description:
      'List your Cachly organizations (team/org plans). ' +
      'Returns each org with plan, seat count, and member info. ' +
      'Org plans (Team €99, Business €299, Enterprise custom) are billed separately from cache tiers.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_org',
    description:
      'Create a new Cachly organization for team collaboration. ' +
      'After creation, invite team members with invite_member and upgrade the plan via the billing portal. ' +
      'Org plans: Team (€99/mo, 10 seats), Business (€299/mo, 50 seats), Enterprise (custom).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Organization display name (e.g. "Acme Engineering")' },
        slug: { type: 'string', description: 'URL-safe slug (e.g. "acme-eng"). Auto-generated from name if omitted.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'invite_member',
    description:
      'MUTATION — sends an invite email immediately and cannot be undone via MCP. ' +
      'Invite a team member to a Cachly organization by email. ' +
      'Requires the caller to be an admin or owner of the organization. ' +
      'Valid roles: admin (manage members + instances), member (read + cache ops). Default role: member. ' +
      'Returns an error if the email is already a member or has a pending invite.',
    // NOTE: schema intentionally omits 'owner' — owners can only be set via the billing portal.
    inputSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'UUID of the organization' },
        email:  { type: 'string', description: 'Email address to invite' },
        role:   { type: 'string', enum: ['admin', 'member'], description: 'Role for the invited member (default: member)' },
      },
      required: ['org_id', 'email'],
    },
  },
  {
    name: 'get_org_plan',
    description:
      'Get the current org plan, seat usage, and billing info for an organization. ' +
      'Shows: plan name, price, seats used/max, next billing date. ' +
      'To upgrade: use the billing portal URL returned by this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'UUID of the organization' },
      },
      required: ['org_id'],
    },
  },
  // ── Legacy / Setup ────────────────────────────────────────────────────────
  {
    name: 'setup_ai_memory',
    description:
      'One-shot setup of the cachly 3-layer AI Memory system for a project.\n\n' +
      'Layer 1 — Storage: your cachly instance (Valkey, persistent across sessions)\n' +
      'Layer 2 — Tools: learn_from_attempts + recall_best_solution + smart_recall (the memory API)\n' +
      'Layer 3 — Autopilot: generates a copilot-instructions.md / .github/copilot-instructions.md\n' +
      '  that instructs any MCP-compatible AI to recall known solutions BEFORE each task\n' +
      '  and save lessons AFTER — fully automatic, zero manual effort.\n\n' +
      'Returns the copilot-instructions.md content + provider-specific .mcp.json snippet.\n' +
      'Optionally writes copilot-instructions.md directly to the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'UUID of the cachly instance to use as the AI brain',
        },
        project_dir: {
          type: 'string',
          description:
            'Absolute path to the project root. If provided, writes copilot-instructions.md ' +
            'to .github/copilot-instructions.md in that directory.',
        },
        embed_provider: {
          type: 'string',
          enum: ['openai', 'mistral', 'cohere', 'ollama', 'gemini'],
          description:
            'Embedding provider to use for smart_recall / semantic search. ' +
            'Default: openai. Use ollama for fully local/free setup.',
        },
        project_description: {
          type: 'string',
          description: 'Short description of the project (used in the generated instructions)',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'cache_stream_set',
    description:
      'Cache a list of string chunks (e.g. LLM token stream) via Redis RPUSH. ' +
      'Each chunk is stored as a separate list element under cachly:stream:{key}. ' +
      'Replay with cache_stream_get.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string',  description: 'UUID of the cache instance' },
        key:         { type: 'string',  description: 'Cache key' },
        chunks:      { type: 'array', items: { type: 'string' }, description: 'Ordered list of string chunks' },
        ttl:         { type: 'number',  description: 'TTL in seconds for the stored list (optional)' },
      },
      required: ['instance_id', 'key', 'chunks'],
    },
  },
  {
    name: 'cache_stream_get',
    description:
      'Retrieve a previously cached stream as an ordered list of string chunks. ' +
      'Returns null on cache miss (key absent or empty list). ' +
      'Stored under cachly:stream:{key}.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key:         { type: 'string', description: 'Cache key' },
      },
      required: ['instance_id', 'key'],
    },
  },
  {
    name: 'cache_org_stats',
    description:
      'Show shared cache statistics for an org namespace. ' +
      'Scans all keys under org:{org_id}:sem:* and reports how many entries are shared. ' +
      'Use this to verify org-sharing is working and to monitor cross-instance cache utilization. ' +
      'Also aggregates org-wide ROI via the Cachly API: total cache hits, hits in the last 24h, ' +
      'estimated total and projected monthly USD savings across all org instances, plus a per-instance breakdown. ' +
      'Zero-config: no API changes required — any cache_set call with org_id writes to this namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        org_id: { type: 'string', description: 'Org ID to inspect (e.g. "acme", "my-company")' },
      },
      required: ['instance_id', 'org_id'],
    },
  },

  {
    name: 'set_cost_per_call',
    description:
      'Set the assumed cost per avoided LLM API call (USD) for this instance. ' +
      'This is used to compute accurate ROI savings estimates in cache_stats. ' +
      'The default ($0.002) is calibrated for a small model (gpt-5.5-mini class). ' +
      'Set your actual model cost for accurate numbers: ' +
      'claude-opus-4.8 → $0.02, gpt-5.5 → $0.015, claude-sonnet-4.6 → $0.009, claude-haiku-4.5 → $0.001. ' +
      'After updating, cache_stats will show savings computed from your real cost. ' +
      'Use list_instances to find your instance_id.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        cost_per_call_usd: {
          type: 'number',
          description: 'Cost per LLM API call in USD. Common values: 0.02 (claude-opus-4.8), 0.015 (gpt-5.5), 0.009 (claude-sonnet-4.6), 0.002 (gpt-5.5-mini), 0.001 (claude-haiku-4.5).',
        },
      },
      required: ['instance_id', 'cost_per_call_usd'],
    },
  },

  // ── v0.6 Cognitive Cache Tools ────────────────────────────────────────────
  {
    name: 'memory_consolidate',
    description:
      'Cognitive memory consolidation — the weekly garbage collector for your AI Brain. ' +
      'Scans all lessons, detects contradictions (same topic with conflicting outcomes), ' +
      'merges duplicates, flags stale entries (not recalled in 90+ days), and computes a ' +
      'health score. Returns a full consolidation report with conflicts resolved, ' +
      'duplicates merged, and a before/after count. ' +
      'Run weekly or when brain_doctor reports > 20 lessons. ' +
      'Like git gc for knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:   { type: 'string', description: 'UUID of the cache instance' },
        dry_run:       { type: 'boolean', description: 'If true, report what would change without writing (default: false)' },
        stale_days:    { type: 'number',  description: 'Lessons not recalled in this many days are flagged stale (default: 90)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_diff',
    description:
      'git log for your AI Brain — see exactly what changed since a point in time. ' +
      'Returns a structured changelog: new lessons added, lessons updated (outcome changed), ' +
      'lessons recalled (hit count increased), and lessons that decayed. ' +
      'Perfect for weekly reviews: "What did my AI learn this week?" ' +
      'Example: brain_diff(instance_id="...", since="7d") → "12 new · 4 updated · 2 stale"',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        since:       { type: 'string', description: 'Time window: "1d", "7d", "30d", or ISO-8601 date (default: "7d")' },
        format:      { type: 'string', enum: ['summary', 'detailed'], description: 'Output format (default: summary)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'causal_trace',
    description:
      'Root Cause Analysis through memory: given a problem description, traces the causal chain ' +
      'from root cause through intermediate failures to the current symptom, then surfaces the ' +
      'exact solution that worked before. Read-only — does not modify any stored data. ' +
      'Requires prior learning: brain must have lessons stored via learn_from_attempts or brain_from_git. ' +
      'Returns an ordered chain of concepts with confidence scores plus the matching solution; ' +
      'returns an empty chain with a message if no causal path is found. ' +
      'Example: causal_trace(problem="auth breaks after restart") → ' +
      '"Root: k8s:namespace-terminating → keycloak:jwks-race → Solution: PollUntilContextTimeout 3min". ' +
      'Use recall_best_solution for direct topic lookup, syndicate_search for community patterns, ' +
      'and causal_trace when you have a symptom and need the full root-cause chain.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        problem:     { type: 'string', description: 'Describe the problem or error you are seeing right now' },
        max_depth:   { type: 'number', description: 'Max causal chain depth to trace (default: 5)' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Optional: narrow search to these tags' },
      },
      required: ['instance_id', 'problem'],
    },
  },
  {
    name: 'knowledge_decay',
    description:
      'Confidence scoring for every lesson in your Brain — because old knowledge rots. ' +
      'Computes a decay score (0–100%) per lesson based on age, recall frequency, and outcome. ' +
      'Lessons recalled recently score high. Lessons from 90 days ago never recalled score low. ' +
      'Returns a ranked list with visual confidence bars: "████░░░░ 40%". ' +
      'Use this before a big refactor to know which lessons to trust and which to re-validate.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the cache instance' },
        min_age_days: { type: 'number', description: 'Only include lessons older than N days (default: 0 = all)' },
        show_top:     { type: 'number', description: 'Number of entries to return, sorted by lowest confidence first (default: 20)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'autopilot',
    description:
      'Generate a CLAUDE.md / copilot-instructions.md that makes any AI self-managing forever. ' +
      'Writes a configuration file to disk — will overwrite an existing file at the target path. ' +
      'No auth required beyond a valid instance_id. ' +
      'The generated file instructs Claude, Cursor, Copilot, Windsurf, or Gemini to automatically ' +
      'call session_start at window open, learn_from_attempts after every fix, and session_end ' +
      'before closing — without being asked. ' +
      'Returns the generated file content as a string and the path where it was written. ' +
      'Use style="minimal" for just the three hooks; style="full" for the complete ruleset with examples. ' +
      'One command. Every AI. Always on. ' +
      'Use setup_ai_memory instead if you want an interactive one-shot setup that also creates an instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the cache instance' },
        editor:       { type: 'string', enum: ['claude', 'cursor', 'copilot', 'windsurf', 'gemini', 'continue', 'all'], description: 'Target editor (default: claude)' },
        project_name: { type: 'string', description: 'Your project name (used in generated instructions)' },
        style:        { type: 'string', enum: ['minimal', 'full'], description: 'minimal = just the hooks, full = full ruleset with examples (default: full)' },
      },
      required: ['instance_id'],
    },
  },
  // ── v0.7 Knowledge Syndication ────────────────────────────────────────────
  {
    name: 'syndicate',
    description:
      'Contribute a verified lesson to the GLOBAL Cachly Knowledge Commons — ' +
      'a privacy-preserving shared brain where every AI instance can learn from the discoveries ' +
      'of every other. Your contributor identity is a one-way HMAC hash: completely anonymous. ' +
      'The lesson is immediately searchable by any other AI using syndicate_search. ' +
      'This is how individual knowledge becomes collective intelligence. ' +
      'Call this AFTER every learn_from_attempts that is worth sharing universally ' +
      '(critical bugs, deployment gotchas, architecture discoveries). ' +
      'If a lesson with the same topic already exists in the commons, it is updated in place (idempotent). ' +
      'Returns { key, confirm_count, scope } confirming the stored lesson. ' +
      'Use scope="org" to keep the lesson private to your organisation. ' +
      'Do NOT use for secrets or PII — content is stored in a shared knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        topic:       { type: 'string', description: 'Topic key in category:keyword format (e.g. "fix:clickhouse-ipv6", "deploy:docker-compose")' },
        outcome:     { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Result of the attempt (default: success)' },
        what_worked: { type: 'string', description: 'Exact approach, command, or fix that worked. File paths are stripped automatically.' },
        what_failed: { type: 'string', description: 'What failed or was wrong — helps others avoid the same trap.' },
        severity:    { type: 'string', enum: ['critical', 'major', 'minor'], description: 'How severe the issue was (default: minor)' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Up to 10 keywords for better discoverability' },
        scope:       { type: 'string', enum: ['public', 'org'], description: 'Visibility: "public" = global commons (default), "org" = private to your org only' },
      },
      required: ['topic', 'what_worked'],
    },
  },
  {
    name: 'syndicate_search',
    description:
      'Search the GLOBAL Cachly Knowledge Commons for solutions contributed by the entire community. ' +
      'Returns lessons ranked by confirm_count (trust score) then recency. ' +
      'Use this BEFORE debugging any unknown issue — someone in the global brain likely solved it already. ' +
      'Example: syndicate_search(q="clickhouse localhost connection refused") → ' +
      '"fix: use 127.0.0.1 not localhost when IPv6 is disabled · confirmed by 47 instances"',
    inputSchema: {
      type: 'object',
      properties: {
        q:        { type: 'string', description: 'Free-text search query (leave empty for most recent lessons)' },
        category: { type: 'string', description: 'Filter by category prefix: "fix", "deploy", "debug", "infra", "api", "web"' },
        scope:    { type: 'string', enum: ['public', 'org'], description: '"public" = global commons (default), "org" = public + your org-private lessons' },
        limit:    { type: 'number', description: 'Max results to return (default: 20, max: 50)' },
      },
      required: [],
    },
  },
  {
    name: 'syndicate_stats',
    description:
      'Show the health of the global Knowledge Commons: total lessons, total confirms, ' +
      'top categories, most-trusted lessons, growth in the last 7 days, and top contributors (anonymous scores). ' +
      'Use for weekly reviews or to explore what the community knows.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'syndicate_trending',
    description:
      'Show the TRENDING lessons in the global Knowledge Commons — those with the fastest confirmation velocity ' +
      'in the last 7 days (confirm_count / age_in_days). ' +
      'Use this at the start of a session or weekly review to see what the community is actively validating. ' +
      'Lessons need at least 2 independent confirms to appear here.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 10, max: 50)' },
      },
      required: [],
    },
  },
  {
    name: 'brain_marketplace',
    description:
      'Browse the Domain Brain marketplace — curated, installable packs of high-trust community lessons, ' +
      'grouped by domain (Kubernetes, Auth, Database, React, Payments, …). ' +
      'Each brain is built from verified, community-confirmed lessons in the global Knowledge Commons. ' +
      'Use at onboarding or when starting work in an unfamiliar domain to bootstrap your Brain instantly. ' +
      'Install one with brain_install(slug="..."). ' +
      'Example: brain_marketplace() → "☸️ Kubernetes Incident Brain · 42 lessons · install: brain_install(slug=\\"k8s\\")".',
    inputSchema: {
      type: 'object',
      properties: {
        min_confirms: { type: 'number', description: 'Only count lessons with at least this many community confirmations (default: 1)' },
      },
      required: [],
    },
  },
  {
    name: 'brain_install',
    description:
      'Install a Domain Brain into your local Brain — pulls its curated, high-trust lessons so they surface in ' +
      'smart_recall immediately, even offline. Idempotent and non-destructive: it NEVER overrides your own lessons ' +
      '(only prior installs of the same brain). Re-run anytime to pull updates. ' +
      'Browse available brains first with brain_marketplace(). ' +
      'Example: brain_install(slug="k8s") → "📦 Installed: Kubernetes Incident Brain · 42 lessons merged".',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the cache instance' },
        slug:         { type: 'string', description: 'Domain brain slug from brain_marketplace (e.g. "k8s", "auth", "db")' },
        min_confirms: { type: 'number', description: 'Only install lessons with at least this many community confirmations (default: 1)' },
        limit:        { type: 'number', description: 'Max lessons to install (default: 200, max: 500)' },
        dry_run:      { type: 'boolean', description: 'Preview what would be installed without writing anything (default: false)' },
      },
      required: ['instance_id', 'slug'],
    },
  },
  // ── Layer 1: Causal Knowledge Graph ────────────────────────────────────────
  {
    name: 'brain_search',
    description:
      'BM25+ full-text search over ALL brain data: lessons, context entries, session history, CKG nodes, roadmap items. ' +
      'Unlike smart_recall (which focuses on lessons + context), brain_search casts a wider net. ' +
      'Use when smart_recall returns nothing or when you want to find anything the brain knows about a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', description: 'Max results (default: 15)' },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'ckg_inspect',
    description:
      'Inspect the Causal Knowledge Graph (CKG) for a concept. Shows all typed edges (fixes, requires, co-occurs, causes) ' +
      'with Bayesian confidence scores. Use to understand what the brain knows about a topic and which fixes have the ' +
      'highest confidence. Also shows related concepts via graph traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        concept: { type: 'string', description: 'Concept to inspect, e.g. "fix:clickhouse-ipv6" or "docker"' },
        max_hops: { type: 'number', description: 'Traversal depth (default: 2)' },
      },
      required: ['instance_id', 'concept'],
    },
  },
  {
    name: 'brain_predict',
    description:
      'READ-ONLY — no side effects, no writes, no external network calls. ' +
      'Predictive Pre-fetch Engine (PPE): given your current context, reads the CKG in your Redis instance ' +
      'to predict likely failures and return the highest-confidence fixes. ' +
      '"Pre-load" means results are returned inline — nothing is cached or persisted. ' +
      'Requires a valid instance_id (your Redis brain). No rate limits. ' +
      'Call at session start when working on a specific feature or debugging area. ' +
      'Set scope="org" to widen prediction across your whole organisation — surfaces ' +
      'cross-team risks ("failed 3× across 2 other teams") from the Org Knowledge Graph, ' +
      'so an incident in one team becomes a vaccine for yours.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        context: { type: 'string', description: 'What you\'re working on, e.g. "upgrading Keycloak from 21 to 24"' },
        top_k: { type: 'number', description: 'Max predictions to return (default: 5)' },
        scope: {
          type: 'string',
          enum: ['instance', 'org', 'org+commons'],
          description:
            'Scope: "instance" (default) = this brain, "org" = warnings from failures in other teams of ' +
            'your organisation, "org+commons" = plus public lessons. Falls back to "instance" without an org.',
        },
      },
      required: ['instance_id', 'context'],
    },
  },
  {
    name: 'brain_plan',
    description:
      'READ-ONLY — no side effects, no writes, no external network calls. ' +
      'Generative planning layer on top of the CKG: given a task you are ABOUT to do ' +
      '(e.g. "upgrade Postgres 14→16", "add Stripe webhooks"), returns an ordered action ' +
      'plan grounded in your own proven lessons — the failure modes most likely to bite ' +
      '(ranked by confidence), the concrete steps that fixed them before (with commands), ' +
      'and a pre-flight checklist. Where brain_predict answers "what might fail?", ' +
      'brain_plan answers "what should I do, in what order?". ' +
      'Requires a valid instance_id (your Redis brain). Call before starting non-trivial work.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        task: { type: 'string', description: 'The change you are about to make, e.g. "migrate auth from sessions to JWT"' },
        top_k: { type: 'number', description: 'Max items per section (default: 5)' },
      },
      required: ['instance_id', 'task'],
    },
  },
  {
    name: 'brain_conflicts',
    description:
      'READ-ONLY — list every unresolved belief_conflict (a previously confirmed fix now contradicted by a failure) ' +
      'plus the agents currently writing to this Brain (last 1h). This is the arbitration inbox for multi-agent teams: ' +
      'when several AI sessions share one Brain, contradictory writes surface here instead of silently overwriting each other. ' +
      'Resolve any listed conflict with brain_resolve_conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_resolve_conflict',
    description:
      'Arbitrate a contested topic by picking the winning side. winner="success" reaffirms the fix (the contradicting ' +
      'failure stops blocking recall); winner="failure" retires the fix (its CKG fixes-edges decay to ~0 and the losing ' +
      'lesson is archived). Human-in-the-loop resolution is the strongest possible confidence signal. ' +
      'List open conflicts first with brain_conflicts.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        topic: { type: 'string', description: 'The contested topic, e.g. "fix:jwks-rotation"' },
        winner: { type: 'string', enum: ['success', 'failure'], description: 'Which side wins the arbitration' },
        resolved_by: { type: 'string', description: 'Who resolved it (agent name or "human"); default "human"' },
      },
      required: ['instance_id', 'topic', 'winner'],
    },
  },
  // ── v4 Move 1: Closed-loop CI learning ───────────────────────────────────
  {
    name: 'brain_confirm_ci',
    description:
      'Close the CI feedback loop: tell the Brain whether a CI job passed or failed and which topics ' +
      'it covered. The Brain adjusts lesson confidence automatically — confirmed failures get +15%, ' +
      'false positives (brain predicted failure but CI passed) get −10%. ' +
      'Called automatically by cachly-action at the end of every pipeline. ' +
      'Also use manually after a deploy to confirm or refute the brain\'s last prediction.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        job_status: { type: 'string', enum: ['success', 'failure', 'cancelled'], description: 'Outcome of the CI job' },
        topics: {
          type: 'array', items: { type: 'string' },
          description: 'Topics touched by this CI run (e.g. ["auth:jwt", "deploy:k8s"])',
        },
        scan_topics: {
          type: 'array', items: { type: 'string' },
          description: 'Topics the brain predicted would fail (from the scan response). Used to detect false positives.',
        },
        source: { type: 'string', description: 'Optional: "github_actions", "gitlab_ci", etc.' },
      },
      required: ['instance_id', 'job_status', 'topics'],
    },
  },
  // ── v4 Move 2: Proactive briefing ─────────────────────────────────────────
  {
    name: 'brain_briefing',
    description:
      'Push-based Brain warning: instead of waiting for you to ask, the Brain proactively checks ' +
      'whether the file you just opened, the PR you are about to raise, or the deploy you are about ' +
      'to run matches any known failure pattern — and surfaces warnings BEFORE something breaks. ' +
      'Call this on file_open (with the file path as context), pr_open (with the PR title/body), ' +
      'or deploy (with a short description of what is being deployed). ' +
      'Returns a risk_level (low/medium/high) plus up to 5 ranked warnings with confidence and a known fix.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        event_type: {
          type: 'string', enum: ['file_open', 'pr_open', 'deploy', 'manual'],
          description: 'What triggered this briefing — determines how the context is interpreted',
        },
        context: {
          type: 'string',
          description: 'The event context: file path for file_open, title+body for pr_open, short description for deploy/manual',
        },
        threshold: {
          type: 'number',
          description: 'Minimum confidence (0–1) for a warning to be surfaced. Default 0.6 — raise it to reduce noise.',
        },
      },
      required: ['instance_id', 'event_type', 'context'],
    },
  },
  // ── Move 5: Privacy-preserving federation ────────────────────────────────
  {
    name: 'brain_contribute_signal',
    description:
      'Contribute a privacy-safe signal to the global Brain commons. Only the topic category, outcome, ' +
      'and confidence bucket (high/medium/low) are shared — no lesson text, no org identity. ' +
      'When ≥ k independent orgs contribute the same pattern, a meta-lesson is derived in the commons. ' +
      'Use this instead of fedbrain_contribute when privacy is required (enterprise, GDPR).',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        topic_category: { type: 'string', description: 'Normalised topic, e.g. "auth:jwt" or "deploy:k8s"' },
        outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Outcome of the pattern' },
        confidence: { type: 'number', description: 'Confidence 0–1 (bucketed before sending; default 0.5)' },
      },
      required: ['instance_id', 'topic_category', 'outcome'],
    },
  },
  {
    name: 'brain_import_meta',
    description:
      'Import k-anonymous meta-lessons from the global Brain commons into your local Brain. ' +
      'Meta-lessons are derived from ≥ k independent org signals — no individual org data is revealed. ' +
      'Imported lessons get state="meta" and never overwrite your own lessons. ' +
      'Filter by category to target relevant patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        category: { type: 'string', description: 'Optional filter, e.g. "auth" or "deploy"' },
        limit: { type: 'number', description: 'Max meta-lessons to import (default 20, max 200)' },
      },
      required: ['instance_id'],
    },
  },
  // ── Layer 3: MADC ────────────────────────────────────────────────────────
  {
    name: 'madc_deliberate',
    description:
      'Multi-Agent Deliberation Chamber (MADC — Layer 3): When conflicting lessons exist for a topic, ' +
      'run deliberation between 6 specialist expert agents (InfraAgent, AuthAgent, DeployAgent, DatabaseAgent, DebugAgent, APIAgent). ' +
      'Each agent votes based on its domain CKG coverage. Unanimous vote → loser superseded. ' +
      'Split vote → contested flag, causal_trace required before acting. ' +
      'Resolution stored as permanent CKG node. Called automatically when learn_from_attempts detects a contradiction.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        topic: { type: 'string', description: 'Topic to deliberate, e.g. "fix:jwks-rotation"' },
        context: { type: 'string', description: 'Optional context for the deliberation' },
      },
      required: ['instance_id', 'topic'],
    },
  },
  // ── Layer 5: CLS ─────────────────────────────────────────────────────────
  {
    name: 'cls_ingest',
    description:
      'Continuous Learning Stream (CLS — Layer 5): Ingest learning signals WITHOUT explicit session_end calls. ' +
      'Sources: git_commit (commit message + files → CKG edges), ci_outcome (green/red build → confirms fix), ' +
      'ide_diagnostic (compiler error + fix pair → instant lesson). ' +
      'Install automatic ingestion with cls_install_hooks — brain learns from every commit and CI run.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        source: {
          type: 'string',
          enum: ['git_commit', 'ci_outcome', 'ide_diagnostic'],
          description: 'Event source type',
        },
        payload: {
          type: 'object',
          description:
            'Event data. git_commit: {message, sha?, files?, diff?}. ' +
            'ci_outcome: {status, prev_status, job, context?}. ' +
            'ide_diagnostic: {error, fix, file?}',
        },
      },
      required: ['instance_id', 'source', 'payload'],
    },
  },
  {
    name: 'cls_install_hooks',
    description:
      'READ-ONLY — outputs text only, writes no files, makes no network calls, has no side effects. ' +
      'Generates ready-to-paste shell scripts: a git post-commit hook and/or a GitHub Actions step. ' +
      'You must manually copy and install the output. ' +
      'Once the generated scripts are installed, each git commit or CI run will make outbound HTTPS calls ' +
      'to api.cachly.dev to feed learning signals to your brain. ' +
      'No auth required to call this tool — only an instance_id. Run once per repository.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        repo_path: { type: 'string', description: 'Path to repo root (default: current dir)' },
        hooks: {
          type: 'array',
          items: { type: 'string', enum: ['git', 'ci'] },
          description: 'Which hooks to output (default: ["git", "ci"])',
        },
      },
      required: ['instance_id'],
    },
  },
  // ── Layer 6: FedBrain ────────────────────────────────────────────────────
  {
    name: 'fedbrain_contribute',
    description:
      'FedBrain (Layer 6): Contribute a lesson to the global Knowledge Commons with a cryptographic ' +
      'knowledge certificate. Certificate includes: domain fingerprint, confidence, outcome chain hash. ' +
      'Lessons with 10+ independent confirmations become Gold Standard. Context-weighted: ' +
      'other brains with similar tech stacks see your lesson ranked higher in fedbrain_search.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        lesson_key: { type: 'string', description: 'Topic key to contribute, e.g. "fix:clickhouse-ipv6"' },
        visibility: {
          type: 'string',
          enum: ['public', 'org_private'],
          description: 'Visibility (default: public)',
        },
      },
      required: ['instance_id', 'lesson_key'],
    },
  },
  {
    name: 'fedbrain_search',
    description:
      'FedBrain context-weighted search: Search the global commons, weighting results by tech-stack similarity. ' +
      'Brains with matching domain context (Go/Kubernetes/Postgres) rank higher than unrelated stacks. ' +
      'Shows certificate provenance, confirm_count, and Gold Standard badges.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        query: { type: 'string', description: 'What to search for' },
        context_hints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Your tech stack, e.g. ["go", "kubernetes", "postgres"]',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'fedbrain_confirm',
    description:
      'Confirm that a syndicated lesson from the global commons worked for you. ' +
      'Propagates confirmation back — increments confirm_count on the knowledge certificate. ' +
      'Also updates your local CKG confidence. At 10 independent confirmations → Gold Standard.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        id: {
          type: 'string',
          description: 'Syndicated lesson id to confirm (shown next to each fedbrain_search result)',
        },
        topic: {
          type: 'string',
          description: 'Optional topic of the lesson — also updates your local CKG confidence for it',
        },
        outcome: {
          type: 'string',
          enum: ['worked', 'partially_worked', 'did_not_work'],
          description: 'Did the lesson work for you?',
        },
      },
      required: ['instance_id', 'id', 'outcome'],
    },
  },
  {
    name: 'fedbrain_status',
    description:
      'Show your FedBrain federation status: lessons contributed to global commons, recent confirmations, ' +
      'Gold Standard lessons, pending propagations. Use to track your brain\'s global knowledge contribution.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_federate',
    description:
      'FedBrain Layer 6 — Private org knowledge transfer: copy CKG edges + lessons from a source brain ' +
      'into your brain for a specific domain (e.g. "billing", "auth", "deploy"). ' +
      'The new hire use case: one command gives you the senior engineer\'s 5 years of typed, confidence-weighted ' +
      'knowledge in your domain. Unlike syndicate_search (global, anonymous), brain_federate is org-private — ' +
      'both brains must be in the same Cachly org, or the source instance_id must be explicitly shared. ' +
      'Example: brain_federate(source="prod-brain-id", domain="billing", min_confidence=0.6)',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Your brain instance ID (destination)' },
        source: { type: 'string', description: 'Source brain instance ID to federate from' },
        domain: { type: 'string', description: 'Domain to transfer, e.g. "billing", "auth", "deploy", "infra". Use "*" for all domains.' },
        min_confidence: { type: 'number', description: 'Minimum edge confidence to transfer (default: 0.6)' },
        dry_run: { type: 'boolean', description: 'Preview what would be transferred without writing (default: false)' },
      },
      required: ['instance_id', 'source', 'domain'],
    },
  },
  {
    name: 'crystal_view',
    description:
      'Inspect the current Memory Crystal — the compressed wisdom distilled from all past sessions. ' +
      'Shows top patterns per category, lesson count, and when the crystal was last refreshed. ' +
      'Call after session_start when you want to quickly see accumulated wisdom across all past work.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        show_raw: { type: 'boolean', description: 'Include raw JSON crystal data (default: false)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'compact_recover',
    description:
      'Call FIRST after any context limit hit / compaction. Reconstructs full context from Memory Crystal + ' +
      'recent sessions + WIP registry + open failures. Returns a condensed briefing so the new context ' +
      'window starts exactly where the previous one left off — no lost progress.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        focus: { type: 'string', description: 'What you were working on (helps filter relevant context)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_from_git',
    description:
      'Bootstrap brain lessons from git history. Parses commit messages and infers fix/feature/refactor ' +
      'lessons automatically. Great for onboarding an existing codebase — run once and the brain instantly ' +
      'knows your team\'s accumulated patterns. Incremental by default: only processes new commits since the ' +
      'last run, so repeated calls are fast. Emits progress updates to stderr during long scans.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        repo_path: { type: 'string', description: 'Path to git repository (default: current directory)' },
        limit: { type: 'number', description: 'Max commits to process (default: 100, max: 500)' },
        branch: { type: 'string', description: 'Git branch to parse (default: current branch / HEAD)' },
        since: { type: 'string', description: 'Only commits after this date, e.g. "2024-01-01" (optional)' },
        incremental: { type: 'boolean', description: 'Only process commits since last run (default: true). Set false to reprocess all.' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_from_ci',
    description:
      'Bulk-ingest CI run outcomes into the Brain — the brain_from_git equivalent for CI history. ' +
      'Feed it an array of {job, status, prev_status} objects from your CI system and it will learn ' +
      'which jobs have been fixed, broken, or are stable. Use it to bootstrap the Brain from historical CI logs.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        outcomes: {
          type: 'array',
          description: 'List of CI run outcomes to ingest',
          items: {
            type: 'object',
            properties: {
              job: { type: 'string', description: 'Job name (e.g. "test", "build", "lint")' },
              status: { type: 'string', description: 'Current status: success|failure|error' },
              prev_status: { type: 'string', description: 'Previous run status (optional, needed to detect transitions)' },
              context: { type: 'string', description: 'Optional: error message, branch, commit hash, etc.' },
            },
            required: ['job', 'status'],
          },
        },
      },
      required: ['instance_id', 'outcomes'],
    },
  },
  {
    name: 'brain_watch',
    description:
      'Install an ambient git post-commit hook that automatically learns from every commit — ' +
      'no manual brain_from_git needed. After installation every `git commit` silently POSTs ' +
      'the commit message, SHA, and changed files to the cachly Brain API in the background. ' +
      'Idempotent: running brain_watch twice installs the hook only once. ' +
      'Uses curl (not Node/npx) so it works in any environment. ' +
      'The hook always exits 0 and runs asynchronously — it never blocks a commit. ' +
      'Returns the hook path and installation status (written/upgraded/appended/unchanged/skipped-no-git).',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID to learn into' },
        project_dir: { type: 'string', description: 'Path to the git repository (default: current directory ".")' },
        api_key: { type: 'string', description: 'Optional cachly API key (cky_…) to embed in the hook for authentication' },
      },
      required: [],
    },
  },
  {
    name: 'brain_predict_failures',
    description:
      'Pre-deploy failure prediction with probability percentages. Given a change context (e.g. ' +
      '"upgrading Keycloak 21→24" or "deploying Redis 7 to prod"), returns the top likely failure modes ' +
      'ranked by probability, with pre-loaded fixes. Uses CKG causal edges + lesson history. ' +
      'Call before any significant deploy, migration, or infrastructure change.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        context: { type: 'string', description: 'What you are about to do, e.g. "upgrading Keycloak 21 to 24"' },
        top_k: { type: 'number', description: 'Number of failure predictions to return (default: 5)' },
        format: { type: 'string', enum: ['brief', 'detailed'], description: 'Output format (default: detailed)' },
      },
      required: ['instance_id', 'context'],
    },
  },

  // ── Phase 3: Shareable / Public Brains ──────────────────────────────────────
  // brain_share, brain_import, brain_share_list, brain_unshare, brain_discover

  {
    name: 'brain_share',
    description:
      'Export a Brain snapshot and create a publicly shareable link that anyone can import. ' +
      'Optionally filter by topic prefix (e.g. only "auth:" or "deploy:" lessons). ' +
      'Visibility can be "public" (discoverable) or "unlisted" (link-only). ' +
      'Returns a share URL and the import command to give to teammates or the community. ' +
      'Example: brain_share(instance_id="...", title="My Auth Patterns", topic_filter=["auth"])',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the Brain instance to export from.' },
        title:        { type: 'string', description: 'Human-readable title for the shared Brain snapshot. Default: "My Brain Snapshot".' },
        description:  { type: 'string', description: 'Short description of what knowledge this Brain contains.' },
        topic_filter: { type: 'array', items: { type: 'string' }, description: 'Only export lessons whose topic contains one of these strings. Omit to export all lessons.' },
        visibility:   { type: 'string', enum: ['public', 'unlisted'], description: '"public" = discoverable in the Brain marketplace. "unlisted" = only accessible by direct link. Default: unlisted.' },
        max_lessons:  { type: 'number', description: 'Maximum number of lessons to include (default 100, max 500).' },
        dry_run:      { type: 'boolean', description: 'If true, preview what would be shared without creating the public link.' },
      },
      required: ['instance_id'],
    },
  },

  {
    name: 'brain_import',
    description:
      'Import lessons from a publicly shared Brain snapshot into your own Brain instance. ' +
      'Accepts a share ID (UUID) or the full share URL from brain_share. ' +
      'Optionally prefix all imported topics to avoid naming collisions (e.g. topic_prefix="team"). ' +
      'Existing lessons are NOT overwritten by default — pass overwrite=true to replace them. ' +
      'Example: brain_import(instance_id="...", share_id="abc123", topic_prefix="imported")',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:    { type: 'string', description: 'UUID of the Brain instance to import lessons into.' },
        share_id:       { type: 'string', description: 'Share ID (UUID) or full share URL from brain_share.' },
        topic_prefix:   { type: 'string', description: 'Optional prefix to prepend to all imported topic names (e.g. "team" → "team:auth:jwt-expiry"). Prevents collisions with your own lessons.' },
        min_confidence: { type: 'number', description: 'Skip lessons below this confidence threshold (0.0–1.0). Default: 0 (import all).' },
        overwrite:      { type: 'boolean', description: 'Replace existing lessons with the same topic. Default false.' },
        dry_run:        { type: 'boolean', description: 'Preview what would be imported without writing to the Brain.' },
      },
      required: ['instance_id', 'share_id'],
    },
  },

  {
    name: 'brain_share_list',
    description:
      'List all Brain snapshots you have previously shared with brain_share. ' +
      'Shows share ID, title, lesson count, visibility, and creation date for each share. ' +
      'Checks the local provenance log and the cachly API. ' +
      'Example: brain_share_list(instance_id="...")',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the Brain instance that created the shares.' },
      },
      required: ['instance_id'],
    },
  },

  {
    name: 'brain_unshare',
    description:
      'Revoke and permanently delete a public Brain share by its share ID. ' +
      'After calling this, the share URL becomes invalid and no one can import it. ' +
      'Note: users who already imported the Brain keep their local copy. ' +
      'Example: brain_unshare(instance_id="...", share_id="abc123")',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the Brain instance that owns the share.' },
        share_id:    { type: 'string', description: 'Share ID to revoke (from brain_share or brain_share_list).' },
      },
      required: ['instance_id', 'share_id'],
    },
  },

  {
    name: 'brain_discover',
    description:
      'Search and browse publicly shared Brain snapshots in the cachly marketplace. ' +
      'Find ready-made knowledge bases on specific topics (TypeScript, Docker, auth, CI/CD, etc.) ' +
      'created and shared by the community. Returns a ranked list with lesson counts, topics, and import commands. ' +
      'Example: brain_discover(query="kubernetes deployment") · brain_discover(topic="auth")',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text search query across Brain titles and descriptions.' },
        topic: { type: 'string', description: 'Filter by topic prefix (e.g. "auth", "docker", "nextjs").' },
        limit: { type: 'number', description: 'Max number of results to return (default 10, max 50).' },
      },
      required: [],
    },
  },

  {
    name: 'brain_seed_starter',
    description:
      'Seed a fresh Brain with a curated set of universal, high-value engineering lessons ' +
      '(Docker layer cache, JWT clock skew, Postgres migration locks, K8s OOM limits, N+1 queries, ' +
      'cache stampede, CORS preflight, and more). Makes the very first smart_recall return a useful hit ' +
      'instead of nothing — ideal right after setup or in a fresh repo with no git history to learn from. ' +
      'Starter lessons are tagged source:"starter", never override your own lessons, and are idempotent (won\'t double-seed). ' +
      'Example: brain_seed_starter(instance_id="...") · brain_seed_starter(instance_id="...", topic_filter=["docker","redis"])',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the Brain instance to seed.' },
        topic_filter: { type: 'array', items: { type: 'string' }, description: 'Only seed lessons whose topic or tags match one of these strings (e.g. ["docker", "auth"]). Omit to seed all.' },
        force: { type: 'boolean', description: 'Re-seed even if already seeded; also overwrites same-topic lessons. Default false.' },
        dry_run: { type: 'boolean', description: 'Preview which starter lessons would be seeded without writing.' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_graph',
    description:
      'Export the Causal Knowledge Graph as a 3D-render-ready node/link payload (schema cachly.brain_graph/v1) — ' +
      'the data layer behind the brain viz: the visual, explorable 3D map of every concept, person, file and service ' +
      'the brain knows, and how they causally relate. Node kinds (concept/person/file/service) carry stable color groups ' +
      'and a size (val) scaled by reference count; links carry edgeType (fixes/causes/co-occurs/authored/collaborates) and ' +
      'confidence (value). Consumed verbatim by react-force-graph-3d / three.js frontends. ' +
      'Example: brain_graph(instance_id="...") · brain_graph(instance_id="...", domain="auth", min_confidence=0.5, format="summary")',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the Brain instance to export.' },
        max_nodes: { type: 'number', description: 'Cap on nodes returned (default 400, max 2000). Edges to dropped nodes are pruned.' },
        domain: { type: 'string', description: 'Only include nodes whose domain or id contains this string (e.g. "auth", "docker"). Omit for the whole graph.' },
        min_confidence: { type: 'number', description: 'Drop edges below this confidence 0..1 (default 0 = keep all).' },
        format: { type: 'string', enum: ['json', 'summary'], description: '"json" (default) emits the full renderable payload; "summary" emits a human-readable overview.' },
      },
      required: ['instance_id'],
    },
  },
  // ── New Power Tools ──────────────────────────────────────────────────────────
  {
    name: 'brain_set_pref',
    description:
      'Persist a user preference for this Brain instance. ' +
      'Preferences are stored in Redis and survive restarts. ' +
      'Known keys: `auto_changelog` (set to "false" to disable the automatic changelog shown at session_start).',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (Brain ID).' },
        key:         { type: 'string', description: 'Preference key (e.g. "auto_changelog").' },
        value:       { type: 'string', description: 'Value to set (e.g. "false" to disable, "true" to re-enable).' },
      },
      required: ['instance_id', 'key', 'value'],
    },
  },
  {
    name: 'brain_get_pref',
    description:
      'Read back one or all preferences stored for this Brain instance. ' +
      'Call with a `key` to get a single value, or omit `key` to list every preference that has been set. ' +
      'Returns a default note when a key has never been set. ' +
      'Complement to `brain_set_pref`.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the Brain instance.' },
        key:         { type: 'string', description: 'Preference key to read. Omit to list all preferences.' },
      },
      required: ['instance_id'],
    },
  },
] as const;



export { TOOLS };
