/**
 * The trailing panel of avatar mode.
 *
 * - With built layers: the live preview at the top, then the pages Pose / Lip sync / Selected and the
 *   "Drawn variants" section (AvatarVariants.tsx: drawn closed eyes and mouth shapes).
 * - Without layers (a fresh draft): the landmarks still to place as a checklist (click one, then click
 *   on the illustration), and, once the spec is valid, the Build button.
 */
import { Button, EmptyState, Icon, Inspector, ProgressView, SegmentedControl, Spinner } from '../design/index.js';
import { AvatarVariants } from './AvatarVariants.js';
import { useT } from '../i18n/index.js';
import { shallowEqual, useAvatar } from './hooks.js';
import { groupLabel, itemLabel } from './labels.js';
import { LipSyncTab, PoseTab, SelectedTab } from './PanelTabs.js';
import { PreviewStage } from './PreviewStage.js';
import { MISSING_LANDMARK } from './problems.js';
import { avatarStore, type PreviewTab } from './store.js';
import './avatar-panel.css';

export function AvatarPanel() {
  const t = useT();
  const s = useAvatar((st) => ({ status: st.status, error: st.error, hasLayers: st.meta !== null, tab: st.tab, selected: st.selection.item !== null }), shallowEqual);
  if (s.status === 'loading' || s.status === 'none') {
    return (
      <Inspector aria-label={t('avatar.panel.label')} className="ed-avpanel" data-testid="avatar-panel">
        <div className="ed-avpanel-center">
          <Spinner size={20} />
        </div>
      </Inspector>
    );
  }
  if (s.status === 'failed') {
    return (
      <Inspector aria-label={t('avatar.panel.label')} className="ed-avpanel" data-testid="avatar-panel">
        <EmptyState icon="error" title={t('avatar.error.title')} description={s.error ?? ''} size="sm" actions={<Button onClick={() => void avatarStore.refresh()}>{t('common.retry')}</Button>} />
      </Inspector>
    );
  }
  if (!s.hasLayers) return <DraftPanel />;
  return (
    <Inspector
      aria-label={t('avatar.panel.label')}
      className="ed-avpanel"
      padded={false}
      data-testid="avatar-panel"
      header={
        <>
          <PreviewStage />
          <SegmentedControl<PreviewTab>
            block
            aria-label={t('avatar.panel.label')}
            value={s.tab}
            onChange={(tab) => avatarStore.setTab(tab)}
            data-testid="avatar-tabs"
            options={[
              { value: 'pose', label: t('avatar.tab.pose') },
              { value: 'lipsync', label: t('avatar.tab.lipsync') },
              {
                value: 'selected',
                label: (
                  <>
                    {t('avatar.tab.selected')}
                    {s.selected && s.tab !== 'selected' && <span className="ed-avpanel-dot" aria-hidden="true" />}
                  </>
                ),
              },
            ]}
          />
        </>
      }
    >
      <div className="ed-avpanel-page r2-scroll">
        {s.tab === 'pose' && <PoseTab />}
        {s.tab === 'lipsync' && <LipSyncTab />}
        {s.tab === 'selected' && <SelectedTab />}
        <AvatarVariants />
      </div>
    </Inspector>
  );
}

/** A fresh draft: what is left to place, then Build. */
function DraftPanel() {
  const t = useT();
  const s = useAvatar(
    (st) => ({ parts: st.parts, doc: st.doc, diagnostics: st.diagnostics, placing: st.placing, job: st.job, spec: st.spec !== null }),
    shallowEqual,
  );
  const required = s.parts.flatMap((g) => g.items.filter((i) => i.required).map((i) => ({ group: g, item: i })));
  const placed = required.filter((r) => r.item.placed).length;
  const missing = required.filter((r) => !r.item.placed);
  const errors = s.diagnostics.filter((d) => d.severity === 'error' && d.code !== MISSING_LANDMARK).length;
  const running = s.job?.state === 'running';
  return (
    <Inspector
      title={t('avatar.draft.title')}
      subtitle={t('avatar.draft.subtitle', { placed, total: required.length })}
      className="ed-avpanel ed-avdraft-panel"
      data-testid="avatar-draft-panel"
      footer={
        // (Save is the toolbar's: avatar.json is Avatar mode's document.)
        <div className="ed-avdraft-actions">
          <Button size="lg" variant="filled" icon="bolt" disabled={!s.spec || running} loading={running} onClick={() => void avatarStore.build(true)} data-testid="avatar-build">
            {running ? t('avatar.draft.building') : t('avatar.draft.build')}
          </Button>
        </div>
      }
    >
      <div className="ed-avdraft-progress">
        <ProgressView value={required.length ? placed / required.length : 0} aria-label={t('avatar.draft.subtitle', { placed, total: required.length })} />
      </div>
      {missing.length === 0 ? (
        <div className="ed-avdraft-done">
          <Icon name={errors ? 'warning' : 'checkCircle'} size={20} data-tone={errors ? 'warning' : 'success'} />
          <div>
            <strong>{errors ? t('avatar.draft.fix', { n: errors }) : t('avatar.draft.ready')}</strong>
            <p>{errors ? t('avatar.draft.fixText') : t('avatar.draft.readyText')}</p>
          </div>
        </div>
      ) : (
        <>
          <p className="ed-avdraft-hint">{t('avatar.draft.hint')}</p>
          <ul className="ed-avdraft-list" data-testid="avatar-missing">
            {missing.map(({ group, item }) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="ed-avdraft-row"
                  data-placing={s.placing === item.id ? '' : undefined}
                  onClick={() => {
                    avatarStore.select(item.id, group.id);
                    avatarStore.startPlacing(s.placing === item.id ? null : item.id);
                  }}
                  data-testid={`avatar-missing-${item.id}`}
                >
                  <span className="ed-avdraft-ring" style={{ '--_c': group.color } as React.CSSProperties} aria-hidden="true" />
                  <span className="ed-avdraft-text">
                    <span className="ed-avdraft-label">{itemLabel(t, item, s.doc)}</span>
                    <span className="ed-avdraft-group">{groupLabel(t, group.id)}</span>
                  </span>
                  <span className="ed-avdraft-go">{s.placing === item.id ? t('avatar.draft.clickImage') : t('avatar.draft.place')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Inspector>
  );
}
