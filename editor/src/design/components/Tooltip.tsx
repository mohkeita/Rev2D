/**
 * Tooltip: a short label (and optional keyboard shortcut) for a control, shown after a hover delay
 * and immediately on keyboard focus. Wrap exactly one element that accepts a ref and event props.
 * After one tooltip has shown, the next ones appear without delay for a moment (scanning a toolbar).
 */
import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import type { Placement } from '../logic/position.js';
import { mergeRefs } from '../util.js';
import { Floating, Layer } from './Layer.js';
import './tooltip.css';

export interface TooltipProps {
  label: ReactNode;
  /** Shortcut shown after the label, e.g. "Ctrl+S" or "Space". */
  shortcut?: string;
  placement?: Placement;
  /** Hover delay in ms. Default 600. */
  delay?: number;
  disabled?: boolean;
  /**
   * false: the tooltip repeats the accessible name of its target (an icon button's label), so it is
   * not also announced as its description. Default true.
   */
  describes?: boolean;
  children: ReactElement;
}

type AnyProps = Record<string, unknown> & { ref?: Ref<HTMLElement> };

/** Time of the last tooltip hide: a new hover within 400 ms skips the delay. */
let lastHidden = 0;

export function Tooltip({ label, shortcut, placement = 'bottom', delay = 600, disabled, describes = true, children }: TooltipProps) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (wait: number): void => {
    cancel();
    if (disabled) return;
    const skip = performance.now() - lastHidden < 400;
    if (wait <= 0 || skip) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), wait);
  };
  const hide = (): void => {
    cancel();
    setOpen((was) => {
      if (was) lastHidden = performance.now();
      return false;
    });
  };

  useEffect(() => cancel, []);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled]);

  const props = children.props as AnyProps;
  const call = (name: string, e: unknown): void => {
    const fn = props[name];
    if (typeof fn === 'function') (fn as (e: unknown) => void)(e);
  };

  const child = cloneElement(children as ReactElement<AnyProps>, {
    ref: mergeRefs<HTMLElement>(setAnchor, props.ref),
    'aria-describedby': open && describes ? id : (props['aria-describedby'] as string | undefined),
    onPointerEnter: (e: { pointerType?: string }) => {
      call('onPointerEnter', e);
      if (e.pointerType !== 'touch') show(delay);
    },
    onPointerLeave: (e: unknown) => {
      call('onPointerLeave', e);
      hide();
    },
    onPointerDown: (e: unknown) => {
      call('onPointerDown', e);
      hide();
    },
    onFocus: (e: { target: Element }) => {
      call('onFocus', e);
      if (e.target instanceof Element && e.target.matches(':focus-visible')) show(0);
    },
    onBlur: (e: unknown) => {
      call('onBlur', e);
      hide();
    },
    onKeyDown: (e: { key: string }) => {
      call('onKeyDown', e);
      if (e.key === 'Escape') hide();
    },
  });

  return (
    <>
      {child}
      {open && anchor && (
        <Layer level="tooltip">
          <Floating anchor={anchor} placement={placement} offset={8} className="r2-tooltip" role="tooltip" id={id}>
            <span>{label}</span>
            {shortcut && <kbd className="r2-tooltip-shortcut">{shortcut}</kbd>}
          </Floating>
        </Layer>
      )}
    </>
  );
}
