/**
 * Menu (opened by a trigger), ContextMenu (opened by right-click / the context-menu key) and the
 * MenuList both are made of (Select reuses it as a list box).
 *
 * Keyboard: Up / Down move, Home / End jump, typing a letter jumps to the next item that starts with
 * it, Enter / Space choose, Escape closes and returns the focus to the trigger, Tab closes.
 * Menus have one level: prefer a short flat menu over submenus.
 */
import { cloneElement, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from '../icons.js';
import { pointRect, type Placement } from '../logic/position.js';
import { rovingIndex, typeaheadIndex } from '../logic/roving.js';
import { cx, mergeRefs, useOutsidePress } from '../util.js';
import { Floating, Layer, type Anchor } from './Layer.js';
import './menu.css';

export interface MenuItem {
  type?: 'item';
  id: string;
  label: string;
  icon?: IconName;
  /** Keyboard shortcut shown at the trailing edge ("Ctrl+S"). */
  shortcut?: string;
  /** Secondary text under the label. */
  description?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** A toggled attribute: shows a checkmark when true (role menuitemcheckbox). */
  checked?: boolean;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | { type: 'separator' } | { type: 'label'; label: string };

export type MenuCloseReason = 'select' | 'escape' | 'outside' | 'tab';

export interface MenuListProps {
  items: readonly MenuEntry[];
  anchor: Anchor;
  placement?: Placement;
  offset?: number;
  onClose: (reason: MenuCloseReason) => void;
  /** Called with the id of the chosen item (after its own onSelect). */
  onAction?: (id: string) => void;
  /** Which item is focused when the menu opens. */
  initialFocus?: 'first' | 'last' | 'selected';
  /** 'listbox': a single-choice list (Select); the item with `selectedId` is marked. */
  role?: 'menu' | 'listbox';
  selectedId?: string;
  matchWidth?: boolean;
  /** Elements that count as "inside" for outside-press dismissal (the trigger). */
  ignore?: ReadonlyArray<{ readonly current: Element | null }>;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

function isItem(e: MenuEntry): e is MenuItem {
  return e.type === undefined || e.type === 'item';
}

export function MenuList({
  items,
  anchor,
  placement = 'bottom-start',
  offset = 6,
  onClose,
  onAction,
  initialFocus = 'first',
  role = 'menu',
  selectedId,
  matchWidth,
  ignore = [],
  className,
  ...rest
}: MenuListProps) {
  const root = useRef<HTMLDivElement>(null);
  const actionable = items.map((e, i) => (isItem(e) ? i : -1)).filter((i) => i >= 0);
  const enabled = (i: number): boolean => isItem(items[i]!) && !(items[i] as MenuItem).disabled;
  const [active, setActive] = useState<number>(() => {
    if (initialFocus === 'selected' && selectedId !== undefined) {
      const s = items.findIndex((e) => isItem(e) && e.id === selectedId && !e.disabled);
      if (s >= 0) return s;
    }
    const list = actionable.filter(enabled);
    return (initialFocus === 'last' ? list[list.length - 1] : list[0]) ?? -1;
  });
  const typed = useRef({ text: '', at: 0 });
  const checkable = items.some((e) => isItem(e) && e.checked !== undefined) || role === 'listbox';

  // After the layout phase: the surface is hidden (unfocusable) until Floating positioned it.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const target = active >= 0 ? el.querySelector<HTMLElement>(`[data-index="${active}"]`) : el;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  useOutsidePress(true, [root, ...ignore], () => onClose('outside'));

  const choose = (i: number): void => {
    const item = items[i];
    if (!item || !isItem(item) || item.disabled) return;
    item.onSelect?.();
    onAction?.(item.id);
    onClose('select');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed in a menu never reach the application's global shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose('escape');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      onClose('tab');
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (active >= 0) choose(active);
      return;
    }
    const pos = actionable.indexOf(active);
    const next = rovingIndex(e.key, pos, actionable.length, { orientation: 'vertical', isDisabled: (n) => !enabled(actionable[n]!) });
    if (next !== null) {
      e.preventDefault();
      setActive(actionable[next]!);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = performance.now();
      typed.current = { text: now - typed.current.at > 600 ? e.key : typed.current.text + e.key, at: now };
      const labels = actionable.map((i) => (items[i] as MenuItem).label);
      const hit = typeaheadIndex(labels, typed.current.text, pos, (n) => !enabled(actionable[n]!));
      if (hit !== null) {
        e.preventDefault();
        setActive(actionable[hit]!);
      }
    }
  };

  return (
    <Layer>
      <Floating
        ref={root}
        anchor={anchor}
        placement={placement}
        offset={offset}
        matchWidth={matchWidth}
        className={cx('r2-menu r2-glass-panel r2-scroll', className)}
        role={role}
        aria-orientation="vertical"
        tabIndex={-1}
        data-checkable={checkable ? '' : undefined}
        onKeyDown={onKeyDown}
        // React events bubble through the portal to the component that rendered the menu: a click on
        // an item must not also click the row or toolbar the menu belongs to.
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        {...rest}
      >
        {items.map((entry, i) => {
          if (entry.type === 'separator') return <div key={i} className="r2-menu-separator" role="separator" />;
          if (entry.type === 'label') {
            return (
              <div key={i} className="r2-menu-label" role="presentation">
                {entry.label}
              </div>
            );
          }
          const selected = role === 'listbox' ? entry.id === selectedId : entry.checked === true;
          const itemRole = role === 'listbox' ? 'option' : entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
          return (
            <div
              key={entry.id}
              role={itemRole}
              className="r2-menu-item"
              tabIndex={-1}
              data-index={i}
              data-active={i === active ? '' : undefined}
              data-destructive={entry.destructive ? '' : undefined}
              aria-disabled={entry.disabled || undefined}
              aria-checked={itemRole === 'menuitemcheckbox' ? selected : undefined}
              aria-selected={itemRole === 'option' ? selected : undefined}
              onPointerMove={() => {
                if (!entry.disabled && active !== i) setActive(i);
              }}
              onClick={() => choose(i)}
            >
              {checkable && <span className="r2-menu-check">{selected && <Icon name="check" size={14} strokeWidth={2.4} />}</span>}
              {entry.icon && <Icon name={entry.icon} size={16} className="r2-menu-icon" />}
              <span className="r2-menu-text">
                <span className="r2-menu-title">{entry.label}</span>
                {entry.description && <span className="r2-menu-description">{entry.description}</span>}
              </span>
              {entry.shortcut && <kbd className="r2-menu-shortcut">{entry.shortcut}</kbd>}
            </div>
          );
        })}
      </Floating>
    </Layer>
  );
}

type TriggerProps = Record<string, unknown> & { ref?: Ref<HTMLElement> };

export interface MenuProps {
  items: readonly MenuEntry[];
  /** The trigger: one element that accepts a ref, onClick and onKeyDown (Button, IconButton). */
  children: ReactElement;
  placement?: Placement;
  onAction?: (id: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  'aria-label'?: string;
  className?: string;
}

/** A menu attached to a trigger. Click, Enter, Space or Down opens it; Up opens it at the last item. */
export function Menu({ items, children, placement = 'bottom-start', onAction, open: openProp, onOpenChange, className, ...rest }: MenuProps) {
  const id = useId();
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const [focusAt, setFocusAt] = useState<'first' | 'last'>('first');
  const trigger = useRef<HTMLElement | null>(null);

  const setOpen = (next: boolean): void => {
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };

  const props = children.props as TriggerProps;
  const call = (name: string, e: unknown): void => {
    const fn = props[name];
    if (typeof fn === 'function') (fn as (e: unknown) => void)(e);
  };

  const child = cloneElement(children as ReactElement<TriggerProps>, {
    ref: mergeRefs<HTMLElement>(trigger, props.ref),
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    'data-open': open ? '' : undefined,
    onClick: (e: unknown) => {
      call('onClick', e);
      setFocusAt('first');
      setOpen(!open);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      call('onKeyDown', e);
      if (e.defaultPrevented || open) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusAt(e.key === 'ArrowUp' ? 'last' : 'first');
        setOpen(true);
      }
    },
  });

  return (
    <>
      {child}
      {open && (
        <MenuList
          id={id}
          items={items}
          anchor={trigger.current}
          placement={placement}
          initialFocus={focusAt}
          ignore={[trigger]}
          onAction={onAction}
          className={className}
          onClose={(reason) => {
            setOpen(false);
            // An outside press moves the focus itself; every other way of closing returns it.
            if (reason !== 'outside') trigger.current?.focus({ preventScroll: true });
          }}
          {...rest}
        />
      )}
    </>
  );
}

export interface ContextMenuProps {
  /** The items, or a function called when the menu opens (items that depend on what was clicked). */
  items: readonly MenuEntry[] | ((target: Element) => readonly MenuEntry[]);
  children: ReactNode;
  onAction?: (id: string) => void;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
}

/**
 * Wraps content that has a context menu: right-click, long-press, or the context-menu key / Shift+F10
 * on a focused element inside it. The wrapper does not affect layout (display: contents).
 */
export function ContextMenu({ items, children, onAction, disabled, className, ...rest }: ContextMenuProps) {
  const [state, setState] = useState<{ anchor: Anchor; items: readonly MenuEntry[]; from: HTMLElement | null } | null>(null);

  return (
    <div
      className="r2-context-target"
      onContextMenu={(e) => {
        if (disabled) return;
        const target = e.target as Element;
        const list = typeof items === 'function' ? items(target) : items;
        if (list.length === 0) return;
        e.preventDefault();
        // The keyboard sends the event without a pointer position: open at the focused element.
        const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
        const r = target.getBoundingClientRect();
        const anchor = keyboard ? pointRect(r.left + Math.min(24, r.width / 2), r.top + r.height) : pointRect(e.clientX, e.clientY);
        setState({ anchor, items: list, from: document.activeElement instanceof HTMLElement ? document.activeElement : null });
      }}
    >
      {children}
      {state && (
        <MenuList
          items={state.items}
          anchor={state.anchor}
          placement="bottom-start"
          offset={2}
          onAction={onAction}
          className={className}
          onClose={(reason) => {
            const from = state.from;
            setState(null);
            if (reason !== 'outside' && from?.isConnected) from.focus({ preventScroll: true });
          }}
          {...rest}
        />
      )}
    </div>
  );
}
