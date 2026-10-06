/** Toast queue: a reducer and the display time of a message. Pure. */

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface ToastData {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms on screen; 0 = until dismissed. Default: toastDuration(). */
  duration?: number;
  /** Label of the one action a toast may carry ("Undo", "Show"). */
  actionLabel?: string;
}

export type ToastAction = { type: 'push'; toast: ToastData } | { type: 'dismiss'; id: string } | { type: 'clear' };

/** Toasts shown at once; older ones leave first. */
export const TOAST_LIMIT = 3;

/**
 * Newest toast last. Pushing an id that is on screen replaces that toast in place (progress messages
 * update instead of stacking); beyond the limit the oldest toast is dropped.
 */
export function toastReducer(state: readonly ToastData[], action: ToastAction, limit = TOAST_LIMIT): ToastData[] {
  switch (action.type) {
    case 'push': {
      const i = state.findIndex((t) => t.id === action.toast.id);
      if (i >= 0) return state.map((t, n) => (n === i ? action.toast : t));
      const next = [...state, action.toast];
      return next.length > limit ? next.slice(next.length - limit) : next;
    }
    case 'dismiss':
      return state.some((t) => t.id === action.id) ? state.filter((t) => t.id !== action.id) : (state as ToastData[]);
    case 'clear':
      return state.length ? [] : (state as ToastData[]);
  }
}

/**
 * How long a toast stays: 4 s, plus reading time for long text, at least 6 s when it carries an
 * action, at most 10 s. Errors stay until dismissed.
 */
export function toastDuration(toast: Pick<ToastData, 'title' | 'description' | 'tone' | 'duration' | 'actionLabel'>): number {
  if (toast.duration !== undefined) return Math.max(0, toast.duration);
  if (toast.tone === 'danger') return 0;
  const chars = toast.title.length + (toast.description?.length ?? 0);
  const reading = 4000 + Math.max(0, chars - 40) * 45;
  return Math.min(10000, Math.max(toast.actionLabel ? 6000 : 4000, reading));
}
