/**
 * Sheet: a modal card for one scoped task, and Alert: a short confirmation built on it.
 *
 * Presentations:
 * - 'sheet'   a card that rises from the bottom edge, inset from the window, with a grabber (drag it
 *             down or press it to dismiss);
 * - 'dialog'  a centred card (the form sheet of iPadOS) for forms and pickers;
 * - 'alert'   a small centred card: bold title, a sentence, one to three buttons.
 *
 * Behaviour: the focus moves into the sheet (`data-autofocus` marks the control, else the first one)
 * and returns to where it was on close; Tab stays inside; Escape, the scrim, the grabber and a swipe
 * down call `onClose`; Enter outside a button calls `onConfirm`. One sheet at a time: close one
 * before opening the next.
 *
 * Header convention: Cancel in `leading`, the confirming action (Done, Create) in `trailing`; or put
 * the buttons in `actions` at the bottom (dialogs, alerts). A destructive action is never the default.
 */
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { designStrings } from '../strings.js';
import { sheetDragOffset, sheetDragOutcome } from '../logic/appearance.js';
import { cx, usePresence } from '../util.js';
import { Button } from './Button.js';
import { useFocusScope } from './focus.js';
import { Layer } from './Layer.js';
import './sheet.css';

export interface SheetProps {
  open: boolean;
  /** Dismissed without confirming: Escape, scrim, grabber, swipe down. */
  onClose: () => void;
  /** Enter was pressed outside a button, link or text area. */
  onConfirm?: () => void;
  /** Escape runs this instead of `onClose` (to answer an inline question before the sheet closes). */
  onEscape?: () => void;
  presentation?: 'sheet' | 'dialog' | 'alert';
  /** Maximum width: sm 380, md 520, lg 720 px. Alerts are always small. */
  size?: 'sm' | 'md' | 'lg';
  title?: ReactNode;
  /** A sentence under the title (alerts), or the accessible description. */
  description?: ReactNode;
  icon?: IconName;
  /** Header: leading action (Cancel) and trailing action (Done). */
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Buttons at the bottom. */
  actions?: ReactNode;
  /** Show the grabber. Default: true for 'sheet'. */
  grabber?: boolean;
  /** false: Escape and the scrim do nothing (a task that must be answered). Default true. */
  dismissible?: boolean;
  /**
   * false: render in place inside the nearest positioned ancestor, without taking the focus or
   * trapping keys (static mock-ups, documentation). Default true.
   */
  modal?: boolean;
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

export function Sheet({
  open,
  onClose,
  onConfirm,
  onEscape,
  presentation = 'sheet',
  size = 'md',
  title,
  description,
  icon,
  leading,
  trailing,
  actions,
  grabber,
  dismissible = true,
  modal = true,
  children,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: SheetProps) {
  const titleId = useId();
  const descId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const presence = usePresence(open, 400);
  const scope = useFocusScope(surface, { active: open && modal });
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const drag = useRef<{ id: number; y: number; t: number; moved: boolean } | null>(null);
  /** The press on the grabber was a drag: the click that ends it must not dismiss the sheet. */
  const dragged = useRef(false);

  if (!presence.mounted) return null;

  const showGrabber = grabber ?? presentation === 'sheet';

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed in a sheet never reach the application's global shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      if (onEscape) onEscape();
      else if (dismissible) onClose();
      return;
    }
    if (e.key === 'Enter' && onConfirm && !e.defaultPrevented && !e.shiftKey && !e.altKey) {
      const t = e.target as HTMLElement;
      if (!t.closest('button, a, textarea, select, [role="option"], [role="listbox"], [role="menu"], [role="combobox"]')) {
        e.preventDefault();
        onConfirm();
        return;
      }
    }
    scope.onKeyDown(e);
  };

