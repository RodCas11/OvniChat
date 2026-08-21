import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { ToastViewport, type ToastVariant, type ToastItem } from './Toast.js';

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/** Small local toast system for transient, non-decision notices only (never a substitute for a
 * blocking confirmation — see `docs/tasks/T13_1_VISUAL_FOUNDATION.md`). Mount once near the root of
 * the app; any descendant calls {@link useToast}. */
export function ToastProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextIdRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant = 'info') => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setToasts((prev) => [...prev, { id, message, variant }]);
      setTimeout(() => {
        dismiss(id);
      }, 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast() must be used within a <ToastProvider>');
  return context;
}
