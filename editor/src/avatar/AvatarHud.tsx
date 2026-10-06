/**
 * What floats over the avatar canvas, inside the free area: banners at the top (a refused save, a
 * change on disk while editing, outlines that need new layers, the build in progress, the AI at
 * work, a part waiting to be placed) and the zoom controls at the trailing bottom corner. Save,
 * Undo and Redo are the toolbar's (avatar.json is Avatar mode's document, document.ts); the shell's
 * status line shows the save state, the pointer and AvatarStatus (what the spec still lacks).
 */
import { Button, Icon, IconButton, Popover, Spinner, Toolbar, ToolbarGroup, ToolbarSeparator } from '../design/index.js';
import { useT, type Translate } from '../i18n/index.js';
import { StatusItem } from '../shell/StatusLine.js';
import { MODE_PANEL } from '../state/app.js';
import { useSession } from '../state/context.js';
import { openAiPanel, useAi, type AiModule } from './ai.js';
import { fitSelection } from './actions.js';
import { shallowEqual, useAvatar } from './hooks.js';
import { itemLabel } from './labels.js';
import { MISSING_LANDMARK } from './problems.js';
import { avatarStore, type AiJobRef, type AvatarJobView } from './store.js';
import { stepAvatarZoom, zoomLabel } from './view.js';
import './avatar-hud.css';

const STEP_KEYS = { start: 'avatar.job.step.start', build: 'avatar.job.step.build', compile: 'avatar.job.step.compile', variants: 'avatar.job.step.variants', reload: 'avatar.job.step.reload' } as const;

/** The banner title of a job: what it does, and how it ended. */
function jobTitle(t: Translate, job: AvatarJobView): string {
  const failed = job.state === 'failed';
  const done = job.state === 'done';
  if (job.kind === 'variants') return failed ? t('avatar.variants.job.failed') : done ? t('avatar.variants.job.done') : t('avatar.variants.job.running');
  if (failed) return t('avatar.job.failed');
  if (done) return job.first ? t('avatar.job.firstDone') : job.layers ? t('avatar.job.done') : t('avatar.toast.compiled');
  return job.first ? t('avatar.job.firstBuilding') : job.layers ? t('avatar.job.building') : t('avatar.job.compiling');
}

export function AvatarHud() {
  return (
    <div className="ed-avhud">
      <div className="ed-avhud-top">
        <AvatarBanners />
      </div>
      <div className="ed-avhud-bottom">
        <AvatarViewControls />
      </div>
    </div>
  );
}

function stepText(t: Translate, job: AvatarJobView): string {
  const step = job.last.step;
  return step && step in STEP_KEYS ? t(STEP_KEYS[step as keyof typeof STEP_KEYS]) : (job.last.message ?? '');
}

