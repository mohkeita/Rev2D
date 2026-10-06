/**
 * Placement of floating surfaces (menus, popovers, tooltips, selects) next to an anchor: preferred
 * side, flip when there is no room, shift along the edge to stay inside the viewport. Pure.
 */

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';
export type Placement = Side | `${Side}-${Align}`;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PositionOptions {
  /** Preferred side and alignment. Default 'bottom-start'. */
  placement?: Placement;
  /** Gap between the anchor and the surface, px. Default 6. */
  offset?: number;
  /** Space kept free along the viewport edges, px. Default 8. */
  margin?: number;
  /** Move to the opposite side when the surface does not fit. Default true. */
  flip?: boolean;
}

export interface Position {
  /** Top-left corner of the surface in viewport coordinates. */
  x: number;
  y: number;
  /** The side actually used (after flipping). */
  side: Side;
  align: Align;
  /** `transform-origin` that makes the surface grow out of its anchor. */
  origin: string;
  /** Space available on the chosen side: a max-height (top / bottom) or max-width (left / right). */
  available: number;
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

export function parsePlacement(placement: Placement = 'bottom-start'): { side: Side; align: Align } {
  const [side, align] = placement.split('-') as [Side, Align | undefined];
  return { side, align: align ?? 'center' };
}

/** Room for the surface on one side of the anchor. */
function spaceOn(side: Side, anchor: Rect, viewport: Rect, offset: number, margin: number): number {
  switch (side) {
    case 'top':
      return anchor.y - viewport.y - offset - margin;
    case 'bottom':
      return viewport.y + viewport.height - (anchor.y + anchor.height) - offset - margin;
    case 'left':
      return anchor.x - viewport.x - offset - margin;
    case 'right':
      return viewport.x + viewport.width - (anchor.x + anchor.width) - offset - margin;
  }
}

export function computePosition(anchor: Rect, floating: Size, viewport: Rect, opts: PositionOptions = {}): Position {
  const { offset = 6, margin = 8, flip = true } = opts;
  let { side, align } = parsePlacement(opts.placement);
  const vertical = side === 'top' || side === 'bottom';
  const needed = vertical ? floating.height : floating.width;

  let available = spaceOn(side, anchor, viewport, offset, margin);
  if (flip && available < needed) {
    const other = spaceOn(OPPOSITE[side], anchor, viewport, offset, margin);
    if (other > available) {
      side = OPPOSITE[side];
      available = other;
    }
  }

  let x: number;
  let y: number;
  if (vertical) {
    y = side === 'bottom' ? anchor.y + anchor.height + offset : anchor.y - offset - floating.height;
    x = align === 'start' ? anchor.x : align === 'end' ? anchor.x + anchor.width - floating.width : anchor.x + anchor.width / 2 - floating.width / 2;
  } else {
    x = side === 'right' ? anchor.x + anchor.width + offset : anchor.x - offset - floating.width;
    y = align === 'start' ? anchor.y : align === 'end' ? anchor.y + anchor.height - floating.height : anchor.y + anchor.height / 2 - floating.height / 2;
  }

  // Shift inside the viewport; a surface larger than the viewport sticks to the start edge.
  const minX = viewport.x + margin;
  const maxX = viewport.x + viewport.width - margin - floating.width;
  const minY = viewport.y + margin;
  const maxY = viewport.y + viewport.height - margin - floating.height;
  x = maxX < minX ? minX : Math.min(maxX, Math.max(minX, x));
  y = maxY < minY ? minY : Math.min(maxY, Math.max(minY, y));

  // Grow out of the anchor: the origin is the anchor's centre projected on the facing edge.
  const ax = Math.min(floating.width, Math.max(0, anchor.x + anchor.width / 2 - x));
  const ay = Math.min(floating.height, Math.max(0, anchor.y + anchor.height / 2 - y));
  const origin = vertical ? `${round(ax)}px ${side === 'bottom' ? '0px' : '100%'}` : `${side === 'right' ? '0px' : '100%'} ${round(ay)}px`;

  return { x: round(x), y: round(y), side, align, origin, available: Math.max(0, round(available)) };
}

function round(v: number): number {
  return Math.round(v * 2) / 2;
}

/** A point (context menus) as an anchor rectangle. */
export function pointRect(x: number, y: number): Rect {
  return { x, y, width: 0, height: 0 };
}
