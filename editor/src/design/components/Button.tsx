/**
 * Button and IconButton.
 *
 * Styles (pick by importance, not by size): `filled` for the one primary action of a view, `tinted`
 * for secondary emphasis, `gray` for ordinary actions, `plain` for the least weight, `glass` for a
 * control that floats alone over the canvas. `destructive` recolours any of them red; a destructive
 * action is never the default button of a dialog.
 *
 * Shapes: small and medium controls are rounded rectangles (dense inspector rows), large and
 * extra-large ones are capsules; `shape` overrides.
 */
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import { Icon, type IconName } from '../icons.js';
import type { Placement } from '../logic/position.js';
import { cx } from '../util.js';
import { Spinner } from './ProgressView.js';
import { Tooltip } from './Tooltip.js';
import './button.css';

export type ButtonVariant = 'filled' | 'tinted' | 'gray' | 'plain' | 'glass';
export type ControlSize = 'sm' | 'md' | 'lg' | 'xl';

const ICON_SIZE: Record<ControlSize, number> = { sm: 14, md: 16, lg: 18, xl: 20 };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Default: 'rounded' for sm / md, 'capsule' for lg / xl. */
  shape?: 'rounded' | 'capsule';
  /** A destructive action (delete, discard): red. */
  destructive?: boolean;
  /** Leading icon. */
  icon?: IconName;
  trailingIcon?: IconName;
  /** Shows a spinner in place of the leading icon and ignores presses; the button keeps the focus. */
  loading?: boolean;
  /** Fill the width of the container. */
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'gray',
  size = 'md',
  shape,
  destructive,
  icon,
  trailingIcon,
  loading,
  block,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      type={type}
      className={cx('r2-button r2-hit', variant === 'glass' && 'r2-glass', className)}
      data-variant={variant}
      data-size={size}
      data-shape={shape ?? (size === 'lg' || size === 'xl' ? 'capsule' : 'rounded')}
      data-destructive={destructive ? '' : undefined}
      data-block={block ? '' : undefined}
      data-loading={loading ? '' : undefined}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Spinner size={ICON_SIZE[size]} /> : icon ? <Icon name={icon} size={ICON_SIZE[size]} /> : null}
      {children != null && children !== false && <span className="r2-button-label">{children}</span>}
      {trailingIcon && <Icon name={trailingIcon} size={ICON_SIZE[size]} />}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: IconName;
  /** Accessible name; also the tooltip. Required: an icon alone says nothing to a screen reader. */
  label: string;
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
  variant?: ButtonVariant;
  size?: ControlSize;
  shape?: 'circle' | 'rounded';
  /** A toggle: `aria-pressed`, shown with the tint when on. */
  pressed?: boolean;
  destructive?: boolean;
  /** false: no tooltip (the label is still the accessible name). */
  tooltip?: boolean | Placement;
  /** Replace the glyph (a custom SVG, a spinner). */
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon,
  label,
  shortcut,
  variant = 'plain',
  size = 'md',
  shape = 'circle',
  pressed,
  destructive,
  tooltip = true,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      className={cx('r2-button r2-icon-button r2-hit', variant === 'glass' && 'r2-glass', className)}
      data-variant={variant}
      data-size={size}
      data-shape={shape === 'circle' ? 'capsule' : 'rounded'}
      data-destructive={destructive ? '' : undefined}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut ? shortcut.replace(/Ctrl/g, 'Control') : undefined}
      {...rest}
    >
      {children ?? <Icon name={icon} size={ICON_SIZE[size] + 2} />}
    </button>
  );
  if (tooltip === false) return button;
  return (
    <Tooltip label={label} shortcut={shortcut} placement={tooltip === true ? 'bottom' : tooltip} describes={false}>
      {button}
    </Tooltip>
  );
}
