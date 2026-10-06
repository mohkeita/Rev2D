/**
 * Panel shells: Sidebar (leading: navigation, outlines) and Inspector (trailing: properties of the
 * selection), plus InspectorSection and InspectorRow for the inspector's content.
 *
 * `floating` (default) is a glass panel with concentric rounded corners that floats above the
 * canvas, inset from the window; `floating={false}` docks it to the edge on a thick material with a
 * hairline. A panel is a landmark (`<aside>` / `<section>` with a name).
 */
import { useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { cx } from '../util.js';
import './panel.css';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  /** Buttons at the trailing end of the title row. */
  actions?: ReactNode;
  /** Fixed content under the title (a search field, a segmented control). */
  header?: ReactNode;
  /** Fixed content at the bottom. */
  footer?: ReactNode;
  floating?: boolean;
  /** false: the body does not scroll and has no padding (the content manages it). */
  padded?: boolean;
  /** Accessible name when there is no visible title. */
  'aria-label'?: string;
}

function Panel({
  kind,
  title,
  subtitle,
  icon,
  actions,
  header,
  footer,
  floating = true,
  padded = true,
  className,
  children,
  ...rest
}: PanelProps & { kind: 'sidebar' | 'inspector' | 'drawer' }) {
  const titleId = useId();
  const Tag = kind === 'sidebar' ? 'aside' : 'section';
  const hasTitle = title != null || actions != null;
  return (
    <Tag
      className={cx('r2-panel', floating ? 'r2-glass-panel' : 'r2-material-thick', className)}
      data-kind={kind}
      data-floating={floating ? '' : undefined}
      aria-labelledby={title != null && !rest['aria-label'] ? titleId : undefined}
      {...rest}
    >
      {hasTitle && (
        <div className="r2-panel-titlebar">
          {icon && <Icon name={icon} size={16} className="r2-panel-icon" />}
          <div className="r2-panel-heading">
            {title != null && (
              <h2 id={titleId} className="r2-panel-title">
                {title}
              </h2>
            )}
            {subtitle != null && <div className="r2-panel-subtitle">{subtitle}</div>}
          </div>
          {actions != null && <div className="r2-panel-actions">{actions}</div>}
        </div>
      )}
      {header != null && <div className="r2-panel-header">{header}</div>}
      <div className={cx('r2-panel-body', padded && 'r2-scroll')} data-padded={padded ? '' : undefined}>
        {children}
      </div>
      {footer != null && <div className="r2-panel-footer">{footer}</div>}
    </Tag>
  );
}

export function Sidebar(props: PanelProps) {
  return <Panel kind="sidebar" {...props} />;
}

export function Inspector(props: PanelProps) {
  return <Panel kind="inspector" {...props} />;
}

/** A bottom drawer (timeline, console): the same shell, laid out for a wide, short area. */
export function Drawer(props: PanelProps) {
  return <Panel kind="drawer" {...props} />;
}

export interface InspectorSectionProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  /** Controls at the trailing end of the section header. */
  trailing?: ReactNode;
  /** Can be folded by its header. Default true. */
  collapsible?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function InspectorSection({ title, trailing, collapsible = true, open: openProp, defaultOpen = true, onOpenChange, className, children, ...rest }: InspectorSectionProps) {
  const id = useId();
  const [inner, setInner] = useState(defaultOpen);
  const open = collapsible ? (openProp ?? inner) : true;
  const toggle = (): void => {
    if (openProp === undefined) setInner(!open);
    onOpenChange?.(!open);
  };
  return (
    <div className={cx('r2-inspector-section', className)} data-open={open ? '' : undefined} {...rest}>
      <div className="r2-inspector-section-header">
        {collapsible ? (
          <button type="button" className="r2-inspector-section-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
            <Icon name="chevronRight" size={12} strokeWidth={2.4} className="r2-inspector-section-chevron" />
            <span id={`${id}-title`}>{title}</span>
          </button>
        ) : (
          <span id={`${id}-title`} className="r2-inspector-section-title">
            {title}
          </span>
        )}
        {trailing != null && <div className="r2-inspector-section-trailing">{trailing}</div>}
      </div>
      {open && (
        <div id={`${id}-body`} role="group" aria-labelledby={`${id}-title`} className="r2-inspector-section-body">
          {children}
        </div>
      )}
    </div>
  );
}

export interface InspectorRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  /** The control(s). A function receives the id of the label for `aria-labelledby`. */
  children: ReactNode | ((labelId: string) => ReactNode);
  /** Value shown between the label and the control (a slider's number). */
  value?: ReactNode;
  /** 'inline': label left, control right (default). 'stack': label above the control. */
  layout?: 'inline' | 'stack';
}

export function InspectorRow({ label, children, value, layout = 'inline', className, ...rest }: InspectorRowProps) {
  const id = useId();
  return (
    <div className={cx('r2-inspector-row', className)} data-layout={layout} {...rest}>
      <div className="r2-inspector-row-label">
        <span id={id} className="r2-truncate">
          {label}
        </span>
        {value != null && <span className="r2-inspector-row-value r2-num">{value}</span>}
      </div>
      <div className="r2-inspector-row-control">{typeof children === 'function' ? children(id) : children}</div>
    </div>
  );
}
