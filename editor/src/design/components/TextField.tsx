/**
 * TextField, SearchField and NumberField.
 *
 * A field is a filled rounded rectangle without a border; the focus ring is the tint. A label sits
 * above it (or to its left inside an InspectorRow); placeholder text is a hint, never the only label.
 */
import { useEffect, useId, useRef, useState, type ChangeEvent, type InputHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from '../icons.js';
import { designStrings } from '../strings.js';
import { clamp, commitNumberInput, formatNumber, roundTo, stepNumber, decimalsOf } from '../logic/number.js';
import { cx, mergeRefs, useControllable, useLatest } from '../util.js';
import './field.css';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size' | 'value' | 'defaultValue' | 'prefix'> {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Enter was pressed (the value as it is). */
  onCommit?: (value: string) => void;
  /** Label above the field. Without it pass `aria-label`. */
  label?: ReactNode;
  /** Helper text under the field. */
  hint?: ReactNode;
  /** Error text under the field; marks the field invalid. */
  error?: ReactNode;
  /** Leading glyph that says what the field is for. */
  icon?: IconName;
  /** Custom leading content (after the icon). */
  leading?: ReactNode;
  /** Content at the trailing end (a unit, a button). */
  trailing?: ReactNode;
  /** Show a clear button while the field has text. */
  clearable?: boolean;
  size?: 'sm' | 'md' | 'lg';
  shape?: 'rounded' | 'capsule';
  /** Monospace digits and ids. */
  mono?: boolean;
  /** Fill the width of the container (default) or size to `width`. */
  width?: number | string;
  ref?: Ref<HTMLInputElement>;
}

export function TextField({
  value,
  defaultValue = '',
  onChange,
  onCommit,
  label,
  hint,
  error,
  icon,
  leading,
  trailing,
  clearable,
  size = 'md',
  shape = 'rounded',
  mono,
  width,
  className,
  id,
  disabled,
  onKeyDown,
  ref,
  ...rest
}: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const noteId = `${fieldId}-note`;
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useControllable(value, defaultValue, onChange);
  const note = error ?? hint;

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && onCommit) onCommit(e.currentTarget.value);
  };

  return (
    <div className={cx('r2-field', className)} data-size={size} data-shape={shape} data-disabled={disabled ? '' : undefined} style={width !== undefined ? { width } : undefined}>
      {label != null && (
        <label className="r2-field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <div className="r2-field-box" data-invalid={error != null ? '' : undefined}>
        {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} className="r2-field-icon" />}
        {leading}
        <input
          ref={mergeRefs(input, ref)}
          id={fieldId}
          className={cx('r2-field-input', mono && 'r2-text-mono r2-num')}
          value={text}
          disabled={disabled}
          aria-invalid={error != null || undefined}
          aria-describedby={note != null ? noteId : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
          onKeyDown={handleKey}
          {...rest}
        />
        {clearable && text !== '' && !disabled && (
          <button
            type="button"
            className="r2-field-clear r2-hit"
            aria-label={designStrings.clear}
            // Keep the focus in the input: the button is a pointer shortcut, Escape / Backspace do the same.
            tabIndex={-1}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              setText('');
              input.current?.focus();
            }}
          >
            <Icon name="close" size={10} strokeWidth={3} />
          </button>
        )}
        {trailing != null && <span className="r2-field-trailing">{trailing}</span>}
      </div>
      {note != null && (
        <div id={noteId} className="r2-field-note" data-tone={error != null ? 'danger' : undefined} role={error != null ? 'alert' : undefined}>
          {note}
        </div>
      )}
    </div>
  );
}

export interface SearchFieldProps extends Omit<TextFieldProps, 'icon' | 'clearable' | 'type'> {}

/** A capsule search field: magnifier, clear button, Escape clears the text. */
export function SearchField({ placeholder = designStrings.search, shape = 'capsule', value, defaultValue = '', onChange, onKeyDown, 'aria-label': ariaLabel, label, ...rest }: SearchFieldProps) {
  const [text, setText] = useControllable(value, defaultValue, onChange);
  return (
    <TextField
      type="search"
      role="searchbox"
      icon="search"
      clearable
      shape={shape}
      placeholder={placeholder}
      value={text}
      onChange={setText}
      label={label}
      aria-label={ariaLabel ?? (label == null ? placeholder : undefined)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === 'Escape' && text !== '' && !e.defaultPrevented) {
          // The first Escape clears the query; the next one reaches whatever is behind (a popover).
          e.preventDefault();
          e.stopPropagation();
          setText('');
        }
      }}
      {...rest}
    />
  );
}

