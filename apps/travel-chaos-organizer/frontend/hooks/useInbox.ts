import { useEffect, useState, useCallback } from "react";
import { inboxApi, InboxItem } from "../lib/api";

export function useInbox(statusFilter = "pending") {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await inboxApi.list(statusFilter));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  return { items, loading, error, refresh };
}
