import { useEffect, useState, useCallback } from "react";
import * as Network from "expo-network";
import { tripsApi, itemsApi, Trip, TripItem } from "../lib/api";
import { upsertTrips, upsertItems, getLocalTrips, getLocalItems, deleteLocalItem } from "../lib/db";
import { enqueue } from "../lib/offlineQueue";

export function useTrips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sync = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const net = await Network.getNetworkStateAsync();
      if (net.isConnected) {
        const remote = await tripsApi.list();
        upsertTrips(remote);
        setTrips(remote);
      } else {
        setTrips(getLocalTrips());
      }
    } catch (e) {
      setError(String(e));
      setTrips(getLocalTrips());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { sync(); }, [sync]);

  async function createOffline(data: Pick<Trip, "name" | "description" | "start_date" | "end_date">) {
    const net = await Network.getNetworkStateAsync();
    if (net.isConnected) {
      const trip = await tripsApi.create(data);
      upsertTrips([trip]);
      setTrips((prev) => [...prev, trip]);
      return trip;
    }
    enqueue("POST", "/api/v1/trips", data);
    const temp: Trip = { id: `temp-${Date.now()}`, user_id: "local", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...data };
    upsertTrips([temp]);
    setTrips((prev) => [...prev, temp]);
    return temp;
  }

  async function updateOffline(id: string, data: Partial<Pick<Trip, "name" | "description" | "start_date" | "end_date">>) {
    const net = await Network.getNetworkStateAsync();
    if (net.isConnected) {
      const updated = await tripsApi.update(id, data);
      upsertTrips([updated]);
      setTrips((prev) => prev.map((t) => (t.id === id ? updated : t)));
      return updated;
    }
    enqueue("PATCH", `/api/v1/trips/${id}`, data);
    setTrips((prev) => prev.map((t) => (t.id === id ? { ...t, ...data } : t)));
  }

  async function deleteTrip(id: string) {
    const net = await Network.getNetworkStateAsync();
    if (net.isConnected) {
      await tripsApi.delete(id);
    } else {
      enqueue("DELETE", `/api/v1/trips/${id}`, {});
    }
    setTrips((prev) => prev.filter((t) => t.id !== id));
  }

  return { trips, loading, error, refresh: sync, createOffline, updateOffline, deleteTrip };
}

export function useTripItems(tripId: string) {
  const [items, setItems] = useState<TripItem[]>([]);
  const [loading, setLoading] = useState(true);

  const sync = useCallback(async () => {
    setLoading(true);
    try {
      const net = await Network.getNetworkStateAsync();
      if (net.isConnected) {
        const remote = await itemsApi.list(tripId);
        upsertItems(remote);
        setItems(remote);
      } else {
        setItems(getLocalItems(tripId));
      }
    } catch {
      setItems(getLocalItems(tripId));
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { sync(); }, [sync]);

  async function deleteItem(itemId: string) {
    const net = await Network.getNetworkStateAsync();
    if (net.isConnected) {
      await itemsApi.delete(tripId, itemId);
    } else {
      enqueue("DELETE", `/api/v1/trips/${tripId}/items/${itemId}`, {});
    }
    deleteLocalItem(itemId);
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  }

  return { items, loading, refresh: sync, deleteItem };
}
