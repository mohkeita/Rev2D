/**
 * Toolbar: controls that float above the canvas in glass capsules.
 *
 *   <Toolbar aria-label="Editor">
 *     <ToolbarGroup aria-label="Document"> <IconButton .../> <ToolbarTitle title="hana" /> </ToolbarGroup>
 *     <ToolbarSpacer />
 *     <ToolbarGroup aria-label="Tools"> ... </ToolbarGroup>
 *     <ToolbarSpacer />
 *     <ToolbarGroup> ... </ToolbarGroup>
 *     <Button variant="filled" shape="capsule">Done</Button>
 *   </Toolbar>
 *
 * Group by function, at most three groups plus one tinted primary action on the trailing side. Icon
 * buttons and text buttons do not share a capsule. The toolbar has no background of its own: the
 * canvas shows between the groups.
 *
 * Keyboard: Tab enters and leaves; Left / Right (Home / End) move between the controls.
 */
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { rovingIndex } from '../logic/roving.js';
import { cx, focusablesIn, isRtl } from '../util.js';
import './toolbar.css';

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** 'lg' (default): 44 px capsules for the main bar. 'md': 36 px for secondary bars. */
  size?: 'md' | 'lg';
  orientation?: 'horizontal' | 'vertical';
}

export function Toolbar({ size = 'lg', orientation = 'horizontal', className, onKeyDown, children, ...rest }: ToolbarProps) {
  const handleKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    // Only keys from the toolbar's own controls (not from a popover it opened, not from text fields).
    if (!e.currentTarget.contains(target) || target.closest('input, textarea, select, [role="slider"], [role="radiogroup"], [role="tablist"], [contenteditable="true"]')) return;
    const items = focusablesIn(e.currentTarget);
    const next = rovingIndex(e.key, items.indexOf(target), items.length, { orientation, rtl: isRtl(e.currentTarget), loop: false });
    if (next === null) return;
    e.preventDefault();
    items[next]!.focus();
  };
  return (
    <div role="toolbar" aria-orientation={orientation} className={cx('r2-toolbar', className)} data-size={size} data-orientation={orientation} onKeyDown={handleKey} {...rest}>
      {children}
    </div>
  );
}

export interface ToolbarGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** false: no glass capsule (controls that bring their own surface). */
  glass?: boolean;
}

export function ToolbarGroup({ glass = true, className, children, ...rest }: ToolbarGroupProps) {
  return (
    <div role="group" className={cx('r2-toolbar-group', glass && 'r2-glass', className)} {...rest}>
      {children}
    </div>
  );
}

/** Flexible space between groups (pushes them apart), or a fixed gap with `size`. */
export function ToolbarSpacer({ size }: { size?: number }) {
  return <div className="r2-toolbar-spacer" aria-hidden="true" style={size !== undefined ? { flex: 'none', width: size, height: size } : undefined} />;
}

/** A thin divider between two sets of controls inside one group. */
export function ToolbarSeparator() {
  return <div className="r2-toolbar-separator" role="separator" aria-orientation="vertical" />;
}

export interface ToolbarTitleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  subtitle?: ReactNode;
}

/** The document or view title inside a group (keep it short: a name, not a sentence). */
export function ToolbarTitle({ title, subtitle, className, ...rest }: ToolbarTitleProps) {
  return (
    <div className={cx('r2-toolbar-title', className)} {...rest}>
      <span className="r2-toolbar-title-text">{title}</span>
      {subtitle != null && <span className="r2-toolbar-subtitle">{subtitle}</span>}
    </div>
  );
}
