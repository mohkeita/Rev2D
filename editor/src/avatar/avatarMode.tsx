/**
 * Avatar mode: fix an avatar by dragging handles on its illustration, with a live preview. Available
 * while an avatar project is open (the open model has an avatar.json next to it, or the project
 * itself was opened), also before its first build (`showsWithoutModel`: the shell shows the project
 * without a model), and the default mode of an avatar project (`isDefault`).
 *
 *   leading   the parts of the spec (PartsList)
 *   canvas    the illustration with handles (AvatarCanvas) and its HUD (AvatarHud)
 *   trailing  the live preview with Pose / Lip sync / Selected, or, before the first build, the
 *             checklist of the landmarks to place and Build (AvatarPanel)
 *   status    what the spec still lacks (AvatarStatus, in the shell's status line)
 *   document  avatar.json (document.ts): the toolbar's Save / Undo / Redo and the unsaved prompt
 */
import { t } from '../i18n/index.js';
import { registerMode } from '../shell/registry.js';
import type { AppState } from '../state/app.js';
import { AvatarCanvas } from './AvatarCanvas.js';
import { AvatarHud, AvatarStatus } from './AvatarHud.js';
import { AvatarPanel } from './AvatarPanel.js';
import { avatarDocument } from './document.js';
import { AVATAR_MODE } from './hooks.js';
import { PartsList } from './PartsList.js';

export function AvatarCanvasSlot() {
  return (
    <>
      <AvatarCanvas />
      <AvatarHud />
    </>
  );
}

const projectOpen = (state: AppState): boolean => !!state.workspace?.avatar;

registerMode({
  id: AVATAR_MODE,
  label: () => t('avatar.mode'),
  icon: 'avatar',
  order: 10,
  isAvailable: projectOpen,
  showsWithoutModel: projectOpen,
  isDefault: projectOpen,
  document: avatarDocument,
  render: { leading: PartsList, canvas: AvatarCanvasSlot, trailing: AvatarPanel, status: AvatarStatus },
  paneLabels: { leading: () => t('avatar.parts.title'), trailing: () => t('avatar.panel.label') },
});