  const onGrabDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, y: e.clientY, t: e.timeStamp, moved: false };
    dragged.current = false;
  };
  const onGrabMove = (e: PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dy) < 4) return;
    d.moved = true;
    dragged.current = true;
    setDragOffset(sheetDragOffset(dy, surface.current?.offsetHeight ?? 400));
  };
  const onGrabUp = (e: PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragOffset(null);
    if (!d.moved) return; // a plain press: the click handler dismisses
    const elapsed = Math.max(1, e.timeStamp - d.t);
    const outcome = sheetDragOutcome({ distance: e.clientY - d.y, velocity: (e.clientY - d.y) / elapsed, height: surface.current?.offsetHeight ?? 400 });
    if (outcome === 'dismiss' && dismissible) onClose();
  };

  const hasHeader = title != null || leading != null || trailing != null || icon != null;
  const alert = presentation === 'alert';

  const host = (
    <div
      className={cx('r2-sheet-host', !modal && 'r2-sheet-host-inline')}
      data-presentation={presentation}
      data-state={presence.state}
      data-testid={testId}
    >
      <div
        className="r2-sheet-scrim"
        onPointerDown={() => {
          if (modal && dismissible) onClose();
        }}
      />
      <div
        ref={surface}
        className={cx('r2-sheet r2-glass-panel', className)}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal={modal || undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : title != null ? titleId : undefined}
        aria-describedby={description != null ? descId : undefined}
        tabIndex={-1}
        data-size={alert ? 'sm' : size}
        data-dragging={dragOffset !== null ? '' : undefined}
        style={dragOffset !== null ? ({ '--r2-sheet-drag': `${dragOffset}px` } as CSSProperties) : undefined}
        onKeyDown={modal ? onKeyDown : undefined}
        onKeyUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={presence.onAnimationEnd}
      >
        {showGrabber && (
          <button
            type="button"
            className="r2-sheet-grabber"
            aria-label={designStrings.dismiss}
            data-autofocus-skip=""
            tabIndex={modal ? 0 : -1}
            onPointerDown={onGrabDown}
            onPointerMove={onGrabMove}
            onPointerUp={onGrabUp}
            onPointerCancel={onGrabUp}
            onClick={() => {
              if (dragged.current) dragged.current = false;
              else if (dismissible) onClose();
            }}
          />
        )}
        {hasHeader && (
          <header className="r2-sheet-header">
            {leading != null && <div className="r2-sheet-leading">{leading}</div>}
            <div className="r2-sheet-heading">
              {icon && <Icon name={icon} size={alert ? 22 : 18} className="r2-sheet-icon" />}
              {title != null && (
                <h2 id={titleId} className="r2-sheet-title">
                  {title}
                </h2>
              )}
            </div>
            {trailing != null && <div className="r2-sheet-trailing">{trailing}</div>}
          </header>
        )}
        {description != null && (
          <p id={descId} className="r2-sheet-description">
            {description}
          </p>
        )}
        {children != null && <div className="r2-sheet-body r2-scroll">{children}</div>}
        {actions != null && <footer className="r2-sheet-actions">{actions}</footer>}
      </div>
    </div>
  );

  return modal ? <Layer>{host}</Layer> : host;
}

export interface AlertAction {
  label: string;
  /** 'default' is the tinted button Enter triggers; 'cancel' is what Escape does. */
  role?: 'default' | 'cancel' | 'destructive';
  onSelect?: () => void;
}

export interface AlertProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  icon?: IconName;
  /** One to three actions, the preferred one last. */
  actions: readonly AlertAction[];
  /** Called after any action and on Escape. */
  onClose: () => void;
  'data-testid'?: string;
}

/** A confirmation: a bold title, one sentence, buttons side by side. Escape runs the cancel action. */
export function Alert({ open, title, message, icon, actions, onClose, ...rest }: AlertProps) {
  const run = (action: AlertAction | undefined): void => {
    action?.onSelect?.();
    onClose();
  };
  const cancel = actions.find((a) => a.role === 'cancel');
  const preferred = actions.find((a) => a.role === 'default');
  return (
    <Sheet
      open={open}
      presentation="alert"
      title={title}
      description={message}
      icon={icon}
      onClose={() => run(cancel)}
      onConfirm={preferred ? () => run(preferred) : undefined}
      actions={actions.map((a, i) => (
        <Button
          key={i}
          size="lg"
          block
          variant={a.role === 'default' ? 'filled' : 'gray'}
          destructive={a.role === 'destructive'}
          data-autofocus={a.role === 'default' || (!preferred && a.role === 'cancel') ? '' : undefined}
          onClick={() => run(a)}
        >
          {a.label}
        </Button>
      ))}
      {...rest}
    />
  );
}
