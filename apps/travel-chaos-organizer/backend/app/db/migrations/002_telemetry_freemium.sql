-- users table: freemium plan tracking. id = Keycloak sub.
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT,
    plan            TEXT NOT NULL DEFAULT 'free',
    plan_expires_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- events table: telemetry. user_id nullable for anonymous/server events.
CREATE TABLE IF NOT EXISTS events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      TEXT,
    event_name   TEXT NOT NULL,
    properties   JSONB,
    platform     TEXT,
    app_version  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_user_id  ON events(user_id);
CREATE INDEX idx_events_name     ON events(event_name);
CREATE INDEX idx_events_created  ON events(created_at DESC);

-- waitlist: email capture from landing page (no auth required)
CREATE TABLE IF NOT EXISTS waitlist (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT NOT NULL UNIQUE,
    source     TEXT DEFAULT 'landing',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
