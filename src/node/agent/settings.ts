/**
 * Settings of the agent bridge that a person can change, and where they come from.
 *
 * Today there is one: `codexWindowsSandbox` (see CodexWindowsSandbox in types.ts). Sources, strongest
 * first:
 *   1. an option of the editor server: startEditorServer({agent: {codexWindowsSandbox}}) ("option"),
 *      which is also how `rev2d edit --agent-codex-sandbox <value>` arrives ("flag");
 *   2. the person's settings file ~/.rev2d/settings.json: {"agent": {"codexWindowsSandbox": "unelevated"}}
 *      ("user"; PUT /api/agent/settings writes it);
 *   3. the default "config": leave the person's Codex configuration alone.
 *
 * A job request can never set them: they are not fields of a job, and the request schema is strict.
 * The settings file is read whenever the settings are needed, so an edit by hand counts at once; other
 * keys of the file (other features may keep theirs there) are preserved on write.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentError, type AgentSettingSource, type AgentSettings, type AgentSettingsInfo, type CodexWindowsSandbox } from './types.js';

export const CODEX_WINDOWS_SANDBOXES: CodexWindowsSandbox[] = ['config', 'unelevated'];
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { codexWindowsSandbox: 'config' };

/** ~/.rev2d/settings.json */
export function defaultSettingsFile(): string {
  return path.join(os.homedir(), '.rev2d', 'settings.json');
}

export function isCodexWindowsSandbox(value: unknown): value is CodexWindowsSandbox {
  return typeof value === 'string' && (CODEX_WINDOWS_SANDBOXES as string[]).includes(value);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The whole settings file as an object; `problem` says why it could not be used (a missing file is fine). */
function readFile(file: string): { doc: Record<string, unknown>; problem?: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { doc: {} } : { doc: {}, problem: `${file} cannot be read (${(e as Error).message})` };
  }
  try {
    const doc: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!isObject(doc)) return { doc: {}, problem: `${file} is not a JSON object` };
    return { doc };
  } catch (e) {
    return { doc: {}, problem: `${file} is not valid JSON (${(e as Error).message})` };
  }
}

/**
 * The "agent" section of the person's settings file. Never throws: a missing file gives no settings,
 * an unreadable file or an unknown value is ignored and named in `notes`.
 */
export function readUserAgentSettings(file: string): { settings: Partial<AgentSettings>; notes: string[] } {
  const { doc, problem } = readFile(file);
  if (problem) return { settings: {}, notes: [`${problem}; it is ignored`] };
  const agent = doc.agent;
  if (agent === undefined) return { settings: {}, notes: [] };
  if (!isObject(agent)) return { settings: {}, notes: [`"agent" in ${file} is not an object; it is ignored`] };
  const settings: Partial<AgentSettings> = {};
  const notes: string[] = [];
  if (agent.codexWindowsSandbox !== undefined) {
    if (isCodexWindowsSandbox(agent.codexWindowsSandbox)) settings.codexWindowsSandbox = agent.codexWindowsSandbox;
    else notes.push(`agent.codexWindowsSandbox in ${file} is ${JSON.stringify(agent.codexWindowsSandbox)}, not one of ${CODEX_WINDOWS_SANDBOXES.map((s) => `"${s}"`).join(', ')}; it is ignored`);
  }
  return { settings, notes };
}

/**
 * Merge `patch` into the "agent" section of the settings file (created with its directory when
 * missing; every other key is kept). Throws AgentError "settings-file" when the file exists but is not
 * a JSON object (it is not overwritten) or cannot be written.
 */
export function writeUserAgentSettings(file: string, patch: Partial<AgentSettings>): void {
  const { doc, problem } = readFile(file);
  if (problem) throw new AgentError('settings-file', `the setting was not saved: ${problem}`, `fix the file by hand or delete it (it should hold a JSON object such as {"agent": {"codexWindowsSandbox": "unelevated"}}), then try again`);
  const agent = isObject(doc.agent) ? doc.agent : {};
  const next = { ...doc, agent: { ...agent, ...patch } };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // Written next to the file and renamed over it, so a reader never sees half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    throw new AgentError('settings-file', `the setting was not saved: cannot write ${file} (${(e as Error).message})`, 'check that the directory is writable');
  }
}

