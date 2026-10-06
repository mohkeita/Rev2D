/**
 * EmptyState: what an empty area says (no model open, no search results, no keyframes yet): a glyph,
 * a short title, one sentence that tells what to do, and the action that does it.
 * Checkerboard: the transparency backdrop of a canvas or an image well.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { cx } from '../util.js';
import './empty.css';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  /** One or two buttons (the primary one filled or tinted). */
  actions?: ReactNode;
  size?: 'sm' | 'md';
}

export function EmptyState({ icon, title, description, actions, size = 'md', className, ...rest }: EmptyStateProps) {
  return (
    <div className={cx('r2-empty', className)} data-size={size} {...rest}>
      {icon && (
        <div className="r2-empty-icon">
          <Icon name={icon} size={size === 'sm' ? 20 : 26} strokeWidth={1.6} />
        </div>
      )}
      <div className="r2-empty-title">{title}</div>
      {description != null && <div className="r2-empty-description">{description}</div>}
      {actions != null && <div className="r2-empty-actions">{actions}</div>}
    </div>
  );
}

export interface CheckerboardProps extends HTMLAttributes<HTMLDivElement> {
  /** Size of one square in px. Default 8. */
  cell?: number;
}

export function Checkerboard({ cell = 8, className, style, children, ...rest }: CheckerboardProps) {
  return (
    <div className={cx('r2-checkerboard', className)} style={{ ...style, '--r2-check-size': `${cell}px` } as CSSProperties} {...rest}>
      {children}
    </div>
  );
}
