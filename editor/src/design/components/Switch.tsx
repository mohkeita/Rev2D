/**
 * Switch: an on / off setting that takes effect immediately. In a list row the row's title is the
 * label (pass `aria-labelledby`, or use ListRow's `control` slot which wires it); standalone, pass
 * `label` to render a clickable text next to it.
 *
 * Keyboard: Space / Enter toggle; Left turns it off, Right turns it on.
 */
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode, Ref } from 'react';
import { cx, isRtl, useControllable } from '../util.js';
import './switch.css';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value' | 'children'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  size?: 'sm' | 'md';
  /** Visible label (clicking it toggles). */
  label?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Switch({ checked, defaultChecked = false, onChange, size = 'md', label, className, disabled, onKeyDown, onClick, ...rest }: SwitchProps) {
  const [on, setOn] = useControllable(checked, defaultChecked, onChange);

  const handleKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const rtl = isRtl(e.currentTarget);
      setOn((e.key === 'ArrowRight') !== rtl);
    }
  };

  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={cx('r2-switch r2-hit', !label && className)}
      data-size={size}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setOn(!on);
      }}
      onKeyDown={handleKey}
      {...rest}
    >
      <span className="r2-switch-knob" aria-hidden="true" />
    </button>
  );
  if (label == null) return control;
  return (
    <label className={cx('r2-switch-field', className)} data-disabled={disabled ? '' : undefined}>
      <span className="r2-switch-label">{label}</span>
      {control}
    </label>
  );
}
