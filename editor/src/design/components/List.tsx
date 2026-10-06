/**
 * List, ListSection and ListRow.
 *
 * Variants:
 * - 'inset'    grouped rows on a rounded plate, hairlines between them that start at the text
 *              (settings, inspector groups, forms);
 * - 'sidebar'  compact rows without plates, the selection is a rounded tinted fill (outliners,
 *              navigation); rows can be indented (`level`) and expandable for trees;
 * - 'plain'    full-width rows with hairlines.
 *
 * A row is: [disclosure] [icon] title / subtitle ... [trailing] [chevron]. With `onSelect` the title
 * area is a button; `trailing` holds independent controls (a switch, an eye toggle) next to it.
 *
 * Keyboard: Up / Down move between the rows of a list, Home / End jump; Right / Left expand and
 * collapse an expandable row.
 */
import { useId, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { rovingIndex } from '../logic/roving.js';
import { designStrings } from '../strings.js';
import { cx, isRtl } from '../util.js';
import './list.css';

export interface ListProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'inset' | 'sidebar' | 'plain';
  /** Row height: 'sm' for dense outliners, 'md' default. */
  size?: 'sm' | 'md';
}

export function List({ variant = 'inset', size = 'md', className, onKeyDown, children, ...rest }: ListProps) {
  const handleKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('r2-row-main')) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('button.r2-row-main:not(:disabled)')];
    const next = rovingIndex(e.key, rows.indexOf(target), rows.length, { orientation: 'vertical', loop: false });
    if (next === null) return;
    e.preventDefault();
    rows[next]!.focus();
  };
  return (
    <div role="list" className={cx('r2-list', className)} data-variant={variant} data-size={size} onKeyDown={handleKey} {...rest}>
      {children}
    </div>
  );
}

export interface ListSectionProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Section title (title-style capitalization, not all caps). */
  header?: ReactNode;
  /** Controls at the trailing end of the header. */
  headerTrailing?: ReactNode;
  /** Explanation under the group. */
  footer?: ReactNode;
}

export function ListSection({ header, headerTrailing, footer, className, children, ...rest }: ListSectionProps) {
  const id = useId();
  return (
    <div role="group" className={cx('r2-list-section', className)} aria-labelledby={header != null ? id : undefined} {...rest}>
      {(header != null || headerTrailing != null) && (
        <div className="r2-list-header">
          <span id={id} className="r2-list-header-title">
            {header}
          </span>
          {headerTrailing}
        </div>
      )}
      <div className="r2-list-group">{children}</div>
      {footer != null && <div className="r2-list-footer">{footer}</div>}
    </div>
  );
}

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect'> {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  /** Colour of the icon (a --r2-kind-* or system colour). Default: the tint. */
  iconColor?: string;
  /** Custom leading content instead of `icon` (a thumbnail, a colour well). */
  leading?: ReactNode;
  /** Trailing accessory: a value, a badge, a switch, icon buttons. A function receives the id of
   *  the title, to label a control with it (`aria-labelledby`). */
  trailing?: ReactNode | ((labelId: string) => ReactNode);
  /** Show a chevron: the row leads somewhere. */
  disclosure?: boolean;
  /** Makes the row a button. The event tells modifier keys (Shift / Ctrl-click to extend a selection). */
  onSelect?: (event: MouseEvent<HTMLButtonElement>) => void;
  selected?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  /** Tree indentation level (0 = top). */
  level?: number;
  /** Expandable row: shows a disclosure triangle; undefined = a leaf. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function ListRow({
  title,
  subtitle,
  icon,
  iconColor,
  leading,
  trailing,
  disclosure,
  onSelect,
  selected,
  disabled,
  destructive,
  level = 0,
  expanded,
  onExpandedChange,
  className,
  style,
  ...rest
}: ListRowProps) {
  const labelId = useId();
  const expandable = expanded !== undefined;

  const main = (
    <>
      {(icon || leading != null) && (
        <span className="r2-row-leading" style={iconColor ? { color: iconColor } : undefined}>
          {leading ?? <Icon name={icon!} size={16} />}
        </span>
      )}
      <span className="r2-row-text">
        <span id={labelId} className="r2-row-title">
          {title}
        </span>
        {subtitle != null && <span className="r2-row-subtitle">{subtitle}</span>}
      </span>
    </>
  );

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!expandable) return;
    const rtl = isRtl(e.currentTarget);
    const open = rtl ? 'ArrowLeft' : 'ArrowRight';
    const close = rtl ? 'ArrowRight' : 'ArrowLeft';
    if ((e.key === open && !expanded) || (e.key === close && expanded)) {
      e.preventDefault();
      onExpandedChange?.(!expanded);
    }
  };

  return (
    <div
      role="listitem"
      className={cx('r2-row', className)}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-destructive={destructive ? '' : undefined}
      data-interactive={onSelect ? '' : undefined}
      data-leading={icon || leading != null ? '' : undefined}
      data-two-line={subtitle != null ? '' : undefined}
      style={level > 0 ? ({ ...style, '--r2-row-level': level } as CSSProperties) : style}
      {...rest}
    >
      {expandable && (
        <button
          type="button"
          className="r2-row-expander"
          aria-label={expanded ? designStrings.collapse : designStrings.expand}
          aria-expanded={expanded}
          tabIndex={-1}
          onClick={() => onExpandedChange?.(!expanded)}
        >
          <Icon name="chevronRight" size={12} strokeWidth={2.4} />
        </button>
      )}
      {onSelect ? (
        <button
          type="button"
          className="r2-row-main"
          disabled={disabled}
          aria-current={selected ? 'true' : undefined}
          aria-expanded={expandable ? expanded : undefined}
          onClick={onSelect}
          onKeyDown={onKeyDown}
        >
          {main}
        </button>
      ) : (
        <div className="r2-row-main">{main}</div>
      )}
      {(trailing != null || disclosure) && (
        <div className="r2-row-trailing">
          {typeof trailing === 'function' ? trailing(labelId) : trailing}
          {disclosure && <Icon name="chevronRight" size={12} strokeWidth={2.4} className="r2-row-chevron" />}
        </div>
      )}
    </div>
  );
}
