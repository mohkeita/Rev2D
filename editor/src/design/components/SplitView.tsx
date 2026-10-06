/**
 * SplitView: a main area (the canvas) with panes docked to its edges: sidebar, inspector, timeline.
 * Panes are resizable (drag the divider, or focus it and use the arrow keys) and collapsible (drag
 * past the minimum, press Enter on the divider, or set `collapsed` from a toolbar button).
 *
 * - docked (default): panes and the main area tile the view, thin dividers between them;
 * - `floating`: the main area is full-bleed and the panes float above it, inset by `gap` (put glass
 *   panels in them). The space the panes cover is published on the root as --r2-safe-top / -right /
 *   -bottom / -left so the canvas can centre its subject in the uncovered part.
 *
 * Panes claim their edge in array order (see logic/dock.ts): list a full-width bottom drawer first,
 * or last to fit it between the side panes.
 */
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  dockKeyAction,
  dragDelta,
  initialDockState,
  layoutDock,
  resizeDock,
  toggleDock,
  type DockEdge,
  type DockPaneLayout,
  type DockPaneSpec,
  type DockState,
} from '../logic/dock.js';
import { designStrings } from '../strings.js';
import { cx, isRtl, useElementSize, useLatest } from '../util.js';
import './splitview.css';

export interface SplitPane extends DockPaneSpec {
  content: ReactNode;
  /** Name of the pane for its divider ("Sidebar", "Inspector", "Timeline"). */
  label: string;
  /** Accessible name of the divider. Default: "Resize <label>" (see setDesignStrings). */
  dividerLabel?: string;
  /** false: fixed size, no divider. Default true. */
  resizable?: boolean;
  /** Presses between the pane's children reach the main area (a toolbar of separate glass groups). */
  passthrough?: boolean;
}

