/**
 * Accessible modal dialog: focus moves into it (the element marked data-autofocus, else the first
 * control) and back to where it was when it closes; Tab cycles inside it; Esc cancels (or runs
 * onEscape); Enter confirms (unless the focused control uses Enter itself: buttons, links, text
 * areas, or an element that handled the key). Pressing on the backdrop cancels. The keys keep working
 * when the focus falls out of the dialog (a focused button disabled while busy), and Ctrl+S / Ctrl+O
 * never open the browser's own dialogs over it.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Visible focusable controls of a dialog, in tab order. */
function focusablesIn(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
}

/** Whether `el` is the dialog on top (dialogs stack in document order: a prompt renders after the dialog it guards). */
function isTopmost(el: HTMLElement): boolean {
  const all = document.querySelectorAll('[aria-modal="true"]');
  return all[all.length - 1] === el;
}

/** Ctrl/Cmd+S, Ctrl/Cmd+Shift+S, Ctrl/Cmd+O: file shortcuts the browser would otherwise take. */
function isBrowserFileShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'o');
}

export interface ModalProps {
  title: ReactNode;
  icon?: IconName;
  /** Tone of the title icon. */
  tone?: 'accent' | 'warning' | 'error';
  onCancel(): void;
  /** Esc runs this instead of onCancel when given (e.g. to answer an inline question first). */
  onEscape?(): void;
  /** Enter (outside buttons and text areas) runs it; omit when Enter should do nothing. */
  onConfirm?(): void;
  children: ReactNode;
  /** Right-aligned action buttons. */
  actions?: ReactNode;
  /** Left side of the footer (status text, secondary links). */
  footer?: ReactNode;
  size?: 'narrow' | 'medium' | 'wide';
  className?: string;
  testId?: string;
  /** role="alertdialog" for confirmations. */
  alert?: boolean;
}

export function Modal({ title, icon, tone = 'accent', onCancel, onEscape, onConfirm, children, actions, footer, size = 'medium', className = '', testId, alert }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Latest callbacks without re-running the focus effect.
  const handlers = useRef({ onCancel, onEscape: onEscape ?? onCancel, onConfirm });
  handlers.current = { onCancel, onEscape: onEscape ?? onCancel, onConfirm };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (el) {
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
      target.focus();
      if (target instanceof HTMLInputElement && target.type === 'text') {
        // data-autofocus="stem": select the file name without its extension, ready to be retyped.
        const ext = target.dataset.autofocus === 'stem' ? /(\.r2d)?\.json$/i.exec(target.value) : null;
        if (ext) target.setSelectionRange(0, ext.index);
        else target.select();
      }
    }
    return () => {
      // Back to the control that opened the dialog, unless another dialog took the focus meanwhile.
      if (previous?.isConnected && (document.activeElement === document.body || document.activeElement === null)) previous.focus();
    };
  }, []);

  // Focus can fall out of the dialog without the user moving it: a focused button that becomes
  // disabled while an operation runs (Save, Create, Import...) drops the focus to <body>, where the
  // dialog's own key handler never sees Esc / Enter / Tab. The topmost dialog then takes those keys
  // at the document level and pulls the focus back in.
  useEffect(() => {
    const onDocumentKey = (e: globalThis.KeyboardEvent): void => {
      const el = ref.current;
      if (!el || e.defaultPrevented || !isTopmost(el)) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && t.closest('[aria-modal="true"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onEscape();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const items = focusablesIn(el);
        (e.shiftKey ? items[items.length - 1] : items[0])?.focus();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && handlers.current.onConfirm) {
        e.preventDefault();
        e.stopPropagation();
        el.focus();
        handlers.current.onConfirm();
      } else if (isBrowserFileShortcut(e)) {
        // Ctrl+S / Ctrl+O would open the browser's own "save page" / "open file" dialogs.
        e.preventDefault();
      }
    };
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget) return;
      // Where the focus went is known after the event; <body> means it was dropped, not moved.
      setTimeout(() => {
        const el = ref.current;
        if (el?.isConnected && isTopmost(el) && (document.activeElement === document.body || document.activeElement === null)) {
          el.focus({ preventScroll: true });
        }
      }, 0);
    };
    const el = ref.current;
    document.addEventListener('keydown', onDocumentKey, true);
    el?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onDocumentKey, true);
      el?.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // After every render: a control that was focused may just have been disabled (busy state).
  useEffect(() => {
    const el = ref.current;
    if (el && isTopmost(el) && (document.activeElement === document.body || document.activeElement === null)) el.focus({ preventScroll: true });
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed in a dialog never reach the editor's global shortcuts.
    e.stopPropagation();
    // ...nor open the browser's own "save page" / "open file" dialogs (Ctrl+S, Ctrl+O).
    if (isBrowserFileShortcut(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handlers.current.onEscape();
      return;
    }
    if (e.key === 'Enter' && !e.defaultPrevented && !e.shiftKey && !e.altKey && handlers.current.onConfirm) {
      const t = e.target as HTMLElement;
      if (t.closest('button, a, textarea, select, [role="option"], [role="listbox"]')) return;
      e.preventDefault();
      handlers.current.onConfirm();
      return;
    }
    if (e.key === 'Tab') {
      const el = ref.current;
      if (!el) return;
      const items = focusablesIn(el);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handlers.current.onCancel();
      }}
    >
      <div
        ref={ref}
        className={`modal modal-${size} file-modal ${className}`.trim()}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        <div className="modal-head">
          <h2 id={titleId} className={`tone-${tone}`}>
            {icon && <Icon name={icon} size={18} />}
            {title}
          </h2>
          <button className="icon-button" title="Close (Esc)" aria-label="Close" onClick={() => handlers.current.onCancel()}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {(actions || footer) && (
          <div className="modal-footer">
            <div className="modal-footer-info">{footer}</div>
            <div className="modal-footer-actions">{actions}</div>
          </div>
        )}
      </div>
    </div>
  );
}
