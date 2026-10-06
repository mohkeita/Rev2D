/**
 * The in-app agent bridge's runner (docs/AGENT-BRIDGE.md): a provider-neutral way to start the Codex
 * CLI or Claude Code for a request, follow it as normalised events, cancel it and continue its session.
 *
 *   types.ts     protocol types (events, jobs, providers, settings) and AgentError
 *   exec.ts      finding a CLI and starting / killing it without a shell
 *   provider.ts  what a provider supplies; text limits; assertSafeArgs
 *   codex.ts     provider "codex" (codex exec --json), its Windows sandbox problem
 *   claude.ts    provider "claude" (claude -p --output-format stream-json)
 *   prompt.ts    the preamble and the task-template registry
 *   logs.ts      job log files and their rotation
 *   settings.ts  the settings a person can change (~/.rev2d/settings.json) and their sources
 *   manager.ts   AgentManager: jobs, timeouts, the stall watchdog, the one-job rule
 */
export * from './types.js';
export { LineSplitter, commandFromPath, explicitCommand, findOnPath, killTree, parseNpmShim, processAlive, resolveCommand, runCommand, spawnCommand, type ResolvedCommand } from './exec.js';
export { assertSafeArgs, type AgentProvider, type ParsedLine, type ProviderProblem, type ProviderRun, type StreamParser } from './provider.js';
export { codexProvider, windowsSandboxHint } from './codex.js';
export { claudeProvider, rev2dCommandRules } from './claude.js';
export { buildAgentPrompt, buildPreamble, registerTaskTemplate, rev2dCommand, taskTemplate, taskTemplates, type BuiltPrompt, type PromptEnv, type TaskInput, type TaskTemplate } from './prompt.js';
export { JobLog, MAX_LOG_FILES, defaultLogDir, listLogFiles, logFileName, rotateLogs } from './logs.js';
export {
  AgentSettingsStore,
  CODEX_WINDOWS_SANDBOXES,
  DEFAULT_AGENT_SETTINGS,
  defaultSettingsFile,
  isCodexWindowsSandbox,
  readUserAgentSettings,
  writeUserAgentSettings,
  type AgentSettingsStoreOptions,
} from './settings.js';
export {
  AgentManager,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_PROMPT_BYTES,
  DEFAULT_STALL_MS,
  DEFAULT_TIMEOUT_MS,
  EFFORTS,
  IMAGE_NAME,
  MAX_IMAGES,
  MODEL_NAME,
  PROVIDERS,
  PROVIDER_IDS,
  SANDBOXES,
  type AgentListener,
  type AgentManagerOptions,
} from './manager.js';
