/**
 * Avatar mode's door to the AI panel (editor/src/ai/api.ts, a separate feature module): a thin
 * adapter that degrades gracefully. The panel module is looked up at build time with
 * import.meta.glob, so this build works with or without it; when it is missing or the agent bridge
 * is off, the AI options are disabled with the reason and the person can copy the same request as
 * text for an agent in a terminal.
 *
 *   loadAi()              the AI module, or null
 *   useAi()               the same in a component (re-renders once it is loaded)
 *   aiAvailability()      {enabled, providers, reason?}
 *   startAi(request)      {jobId} | {error}
 *   avatarCreateRequest / fixPartRequest / terminalRequest   the requests avatar mode sends
 */
import { useEffect, useState } from 'react';
import type { AvatarRef } from '../api.js';

/** What the AI panel module exports (the contract of editor/src/ai/api.ts). */
export interface AiTaskRequest {
  kind: string;
  prompt?: string;
  context?: Record<string, unknown>;
  images?: string[];
  allowImageGeneration?: boolean;
  provider?: string;
}

export type AiTaskResult = { jobId: string } | { error: string };

export interface AiJobView {
  state: string;
  lastStatus: string | null;
  done: boolean;
}

export interface AiAvailability {
  enabled: boolean;
  providers: unknown[];
  reason?: string;
}

export interface AiModule {
  openAiPanel(): void;
  startAiTask(request: AiTaskRequest): Promise<AiTaskResult>;
  useAiJob(jobId: string | null): AiJobView | null;
  aiAvailability(): AiAvailability | Promise<AiAvailability>;
}

// An empty object when editor/src/ai/api.ts is not part of this build.
const modules = import.meta.glob<AiModule>('../ai/api.ts');

let loaded: Promise<AiModule | null> | null = null;
let resolved: AiModule | null | undefined;

/** The AI panel module, or null when this build has none (or it failed to load). */
export function loadAi(): Promise<AiModule | null> {
  if (!loaded) {
    const load = Object.values(modules)[0];
    loaded = load
      ? load().then(
          (m) => {
            const ok = typeof m?.startAiTask === 'function' && typeof m?.openAiPanel === 'function';
            resolved = ok ? m : null;
            return resolved;
          },
          () => (resolved = null),
        )
      : Promise.resolve((resolved = null));
  }
  return loaded;
}

/** Whether this build contains the AI panel at all. */
export const AI_MODULE_PRESENT = Object.keys(modules).length > 0;

/** The AI module in a component: null until loaded (and when there is none). */
export function useAi(): AiModule | null {
  const [mod, setMod] = useState<AiModule | null>(resolved ?? null);
  useEffect(() => {
    let live = true;
    void loadAi().then((m) => live && setMod(m));
    return () => {
      live = false;
    };
  }, []);
  return mod;
}

