/** Korean. Every key of the English dictionary must be here (the type says so). */
import type { en } from './en.js';
import { ai } from './ko/ai.js';
import { avatar } from './ko/avatar.js';
import { common } from './ko/common.js';
import { files } from './ko/files.js';
import { panels } from './ko/panels.js';
import { session } from './ko/session.js';
import { shell } from './ko/shell.js';

export const ko: Record<keyof typeof en, string> = { ...common, ...ai, ...avatar, ...shell, ...panels, ...session, ...files };