export interface SplitViewProps {
  panes: readonly SplitPane[];
  /** The main area. */
  children: ReactNode;
  floating?: boolean;
  /** Floating: inset of the panes (default 12). Docked: thickness of the dividers (default 1). */
  gap?: number;
  /** Controlled sizes and collapsed flags; omit for internal state. */
  state?: DockState;
  onStateChange?: (state: DockState) => void;
  /** Ids of the panes that start collapsed (uncontrolled). */
  defaultCollapsed?: readonly string[];
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

function paneStyle(p: DockPaneLayout, rtl: boolean): CSSProperties {
  const leadingSide = rtl ? 'right' : 'left';
  const trailingSide = rtl ? 'left' : 'right';
  const { top, right, bottom, left } = p.inset;
  switch (p.edge) {
    case 'leading':
      return { top, bottom, [leadingSide]: left, width: p.size };
    case 'trailing':
      return { top, bottom, [trailingSide]: right, width: p.size };
    case 'top':
      return { top, [leadingSide]: left, [trailingSide]: right, height: p.size };
    case 'bottom':
      return { bottom, [leadingSide]: left, [trailingSide]: right, height: p.size };
  }
}

/** The divider sits on the inner edge of its pane (at the container edge when collapsed). */
function dividerStyle(p: DockPaneLayout, thickness: number, rtl: boolean): CSSProperties {
  const leadingSide = rtl ? 'right' : 'left';
  const trailingSide = rtl ? 'left' : 'right';
  const { top, right, bottom, left } = p.inset;
  const extent = p.collapsed ? 0 : p.size;
  switch (p.edge) {
    case 'leading':
      return { top, bottom, [leadingSide]: left + extent, width: thickness };
    case 'trailing':
      return { top, bottom, [trailingSide]: right + extent, width: thickness };
    case 'top':
      return { [leadingSide]: left, [trailingSide]: right, top: top + extent, height: thickness };
    case 'bottom':
      return { [leadingSide]: left, [trailingSide]: right, bottom: bottom + extent, height: thickness };
  }
}

export function SplitView({ panes, children, floating = false, gap, state: stateProp, onStateChange, defaultCollapsed, className, style, ...rest }: SplitViewProps) {
  const [inner, setInner] = useState<DockState>(() => initialDockState(panes, defaultCollapsed));
  const state = stateProp ?? inner;
  const [measureRef, size] = useElementSize<HTMLDivElement>();
  const root = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<{ id: string; pointerId: number; x: number; y: number; start: number; edge: DockEdge } | null>(null);
  const thickness = gap ?? (floating ? 12 : 1);
  const layout = useMemo(() => layoutDock(panes, state, size, { floating, gap: thickness }), [panes, state, size, floating, thickness]);
  const latest = useLatest({ state, panes, size, onStateChange, controlled: stateProp !== undefined });
  const rtl = isRtl(root.current);

  const update = (next: DockState): void => {
    const l = latest.current;
    if (next === l.state) return;
    if (!l.controlled) setInner(next);
    l.onStateChange?.(next);
  };

  const onDividerDown = (e: PointerEvent<HTMLDivElement>, p: DockPaneLayout): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: p.id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, start: p.collapsed ? 0 : p.size, edge: p.edge };
    setDragging(p.id);
    e.preventDefault();
  };
  const onDividerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const l = latest.current;
    const delta = dragDelta(d.edge, e.clientX - d.x, e.clientY - d.y, isRtl(root.current));
    update(resizeDock(l.panes, l.state, d.id, d.start + delta, l.size));
  };
  const onDividerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(null);
  };

  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>, p: DockPaneLayout, spec: SplitPane): void => {
    const action = dockKeyAction(p.edge, e.key, { shiftKey: e.shiftKey, rtl: isRtl(root.current) });
    if (!action) return;
    e.preventDefault();
    const l = latest.current;
    if (action.type === 'toggle') {
      if (spec.collapsible) update(toggleDock(l.state, p.id));
    } else if (action.type === 'min') update(resizeDock(l.panes, l.state, p.id, p.min, l.size));
    else if (action.type === 'max') update(resizeDock(l.panes, l.state, p.id, p.max, l.size));
    else update(resizeDock(l.panes, l.state, p.id, (p.collapsed ? 0 : p.size) + action.delta, l.size));
  };

  const rootStyle = {
    ...style,
    '--r2-safe-top': `${layout.safe.top}px`,
    '--r2-safe-right': `${rtl ? layout.safe.left : layout.safe.right}px`,
    '--r2-safe-bottom': `${layout.safe.bottom}px`,
    '--r2-safe-left': `${rtl ? layout.safe.right : layout.safe.left}px`,
  } as CSSProperties;

  const m = layout.main;
  const mainStyle: CSSProperties = { top: m.top, bottom: m.bottom, [rtl ? 'right' : 'left']: m.left, [rtl ? 'left' : 'right']: m.right };

  return (
    <div
      ref={(node) => {
        root.current = node;
        measureRef(node);
      }}
      className={cx('r2-split', className)}
      data-floating={floating ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      style={rootStyle}
      {...rest}
    >
      <div className="r2-split-main" style={mainStyle}>
        {children}
      </div>
      {layout.panes.map((p, i) => {
        const spec = panes[i]!;
        const resizable = spec.resizable !== false && (spec.max > spec.min || spec.collapsible === true);
        return (
          <div key={p.id} className="r2-split-slot" data-edge={p.edge} data-pane={p.id}>
            <div className="r2-split-pane" data-collapsed={p.collapsed ? '' : undefined} data-passthrough={spec.passthrough ? '' : undefined} style={paneStyle(p, rtl)} inert={p.collapsed || undefined}>
              {spec.content}
            </div>
            {resizable && (
              <div
                className="r2-split-divider"
                role="separator"
                tabIndex={0}
                aria-label={spec.dividerLabel ?? designStrings.resize(spec.label)}
                aria-orientation={p.edge === 'leading' || p.edge === 'trailing' ? 'vertical' : 'horizontal'}
                aria-valuemin={spec.collapsible ? 0 : Math.round(p.min)}
                aria-valuemax={Math.round(p.max)}
                aria-valuenow={p.collapsed ? 0 : Math.round(p.size)}
                data-active={dragging === p.id ? '' : undefined}
                data-collapsed={p.collapsed ? '' : undefined}
                style={dividerStyle(p, thickness, rtl)}
                onPointerDown={(e) => onDividerDown(e, p)}
                onPointerMove={onDividerMove}
                onPointerUp={onDividerUp}
                onPointerCancel={onDividerUp}
                onDoubleClick={() => update(resizeDock(latest.current.panes, latest.current.state, p.id, spec.size, latest.current.size))}
                onKeyDown={(e) => onDividerKey(e, p, spec)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
