/**
 * Start screen, shown while nothing is open (an avatar project without a model is shown by Avatar
 * mode): the app mark, three big actions (New / Open / Import), the "Avatar from an illustration"
 * card, the recent files of this workspace and example cards. An example opens the New dialog with it
 * preselected, so the example is COPIED into the workspace, never edited in place.
 *
 * The shell renders it as the full-bleed main area under the floating toolbar: it scrolls by itself
 * and starts below the toolbar (--r2-safe-top).
 */
import { isAvatarSpecPath } from '../avatar/actions.js';
import { AvatarStartCard } from '../avatar/StartCard.js';
import { Icon, List, ListRow, ListSection, Spinner, type IconName } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import { Keys } from '../ui/kit.js';
import { baseName, dirOf, relativeToRoot, rootLabel } from './paths.js';
import { FILE_SHORTCUTS } from './shortcuts.js';
import { EXAMPLE_ORDER, SIZED_TEMPLATES, templateSummary, templateThumbnail, templateTitle } from './templates.js';
import { useTemplates } from './useTemplates.js';
import './start-screen.css';

function ActionCard({
  icon,
  title,
  text,
  shortcut,
  onClick,
  primary,
  testId,
}: {
  icon: IconName;
  title: string;
  text: string;
  shortcut?: string;
  onClick(): void;
  primary?: boolean;
  testId: string;
}) {
  return (
    <button type="button" className="ed-start-action" data-primary={primary ? '' : undefined} onClick={onClick} data-testid={testId}>
      <span className="ed-start-action-icon">
        <Icon name={icon} size={22} />
      </span>
      <span className="ed-start-action-text">
        <span className="ed-start-action-title">{title}</span>
        <span className="ed-start-action-sub">{text}</span>
      </span>
      {shortcut && <Keys keys={shortcut} className="ed-start-action-keys" />}
    </button>
  );
}

export function StartScreen() {
  const t = useT();
  const session = useSession();
  const root = useApp((s) => s.workspace?.root ?? null);
  const recent = useApp((s) => s.workspace?.recent ?? []);
  const busy = useApp((s) => s.fileBusy);
  const { templates } = useTemplates();
  const examples = (templates ?? [])
    .filter((tpl) => !SIZED_TEMPLATES.has(tpl.name))
    .sort((a, b) => {
      const ia = EXAMPLE_ORDER.indexOf(a.name);
      const ib = EXAMPLE_ORDER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const recentItems = recent
    .map((abs) => ({ abs, rel: root ? relativeToRoot(abs, root) : null }))
    .filter((r): r is { abs: string; rel: string } => r.rel !== null);
  const outside = recent.length - recentItems.length;

  return (
    <main className="ed-start r2-scroll" data-testid="start-screen">
      <div className="ed-start-inner">
        <header className="ed-start-hero">
          <span className="ed-start-mark" aria-hidden="true">
            <Icon name="bone" size={30} strokeWidth={1.9} />
          </span>
          <div className="ed-start-heading">
            <h1 className="ed-start-title">Rev2D</h1>
            <p className="ed-start-tagline">{t('files.start.tagline')}</p>
          </div>
          {root && (
            <span className="ed-start-root" title={root}>
              <Icon name="home" size={12} />
              <span className="ed-ellipsis">{root}</span>
            </span>
          )}
        </header>

        <div className="ed-start-actions">
          <ActionCard
            icon="fileNew"
            title={t('files.start.new.title')}
            text={t('files.start.new.text')}
            shortcut={FILE_SHORTCUTS.new}
            onClick={() => session.openDialog({ kind: 'new' })}
            primary
            testId="start-new"
          />
          <ActionCard
            icon="folderOpen"
            title={t('files.start.open.title')}
            text={t('files.start.open.text', { root: rootLabel(root) })}
            shortcut={FILE_SHORTCUTS.open}
            onClick={() => session.openDialog({ kind: 'open' })}
            testId="start-open"
          />
          <ActionCard icon="upload" title={t('files.start.import.title')} text={t('files.start.import.text')} onClick={() => session.pickImportFiles()} testId="start-import" />
        </div>
        <AvatarStartCard />

        <div className="ed-start-columns">
          <section className="ed-start-section" aria-labelledby="start-recent-title">
            <h2 id="start-recent-title" className="ed-start-h2">
              {t('files.recent.title')}
            </h2>
            {recentItems.length === 0 ? (
              <div className="ed-start-empty">
                <Icon name="clock" size={20} className="ed-start-empty-icon" />
                <p>{t('files.start.recent.empty')}</p>
                <p className="ed-muted">{t('files.start.recent.emptyHint')}</p>
              </div>
            ) : (
              <List variant="inset">
                <ListSection>
                  {recentItems.map((r) => (
                    <ListRow
                      key={r.abs}
                      icon={isAvatarSpecPath(r.rel) ? 'avatar' : 'file'}
                      iconColor="var(--r2-kind-part)"
                      title={isAvatarSpecPath(r.rel) ? baseName(dirOf(r.rel)) || rootLabel(root) : baseName(r.rel)}
                      subtitle={dirOf(r.rel) ? `${dirOf(r.rel)}/` : `${rootLabel(root)}/`}
                      disclosure
                      disabled={!!busy}
                      onSelect={() => void session.openRecent(r.abs)}
                      data-testid="start-recent-item"
                    />
                  ))}
                </ListSection>
              </List>
            )}
            {outside > 0 && <p className="ed-start-note">{t('files.start.recent.outside', { n: outside })}</p>}
          </section>

          <section className="ed-start-section" aria-labelledby="start-examples-title">
            <h2 id="start-examples-title" className="ed-start-h2">
              {t('files.start.examples.title')}
              <span className="ed-start-h2-note">{t('files.start.examples.note')}</span>
            </h2>
            <div className="ed-start-examples">
              {templates === null && (
                <div className="ed-start-loading">
                  <Spinner size={14} />
                  <span>{t('files.start.examples.loading')}</span>
                </div>
              )}
              {examples.map((tpl) => {
                const thumb = templateThumbnail(tpl.name);
                return (
                  <button
                    key={tpl.name}
                    type="button"
                    className="ed-start-example"
                    onClick={() => session.openDialog({ kind: 'new', template: tpl.name })}
                    title={tpl.description}
                    data-testid={`example-${tpl.name}`}
                  >
                    <span className="ed-start-example-thumb">{thumb ? <img src={thumb} alt="" /> : <Icon name="model" size={28} />}</span>
                    <span className="ed-start-example-name">{templateTitle(tpl.name)}</span>
                    <span className="ed-start-example-desc">{templateSummary(tpl.name, tpl.description, 90)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="ed-start-foot">
          <Icon name="bolt" size={14} />
          <span>{t('files.start.footer')}</span>
        </footer>
      </div>
    </main>
  );
}
