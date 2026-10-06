/**
 * The leading sidebar of avatar mode: the parts of the avatar spec by category (Face, Hair &
 * accessories, Body), each group with its colour, label, one-line description and a toggle for its
 * handles, then its items. Absent optional groups are dimmed ("Not in this avatar") and offer to add
 * one. Selecting a group or an item selects its handles on the canvas; a double-click frames it; the
 * context menu has Fit / Place, hide the group, Ask AI and Remove. At the bottom: the problems of the
 * spec, each row selecting the part it is about.
 */
import { useMemo, useState } from 'react';
import type { AvatarPartGroupInfo, AvatarPartItemInfo } from '../../../src/avatar/index.js';
import type { Diagnostic } from '../../../src/core/types.js';
import { ContextMenu, Icon, IconButton, Menu, Sidebar, Spinner, type MenuEntry } from '../design/index.js';
import { useT, type Translate } from '../i18n/index.js';
import { useAi } from './ai.js';
import { fitGroup, fitItem, itemMenu } from './actions.js';
import { shallowEqual, useAvatar } from './hooks.js';
import { categoryLabel, groupDescription, groupLabel, itemLabel, type PartCategory } from './labels.js';
import { MISSING_LANDMARK, itemForPath, problemsByItem, worstSeverity } from './problems.js';
import { avatarStore } from './store.js';
import './parts-list.css';

const CATEGORIES: PartCategory[] = ['face', 'hair', 'body'];

function addEntries(t: Translate): MenuEntry[] {
  return [
    { type: 'label', label: t('avatar.add.title') },
    { id: 'strand', label: t('avatar.add.strand'), icon: 'hair', description: t('avatar.add.strand.desc'), onSelect: () => avatarStore.startPlacing('strand') },
    { id: 'pendulum', label: t('avatar.add.pendulum'), icon: 'link', description: t('avatar.add.pendulum.desc'), onSelect: () => avatarStore.startPlacing('attachment:pendulum') },
    { id: 'jiggle', label: t('avatar.add.jiggle'), icon: 'sparkle', description: t('avatar.add.jiggle.desc'), onSelect: () => avatarStore.startPlacing('attachment:jiggle') },
    { id: 'cutout', label: t('avatar.add.cutout'), icon: 'hand', description: t('avatar.add.cutout.desc'), onSelect: () => avatarStore.startPlacing('attachment:cutout') },
  ];
}

export function PartsList() {
  const t = useT();
  const s = useAvatar((st) => ({ status: st.status, parts: st.parts, doc: st.doc, info: st.info, image: st.image, diagnostics: st.diagnostics, hidden: st.hidden, selection: st.selection, placing: st.placing }), shallowEqual);
  const ai = useAi();
  const problems = useMemo(() => problemsByItem(s.doc, s.diagnostics), [s.doc, s.diagnostics]);
  const name = s.info?.name ?? '';
  const subtitle = s.image ? `${name ? `${name} · ` : ''}${s.image.width} × ${s.image.height}` : name;

  const menuFor = (target: Element): MenuEntry[] => {
    const id = target.closest<HTMLElement>('[data-item]')?.dataset.item;
    const item = id ? avatarStore.item(id) : null;
    return item ? itemMenu(t, item, ai !== null) : [];
  };

  return (
    <Sidebar
      title={t('avatar.parts.title')}
      subtitle={subtitle}
      className="ed-avparts"
      padded={false}
      data-testid="avatar-parts"
      actions={
        <Menu items={addEntries(t)} placement="bottom-end" aria-label={t('avatar.add.title')}>
          <IconButton icon="plus" label={t('avatar.add.title')} disabled={!s.doc} data-testid="avatar-add" />
        </Menu>
      }
      footer={<Problems diagnostics={s.diagnostics} doc={s.doc} missing={s.parts.reduce((n, g) => n + g.items.filter((i) => i.required && !i.placed).length, 0)} />}
    >
      {s.status === 'loading' ? (
        <div className="ed-avparts-loading">
          <Spinner size={18} />
        </div>
      ) : (
        <ContextMenu items={menuFor}>
          <div className="ed-avparts-scroll r2-scroll" onKeyDown={(e) => onListKey(e)}>
            {CATEGORIES.map((cat) => {
              const groups = s.parts.filter((g) => g.category === cat);
              if (!groups.length) return null;
              return (
                <section key={cat} className="ed-avparts-cat" aria-label={categoryLabel(t, cat)}>
                  <h3 className="ed-avparts-cat-title">{categoryLabel(t, cat)}</h3>
                  {groups.map((g) => (
                    <Group key={g.id} group={g} doc={s.doc} hidden={s.hidden.includes(g.id)} selection={s.selection} problems={problems} placing={s.placing} t={t} />
                  ))}
                </section>
              );
            })}
          </div>
        </ContextMenu>
      )}
    </Sidebar>
  );
}

