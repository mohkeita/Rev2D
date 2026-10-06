/**
 * Select: one value from a list, shown in a popover list box (the pop-up button of iPadOS).
 *
 * Keyboard: Enter / Space / Up / Down open the list at the current value; inside, Up / Down move,
 * typing jumps, Enter chooses, Escape closes without changing the value.
 */
import { useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Icon, type IconName } from '../icons.js';
import { designStrings } from '../strings.js';
import { cx, mergeRefs, useControllable } from '../util.js';
import { MenuList, type MenuEntry } from './Menu.js';
import './select.css';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  icon?: IconName;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  options: ReadonlyArray<SelectOption<T>>;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  /** Shown while no option is selected. */
  placeholder?: string;
  size?: 'sm' | 'md' | 'lg';
  /** 'gray': a filled field (forms). 'plain': text and chevrons only (inside a list row). */
  variant?: 'gray' | 'plain';
  block?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
  className?: string;
  'data-testid'?: string;
  ref?: Ref<HTMLButtonElement>;
}

export function Select<T extends string = string>({
  options,
  value,
  defaultValue,
  onChange,
  placeholder = designStrings.select,
  size = 'md',
  variant = 'gray',
  block,
  disabled,
  className,
  ref,
  ...rest
}: SelectProps<T>) {
  const listId = useId();
  const [current, setCurrent] = useControllable<T | undefined>(value, defaultValue, onChange as (v: T | undefined) => void);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === current);

  const items: MenuEntry[] = options.map((o) => ({ id: o.value, label: o.label, icon: o.icon, description: o.description, disabled: o.disabled }));

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <>
      <button
        ref={mergeRefs(button, ref)}
        type="button"
        role="combobox"
        className={cx('r2-select r2-hit', className)}
        data-size={size}
        data-variant={variant}
        data-block={block ? '' : undefined}
        data-open={open ? '' : undefined}
        data-placeholder={selected ? undefined : ''}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
        {...rest}
      >
        {selected?.icon && <Icon name={selected.icon} size={16} />}
        <span className="r2-select-value">{selected?.label ?? placeholder}</span>
        <Icon name="chevronUpDown" size={14} className="r2-select-chevrons" />
      </button>
      {open && (
        <MenuList
          id={listId}
          role="listbox"
          items={items}
          selectedId={current}
          initialFocus="selected"
          anchor={button.current}
          placement="bottom-start"
          offset={4}
          matchWidth
          ignore={[button]}
          aria-label={rest['aria-label']}
          aria-labelledby={rest['aria-labelledby']}
          onAction={(id) => setCurrent(id as T)}
          onClose={(reason) => {
            setOpen(false);
            if (reason !== 'outside') button.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
