import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { usersApi, UserPlan } from "./api";

type QuotaCtx = {
  plan: UserPlan | null;
  isPro: boolean;
  refresh: () => Promise<void>;
};

const QuotaContext = createContext<QuotaCtx>({
  plan: null,
  isPro: false,
  refresh: async () => {},
});

export function QuotaProvider({ children }: { children: React.ReactNode }) {
  const [plan, setPlan] = useState<UserPlan | null>(null);

  const refresh = useCallback(async () => {
    try {
      const p = await usersApi.me();
      setPlan(p);
    } catch {
      // not authenticated yet — ignore
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <QuotaContext.Provider value={{ plan, isPro: plan?.is_pro ?? false, refresh }}>
      {children}
    </QuotaContext.Provider>
  );
}

export function useQuota() {
  return useContext(QuotaContext);
}
