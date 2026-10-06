/**
 * Messages the session produces (toasts, busy labels, undo labels, the reasons shown in dialogs).
 * Unit tests of the session read the English text: keep it stable.
 */
export const session = {
  'session.theModel': 'the model',
  'session.theModelCap': 'The model',
  'session.theModelFile': 'The model file',
  'session.noModel': 'No model is open.',

  'session.reloadFailed': 'Reload failed: {message}',
  'session.missing': '{name} was deleted or moved on disk.',
  'session.missingKept': '{name} was deleted or moved on disk. It is still open here: Save (Ctrl+S) writes it back, Save As… stores it elsewhere.',
  'session.replacedByDisk': 'The file changed on disk; your unsaved edit was replaced by the new version.',
  'session.evalFailed': 'Evaluation failed: {message}',

  'session.history.external': 'External change',
  'session.history.edit': 'Edit {target}',
  'session.history.import': 'Import {label}',
  'session.undo': 'Undo: {label}',
  'session.redo': 'Redo: {label}',

  'session.edit.notJson': 'The file on disk is not valid JSON; fix it in your text editor first.',
  'session.edit.gone': '{target} no longer exists in the file.',

  'session.saved': 'Saved',
  'session.savedOver': 'Saved: your version replaced the change on disk.',
  'session.saveAnyway': 'Save anyway',
  'session.save.notJson': 'Nothing to save: the file is not valid JSON.',
  'session.save.upToDate': 'No unsaved changes: the file on disk is up to date.',
  'session.write.rejected': 'Not saved: the server rejected the model ({n} {n|error|errors}).',
  'session.write.conflict': 'Not saved: the file changed on disk since it was loaded.',
  'session.write.switched': 'Not saved: {name} was opened meanwhile.',
  'session.write.switchedToast': 'Not saved: another model ({name}) was opened meanwhile.',
  'session.write.failed': 'Save failed: {message}',
  'session.guard.notJson': 'The file is not valid JSON, so it cannot be saved from here.',

  // What the person was about to do when the unsaved-changes question came up ("…it is lost when you {action}.").
  'session.action.open': 'open {name}',
  'session.action.new': 'create a new model',
  'session.action.newAvatar': 'create a new avatar',
  'session.action.saveAs': 'save the model as {name}',
  'session.action.import': 'import {name}',
  'session.action.close': 'close it',
  'session.action.reload': 'reload it from disk',

  'session.busy.opening': 'Opening {name}…',
  'session.busy.creating': 'Creating {name}…',
  'session.busy.saving': 'Saving {name}…',
  'session.busy.importing': 'Importing {name}…',
  'session.busy.exporting': 'Exporting to {format}…',
  'session.busy.closing': 'Closing…',

  'session.opened': 'Opened {path}',
  'session.created': 'Created {path}',
  'session.savedAs': 'Saved as {path}',
  'session.imported': 'Imported {path}',
  'session.reloaded': 'Reloaded {name} from disk',
  'session.exported': 'Exported {name}',
  'session.openFailed': 'Could not open {name}: {error}',
  'session.closeFailed': 'Could not close the model: {error}',
  'session.exportFailed': 'Export failed: {message}',
  'session.readFailed': 'Could not read the picked files: {message}',
  'session.modelUnreadable': 'The model file could not be read.',
  'session.downloadedUnsaved': 'Downloaded the version shown in the editor (it is not saved to disk yet).',
  'session.report': 'Report',
  'session.spineReport': 'Spine Import Report',

  'session.live2d.notJson': 'The model file is not valid JSON; fix it before importing into it.',
  'session.live2d.files': '{n} Live2D files',
  'session.live2d.opFailed': 'The import failed: op #{index} ({op}): {message}',
  'session.live2d.invalid': 'The imported model would have {n} validation {n|error|errors}; nothing was changed.',

  'session.closedElsewhere': '{name} was closed in another tab',
  'session.openedElsewhere': '{name} was opened in another tab',
  'session.editDiscarded': 'Your unsaved edit to {name} was discarded.',

  // Shown with the caption "AI": what an AI tool did through the bridge, or what was wrong with its command.
  'session.ai.closed': 'closed {name}',
  'session.ai.opened': 'opened {name}',
  'session.ai.unknownParams': 'AI setParams: unknown {n|parameter|parameters} {list}',
  'session.ai.unknownAnimation': 'AI play: unknown animation "{id}"',
  'session.ai.setAnimations': 'AI setAnimations: {text}',
  'session.ai.animations.unknown': 'unknown animation {list}',
  'session.ai.animations.clamped': 'weights are limited to 0..1 in the editor ({list})',
  'session.ai.animations.repeated': 'each animation plays once in the editor; ignored repeated {list}',
  'session.ai.animations.badOptions': 'ignored bad layer options ({list}); mode is "override" or "add", start a number of seconds, hold true or false',
  'session.ai.selectMissing': 'AI select: not found: {list}',
  'session.ai.unknownOverlay': 'AI setOverlay: unknown layer {list} (valid: {valid})',
  'session.ai.badViewBox': 'AI focus: bad viewBox {value} (need "fit" or [x, y, w, h] with w, h > 0)',
} satisfies Record<string, string>;