export function AvatarBanners() {
  const t = useT();
  const ai = useAi();
  const s = useAvatar(
    (st) => ({ conflict: st.conflict, external: st.external, stale: st.stale, staleItems: st.staleItems, job: st.job, placing: st.placing, doc: st.doc, saving: st.saving, aiJob: st.ai, hasMeta: st.meta !== null }),
    shallowEqual,
  );
  const placingItem = s.placing && !s.placing.startsWith('attachment:') && s.placing !== 'strand' ? avatarStore.item(s.placing) : null;
  const placingText = s.placing === 'strand' ? t('avatar.add.strand') : s.placing?.startsWith('attachment:') ? t(`avatar.add.${s.placing.slice(11)}` as 'avatar.add.pendulum') : placingItem ? itemLabel(t, placingItem, s.doc) : null;
  const running = s.job?.state === 'running';
  const changed = s.staleItems.map((id) => avatarStore.item(id)).filter((i) => i !== null);

  return (
    <div className="ed-avbanners" onPointerDown={(e) => e.stopPropagation()}>
      {s.aiJob && ai && <AiStrip ai={ai} job={s.aiJob} />}
      {s.conflict && (
        <div className="ed-banner r2-glass-panel" data-tone="warning" role="alert" data-testid="avatar-conflict-banner">
          <Icon name="warning" size={18} className="ed-banner-icon" />
          <div className="ed-banner-text">
            <strong>{t('avatar.conflict.title')}</strong>
            <span>{t('avatar.conflict.text')}</span>
          </div>
          <div className="ed-banner-actions">
            <Button size="md" onClick={() => void avatarStore.resolveConflict('reload')} data-testid="avatar-conflict-reload">
              {t('avatar.conflict.reload')}
            </Button>
            <Button size="md" destructive onClick={() => void avatarStore.resolveConflict('overwrite')} data-testid="avatar-conflict-overwrite">
              {t('avatar.conflict.overwrite')}
            </Button>
          </div>
        </div>
      )}
      {s.external && !s.conflict && (
        <div className="ed-banner r2-glass-panel" data-tone="info" role="alert" data-testid="avatar-external-banner">
          <Icon name="refresh" size={18} className="ed-banner-icon ed-avbanner-info" />
          <div className="ed-banner-text">
            <strong>{t('avatar.external.title')}</strong>
            <span>{t('avatar.external.text')}</span>
          </div>
          <div className="ed-banner-actions">
            <Button size="md" onClick={() => void avatarStore.resolveExternal('keep')} data-testid="avatar-external-keep">
              {t('avatar.external.keep')}
            </Button>
            <Button size="md" variant="tinted" onClick={() => void avatarStore.resolveExternal('reload')} data-testid="avatar-external-reload">
              {t('avatar.external.reload')}
            </Button>
          </div>
        </div>
      )}
      {s.job && <JobBanner job={s.job} />}
      {s.stale && s.hasMeta && !running && (
        <div className="ed-banner r2-glass-panel ed-avbanner-stale" data-tone="warning" role="status" data-testid="avatar-stale-banner">
          <Icon name="layers" size={18} className="ed-banner-icon ed-avbanner-layers" />
          <div className="ed-banner-text">
            <strong>{t('avatar.stale.title')}</strong>
            <span>{t('avatar.stale.text')}</span>
            {changed.length > 0 && (
              <span className="ed-avbanner-chips">
                {changed.slice(0, 4).map((i) => (
                  <button key={i.id} type="button" className="ed-avchip" onClick={() => avatarStore.select(i.id)}>
                    {itemLabel(t, i, s.doc)}
                  </button>
                ))}
                {changed.length > 4 && <span className="ed-avchip" data-more="">{t('avatar.stale.more', { n: changed.length - 4 })}</span>}
              </span>
            )}
          </div>
          <div className="ed-banner-actions">
            <Button size="md" variant="tinted" icon="refresh" loading={s.saving} onClick={() => void avatarStore.build(true)} data-testid="avatar-rebuild">
              {t('avatar.stale.rebuild')}
            </Button>
          </div>
        </div>
      )}
      {placingText && (
        <div className="ed-avplacing r2-glass" role="status" data-testid="avatar-placing">
          <Icon name="target" size={16} />
          <span>{t('avatar.placing.text', { item: placingText })}</span>
          <Button size="sm" variant="plain" onClick={() => avatarStore.startPlacing(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}

function JobBanner({ job }: { job: AvatarJobView }) {
  const t = useT();
  const failed = job.state === 'failed';
  const done = job.state === 'done';
  const e = job.last;
  return (
    <div className="ed-banner r2-glass-panel ed-avjob" data-tone={failed ? 'danger' : done ? 'success' : undefined} role="status" data-state={job.state} data-testid="avatar-job">
      {failed ? <Icon name="error" size={18} className="ed-banner-icon" /> : done ? <Icon name="checkCircle" size={18} className="ed-banner-icon ed-avjob-done" /> : <Spinner size={18} />}
      <div className="ed-banner-text">
        <strong>{jobTitle(t, job)}</strong>
        <span>{failed ? (e.message ?? '') : done ? (e.message ?? '') : stepText(t, job)}</span>
        {failed && e.hint && <span className="ed-avjob-hint">{e.hint}</span>}
        {!failed && !done && (
          <span className="ed-avjob-steps" aria-hidden="true">
            {(['start', 'build', 'reload'] as const).map((step) => (
              <span key={step} className="ed-avjob-step" data-on={job.steps.includes(step) || (step === 'build' && (job.steps.includes('compile') || job.steps.includes('variants'))) ? '' : undefined} />
            ))}
          </span>
        )}
      </div>
      <div className="ed-banner-actions">
        {failed && e.log && (
          <Popover
            placement="bottom-end"
            width={460}
            title={t('avatar.job.log')}
            trigger={
              <Button size="md" data-testid="avatar-job-log">
                {t('avatar.job.showLog')}
              </Button>
            }
          >
            <pre className="ed-avjob-log r2-scroll">{e.log}</pre>
          </Popover>
        )}
        {(failed || done) && <IconButton icon="close" label={t('common.close')} onClick={() => avatarStore.store.set({ job: null })} />}
      </div>
    </div>
  );
}

/** The AI job working on this project: a quiet strip with its latest status. */
function AiStrip({ ai, job }: { ai: AiModule; job: AiJobRef }) {
  const t = useT();
  const view = ai.useAiJob(job.id);
  const done = view?.done ?? false;
  const failed = done && view?.state !== 'done';
  const title =
    job.kind === 'avatar-create'
      ? done
        ? failed
          ? t('avatar.ai.createStopped')
          : t('avatar.ai.createDone')
        : t('avatar.ai.creating')
      : job.kind === 'avatar-variants'
        ? done
          ? failed
            ? t('avatar.ai.drawStopped')
            : t('avatar.ai.drawDone')
          : t('avatar.ai.drawing')
        : done
          ? failed
            ? t('avatar.ai.fixStopped')
            : t('avatar.ai.fixDone')
          : t('avatar.ai.fixing');
  return (
    <div className="ed-avai r2-glass" data-state={done ? (failed ? 'failed' : 'done') : 'running'} role="status" data-testid="avatar-ai-strip">
      {done ? <Icon name={failed ? 'warning' : 'checkCircle'} size={16} className="ed-avai-icon" /> : <Icon name="sparkles" size={16} className="ed-avai-icon ed-avai-pulse" />}
      <span className="ed-avai-title">{title}</span>
      {view?.lastStatus && !done && <span className="ed-avai-status">{view.lastStatus}</span>}
      <Button size="sm" variant="plain" onClick={() => openAiPanel()} data-testid="avatar-ai-open">
        {t('avatar.ai.openPanel')}
      </Button>
      {done && <IconButton icon="close" size="sm" label={t('common.close')} onClick={() => avatarStore.setAiJob(null)} />}
    </div>
  );
}

/** Zoom and framing: a small glass group at the trailing bottom corner of the free area. */
export function AvatarViewControls() {
  const t = useT();
  const s = useAvatar((st) => ({ zoom: st.camera.zoom, ready: st.status === 'ready', selected: st.selection.item ?? st.selection.group }), shallowEqual);
  if (!s.ready) return null;
  return (
    <Toolbar size="md" aria-label={t('avatar.view.label')} className="ed-avview" data-testid="avatar-view-bar">
      <ToolbarGroup>
        <IconButton icon="zoomOut" label={t('view.zoomOut')} shortcut="-" tooltip="top" onClick={() => avatarStore.zoomTo(stepAvatarZoom(s.zoom, -1))} />
        <button type="button" className="ed-avzoom r2-num" title={t('view.zoomReset')} aria-label={t('view.zoomReset')} onClick={() => avatarStore.zoomTo(1)} data-testid="avatar-zoom">
          {zoomLabel(s.zoom)}
        </button>
        <IconButton icon="zoomIn" label={t('view.zoomIn')} shortcut="+" tooltip="top" onClick={() => avatarStore.zoomTo(stepAvatarZoom(s.zoom, 1))} />
        <ToolbarSeparator />
        <IconButton icon="target" label={t('avatar.view.fitSelected')} shortcut="F" tooltip="top" disabled={!s.selected} onClick={() => fitSelection()} data-testid="avatar-fit-selected" />
        <IconButton icon="fit" label={t('avatar.view.fitImage')} shortcut="Shift+F" tooltip="top" onClick={() => avatarStore.fit('image')} data-testid="avatar-fit" />
      </ToolbarGroup>
    </Toolbar>
  );
}

/**
 * Avatar mode's item of the shell's status line (WorkspaceMode.render.status): whether the spec has
 * problems, how many landmarks are still to place, or that all are placed. It opens the avatar panel
 * (its checklist lists them).
 */
export function AvatarStatus() {
  const t = useT();
  const session = useSession();
  const s = useAvatar(
    (st) => ({
      errors: st.diagnostics.filter((d) => d.severity === 'error' && d.code !== MISSING_LANDMARK).length,
      missing: st.parts.reduce((n, g) => n + g.items.filter((i) => i.required && !i.placed).length, 0),
      ready: st.status === 'ready',
    }),
    shallowEqual,
  );
  if (!s.ready) return null;
  return (
    <StatusItem
      icon={s.errors ? 'error' : s.missing ? 'target' : 'checkCircle'}
      tone={s.errors ? 'danger' : s.missing ? 'warning' : 'success'}
      onClick={() => session.showTrailingPanel(MODE_PANEL)}
      data-testid="avatar-status"
    >
      <span>{s.errors ? t('avatar.status.errors', { n: s.errors }) : s.missing ? t('avatar.status.missing', { n: s.missing }) : t('avatar.status.complete')}</span>
    </StatusItem>
  );
}
