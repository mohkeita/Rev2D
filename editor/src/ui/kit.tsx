/**
 * Small pieces the editor's screens share, built on the design tokens (classes `ed-*`, styles in
 * kit.css): inline notices, key caps, labelled form rows, removable chips and a few text helpers.
 * Everything bigger comes from the design system (../design/index.js).
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from '../design/index.js';
import { cx } from '../design/util.js';
import './kit.css';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const NOTICE_ICON: Record<NoticeTone, IconName> = { info: 'info', success: 'checkCircle', warning: 'warning', danger: 'error' };

export interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: NoticeTone;
  icon?: IconName;
  /** Buttons at the trailing end (a retry, the answers to an inline question). */
  actions?: ReactNode;
  /** Secondary line under the text (a hint with the fix). */
  hint?: ReactNode;
}

/** An inline message inside a panel or dialog: tinted plate, status glyph, text, optional actions. */
export function Notice({ tone = 'info', icon, actions, hint, className, children, role, ...rest }: NoticeProps) {
  return (
    <div className={cx('ed-notice', className)} data-tone={tone} role={role ?? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status')} {...rest}>
      <Icon name={icon ?? NOTICE_ICON[tone]} size={16} className="ed-notice-icon" />
      <div className="ed-notice-text">
        {children}
        {hint != null && <div className="ed-notice-hint">{hint}</div>}
      </div>
      {actions != null && <div className="ed-notice-actions">{actions}</div>}
    </div>
  );
}

/** Key caps: "Ctrl+Shift+S" becomes three caps; a space-separated list ("B M W") one cap per key. */
export function Keys({ keys, className }: { keys: string; className?: string }) {
  const parts = keys.includes('+') && keys.length > 1 ? keys.split('+').map((k) => k.trim()) : [keys];
  return (
    <span className={cx('ed-keys', className)}>
      {parts.map((k, i) => (
        <kbd key={i} className="ed-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export interface FieldRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  /** Controls at the trailing end of the label line (links such as "all / none"). */
  labelTrailing?: ReactNode;
  /** Explanation under the control. */
  hint?: ReactNode;
  /** Error text under the control. */
  error?: ReactNode;
  /** 'inline': label left, control right. Default 'stack': label above. */
  layout?: 'stack' | 'inline';
}

/** A labelled row of a form for controls that bring no label of their own (segmented, select, a list). */
export function FieldRow({ label, labelTrailing, hint, error, layout = 'stack', className, children, ...rest }: FieldRowProps) {
  return (
    <div className={cx('ed-field', className)} data-layout={layout} {...rest}>
      <div className="ed-field-label">
        <span>{label}</span>
        {labelTrailing}
      </div>
      <div className="ed-field-control">{children}</div>
      {error != null ? (
        <div className="ed-field-note" data-tone="danger" role="alert">
          {error}
        </div>
      ) : hint != null ? (
        <div className="ed-field-note">{hint}</div>
      ) : null}
    </div>
  );
}

export interface ChipProps {
  children: ReactNode;
  /** Makes the chip a button with a trailing x (a filter that can be cleared). */
  onRemove?: () => void;
  /** Accessible name / tooltip of the button. */
  label?: string;
  tone?: 'neutral' | 'tint';
  className?: string;
  'data-testid'?: string;
}

/** A small capsule: a filter in effect, an option set elsewhere. With `onRemove` it is a button. */
export function Chip({ children, onRemove, label, tone = 'tint', className, ...rest }: ChipProps) {
  if (!onRemove) {
    return (
      <span className={cx('ed-chip', className)} data-tone={tone} {...rest}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" className={cx('ed-chip', className)} data-tone={tone} title={label} aria-label={label} onClick={onRemove} {...rest}>
      <span className="ed-chip-text">{children}</span>
      <Icon name="close" size={10} strokeWidth={2.6} />
    </button>
  );
}

/** A text button inside running text ("Show 3 info notes", "all", "none"). */
export function LinkButton({ className, ...rest }: HTMLAttributes<HTMLButtonElement> & { disabled?: boolean }) {
  return <button type="button" className={cx('ed-link', className)} {...rest} />;
}
