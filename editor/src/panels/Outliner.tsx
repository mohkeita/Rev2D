/**
 * Left panel: searchable outliner with tabs for the rig tree, parts (draw order + preview
 * visibility), warps, parameters, animations and the remaining rig objects. Selection is shared
 * with the viewport and the AI bridge.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Model } from '../../../src/core/index.js';
import type { OutlinerTab } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import type { EntityKind } from '../state/doc.js';
import { buildRigTree, filterTree, matches, type TreeNode } from '../state/outline.js';
import { Icon, type IconName } from '../ui/icons.js';

const TABS: Array<{ id: OutlinerTab; label: string; icon: IconName; title: string }> = [
  { id: 'tree', label: 'Rig', icon: 'bone', title: 'Bones hierarchy with attached warps and parts' },
  { id: 'parts', label: 'Parts', icon: 'part', title: 'Parts in draw order (top first)' },
  { id: 'warps', label: 'Warps', icon: 'warp', title: 'Warp deformers' },
  { id: 'params', label: 'Params', icon: 'param', title: 'Parameters' },
  { id: 'animations', label: 'Anims', icon: 'film', title: 'Animations' },
  { id: 'rig', label: 'More', icon: 'link', title: 'Bindings, IK, physics and textures' },
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

export function Outliner() {
  const session = useSession();
  const tab = useApp((s) => s.outlinerTab);
  const search = useApp((s) => s.search);
  const model = useApp((s) => s.model);
  const selection = useApp((s) => s.selection);
  const list = useRef<HTMLDivElement>(null);

  // Keep the (first) selected row visible when the selection changes elsewhere.
  useEffect(() => {
    const key = selection[0];
    if (!key || !list.current) return;
    const row = list.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selection, tab]);

  return (
    <aside className="panel outliner" data-testid="outliner">
      <div className="panel-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`panel-tab${tab === t.id ? ' is-active' : ''}`}
            title={t.title}
            onClick={() => session.store.set({ outlinerTab: t.id })}
          >
            <Icon name={t.icon} size={14} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="search">
        <Icon name="search" size={14} />
        <input
          type="search"
          placeholder="Filter by id…"
          value={search}
          onChange={(e) => session.store.set({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') session.store.set({ search: '' });
          }}
          aria-label="Filter outliner"
        />
      </div>
      <div className="panel-body outline-list" ref={list}>
        {!model ? (
          <p className="empty-note">No valid model loaded.</p>
        ) : tab === 'tree' ? (
          <RigTree model={model} search={search} />
        ) : tab === 'parts' ? (
          <PartsList model={model} search={search} />
        ) : tab === 'warps' ? (
          <SimpleList
            search={search}
            items={model.warps.map((w) => ({
              key: `warp:${w.id}`,
              kind: 'warp' as const,
              id: w.id,
              meta: `${w.cols}×${w.rows}${w.parent ? ` · ${w.parent}` : ''}`,
            }))}
          />
        ) : tab === 'params' ? (
          <SimpleList
            search={search}
            items={model.parameters.map((p) => ({
              key: `param:${p.id}`,
              kind: 'param' as const,
              id: p.id,
              meta: `${p.group ? `${p.group} · ` : ''}${p.min} … ${p.max}`,
            }))}
          />
        ) : tab === 'animations' ? (
          <AnimationList model={model} search={search} />
        ) : (
          <RigObjects model={model} search={search} />
        )}
      </div>
    </aside>
  );
}

function useRowProps(key: string) {
  const session = useSession();
  const selected = useApp((s) => s.selection.includes(key));
  const hovered = useApp((s) => s.hover === key);
  return {
    'data-key': key,
    className: `row${selected ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`,
    onClick: (e: React.MouseEvent) => session.select([key], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace'),
    onMouseEnter: () => session.setHover(key.startsWith('part:') || key.startsWith('bone:') ? key : null),
    onMouseLeave: () => session.setHover(null),
  };
}

function Row({ rowKey, kind, id, meta, badge, depth = 0, children, lead }: {
  rowKey: string;
  kind: EntityKind | 'group';
  id: string;
  meta?: ReactNode;
  badge?: string;
  depth?: number;
  children?: ReactNode;
  lead?: ReactNode;
}) {
  const props = useRowProps(rowKey);
  return (
    <div {...props} style={{ paddingLeft: 8 + depth * 14 }} title={rowKey}>
      {lead}
      <Icon name={KIND_ICON[kind]} size={14} className={`icon kind-${kind}`} />
      <span className="row-label">{id}</span>
      {badge && <span className="tag">{badge}</span>}
      {meta !== undefined && <span className="row-meta">{meta}</span>}
      {children}
    </div>
  );
}

function RigTree({ model, search }: { model: Model; search: string }) {
  const tree = useMemo(() => buildRigTree(model), [model]);
  const shown = useMemo(() => filterTree(tree, search), [tree, search]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string): void => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };
  if (shown.length === 0) return <p className="empty-note">{search ? 'No matches.' : 'No bones, warps or parts.'}</p>;
  const render = (n: TreeNode, depth: number): ReactNode => {
    const open = search !== '' || !collapsed.has(n.key);
    const lead = n.children.length ? (
      <button
        className="twisty"
        aria-label={open ? 'Collapse' : 'Expand'}
        onClick={(e) => {
          e.stopPropagation();
          toggle(n.key);
        }}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
    ) : (
      <span className="twisty-space" />
    );
    return (
      <div key={n.key} role="treeitem" aria-expanded={n.children.length ? open : undefined}>
        {n.kind === 'group' ? (
          <div className="row row-group" style={{ paddingLeft: 8 + depth * 14 }}>
            {lead}
            <Icon name="model" size={14} />
            <span className="row-label">{n.id}</span>
          </div>
        ) : (
          <Row rowKey={n.key} kind={n.kind} id={n.id} badge={n.badge} depth={depth} lead={lead} />
        )}
        {open && n.children.map((c) => render(c, depth + 1))}
      </div>
    );
  };
  return <div role="tree">{shown.map((n) => render(n, 0))}</div>;
}

function PartsList({ model, search }: { model: Model; search: string }) {
  const session = useSession();
  const drawOrder = useApp((s) => s.drawOrder);
  const hidden = useApp((s) => s.hidden);
  // Top-most first; parts not drawn in the current pose (invisible / opacity 0) follow, dimmed.
  const drawn = [...drawOrder].reverse();
  const inPose = new Set(drawOrder);
  const rest = model.parts.map((p) => p.id).filter((id) => !inPose.has(id));
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const rows = [...drawn, ...rest].filter((id) => matches(id, search));
  if (rows.length === 0) return <p className="empty-note">{search ? 'No matches.' : 'No parts.'}</p>;
  return (
    <>
      <div className="list-caption">
        <span title="Parts in draw order, top-most first">Draw order ↓</span>
        {hidden.length > 0 && (
          <button className="link-button" title="Show all parts again (Alt+H)" onClick={() => session.showAllParts()}>
            Show {hidden.length} hidden
          </button>
        )}
      </div>
      {rows.map((id) => {
        const part = byId.get(id);
        const isHidden = hidden.includes(id);
        const meta = [part?.blend !== 'normal' ? part?.blend : null, part?.mask?.length ? (part.maskInvert ? 'mask⁻¹' : 'mask') : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <Row
            key={id}
            rowKey={`part:${id}`}
            kind="part"
            id={id}
            meta={meta || undefined}
            lead={
              <button
                className={`eye${isHidden ? ' is-off' : ''}`}
                title={isHidden ? 'Show in preview (H toggles)' : 'Hide in preview only — not saved (H toggles)'}
                aria-pressed={!isHidden}
                onClick={(e) => {
                  e.stopPropagation();
                  session.toggleHidden(id);
                }}
              >
                <Icon name={isHidden ? 'eyeOff' : 'eye'} size={14} />
              </button>
            }
          >
            {!inPose.has(id) && <span className="tag tag-dim" title="Not drawn in the current pose (visible: false or opacity 0)">off</span>}
          </Row>
        );
      })}
    </>
  );
}

function SimpleList({ items, search }: { items: Array<{ key: string; kind: EntityKind; id: string; meta?: string }>; search: string }) {
  const shown = items.filter((i) => matches(i.id, search));
  if (shown.length === 0) return <p className="empty-note">{search ? 'No matches.' : 'None.'}</p>;
  return (
    <>
      {shown.map((i) => (
        <Row key={i.key} rowKey={i.key} kind={i.kind} id={i.id} meta={i.meta} />
      ))}
    </>
  );
}

function AnimationList({ model, search }: { model: Model; search: string }) {
  const session = useSession();
  const current = useApp((s) => s.animation);
  const playing = useApp((s) => s.playing);
  const shown = model.animations.filter((a) => matches(a.id, search));
  if (shown.length === 0) return <p className="empty-note">{search ? 'No matches.' : 'No animations.'}</p>;
  return (
    <>
      {shown.map((a) => (
        <Row
          key={a.id}
          rowKey={`animation:${a.id}`}
          kind="animation"
          id={a.id}
          meta={`${a.duration}s${a.loop ? ' · loop' : ''} · ${a.tracks.length} tr`}
        >
          <button
            className={`icon-button icon-button-small row-action${current === a.id && playing ? ' is-on' : ''}`}
            title={current === a.id && playing ? 'Pause' : `Play "${a.id}"`}
            onClick={(e) => {
              e.stopPropagation();
              if (current === a.id && playing) session.pause();
              else {
                if (current !== a.id) session.setAnimation(a.id);
                session.play();
              }
            }}
          >
            <Icon name={current === a.id && playing ? 'pause' : 'play'} size={12} />
          </button>
        </Row>
      ))}
    </>
  );
}

function RigObjects({ model, search }: { model: Model; search: string }) {
  const bindings = model.bindings
    .map((b, i) => ({ key: `binding:${b.id ?? i}`, id: b.id ?? `#${i}`, target: b.target, params: b.params }))
    .filter((b) => matches(b.id, search) || matches(b.target, search) || b.params.some((p) => matches(p, search)));
  const ik = model.ik.filter((c) => matches(c.id, search));
  const physics = model.physics.filter((p) => matches(p.id, search));
  const textures = model.textures.filter((t) => matches(t.id, search));
  const section = (title: string, count: number, body: ReactNode): ReactNode =>
    count > 0 && (
      <div className="list-section">
        <div className="list-caption">
          <span>{title}</span>
          <span className="count">{count}</span>
        </div>
        {body}
      </div>
    );
  if (!bindings.length && !ik.length && !physics.length && !textures.length) {
    return <p className="empty-note">{search ? 'No matches.' : 'No bindings, IK, physics or textures.'}</p>;
  }
  return (
    <>
      {section(
        'Bindings',
        bindings.length,
        bindings.map((b) => <Row key={b.key} rowKey={b.key} kind="binding" id={b.target} meta={b.params.join(' × ')} />),
      )}
      {section(
        'IK',
        ik.length,
        ik.map((c) => <Row key={c.id} rowKey={`ik:${c.id}`} kind="ik" id={c.id} meta={`${c.bones.join(' → ')} ⟶ ${c.target}`} />),
      )}
      {section(
        'Physics',
        physics.length,
        physics.map((p) => (
          <Row key={p.id} rowKey={`physics:${p.id}`} kind="physics" id={p.id} meta={p.outputs.map((o) => o.param).join(', ')} />
        )),
      )}
      {section(
        'Textures',
        textures.length,
        textures.map((t) => <Row key={t.id} rowKey={`texture:${t.id}`} kind="texture" id={t.id} meta={t.path.startsWith('data:') ? 'data URI' : t.path} />),
      )}
    </>
  );
}
