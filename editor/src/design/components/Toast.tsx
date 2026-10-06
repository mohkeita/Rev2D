/**
 * Toast: a brief, non-blocking status message in a glass capsule ("Saved", "Exported 3 files",
 * "Could not load texture"). At most one action ("Undo", "Show"). Toasts never carry information
 * that is only available there: an error also shows where it happened.
 *
 *   <ToastProvider> ...app... </ToastProvider>
 *   const toast = useToast();
 *   toast.show({ title: 'Saved', tone: 'success' });
 *
 * `Toast` alone is the presentational capsule (for static layouts and custom regions).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { toastDuration, toastReducer, type ToastData, type ToastTone } from '../logic/toast.js';
import { designStrings } from '../strings.js';
import { cx } from '../util.js';
import { Layer } from './Layer.js';
import './toast.css';

const TONE_ICON: Record<ToastTone, IconName | null> = {
  neutral: null,
  success: 'checkCircle',
  warning: 'warning',
  danger: 'error',
  info: 'info',
};

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Overrides the icon of the tone. */
  icon?: IconName;
  /** The one action of the toast. */
  action?: { label: string; onSelect: () => void };
  /** Shows a close button. */
  onDismiss?: () => void;
}

export function Toast({ title, description, tone = 'neutral', icon, action, onDismiss, className, ...rest }: ToastProps) {
  const glyph = icon ?? TONE_ICON[tone];
  return (
    <div className={cx('r2-toast r2-glass-panel', className)} data-tone={tone} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'} {...rest}>
      {glyph && <Icon name={glyph} size={18} className="r2-toast-icon" />}
      <div className="r2-toast-text">
        <div className="r2-toast-title">{title}</div>
        {description != null && <div className="r2-toast-description">{description}</div>}
      </div>
      {action && (
        <button type="button" className="r2-toast-action" onClick={action.onSelect}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="r2-toast-close r2-hit" aria-label={designStrings.dismiss} onClick={onDismiss}>
          <Icon name="close" size={12} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

export interface ToastOptions {
  /** Reuse an id to update a toast in place (progress, repeated saves). */
  id?: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  icon?: IconName;
  /** ms on screen; 0 keeps it until dismissed. Default: by length, errors stay. */
  duration?: number;
  action?: { label: string; onSelect: () => void };
}

export interface ToastApi {
  /** Show (or update) a toast; returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Where toasts appear. Default 'bottom' (above a timeline: pass `offset`). */
  placement?: 'top' | 'bottom';
  /** Distance from that edge in px. Default 24. */
  offset?: number;
  /** Toasts shown at once. Default 3. */
  limit?: number;
}

export function ToastProvider({ children, placement = 'bottom', offset = 24, limit = 3 }: ToastProviderProps) {
  const [toasts, dispatch] = useReducer((state: ToastData[], action: Parameters<typeof toastReducer>[1]) => toastReducer(state, action, limit), []);
  const extras = useRef(new Map<string, Pick<ToastOptions, 'icon' | 'action'>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    extras.current.delete(id);
    dispatch({ type: 'dismiss', id });
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show: (options) => {
        const id = options.id ?? `toast-${++counter.current}`;
        const data: ToastData = {
          id,
          title: options.title,
          description: options.description,
          tone: options.tone,
          duration: options.duration,
          actionLabel: options.action?.label,
        };
        extras.current.set(id, { icon: options.icon, action: options.action });
        dispatch({ type: 'push', toast: data });
        const old = timers.current.get(id);
        if (old) clearTimeout(old);
        const ms = toastDuration(data);
        if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
        else timers.current.delete(id);
        return id;
      },
      dismiss,
      clear: () => {
        for (const t of timers.current.values()) clearTimeout(t);
        timers.current.clear();
        extras.current.clear();
        dispatch({ type: 'clear' });
      },
    }),
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Layer level="toast">
        <div className="r2-toast-region" data-placement={placement} style={{ [placement]: offset }} role="region" aria-label={designStrings.notifications}>
          {toasts.map((t) => {
            const extra = extras.current.get(t.id);
            const action = extra?.action;
            return (
              <Toast
                key={t.id}
                title={t.title}
                description={t.description}
                tone={t.tone}
                icon={extra?.icon}
                action={
                  action && {
                    label: action.label,
                    onSelect: () => {
                      action.onSelect();
                      dismiss(t.id);
                    },
                  }
                }
                onDismiss={toastDuration(t) === 0 ? () => dismiss(t.id) : undefined}
              />
            );
          })}
        </div>
      </Layer>
    </ToastContext.Provider>
  );
}
