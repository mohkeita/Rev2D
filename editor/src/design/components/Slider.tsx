/**
 * Slider: a value in a range, set by dragging the knob or the track.
 *
 * - `origin`: a neutral value inside the range (0 for a -30..30 angle); the track fills from it.
 * - `ticks`: marks on the track (a list of values, a count, or `true` for one per step).
 * - `showValue`: a bubble above the knob while dragging / focused ('auto'), or always.
 * - `resetValue`: double-click (or Alt-click) the slider to return to it (a parameter's default).
 *
 * Keyboard (role="slider" on the knob): arrows = one step, Shift + arrows and PageUp / PageDown = ten
 * steps, Home / End = the ends. `onChange` fires continuously, `onChangeEnd` once per gesture.
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { formatNumber } from '../logic/number.js';
import { fillSegment, pointerToRatio, ratioToValue, sliderKeyValue, tickRatios, valueToRatio } from '../logic/slider.js';
import { cx, isRtl, useControllable, useLatest } from '../util.js';
import './slider.css';

export interface SliderProps {
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  /** The gesture ended (pointer released, key pressed, reset): commit point for undo. */
  onChangeEnd?: (value: number) => void;
  origin?: number;
  ticks?: readonly number[] | number | boolean;
  showValue?: 'auto' | 'always' | 'never';
  formatValue?: (value: number) => string;
  resetValue?: number;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  id?: string;
  'data-testid'?: string;
  ref?: Ref<HTMLDivElement>;
}

export function Slider({
  value,
  defaultValue,
  min = 0,
  max = 1,
  step,
  onChange,
  onChangeEnd,
  origin,
  ticks,
  showValue = 'auto',
  formatValue,
  resetValue,
  disabled,
  size = 'md',
  className,
  id,
  ref,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
}: SliderProps) {
  const range = { min, max, step };
  const [current, setCurrent] = useControllable(value, defaultValue ?? resetValue ?? min, onChange);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; grabOffset: number; last: number } | null>(null);
  const latest = useLatest({ current, onChangeEnd });

  const ratio = valueToRatio(current, min, max);
  const fill = fillSegment(current, range, origin);
  const marks = tickRatios(ticks, range);
  const text = formatValue ? formatValue(current) : formatNumber(current, { step });

  const commit = (v: number): void => {
    setCurrent(v);
    latest.current.onChangeEnd?.(v);
  };

  const valueAt = (clientX: number, grabOffset: number): number => {
    const el = root.current!;
    const rect = el.getBoundingClientRect();
    const thumbWidth = thumb.current?.offsetWidth ?? 0;
    return ratioToValue(pointerToRatio(clientX, rect.left, rect.width, thumbWidth, grabOffset, isRtl(el)), range);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return;
    if (e.altKey && resetValue !== undefined) {
      e.preventDefault();
      commit(resetValue);
      return;
    }
    const t = thumb.current;
    let grabOffset = 0;
    if (t && e.target instanceof Node && t.contains(e.target)) {
      const r = t.getBoundingClientRect();
      grabOffset = e.clientX - (r.left + r.width / 2);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = valueAt(e.clientX, grabOffset);
    drag.current = { pointerId: e.pointerId, grabOffset, last: v };
    setDragging(true);
    setCurrent(v);
    t?.focus({ preventScroll: true });
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const v = valueAt(e.clientX, d.grabOffset);
    if (v !== d.last) {
      d.last = v;
      setCurrent(v);
    }
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    latest.current.onChangeEnd?.(d.last);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const next = sliderKeyValue(e.key, current, range, { shiftKey: e.shiftKey, rtl: isRtl(root.current) });
    if (next === null) return;
    e.preventDefault();
    if (next !== current) commit(next);
  };

  const style = {
    '--r2-slider-ratio': ratio,
    '--r2-slider-fill-start': fill.start,
    '--r2-slider-fill-end': fill.end,
  } as CSSProperties;

  return (
    <div
      ref={(node) => {
        root.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
      }}
      id={id}
      className={cx('r2-slider', className)}
      data-size={size}
      data-dragging={dragging ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-origin={origin === undefined ? 'min' : 'value'}
      data-show-value={showValue}
      data-testid={testId}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        if (!disabled && resetValue !== undefined) commit(resetValue);
      }}
    >
      <div className="r2-slider-track">
        <div className="r2-slider-fill" />
        {marks.map((m, i) => (
          <span key={i} className="r2-slider-tick" style={{ '--r2-slider-tick': m } as CSSProperties} />
        ))}
      </div>
      <div
        ref={thumb}
        className="r2-slider-thumb"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-orientation="horizontal"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={current}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
      >
        {showValue !== 'never' && (
          <span className="r2-slider-bubble r2-num" aria-hidden="true">
            {text}
          </span>
        )}
      </div>
    </div>
  );
}