/** Up / Down move between the rows of the list. */
function onListKey(e: React.KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
  const i = rows.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

function Group({
  group,
  doc,
  hidden,
  selection,
  problems,
  placing,
  t,
}: {
  group: AvatarPartGroupInfo;
  doc: unknown;
  hidden: boolean;
  selection: { group: string | null; item: string | null };
  problems: Map<string, Diagnostic[]>;
  placing: string | null;
  t: Translate;
}) {
  const selected = selection.group === group.id && selection.item === null;
  const active = selection.group === group.id;
  const addable = group.id === 'strands' || group.id === 'attachments';
  const color = { '--_c': group.color } as React.CSSProperties;
  return (
    <div className="ed-avgroup" data-active={active ? '' : undefined} data-absent={group.present ? undefined : ''} data-hidden={hidden ? '' : undefined} data-testid={`avatar-group-${group.id}`}>
      <div className="ed-avgroup-head">
        <button
          type="button"
          className="ed-avgroup-main"
          data-row=""
          data-selected={selected ? '' : undefined}
          aria-current={selected ? 'true' : undefined}
          onClick={() => avatarStore.selectGroup(selected ? null : group.id)}
          onDoubleClick={() => fitGroup(group.id)}
          title={groupDescription(t, group.id)}
        >
          <span className="ed-avdot" style={color} aria-hidden="true" />
          <span className="ed-avgroup-text">
            <span className="ed-avgroup-label">{groupLabel(t, group.id)}</span>
            <span className="ed-avgroup-desc">{group.present ? groupDescription(t, group.id) : t('avatar.parts.absent')}</span>
          </span>
        </button>
        {addable && (
          <Menu items={group.id === 'strands' ? [{ id: 'strand', label: t('avatar.add.strand'), icon: 'hair', onSelect: () => avatarStore.startPlacing('strand') }] : addEntries(t).filter((e) => 'id' in e && e.id !== 'strand')} placement="bottom-end" aria-label={t('avatar.add.title')}>
            <IconButton icon="plus" size="sm" label={group.id === 'strands' ? t('avatar.add.strand') : t('avatar.add.attachment')} data-testid={`avatar-add-${group.id}`} />
          </Menu>
        )}
        {group.present && (
          <IconButton
            icon={hidden ? 'eyeOff' : 'eye'}
            size="sm"
            label={hidden ? t('avatar.parts.showHandles') : t('avatar.parts.hideHandles')}
            pressed={!hidden}
            onClick={() => avatarStore.toggleGroup(group.id)}
            className="ed-avgroup-eye"
            data-testid={`avatar-eye-${group.id}`}
          />
        )}
      </div>
      {(group.present || group.id === 'cheeks') && group.items.length > 0 && (
        <div className="ed-avitems" role="list">
          {group.items.map((item) => (
            <Item key={item.id} item={item} doc={doc} color={group.color} selected={selection.item === item.id} problems={problems.get(item.id)} placing={placing === item.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function Item({ item, doc, color, selected, problems, placing, t }: { item: AvatarPartItemInfo; doc: unknown; color: string; selected: boolean; problems?: Diagnostic[]; placing: boolean; t: Translate }) {
  const own = problems?.filter((d) => d.code !== MISSING_LANDMARK);
  const sev = worstSeverity(own);
  const missing = !item.placed;
  const state = missing ? (item.required ? 'missing' : 'optional') : 'placed';
  return (
    <div className="ed-avitem" role="listitem" data-item={item.id} data-state={state} data-selected={selected ? '' : undefined} data-testid={`avatar-item-${item.id}`}>
      <button
        type="button"
        className="ed-avitem-main"
        data-row=""
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          avatarStore.select(item.id);
          if (missing) avatarStore.startPlacing(item.id);
        }}
        onDoubleClick={() => fitItem(item.id)}
      >
        <span className="ed-avitem-mark" style={{ '--_c': color } as React.CSSProperties} aria-hidden="true" />
        <span className="ed-avitem-label">{itemLabel(t, item, doc)}</span>
        {placing ? (
          <span className="ed-avitem-note" data-tone="tint">
            {t('avatar.parts.clickToPlace')}
          </span>
        ) : missing ? (
          <span className="ed-avitem-note" data-tone={item.required ? 'warning' : undefined}>
            {item.required ? t('avatar.parts.missing') : t('avatar.parts.optional')}
          </span>
        ) : sev ? (
          <Icon name={sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'info'} size={14} className="ed-avitem-sev" data-sev={sev} title={own?.[0]?.message} />
        ) : null}
      </button>
    </div>
  );
}

/** The problems of the spec (missing landmarks are counted, the rest listed); a row selects its part. */
function Problems({ diagnostics, doc, missing }: { diagnostics: Diagnostic[]; doc: unknown; missing: number }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const list = diagnostics.filter((d) => d.code !== MISSING_LANDMARK);
  const errors = list.filter((d) => d.severity === 'error').length;
  const warnings = list.filter((d) => d.severity === 'warning').length;
  const clean = list.length === 0 && missing === 0;
  return (
    <div className="ed-avproblems" data-testid="avatar-problems">
      <button type="button" className="ed-avproblems-head" aria-expanded={open} onClick={() => setOpen(!open)} disabled={list.length === 0}>
        {clean ? (
          <Icon name="checkCircle" size={14} className="ed-avproblems-ok" />
        ) : list.length ? (
          <Icon name={errors ? 'error' : warnings ? 'warning' : 'info'} size={14} data-sev={errors ? 'error' : warnings ? 'warning' : 'info'} className="ed-avproblems-glyph" />
        ) : (
          <Icon name="target" size={14} className="ed-avproblems-glyph" data-sev="warning" />
        )}
        <span className="ed-avproblems-title">{clean ? t('avatar.problems.none') : list.length ? (errors || warnings ? t('avatar.problems.summary', { errors, warnings }) : t('avatar.problems.notes', { n: list.length })) : t('avatar.problems.missing', { n: missing })}</span>
        {missing > 0 && list.length > 0 && <span className="ed-avproblems-missing">{t('avatar.problems.missing', { n: missing })}</span>}
        {list.length > 0 && <Icon name="chevronDown" size={12} className="ed-avproblems-chevron" data-open={open ? '' : undefined} />}
      </button>
      {open && list.length > 0 && (
        <ul className="ed-avproblems-list r2-scroll">
          {list.map((d, i) => {
            const item = itemForPath(doc, d.path);
            return (
              <li key={`${d.code}-${d.path}-${i}`}>
                <button
                  type="button"
                  className="ed-avproblem"
                  data-sev={d.severity}
                  onClick={() => {
                    if (!item) return;
                    avatarStore.select(item);
                    fitItem(item);
                  }}
                  title={d.hint ?? d.message}
                  data-testid="avatar-problem"
                >
                  <Icon name={d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info'} size={13} className="ed-avproblem-icon" />
                  <span className="ed-avproblem-text">{d.message}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
