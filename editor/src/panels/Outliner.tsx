/**
 * Leading sidebar: the searchable outline of the model. A segmented control switches between the
 * rig tree, parts (draw order + preview visibility), warps, parameters, animations and the
 * remaining rig objects. Selection is shared with the viewport and the AI bridge: a click selects
 * (Shift / Ctrl-click extends), a double click opens the item in the inspector, the context menu
 * offers the actions of a row.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Model } from '../../../src/core/index.js';
import { Badge, ContextMenu, IconButton, List, ListRow, ListSection, SearchField, SegmentedControl, Sidebar, type IconName, type MenuEntry } from '../design/index.js';
import { useT, type MessageKey, type Translate } from '../i18n/index.js';
import type { OutlinerTab } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import type { EntityKind } from '../state/doc.js';
import { buildRigTree, filterTree, matches, type TreeNode } from '../state/outline.js';
import type { Session } from '../state/session.js';
import { LinkButton } from '../ui/kit.js';
import './outliner.css';

const TABS: Array<{ id: OutlinerTab; icon: IconName; title: MessageKey; hint: MessageKey }> = [
  { id: 'tree', icon: 'bone', title: 'outliner.tab.tree', hint: 'outliner.tab.tree.hint' },
  { id: 'parts', icon: 'part', title: 'outliner.tab.parts', hint: 'outliner.tab.parts.hint' },
  { id: 'warps', icon: 'warp', title: 'outliner.tab.warps', hint: 'outliner.tab.warps.hint' },
  { id: 'params', icon: 'param', title: 'outliner.tab.params', hint: 'outliner.tab.params.hint' },
  { id: 'animations', icon: 'film', title: 'outliner.tab.animations', hint: 'outliner.tab.animations.hint' },
  { id: 'rig', icon: 'link', title: 'outliner.tab.more', hint: 'outliner.tab.more.hint' },
];

export const KIND_ICON: Record<EntityKind | 'group', IconName> = {
  bone: 'bone',
  warp: 'warp',
  part: 'part',
  param: 'param',
  animation: 'film',
  binding: 'link',
  ik: 'constraint',
  physics: 'physics',
  texture: 'texture',
  group: 'model',
};

/** The glyph colour of each kind of rig item (design tokens --r2-kind-*). */
export const KIND_COLOR: Record<EntityKind | 'group', string> = {
  bone: 'var(--r2-kind-bone)',
  warp: 'var(--r2-kind-warp)',
  part: 'var(--r2-kind-part)',
  param: 'var(--r2-kind-parameter)',
  animation: 'var(--r2-kind-animation)',
  binding: 'var(--r2-kind-binding)',
  ik: 'var(--r2-kind-ik)',
  physics: 'var(--r2-kind-physics)',
  texture: 'var(--r2-kind-texture)',
  group: 'var(--r2-label-3)',
};

/** Context menu of an outline row (found from the element under the pointer by its data-key). */
function rowMenu(t: Translate, session: Session, target: Element): MenuEntry[] {
  const key = target.closest<HTMLElement>('[data-key]')?.dataset.key;
  if (!key) return [];
  const id = key.slice(key.indexOf(':') + 1);
  const kind = key.slice(0, key.indexOf(':'));
  const s = session.get();
  const items: MenuEntry[] = [{ id: 'inspect', label: t('outliner.menu.inspect'), icon: 'sidebarRight', onSelect: () => session.inspect([key]) }];
  if (kind === 'part' || kind === 'bone' || kind === 'warp') {
    items.push({
      id: 'frame',
      label: t('outliner.menu.frame'),
      icon: 'fit',
      shortcut: 'F',
      onSelect: () => {
        session.select([key]);
        session.focus('selection');
      },
    });
  }
  if (kind === 'part') {
    const hidden = s.hidden.includes(id);
    items.push({ id: 'hide', label: hidden ? t('outliner.menu.show') : t('outliner.menu.hide'), icon: hidden ? 'eye' : 'eyeOff', shortcut: 'H', onSelect: () => session.toggleHidden(id) });
  }
  if (kind === 'animation') {
    items.push({
      id: 'play',
      label: t('outliner.menu.play'),
      icon: 'play',
      onSelect: () => {
        session.setAnimation(id);
        session.play();
      },
    });
  }
  if (kind === 'param' && s.overrides[id] !== undefined) items.push({ id: 'reset', label: t('params.reset'), icon: 'reset', onSelect: () => session.resetParam(id) });
  items.push({ type: 'separator' }, { id: 'copy', label: t('outliner.menu.copyId'), icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(id).catch(() => undefined) });
  return items;
}

