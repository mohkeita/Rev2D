/**
 * The built-in "Rig" workspace mode: the outliner, the WebGL viewport, the inspector (parameters,
 * selection, problems) and the timeline drawer. It registers itself like any other mode; its slots
 * are exported so another mode can reuse one (e.g. keep the viewport and replace the panels).
 */
import { t } from '../i18n/index.js';
import { InspectorPanel } from '../panels/InspectorPanel.js';
import { Outliner } from '../panels/Outliner.js';
import { Timeline } from '../panels/Timeline.js';
import { DEFAULT_MODE } from '../state/app.js';
import { ViewControls, Viewport, ViewportMessages } from '../viewport/Viewport.js';
import { registerMode } from './registry.js';

/** Height of the closed timeline drawer: its transport bar. */
export const TIMELINE_BAR = 52;

/** The Rig canvas: the viewport edge to edge, its messages and zoom controls in the free area. */
export function RigCanvas() {
  return (
    <>
      <Viewport />
      <ViewportMessages />
      <ViewControls />
    </>
  );
}

export { InspectorPanel as RigTrailing, Outliner as RigLeading, Timeline as RigBottom };

registerMode({
  id: DEFAULT_MODE,
  label: () => t('mode.rig'),
  icon: 'bone',
  order: 0,
  render: { leading: Outliner, canvas: RigCanvas, trailing: InspectorPanel, bottom: Timeline },
  bottomBar: TIMELINE_BAR,
});
