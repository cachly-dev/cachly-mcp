import { useEffect, useState, useCallback } from "react";
import * as Network from "expo-network";
import { tripsApi, itemsApi, Trip, TripItem } from "../lib/api";
import { upsertTrips, upsertItems, getLocalTrips, getLocalItems } from "../lib/db";

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

  return { trips, loading, error, refresh: sync };
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

  return { items, loading, refresh: sync };
}
