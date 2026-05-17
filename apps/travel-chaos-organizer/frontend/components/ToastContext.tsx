import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
import ToastRenderer from "./Toast";

export type ToastType = "success" | "error" | "warning" | "info";
export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastCtx {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const Ctx = createContext<ToastCtx>({ showToast: () => {} });

let _counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: ToastType = "info", duration?: number) => {
    const id = String(++_counter);
    setToasts(prev => [...prev, { id, message, type, duration }]);
  }, []);

  const remove = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <Ctx.Provider value={{ showToast }}>
      {children}
      <ToastRenderer toasts={toasts} remove={remove} />
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
