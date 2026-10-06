/**
 * SegmentedControl: one choice among a few closely related options (2 - 7), with a thumb that slides
 * to the selection. Segments are equally wide; use either text or icons in one control, not a mix.
 *
 * Keyboard (radio group pattern): Tab reaches the selected segment; Left / Right (Up / Down) move the
 * selection, Home / End jump to the ends.
 */
import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { rovingIndex } from '../logic/roving.js';
import { cx, isRtl, useControllable } from '../util.js';
import './segmented.css';

export interface SegmentOption<T extends string = string> {
  value: T;
  /** Text of the segment; with `icon` and no label, give `ariaLabel`. */
  label?: ReactNode;
  icon?: IconName;
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  size?: 'sm' | 'md' | 'lg';
  shape?: 'capsule' | 'rounded';
  /** Fill the width of the container. */
  block?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  id?: string;
  'data-testid'?: string;
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  defaultValue,
  onChange,
  size = 'md',
  shape = 'capsule',
  block,
  disabled,
  className,
  ...rest
}: SegmentedControlProps<T>) {
  const [current, setCurrent] = useControllable<T | undefined>(value, defaultValue ?? options[0]?.value, onChange as (v: T | undefined) => void);
  const root = useRef<HTMLDivElement>(null);
  const index = options.findIndex((o) => o.value === current);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const next = rovingIndex(e.key, index, options.length, {
      orientation: 'both',
      rtl: isRtl(root.current),
      isDisabled: (i) => disabled === true || options[i]!.disabled === true,
    });
    if (next === null) return;
    e.preventDefault();
    setCurrent(options[next]!.value);
    root.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      ref={root}
      role="radiogroup"
      className={cx('r2-segmented', className)}
      data-size={size}
      data-shape={shape}
      data-block={block ? '' : undefined}
      aria-disabled={disabled || undefined}
      style={{ '--r2-seg-count': options.length, '--r2-seg-index': Math.max(0, index) } as CSSProperties}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {index >= 0 && <span className="r2-segmented-thumb" aria-hidden="true" />}
      {options.map((o, i) => {
        const selected = i === index;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="r2-segment"
            aria-checked={selected}
            aria-label={o.ariaLabel}
            // Roving tabindex: the selected segment (or the first one) is the tab stop.
            tabIndex={selected || (index < 0 && i === 0) ? 0 : -1}
            disabled={disabled || o.disabled}
            data-value={o.value}
            onClick={() => setCurrent(o.value)}
          >
            {o.icon && <Icon name={o.icon} size={size === 'lg' ? 18 : 16} />}
            {o.label != null && <span className="r2-segment-label">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
