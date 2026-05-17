-- Travel Chaos Organizer — Initial Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS trips (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    start_date  DATE,
    end_date    DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trips_user_id ON trips(user_id);

CREATE TYPE item_type AS ENUM (
    'flight', 'train', 'bus', 'hotel', 'rental_car',
    'activity', 'transfer', 'document', 'other'
);

CREATE TABLE IF NOT EXISTS trip_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL,
    type          item_type NOT NULL DEFAULT 'other',
    title         TEXT NOT NULL,
    raw_text      TEXT,
    parsed_data   JSONB,
    event_at      TIMESTAMPTZ,
    event_end_at  TIMESTAMPTZ,
    booking_ref   TEXT,
    provider      TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trip_items_trip_id ON trip_items(trip_id);
CREATE INDEX idx_trip_items_event_at ON trip_items(event_at);
CREATE INDEX idx_trip_items_parsed_data ON trip_items USING gin(parsed_data);

CREATE TABLE IF NOT EXISTS attachments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_item_id  UUID REFERENCES trip_items(id) ON DELETE CASCADE,
    inbox_id      UUID,
    user_id       TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_trip_item_id ON attachments(trip_item_id);

CREATE TYPE inbox_status AS ENUM ('pending', 'processed', 'rejected', 'assigned');

CREATE TABLE IF NOT EXISTS chaos_inbox (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      TEXT NOT NULL,
    raw_content  TEXT,
    source       TEXT,
    status       inbox_status NOT NULL DEFAULT 'pending',
    parsed_data  JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chaos_inbox_user_id ON chaos_inbox(user_id);
CREATE INDEX idx_chaos_inbox_status ON chaos_inbox(status);
