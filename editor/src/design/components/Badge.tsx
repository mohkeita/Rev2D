/**
 * Badge: a short status or count next to something else ("3", "New", "Error"). Colour never carries
 * the meaning alone: a badge has text, or sits next to a label that explains it.
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { cx } from '../util.js';
import './badge.css';

export type BadgeTone = 'neutral' | 'tint' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** 'soft': tinted plate (default). 'solid': filled, for counts that need attention. 'outline'. */
  variant?: 'soft' | 'solid' | 'outline';
  icon?: IconName;
  /** A dot without text (give it an aria-label or pair it with visible text). */
  dot?: boolean;
  children?: ReactNode;
}

export function Badge({ tone = 'neutral', variant = 'soft', icon, dot, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('r2-badge r2-num', className)} data-tone={tone} data-variant={variant} data-dot={dot ? '' : undefined} {...rest}>
      {icon && <Icon name={icon} size={12} strokeWidth={2.2} />}
      {!dot && children}
    </span>
  );
}
