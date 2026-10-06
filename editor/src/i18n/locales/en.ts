/** English: the source dictionary. Its keys are the message keys of the editor (see ../index.ts). */
import { ai } from './en/ai.js';
import { avatar } from './en/avatar.js';
import { common } from './en/common.js';
import { files } from './en/files.js';
import { panels } from './en/panels.js';
import { session } from './en/session.js';
import { shell } from './en/shell.js';

export const en = { ...common, ...ai, ...avatar, ...shell, ...panels, ...session, ...files };
