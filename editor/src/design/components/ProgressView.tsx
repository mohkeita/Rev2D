/**
 * ProgressView: linear bar or circular indicator, determinate (`value` 0..1) or indeterminate (no
 * value). The indeterminate circular style is an activity spinner (eight fading spokes).
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { clamp } from '../logic/number.js';
import { designStrings } from '../strings.js';
import { cx } from '../util.js';
import './progress.css';

export interface ProgressViewProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  variant?: 'linear' | 'circular';
  /** Progress 0..1. Omit for an indeterminate indicator. */
  value?: number;
  /** Circular: diameter in px (default 20). Linear: 'sm' = 2 px, 'md' = 4 px, 'lg' = 6 px track. */
  size?: number | 'sm' | 'md' | 'lg';
  /** Text shown under a linear bar (what is happening, not "Loading"). */
  label?: ReactNode;
  /** Colour: the tint (default) or the current text colour. */
  tone?: 'tint' | 'current';
}

const SPOKES = [0, 1, 2, 3, 4, 5, 6, 7];

export function ProgressView({ variant = 'linear', value, size, label, tone = 'tint', className, style, ...rest }: ProgressViewProps) {
  const determinate = value !== undefined && Number.isFinite(value);
  const v = determinate ? clamp(value, 0, 1) : 0;
  const aria = {
    role: 'progressbar',
    'aria-valuemin': determinate ? 0 : undefined,
    'aria-valuemax': determinate ? 100 : undefined,
    'aria-valuenow': determinate ? Math.round(v * 100) : undefined,
    'aria-busy': determinate ? undefined : true,
  } as const;

  if (variant === 'circular') {
    const d = typeof size === 'number' ? size : size === 'sm' ? 14 : size === 'lg' ? 28 : 20;
    const css = { ...style, width: d, height: d } as CSSProperties;
    if (!determinate) {
      return (
        <div className={cx('r2-spinner', className)} data-tone={tone} style={css} {...aria} {...rest}>
          <svg viewBox="0 0 24 24" width={d} height={d} aria-hidden="true">
            {SPOKES.map((i) => (
              <rect key={i} x="10.75" y="2.5" width="2.5" height="6" rx="1.25" transform={`rotate(${i * 45} 12 12)`} opacity={0.14 + (i / 7) * 0.8} />
            ))}
          </svg>
        </div>
      );
    }
    const r = 9.5;
    const c = 2 * Math.PI * r;
    return (
      <div className={cx('r2-progress-ring', className)} data-tone={tone} style={css} {...aria} {...rest}>
        <svg viewBox="0 0 24 24" width={d} height={d} aria-hidden="true">
          <circle className="r2-progress-ring-track" cx="12" cy="12" r={r} />
          <circle className="r2-progress-ring-value" cx="12" cy="12" r={r} strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 12 12)" />
        </svg>
      </div>
    );
  }

  return (
    <div className={cx('r2-progress', className)} data-size={typeof size === 'string' ? size : 'md'} data-tone={tone} data-indeterminate={determinate ? undefined : ''} style={style} {...aria} {...rest}>
      <div className="r2-progress-track">
        <div className="r2-progress-bar" style={determinate ? { width: `${v * 100}%` } : undefined} />
      </div>
      {label != null && <div className="r2-progress-label">{label}</div>}
    </div>
  );
}

/** The activity spinner on its own (inside buttons, rows, empty states). */
export function Spinner({ size = 16, ...rest }: Omit<ProgressViewProps, 'variant' | 'value' | 'label'>) {
  return <ProgressView variant="circular" size={size} tone="current" aria-label={designStrings.inProgress} {...rest} />;
}
