/**
 * Layer: a portal into <body> for surfaces that float above the page (menus, popovers, sheets,
 * toasts, tooltips), and Floating: a surface positioned next to an anchor.
 *
 * A portal leaves the DOM subtree it is used in, so the layer copies the appearance scope of that
 * subtree (data-appearance, data-contrast, data-transparency, data-materials, data-motion, lang,
 * dir): a menu opened inside a dark preview is dark.
 */
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { computePosition, type Placement, type Position, type Rect } from '../logic/position.js';
import { cx, mergeRefs } from '../util.js';
import './layer.css';

const SCOPE_ATTRIBUTES = ['data-appearance', 'data-contrast', 'data-transparency', 'data-materials', 'data-motion', 'lang', 'dir'] as const;

export interface LayerProps {
  children: ReactNode;
  /** Stacking level: overlays stack in the order they open; toasts and tooltips sit above them. */
  level?: 'overlay' | 'toast' | 'tooltip';
  className?: string;
}

export function Layer({ children, level = 'overlay', className }: LayerProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const layer = useRef<HTMLDivElement>(null);

  // The scope is copied onto the portal root imperatively, in the commit that mounts it: the content
  // must be in the document (and focusable) by the time the effects of that commit run.
  useLayoutEffect(() => {
    const el = marker.current;
    const root = layer.current;
    if (!el || !root) return;
    for (const attr of SCOPE_ATTRIBUTES) {
      const owner = el.closest(`[${attr}]`);
      const value = owner?.getAttribute(attr);
      if (owner && owner !== document.documentElement && value) root.setAttribute(attr, value);
      else root.removeAttribute(attr);
    }
  });

  return (
    <>
      <span ref={marker} hidden data-r2-layer-marker="" />
      {createPortal(
        <div ref={layer} className={cx('r2-layer', className)} data-level={level}>
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** What a floating surface is attached to: an element, or a rectangle / point in viewport coordinates. */
export type Anchor = Element | Rect | null | undefined;

export function anchorRect(anchor: Anchor): Rect | null {
  if (!anchor) return null;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return anchor;
}

export interface FloatingProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  anchor: Anchor;
  placement?: Placement;
  /** Gap to the anchor in px. */
  offset?: number;
  /** Give the surface at least the width of its anchor (selects). */
  matchWidth?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/**
 * A fixed-position surface that follows its anchor (re-measured on scroll, resize and when its own
 * size changes). It sets `data-side`, `data-positioned` and the custom properties
 * --r2-floating-origin and --r2-floating-available (space on the chosen side) on the element.
 */
export function Floating({ anchor, placement = 'bottom-start', offset = 6, matchWidth, children, className, style, ref, ...rest }: FloatingProps) {
  const el = useRef<HTMLDivElement>(null);

  // Positioned imperatively in the layout phase (no state, no second render): the surface is visible
  // and focusable when the effects of the commit that mounted it run.
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    let last: Position | null = null;
    const update = (): void => {
      const a = anchorRect(anchor);
      if (!a) return;
      const viewport = { x: 0, y: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      if (matchWidth) node.style.minWidth = `${a.width}px`;
      // offsetWidth / offsetHeight ignore the scale of the entry animation.
      const next = computePosition(a, { width: node.offsetWidth, height: node.offsetHeight }, viewport, { placement, offset });
      if (last && last.x === next.x && last.y === next.y && last.side === next.side && last.origin === next.origin && last.available === next.available) return;
      last = next;
      node.style.left = `${next.x}px`;
      node.style.top = `${next.y}px`;
      node.style.setProperty('--r2-floating-origin', next.origin);
      node.style.setProperty('--r2-floating-available', `${next.available}px`);
      node.dataset.side = next.side;
      node.dataset.positioned = '';
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (anchor instanceof Element) observer.observe(anchor);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, placement, offset, matchWidth]);

  return (
    <div ref={mergeRefs(el, ref)} className={cx('r2-floating', className)} style={style} {...rest}>
      {children}
    </div>
  );
}
