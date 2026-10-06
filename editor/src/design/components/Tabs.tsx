/**
 * Tabs: switch between a few views that share one area (the panels of a dock, the pages of a
 * dialog). For two to five closely related modes of the same view a SegmentedControl is lighter.
 *
 * Keyboard (tabs pattern, automatic activation): Tab reaches the selected tab, Left / Right move and
 * select, Home / End jump; the panel is the next tab stop.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.js';
import { rovingIndex } from '../logic/roving.js';
import { cx, isRtl, useControllable } from '../util.js';
import './tabs.css';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: IconName;
  /** A count or status after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  tabs: ReadonlyArray<TabItem<T>>;
  value?: T;
  defaultValue?: T;
  onChange?: (id: T) => void;
  size?: 'sm' | 'md';
  /** Content at the trailing end of the tab row (actions of the current view). */
  trailing?: ReactNode;
  /** Render the panel of the selected tab. Omit to place the panel yourself (see tabPanelProps). */
  children?: (id: T) => ReactNode;
  /** Prefix of the tab / panel ids (to wire a panel rendered elsewhere). Default: generated. */
  idBase?: string;
  'aria-label'?: string;
  className?: string;
  'data-testid'?: string;
}

/** Ids that connect a tab with its panel when the panel is rendered outside <Tabs>. */
export function tabPanelProps(idBase: string, id: string): { id: string; role: 'tabpanel'; 'aria-labelledby': string; tabIndex: 0 } {
  return { id: `${idBase}-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `${idBase}-tab-${id}`, tabIndex: 0 };
}

export function Tabs<T extends string = string>({ tabs, value, defaultValue, onChange, size = 'md', trailing, children, idBase, className, 'aria-label': ariaLabel, ...rest }: TabsProps<T>) {
  const auto = useId();
  const base = idBase ?? auto;
  const [current, setCurrent] = useControllable<T | undefined>(value, defaultValue ?? tabs[0]?.id, onChange as (v: T | undefined) => void);
  const list = useRef<HTMLDivElement>(null);
  const index = tabs.findIndex((t) => t.id === current);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const next = rovingIndex(e.key, index, tabs.length, { rtl: isRtl(list.current), isDisabled: (i) => tabs[i]!.disabled === true });
    if (next === null) return;
    e.preventDefault();
    setCurrent(tabs[next]!.id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className={cx('r2-tabs', className)} data-size={size} {...rest}>
      <div className="r2-tabs-bar">
        <div ref={list} role="tablist" className="r2-tabs-list" aria-label={ariaLabel} onKeyDown={onKeyDown}>
          {tabs.map((t, i) => {
            const selected = i === index;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${base}-tab-${t.id}`}
                className="r2-tab"
                aria-selected={selected}
                aria-controls={`${base}-panel-${t.id}`}
                tabIndex={selected || (index < 0 && i === 0) ? 0 : -1}
                disabled={t.disabled}
                onClick={() => setCurrent(t.id)}
              >
                {t.icon && <Icon name={t.icon} size={16} />}
                <span>{t.label}</span>
                {t.badge != null && <span className="r2-tab-badge">{t.badge}</span>}
              </button>
            );
          })}
        </div>
        {trailing != null && <div className="r2-tabs-trailing">{trailing}</div>}
      </div>
      {children && current !== undefined && (
        <div className="r2-tabs-panel" {...tabPanelProps(base, current)}>
          {children(current)}
        </div>
      )}
    </div>
  );
}