export interface NumberFieldProps extends Omit<TextFieldProps, 'value' | 'defaultValue' | 'onChange' | 'onCommit' | 'type' | 'clearable' | 'min' | 'max' | 'step'> {
  value?: number;
  defaultValue?: number;
  /** Fires while stepping / scrubbing and when typed text is committed (Enter, blur). */
  onChange?: (value: number) => void;
  /** A gesture ended: text committed, a key step, the end of a scrub. */
  onChangeEnd?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimals shown and kept. Default: those of `step` (at least what was typed, up to 3). */
  precision?: number;
  /** Unit after the number ("px", "°"). */
  unit?: string;
  /** Short leading label ("X", "W"); dragging it left / right scrubs the value. */
  prefix?: string;
}

/**
 * A number typed as text: Enter or blur commits (clamped, rounded), Escape restores. Up / Down step
 * (Shift = 10 steps, Alt = a tenth); dragging the prefix scrubs.
 */
export function NumberField({
  value,
  defaultValue = 0,
  onChange,
  onChangeEnd,
  min,
  max,
  step = 1,
  precision,
  unit,
  prefix,
  onKeyDown,
  onBlur,
  onFocus,
  disabled,
  className,
  ...rest
}: NumberFieldProps) {
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const shown = formatNumber(current, { precision: precision ?? Math.max(decimalsOf(step), 3) });
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useLatest({ current, onChangeEnd });
  const scrub = useRef<{ id: number; x: number; start: number; moved: boolean } | null>(null);

  // A new value from outside replaces an untouched draft.
  useEffect(() => setDraft(null), [current]);

  const commit = (text: string): void => {
    const next = commitNumberInput(text, latest.current.current, { min, max, precision, step });
    setDraft(null);
    setCurrent(next);
    latest.current.onChangeEnd?.(next);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.currentTarget.value);
      e.currentTarget.select();
    } else if (e.key === 'Escape' && draft !== null) {
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = draft !== null ? commitNumberInput(draft, current, { min, max, precision, step }) : current;
      const next = stepNumber(base, e.key === 'ArrowUp' ? 1 : -1, { min, max, step, multiplier: e.shiftKey ? 10 : e.altKey ? 0.1 : 1 });
      setDraft(null);
      setCurrent(next);
      latest.current.onChangeEnd?.(next);
    }
  };

  const onScrubDown = (e: PointerEvent<HTMLSpanElement>): void => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { id: e.pointerId, x: e.clientX, start: current, moved: false };
    e.preventDefault();
  };
  const onScrubMove = (e: PointerEvent<HTMLSpanElement>): void => {
    const s = scrub.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    if (!s.moved && Math.abs(dx) < 3) return;
    s.moved = true;
    const amount = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    const decimals = Math.max(decimalsOf(step), decimalsOf(amount));
    setCurrent(clamp(roundTo(s.start + Math.round(dx / 2) * amount, decimals), min, max));
  };
  const onScrubUp = (e: PointerEvent<HTMLSpanElement>): void => {
    const s = scrub.current;
    if (!s || s.id !== e.pointerId) return;
    scrub.current = null;
    if (s.moved) latest.current.onChangeEnd?.(latest.current.current);
  };

  return (
    <TextField
      className={cx('r2-number-field', className)}
      inputMode="decimal"
      role="spinbutton"
      aria-valuenow={current}
      aria-valuemin={min}
      aria-valuemax={max}
      disabled={disabled}
      value={draft ?? shown}
      onChange={setDraft}
      onKeyDown={handleKey}
      onFocus={(e) => {
        onFocus?.(e);
        e.currentTarget.select();
      }}
      onBlur={(e) => {
        onBlur?.(e);
        if (draft !== null) commit(draft);
      }}
      trailing={unit ? <span className="r2-field-unit">{unit}</span> : undefined}
      leading={
        prefix ? (
          <span
            className="r2-field-prefix"
            aria-hidden="true"
            title={designStrings.dragToChange}
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubUp}
            onPointerCancel={onScrubUp}
          >
            {prefix}
          </span>
        ) : undefined
      }
      {...rest}
    />
  );
}
