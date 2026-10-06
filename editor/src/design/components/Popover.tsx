/**
 * Popover: a transient panel attached to the control that opened it (options, a small inspector).
 * It grows out of its anchor, takes the focus, and closes on Escape, on a press outside, or when the
 * trigger is pressed again; the focus returns to the trigger. One popover at a time, never nested.
 *
 * Use it uncontrolled with `trigger`, or controlled with `open` + `anchor`.
 */
import { cloneElement, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from 'react';
import type { Placement } from '../logic/position.js';
import { cx, mergeRefs, useOutsidePress } from '../util.js';
import { useFocusScope } from './focus.js';
import { Floating, Layer, type Anchor } from './Layer.js';
import './popover.css';

type TriggerProps = Record<string, unknown> & { ref?: Ref<HTMLElement> };

export interface PopoverProps {
  /** The control that opens the popover: one element that accepts a ref and onClick. */
  trigger?: ReactElement;
  /** Controlled use without a trigger: what the popover is attached to. */
  anchor?: Anchor;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  offset?: number;
  /** Heading shown at the top (also the accessible name). Without it pass `aria-label`. */
  title?: ReactNode;
  'aria-label'?: string;
  width?: number | string;
  /** false: no inner padding (a list or custom layout that reaches the edges). */
  padded?: boolean;
  /** Content, or a function that receives `close`. */
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  'data-testid'?: string;
}

export function Popover({
  trigger,
  anchor,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  placement = 'bottom',
  offset = 8,
  title,
  width,
  padded = true,
  children,
  className,
  ...rest
}: PopoverProps) {
  const titleId = useId();
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const triggerEl = useRef<HTMLElement | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  const setOpen = (next: boolean): void => {
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };
  const close = (): void => setOpen(false);

  const scope = useFocusScope(surface, { active: open });
  useOutsidePress(open, [surface, triggerEl], close);

  let triggerNode: ReactNode = null;
  if (trigger) {
    const props = trigger.props as TriggerProps;
    triggerNode = cloneElement(trigger as ReactElement<TriggerProps>, {
      ref: mergeRefs<HTMLElement>(triggerEl, props.ref),
      'aria-haspopup': 'dialog',
      'aria-expanded': open,
      'data-open': open ? '' : undefined,
      onClick: (e: unknown) => {
        if (typeof props.onClick === 'function') (props.onClick as (e: unknown) => void)(e);
        setOpen(!open);
      },
    });
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed in a popover stay in it (no global shortcuts, no toolbar arrow navigation).
    e.stopPropagation();
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      close();
      return;
    }
    scope.onKeyDown(e);
  };

  const target = trigger ? triggerEl.current : anchor;

  return (
    <>
      {triggerNode}
      {open && target && (
        <Layer>
          <Floating
            ref={surface}
            anchor={target}
            placement={placement}
            offset={offset}
            className={cx('r2-popover r2-glass-panel', className)}
            role="dialog"
            aria-labelledby={title != null ? titleId : undefined}
            tabIndex={-1}
            data-padded={padded ? '' : undefined}
            style={width !== undefined ? ({ width } as CSSProperties) : undefined}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            {...rest}
          >
            {title != null && (
              <div id={titleId} className="r2-popover-title">
                {title}
              </div>
            )}
            <div className="r2-popover-body r2-scroll">{typeof children === 'function' ? children(close) : children}</div>
          </Floating>
        </Layer>
      )}
    </>
  );
}