export interface AgentSettingsStoreOptions {
  /** The person's settings file; null: keep the user settings in memory only (nothing is read or written). */
  file: string | null;
  /** Settings given to the server itself: they beat the settings file. */
  option?: Partial<AgentSettings>;
  /** What `option` is called in AgentSettingsInfo.sources ("flag" when it came from the command line). */
  optionSource?: 'option' | 'flag';
  /** Default process.platform. */
  platform?: NodeJS.Platform;
}

/** The effective agent settings of one editor server. */
export class AgentSettingsStore {
  readonly file: string | null;
  private readonly option: Partial<AgentSettings>;
  private readonly optionSource: 'option' | 'flag';
  private readonly windows: boolean;
  /** The user settings when there is no file. */
  private memory: Partial<AgentSettings> = {};

  constructor(opts: AgentSettingsStoreOptions) {
    this.file = opts.file === null ? null : path.resolve(opts.file);
    this.option = {};
    if (opts.option?.codexWindowsSandbox !== undefined) {
      if (!isCodexWindowsSandbox(opts.option.codexWindowsSandbox)) {
        throw new Error(`agent.codexWindowsSandbox must be ${CODEX_WINDOWS_SANDBOXES.map((s) => `"${s}"`).join(' or ')}, got ${JSON.stringify(opts.option.codexWindowsSandbox)}`);
      }
      this.option.codexWindowsSandbox = opts.option.codexWindowsSandbox;
    }
    this.optionSource = opts.optionSource ?? 'option';
    this.windows = (opts.platform ?? process.platform) === 'win32';
  }

  private user(): { settings: Partial<AgentSettings>; notes: string[] } {
    return this.file === null ? { settings: { ...this.memory }, notes: [] } : readUserAgentSettings(this.file);
  }

  /** The effective settings: what the next job uses. */
  get(): AgentSettings {
    return this.info().settings;
  }

  /** The effective settings with their sources (GET /api/agent/settings). */
  info(): AgentSettingsInfo {
    const user = this.user();
    const notes = [...user.notes];
    const pick = <K extends keyof AgentSettings>(key: K): { value: AgentSettings[K]; source: AgentSettingSource } => {
      const option = this.option[key];
      if (option !== undefined) {
        const saved = user.settings[key];
        if (saved !== undefined && saved !== option) {
          const how = this.optionSource === 'flag' ? 'this editor was started with a flag' : 'this editor server was started with an option';
          notes.push(`${key}: the saved value "${saved}" is not used, because ${how} that sets "${option}"; it counts once the editor is started without it`);
        }
        return { value: option as AgentSettings[K], source: this.optionSource };
      }
      const saved = user.settings[key];
      if (saved !== undefined) return { value: saved as AgentSettings[K], source: 'user' };
      return { value: DEFAULT_AGENT_SETTINGS[key], source: 'default' };
    };
    const sandbox = pick('codexWindowsSandbox');
    if (!this.windows && sandbox.value !== 'config') notes.push('codexWindowsSandbox only has an effect on Windows');
    return {
      settings: { codexWindowsSandbox: sandbox.value },
      sources: { codexWindowsSandbox: sandbox.source },
      user: user.settings,
      file: this.file,
      windows: this.windows,
      notes,
    };
  }

  /** Save user settings (to the settings file, or in memory without one) and return the result. */
  setUser(patch: Partial<AgentSettings>): AgentSettingsInfo {
    if (patch.codexWindowsSandbox !== undefined && !isCodexWindowsSandbox(patch.codexWindowsSandbox)) {
      throw new AgentError('invalid', `codexWindowsSandbox must be ${CODEX_WINDOWS_SANDBOXES.map((s) => `"${s}"`).join(' or ')}`);
    }
    if (this.file === null) this.memory = { ...this.memory, ...patch };
    else writeUserAgentSettings(this.file, patch);
    return this.info();
  }
}
