/**
 * The Rig mode's trailing panel: a segmented control over three pages.
 *
 *   Parameters   the control surface: sliders for every parameter;
 *   Inspector    the selected object: live values, what drives it, its JSON;
 *   Problems     validation diagnostics of the file.
 *
 * The inspector page stays mounted while another page shows, so an unfinished JSON edit survives a
 * look at the sliders.
 */
import { Inspector, SegmentedControl } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { errorCount, warningCount, type InspectorTab } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { Diagnostics } from './Diagnostics.js';
import { SelectionInspector } from './Inspector.js';
import { Parameters } from './Parameters.js';
import './inspector.css';

export function InspectorPanel() {
  const session = useSession();
  const t = useT();
  const tab = useApp((s) => s.inspectorTab);
  const counts = useApp((s) => ({ errors: errorCount(s.diagnostics), warnings: warningCount(s.diagnostics) }), shallowEqual);
  const selected = useApp((s) => s.selection.length);
  const problems = counts.errors + counts.warnings;
  return (
    <Inspector
      aria-label={t('shell.pane.trailing')}
      className="ed-inspector"
      padded={false}
      data-testid="inspector-panel"
      header={
        <SegmentedControl<InspectorTab>
          block
          aria-label={t('shell.pane.trailing')}
          value={tab}
          onChange={(next) => session.setInspectorTab(next)}
          data-testid="inspector-tabs"
          options={[
            { value: 'parameters', label: t('inspector.tab.parameters') },
            {
              value: 'selection',
              label: (
                <>
                  {t('inspector.tab.selection')}
                  {selected > 0 && tab !== 'selection' && <span className="ed-tab-dot" aria-hidden="true" />}
                </>
              ),
            },
            {
              value: 'problems',
              label: (
                <>
                  {t('inspector.tab.problems')}
                  {problems > 0 && <span className="ed-tab-dot" data-tone={counts.errors ? 'danger' : 'warning'} title={String(problems)} />}
                </>
              ),
            },
          ]}
        />
      }
    >
      {tab === 'parameters' && <Parameters />}
      <div className="ed-inspector-page r2-scroll" hidden={tab !== 'selection'}>
        <SelectionInspector active={tab === 'selection'} />
      </div>
      {tab === 'problems' && <Diagnostics />}
    </Inspector>
  );
}
