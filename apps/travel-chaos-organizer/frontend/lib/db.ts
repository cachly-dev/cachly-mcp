/**
 * Local SQLite — offline mirror of trips and trip_items.
 * Syncs from API when online, reads locally when offline.
 */
import * as SQLite from "expo-sqlite";
import { Trip, TripItem } from "./api";

const db = SQLite.openDatabaseSync("tco.db");

export function initDb(): void {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      start_date TEXT,
      end_date TEXT,
      created_at TEXT,
      updated_at TEXT,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS trip_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      type TEXT,
      title TEXT,
      raw_text TEXT,
      parsed_data TEXT,
      event_at TEXT,
      event_end_at TEXT,
      booking_ref TEXT,
      provider TEXT,
      created_at TEXT,
      synced_at INTEGER
    );
  `);
}

export function upsertTrips(trips: Trip[]): void {
  const now = Date.now();
  for (const t of trips) {
    db.runSync(
      `INSERT OR REPLACE INTO trips
        (id, user_id, name, description, start_date, end_date, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.user_id, t.name, t.description ?? null, t.start_date ?? null,
       t.end_date ?? null, t.created_at, t.updated_at, now]
    );
  }
}

export function upsertItems(items: TripItem[]): void {
  const now = Date.now();
  for (const i of items) {
    db.runSync(
      `INSERT OR REPLACE INTO trip_items
        (id, trip_id, type, title, raw_text, parsed_data, event_at, event_end_at, booking_ref, provider, created_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [i.id, i.trip_id, i.type, i.title, i.raw_text ?? null,
       i.parsed_data ? JSON.stringify(i.parsed_data) : null,
       i.event_at ?? null, i.event_end_at ?? null, i.booking_ref ?? null,
       i.provider ?? null, i.created_at, now]
    );
  }
}

export function getLocalTrips(): Trip[] {
  return db.getAllSync<Trip>("SELECT * FROM trips ORDER BY start_date ASC");
}

export function deleteLocalItem(itemId: string): void {
  db.runSync("DELETE FROM trip_items WHERE id = ?", [itemId]);
}

export function getLocalItems(tripId: string): TripItem[] {
  const rows = db.getAllSync<Record<string, unknown>>(
    "SELECT * FROM trip_items WHERE trip_id = ? ORDER BY event_at ASC",
    [tripId]
  );
  return rows.map((r) => ({
    ...r,
    parsed_data: r.parsed_data ? JSON.parse(r.parsed_data as string) : null,
  })) as TripItem[];
}
