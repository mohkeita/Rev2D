/**
 * Stepper: minus / plus buttons that change a number by one step. Hold a button to repeat. Pair it
 * with a visible value (a NumberField, or the title of the row it sits in).
 */
import { useEffect, useRef, type HTMLAttributes, type Ref } from 'react';
import { Icon } from '../icons.js';
import { stepNumber } from '../logic/number.js';
import { cx, useControllable, useLatest } from '../util.js';
import './stepper.css';

export interface StepperProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Names of the two buttons, e.g. "Decrease z" / "Increase z". */
  decrementLabel?: string;
  incrementLabel?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Hold-to-repeat timing: first repeat after 400 ms, then accelerating to 20 per second. */
export function repeatDelay(count: number): number {
  return count === 0 ? 400 : Math.max(50, 140 - count * 10);
}

export function Stepper({
  value,
  defaultValue = 0,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  size = 'md',
  disabled,
  decrementLabel = 'Decrease',
  incrementLabel = 'Increase',
  className,
  ...rest
}: StepperProps) {
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const latest = useLatest({ current, setCurrent, min, max, step });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The press already stepped by repeating: the click that ends it must not step once more. */
  const repeated = useRef(false);

  const stop = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const nudge = (direction: 1 | -1): boolean => {
    const l = latest.current;
    const next = stepNumber(l.current, direction, { min: l.min, max: l.max, step: l.step });
    if (next === l.current) return false;
    l.setCurrent(next);
    return true;
  };

  const start = (direction: 1 | -1): void => {
    stop();
    repeated.current = false;
    let count = 0;
    const tick = (): void => {
      repeated.current = true;
      // The value arrives through props one render later: wait for it before the next step.
      if (!nudge(direction)) return stop();
      timer.current = setTimeout(tick, repeatDelay(++count));
    };
    timer.current = setTimeout(tick, repeatDelay(0));
  };

  const button = (direction: 1 | -1) => {
    const atLimit = direction < 0 ? current <= min : current >= max;
    return (
      <button
        type="button"
        className="r2-stepper-button r2-hit"
        aria-label={direction < 0 ? decrementLabel : incrementLabel}
        disabled={disabled || atLimit}
        onPointerDown={(e) => {
          if (e.button === 0) start(direction);
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onBlur={stop}
        onClick={() => {
          if (repeated.current) repeated.current = false;
          else nudge(direction);
        }}
      >
        <Icon name={direction < 0 ? 'minus' : 'plus'} size={size === 'sm' ? 12 : 14} strokeWidth={2.25} />
      </button>
    );
  };

  return (
    <div role="group" className={cx('r2-stepper', className)} data-size={size} data-disabled={disabled ? '' : undefined} {...rest}>
      {button(-1)}
      <span className="r2-stepper-divider" aria-hidden="true" />
      {button(1)}
    </div>
  );
}
