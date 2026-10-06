/**
 * Dialog: the editor's modal dialogs, on the design system's Sheet (a centred card; `alert` gives the
 * small confirmation card). The Sheet moves the focus in and back, keeps Tab inside, closes on Escape
 * and confirms on Enter; this wrapper adds what the editor's file dialogs rely on:
 *
 * - `onEscape`: Escape answers an inline question first (a replace confirmation) instead of closing;
 * - keys keep working when the focus falls out of the dialog (a focused button that is disabled
 *   while an operation runs drops the focus to <body>): the dialog on top takes Escape / Enter / Tab
 *   at the document level and pulls the focus back in;
 * - Ctrl+S / Ctrl+O never open the browser's own "save page" / "open file" dialogs over it;
 * - `data-autofocus="stem"` on a file-name field selects the name without its extension;
 * - `footer`: a line of status text at the leading side of the action row.
 *
 * `useLingering` keeps a dialog rendered while its closing animation plays.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Sheet, type IconName } from '../design/index.js';
import './kit.css';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Open (not closing) modal sheets, in the order they were opened: the last one is on top. */
function openSheets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.r2-sheet-host:not([data-state="closing"]) > .r2-sheet[aria-modal="true"]')];
}

function isTopmost(el: HTMLElement): boolean {
  const all = openSheets();
  return all[all.length - 1] === el;
}

function focusIsLost(): boolean {
  return document.activeElement === document.body || document.activeElement === null;
}

/** Ctrl/Cmd+S, Ctrl/Cmd+Shift+S, Ctrl/Cmd+O: file shortcuts the browser would otherwise take. */
function isBrowserFileShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'o');
}

export interface DialogProps {
  /** false plays the closing animation (see useLingering). Default true. */
  open?: boolean;
  title: ReactNode;
  icon?: IconName;
  /** A sentence under the title (the message of an alert). */
  description?: ReactNode;
  /** sm 380, md 520, lg 720 px wide. */
  size?: 'sm' | 'md' | 'lg';
  /** A confirmation: small card, role="alertdialog", buttons side by side (stacked from three). */
  alert?: boolean;
  /** Escape, the scrim. */
  onCancel(): void;
  /** Escape runs this instead of onCancel when given (e.g. to answer an inline question first). */
  onEscape?(): void;
  /** Enter (outside buttons, lists and text areas) runs it; omit when Enter should do nothing. */
  onConfirm?(): void;
  children?: ReactNode;
  /** Buttons at the trailing end of the bottom row: Cancel first, the confirming action last. */
  actions?: ReactNode;
  /** Status text at the leading side of the bottom row. */
  footer?: ReactNode;
  testId?: string;
  'aria-label'?: string;
  className?: string;
}

export function Dialog({ open = true, title, icon, description, size = 'md', alert, onCancel, onEscape, onConfirm, children, actions, footer, testId, className, ...rest }: DialogProps) {
  const probe = useRef<HTMLSpanElement>(null);
  const handlers = useRef({ onCancel, onEscape: onEscape ?? onCancel, onConfirm });
  handlers.current = { onCancel, onEscape: onEscape ?? onCancel, onConfirm };
  const surface = (): HTMLElement | null => probe.current?.closest<HTMLElement>('.r2-sheet') ?? null;

  // After the Sheet focused its field: select a file name without its extension, ready to be retyped.
  useEffect(() => {
    if (!open) return;
    const input = surface()?.querySelector<HTMLInputElement>('input[data-autofocus="stem"]');
    const ext = input ? /(\.r2d)?\.json$/i.exec(input.value) : null;
    if (input && ext && document.activeElement === input) input.setSelectionRange(0, ext.index);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      const el = surface();
      if (!el || !isTopmost(el)) return;
      if (isBrowserFileShortcut(e)) {
        e.preventDefault();
        return;
      }
      if (e.defaultPrevented) return;
      // Keys pressed inside a dialog, menu or popover are handled there.
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.r2-layer')) return;
      const h = handlers.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        h.onEscape();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
        (e.shiftKey ? items[items.length - 1] : items[0])?.focus();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && h.onConfirm) {
        e.preventDefault();
        e.stopPropagation();
        el.focus();
        h.onConfirm();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  // After every render: a control that had the focus may just have been disabled (busy state).
  useEffect(() => {
    if (!open) return;
    const el = surface();
    if (el && focusIsLost() && isTopmost(el)) el.focus({ preventScroll: true });
  });

  return (
    <Sheet
      open={open}
      presentation={alert ? 'alert' : 'dialog'}
      size={size}
      icon={icon}
      title={
        <>
          {title}
          <span ref={probe} hidden />
        </>
      }
      description={description}
      onClose={() => handlers.current.onCancel()}
      onEscape={() => handlers.current.onEscape()}
      onConfirm={onConfirm ? () => handlers.current.onConfirm?.() : undefined}
      className={className ? `ed-dialog ${className}` : 'ed-dialog'}
      data-testid={testId}
      actions={
        actions != null || footer != null ? (
          <>
            {footer != null && <div className="ed-dialog-info">{footer}</div>}
            {actions}
          </>
        ) : undefined
      }
      {...rest}
    >
      {children}
    </Sheet>
  );
}

/**
 * Keeps the last non-null `value` for `ms` after it became null, with `open: false` meanwhile, so a
 * dialog that is rendered from state can play its closing animation:
 *
 *   const shown = useLingering(dialog);
 *   {shown.value?.kind === 'open' && <OpenDialog open={shown.open} />}
 */
export function useLingering<T>(value: T | null, ms = 320): { value: T | null; open: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  if (value !== null && kept !== value) setKept(value);
  useEffect(() => {
    if (value !== null) return;
    const timer = setTimeout(() => setKept(null), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return { value: value ?? kept, open: value !== null };
}