/** Whether AI jobs can start now, and why not. `missing`: the reason when the panel is not in this build. */
export async function aiAvailability(missing: string): Promise<AiAvailability> {
  const m = await loadAi();
  if (!m) return { enabled: false, providers: [], reason: missing };
  try {
    const a = await m.aiAvailability();
    return { enabled: !!a?.enabled, providers: Array.isArray(a?.providers) ? a.providers : [], ...(a?.reason ? { reason: a.reason } : {}) };
  } catch (e) {
    return { enabled: false, providers: [], reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Start an AI job (the panel opens and shows it). */
export async function startAi(request: AiTaskRequest, missing: string): Promise<AiTaskResult> {
  const m = await loadAi();
  if (!m) return { error: missing };
  try {
    const r = await m.startAiTask(request);
    return r && typeof (r as { jobId?: unknown }).jobId === 'string' ? { jobId: (r as { jobId: string }).jobId } : { error: (r as { error?: string })?.error ?? missing };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function openAiPanel(): void {
  void loadAi().then((m) => m?.openAiPanel());
}

/** The "avatar-create" job for a project: its folder and its illustration, both relative to the workspace root. */
export function avatarCreateRequest(projectPath: string, imagePath: string, prompt?: string): AiTaskRequest {
  return { kind: 'avatar-create', context: { project: projectPath }, images: [imagePath], ...(prompt ? { prompt } : {}) };
}

/** Path of the illustration relative to the workspace root ("" project = the root itself). */
export function projectImagePath(ref: Pick<AvatarRef, 'projectPath'>, imageFile: string): string {
  return ref.projectPath ? `${ref.projectPath}/${imageFile}` : imageFile;
}

/** A free-form request about one part (the prompt is written by the caller in the person's language). */
export function fixPartRequest(projectPath: string, prompt: string, imagePath?: string): AiTaskRequest {
  return { kind: 'freeform', prompt, context: { project: projectPath }, ...(imagePath ? { images: [imagePath] } : {}) };
}

/**
 * The avatar-create request as text for an agent in a terminal (when the in-app bridge is off). It is
 * in English: it is read by an agent, and the Rev2D guides it points to are English.
 */
export function terminalRequest(project: string, projectPath: string): string {
  const where = projectPath ? `"${projectPath}" (${project})` : `"${project}"`;
  return [
    `Create an animated avatar from the illustration in the Rev2D avatar project ${where}.`,
    'Work inside that folder and follow the avatar guide: `rev2d docs avatar` (if that topic is unknown: `rev2d avatar --help` and `rev2d avatar schema`).',
    '1. Run the vision check first (`rev2d avatar vision-check make work/vision`, then `score`); stop if you cannot pass it.',
    '2. Read the picture with `rev2d avatar grid . -o work/grid.png` (add `--region x0,y0,x1,y1` to magnify) and place the landmarks in avatar.json, in SOURCE pixels. "imageLeft" / "imageRight" are sides of the image.',
    '3. Validate after every group with `rev2d avatar validate .` and check the parts with `rev2d avatar overlay . -o work/overlay.png`.',
    '4. Build with `rev2d avatar build .`, review with `rev2d avatar poses .` (look at every sheet in review/) and fix the landmarks behind what looks wrong.',
    'Write only avatar.json and files in work/. The Rev2D editor shows every change of avatar.json live.',
    'Finish with a short note naming the parts you are least sure about (e.g. "face.eyes.imageRight.opening").',
  ].join('\n');
}

/**
 * The "avatar-variants" job: the agent draws the variants with its provider's OWN image generator
 * (the illustration and the edit masks go to that provider), then imports them. `provider` must be
 * one with image generation (AgentProviderInfo.features.imageGeneration).
 */
export function avatarVariantsRequest(projectPath: string, variants: readonly string[], provider?: string): AiTaskRequest {
  return { kind: 'avatar-variants', context: { project: projectPath, ...(variants.length ? { variants: [...variants] } : {}) }, allowImageGeneration: true, ...(provider ? { provider } : {}) };
}

/** A provider that can draw: installed and with a built-in image generator. */
export interface DrawingProvider {
  id: string;
  name: string;
}

/** The first provider of an availability answer that can draw pictures, or null. */
export function drawingProvider(a: AiAvailability | null): DrawingProvider | null {
  for (const p of a?.providers ?? []) {
    const v = p as { id?: unknown; name?: unknown; available?: unknown; features?: { imageGeneration?: unknown } };
    if (v && v.available === true && v.features?.imageGeneration === true && typeof v.id === 'string') return { id: v.id, name: typeof v.name === 'string' ? v.name : v.id };
  }
  return null;
}

/**
 * The drawn-variants request as text for an agent in a terminal (English, like the guides it points
 * to): request, draw with an image generator, import, review.
 */
export function variantsTerminalRequest(project: string, projectPath: string, variants: readonly string[]): string {
  const where = projectPath ? `"${projectPath}" (${project})` : `"${project}"`;
  const ids = variants.length ? ` ${variants.join(' ')}` : '';
  return [
    `Draw eye and mouth variants for the built Rev2D avatar project ${where} with an image generator, then import them.`,
    'Work inside that folder ("rev2d help avatar variants" shows the exact arguments).',
    `1. Run \`rev2d avatar variants request .${ids}\`. Read variant-requests/README.md and look at every mask and at variant-requests/preview.png.`,
    '2. For each variant, edit source.png with your image generator exactly as variant-requests/<id>.prompt.txt says, changing only the area its mask leaves transparent; same size, framing, style and colours. Save it as variants/<id>.png and compare it with source.png.',
    '3. Run `rev2d avatar variants import .`. When a drawing is rejected, read the reason, draw it again and import again (at most three attempts per variant).',
    '4. Review with `rev2d avatar poses .` and look at review/eyes.png and review/mouth.png: no seam, halo or colour step around the sprites.',
    'Never modify source.png or avatar.json. Finish with a short note: which variants were accepted, which were left out and why.',
  ].join('\n');
}