export function Outliner() {
  const session = useSession();
  const t = useT();
  const tab = useApp((s) => s.outlinerTab);
  const search = useApp((s) => s.search);
  const model = useApp((s) => s.model);
  const selection = useApp((s) => s.selection);
  const hiddenCount = useApp((s) => s.hidden.length);
  const list = useRef<HTMLDivElement>(null);
  const current = TABS.find((x) => x.id === tab) ?? TABS[0];

  // Keep the (first) selected row visible when the selection changes elsewhere.
  useEffect(() => {
    const key = selection[0];
    if (!key || !list.current) return;
    const row = list.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selection, tab]);

  return (
    <Sidebar
      title={t(current.title)}
      subtitle={t(current.hint)}
      className="ed-outliner"
      data-testid="outliner"
      actions={
        tab === 'parts' && hiddenCount > 0 ? (
          <IconButton icon="eye" label={t('outliner.showAll', { n: hiddenCount })} shortcut="Alt+H" onClick={() => session.showAllParts()} data-testid="show-all-parts" />
        ) : undefined
      }
      header={
        <>
          <SegmentedControl
            block
            size="sm"
            aria-label={t('outliner.label')}
            value={tab}
            onChange={(id) => session.store.set({ outlinerTab: id })}
            options={TABS.map((x) => ({ value: x.id, icon: x.icon, ariaLabel: t(x.title) }))}
            data-testid="outliner-tabs"
          />
          <SearchField size="sm" value={search} onChange={(text) => session.store.set({ search: text })} placeholder={t('outliner.search')} aria-label={t('outliner.search')} data-testid="outliner-search" />
        </>
      }
    >
      <ContextMenu items={(target) => rowMenu(t, session, target)}>
        <div ref={list} className="ed-outline">
          {!model ? (
            <Empty>{t('outliner.noModel')}</Empty>
          ) : tab === 'tree' ? (
            <RigTree model={model} search={search} />
          ) : tab === 'parts' ? (
            <PartsList model={model} search={search} />
          ) : tab === 'warps' ? (
            <SimpleList
              search={search}
              empty={t('outliner.empty.warps')}
              items={model.warps.map((w) => ({ key: `warp:${w.id}`, kind: 'warp' as const, id: w.id, meta: `${w.cols}×${w.rows}${w.parent ? ` · ${w.parent}` : ''}` }))}
            />
          ) : tab === 'params' ? (
            <SimpleList
              search={search}
              empty={t('outliner.empty.params')}
              items={model.parameters.map((p) => ({ key: `param:${p.id}`, kind: 'param' as const, id: p.id, meta: `${p.min} … ${p.max}` }))}
            />
          ) : tab === 'animations' ? (
            <AnimationList model={model} search={search} />
          ) : (
            <RigObjects model={model} search={search} />
          )}
        </div>
      </ContextMenu>
    </Sidebar>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="ed-outline-empty">{children}</p>;
}

function NoMatches({ search, empty }: { search: string; empty: string }) {
  const t = useT();
  return <Empty>{search ? t('common.noMatchesFor', { query: search }) : empty}</Empty>;
}

interface RowProps {
  rowKey: string;
  kind: EntityKind;
  id: string;
  meta?: ReactNode;
  badge?: string;
  level?: number;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  /** Controls at the trailing end (eye toggle, play button). */
  accessory?: ReactNode;
  dim?: boolean;
}

/** One selectable row of the outline. */
function Row({ rowKey, kind, id, meta, badge, level, expanded, onExpandedChange, accessory, dim }: RowProps) {
  const session = useSession();
  const selected = useApp((s) => s.selection.includes(rowKey));
  const hovered = useApp((s) => s.hover === rowKey);
  const hoverable = kind === 'part' || kind === 'bone';
  return (
    <ListRow
      data-key={rowKey}
      data-hovered={hovered && !selected ? '' : undefined}
      data-dim={dim ? '' : undefined}
      title={id}
      icon={KIND_ICON[kind]}
      iconColor={KIND_COLOR[kind]}
      level={level}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      selected={selected}
      onSelect={(e: MouseEvent) => session.select([rowKey], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace')}
      onDoubleClick={() => session.inspect([rowKey])}
      onMouseEnter={hoverable ? () => session.setHover(rowKey) : undefined}
      onMouseLeave={hoverable ? () => session.setHover(null) : undefined}
      trailing={
        badge || meta !== undefined || accessory ? (
          <>
            {badge && <Badge>{badge}</Badge>}
            {meta !== undefined && <span className="ed-row-meta">{meta}</span>}
            {accessory}
          </>
        ) : undefined
      }
    />
  );
}

function RigTree({ model, search }: { model: Model; search: string }) {
  const t = useT();
  const tree = useMemo(() => buildRigTree(model), [model]);
  const shown = useMemo(() => filterTree(tree, search), [tree, search]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const setOpen = (key: string, open: boolean): void => {
    const next = new Set(collapsed);
    if (open) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };
  if (shown.length === 0) return <NoMatches search={search} empty={t('outliner.empty.tree')} />;
  const rows: ReactNode[] = [];
  const walk = (n: TreeNode, depth: number): void => {
    const open = search !== '' || !collapsed.has(n.key);
    const expandable = n.children.length > 0;
    if (n.kind === 'group') {
      rows.push(
        <ListRow
          key={n.key}
          className="ed-row-group"
          title={n.id}
          icon="model"
          iconColor={KIND_COLOR.group}
          level={depth}
          expanded={expandable ? open : undefined}
          onExpandedChange={(o) => setOpen(n.key, o)}
        />,
      );
    } else {
      rows.push(<Row key={n.key} rowKey={n.key} kind={n.kind} id={n.id} badge={n.badge} level={depth} expanded={expandable ? open : undefined} onExpandedChange={(o) => setOpen(n.key, o)} />);
    }
    if (open) for (const c of n.children) walk(c, depth + 1);
  };
  for (const n of shown) walk(n, 0);
  return (
    <List variant="sidebar" size="sm" aria-label={t('outliner.tab.tree')}>
      <ListSection>{rows}</ListSection>
    </List>
  );
}

function PartsList({ model, search }: { model: Model; search: string }) {
  const session = useSession();
  const t = useT();
  const drawOrder = useApp((s) => s.drawOrder);
  const hidden = useApp((s) => s.hidden);
  // Top-most first; parts not drawn in the current pose (invisible / opacity 0) follow, dimmed.
  const drawn = [...drawOrder].reverse();
  const inPose = new Set(drawOrder);
  const rest = model.parts.map((p) => p.id).filter((id) => !inPose.has(id));
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const rows = [...drawn, ...rest].filter((id) => matches(id, search));
  if (rows.length === 0) return <NoMatches search={search} empty={t('outliner.empty.parts')} />;
  return (
    <List variant="sidebar" size="sm" aria-label={t('outliner.tab.parts')}>
      <ListSection
        header={t('outliner.drawOrder')}
        headerTrailing={
          hidden.length > 0 ? (
            <LinkButton title={t('outliner.showAll.tip')} onClick={() => session.showAllParts()}>
              {t('outliner.showAll', { n: hidden.length })}
            </LinkButton>
          ) : undefined
        }
      >
        {rows.map((id) => {
          const part = byId.get(id);
          const isHidden = hidden.includes(id);
          const meta = [part?.blend !== 'normal' ? part?.blend : null, part?.mask?.length ? (part.maskInvert ? t('outliner.maskInverted') : t('outliner.mask')) : null].filter(Boolean).join(' · ');
          return (
            <Row
              key={id}
              rowKey={`part:${id}`}
              kind="part"
              id={id}
              meta={meta || undefined}
              badge={!inPose.has(id) ? t('outliner.notDrawn') : undefined}
              dim={isHidden || !inPose.has(id)}
              accessory={
                <IconButton
                  icon={isHidden ? 'eyeOff' : 'eye'}
                  size="sm"
                  label={isHidden ? t('outliner.showPart') : t('outliner.hidePart')}
                  className="ed-row-eye"
                  data-off={isHidden ? '' : undefined}
                  tooltip="right"
                  onClick={(e) => {
                    e.stopPropagation();
                    session.toggleHidden(id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              }
            />
          );
        })}
      </ListSection>
    </List>
  );
}

function SimpleList({ items, search, empty }: { items: Array<{ key: string; kind: EntityKind; id: string; meta?: string }>; search: string; empty: string }) {
  const shown = items.filter((i) => matches(i.id, search));
  if (shown.length === 0) return <NoMatches search={search} empty={empty} />;
  return (
    <List variant="sidebar" size="sm">
      <ListSection>
        {shown.map((i) => (
          <Row key={i.key} rowKey={i.key} kind={i.kind} id={i.id} meta={i.meta} />
        ))}
      </ListSection>
    </List>
  );
}

function AnimationList({ model, search }: { model: Model; search: string }) {
  const session = useSession();
  const t = useT();
  const current = useApp((s) => s.animation);
  const playing = useApp((s) => s.playing);
  const shown = model.animations.filter((a) => matches(a.id, search));
  if (shown.length === 0) return <NoMatches search={search} empty={t('outliner.empty.animations')} />;
  return (
    <List variant="sidebar" size="sm" aria-label={t('outliner.tab.animations')}>
      <ListSection>
        {shown.map((a) => {
          const active = current === a.id && playing;
          return (
            <Row
              key={a.id}
              rowKey={`animation:${a.id}`}
              kind="animation"
              id={a.id}
              meta={`${a.duration}s${a.loop ? ` · ${t('outliner.loop')}` : ''}`}
              accessory={
                <IconButton
                  icon={active ? 'pause' : 'play'}
                  size="sm"
                  label={active ? t('timeline.pause') : t('outliner.playAnimation', { id: a.id })}
                  pressed={active}
                  tooltip="right"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (active) session.pause();
                    else {
                      if (current !== a.id) session.setAnimation(a.id);
                      session.play();
                    }
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              }
            />
          );
        })}
      </ListSection>
    </List>
  );
}

function RigObjects({ model, search }: { model: Model; search: string }) {
  const t = useT();
  const bindings = model.bindings
    .map((b, i) => ({ key: `binding:${b.id ?? i}`, id: b.id ?? `#${i}`, target: b.target, params: b.params }))
    .filter((b) => matches(b.id, search) || matches(b.target, search) || b.params.some((p) => matches(p, search)));
  const ik = model.ik.filter((c) => matches(c.id, search));
  const physics = model.physics.filter((p) => matches(p.id, search));
  const textures = model.textures.filter((x) => matches(x.id, search));
  if (!bindings.length && !ik.length && !physics.length && !textures.length) return <NoMatches search={search} empty={t('outliner.empty.more')} />;
  const count = (n: number): ReactNode => <span className="ed-row-meta r2-num">{n}</span>;
  return (
    <List variant="sidebar" size="sm">
      {bindings.length > 0 && (
        <ListSection header={t('outliner.bindings')} headerTrailing={count(bindings.length)}>
          {bindings.map((b) => (
            <Row key={b.key} rowKey={b.key} kind="binding" id={b.target} meta={b.params.join(' × ')} />
          ))}
        </ListSection>
      )}
      {ik.length > 0 && (
        <ListSection header={t('outliner.ik')} headerTrailing={count(ik.length)}>
          {ik.map((c) => (
            <Row key={c.id} rowKey={`ik:${c.id}`} kind="ik" id={c.id} meta={`${c.bones.join(' → ')} ⟶ ${c.target}`} />
          ))}
        </ListSection>
      )}
      {physics.length > 0 && (
        <ListSection header={t('outliner.physics')} headerTrailing={count(physics.length)}>
          {physics.map((p) => (
            <Row key={p.id} rowKey={`physics:${p.id}`} kind="physics" id={p.id} meta={p.outputs.map((o) => o.param).join(', ')} />
          ))}
        </ListSection>
      )}
      {textures.length > 0 && (
        <ListSection header={t('outliner.textures')} headerTrailing={count(textures.length)}>
          {textures.map((x) => (
            <Row key={x.id} rowKey={`texture:${x.id}`} kind="texture" id={x.id} meta={x.path.startsWith('data:') ? t('outliner.dataUri') : x.path} />
          ))}
        </ListSection>
      )}
    </List>
  );
}
