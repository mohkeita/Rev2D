/**
 * Agent task templates of avatar mode (docs/AGENT-BRIDGE.md §5): what an in-app agent is asked to do
 * with an avatar project. The preamble of every job (where the agent is, how to call Rev2D, the
 * privacy and image rules) comes first; a template only writes the task that follows it.
 *
 *   avatar-create    context {project}             fill in avatar.json for the project's illustration,
 *                                                  build the avatar, review its poses, fix, hand over
 *   avatar-variants  context {project, variants?}  draw eye / mouth variants with the agent's OWN image
 *                                                  generator and import them; the job must allow image
 *                                                  generation
 *
 * `context.project` is the project folder relative to the workspace root (AvatarRef.projectPath): the
 * agent bridge makes it the job's working directory, so the commands below name the project as ".".
 * The in-app flow: POST /api/avatar/new (a project from one picture), then POST /api/agent/jobs
 * {provider, kind: "avatar-create", context: {project: projectPath}, images: [image.path]}.
 *
 * Importing this module registers the templates (the editor server does).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { VARIANT_IDS, type VariantId } from '../avatar/types.js';
import { AgentError, PROVIDERS, registerTaskTemplate, rev2dCommand, type TaskInput, type TaskTemplate } from '../node/agent/index.js';
import { LAYERS_FILE, SOURCE_FILE, SPEC_FILE } from './avatar-routes.js';

/** The variants worth drawing first: they replace the two deformations a mesh does worst. */
export const RECOMMENDED_VARIANTS: readonly VariantId[] = ['eyes_closed', 'mouth_a'];

const PROJECT_HINT =
  'send "context": {"project": "<the folder of the avatar project, relative to the workspace root>"}; POST /api/avatar/new creates a project from a picture and returns that path as "projectPath"';

/** The job's working directory must be an avatar project (the bridge resolved context.project to it). */
function requireProject(kind: string, input: TaskInput): void {
  if (existsSync(path.join(input.env.cwd, SPEC_FILE))) return;
  throw new AgentError('invalid', `the "${kind}" task needs an avatar project: ${input.env.cwd} has no ${SPEC_FILE}`, PROJECT_HINT);
}

/** What the person added in their own words, as a closing paragraph. */
function wishes(prompt: string): string[] {
  return prompt ? ['', 'From the person', prompt] : [];
}

export const avatarCreateTask: TaskTemplate = {
  kind: 'avatar-create',
  title: 'Create an avatar from this illustration',
  description:
    'Places the landmarks of an avatar project on its illustration (avatar.json), builds the avatar, reviews its poses and fixes what is off. Context: {"project": "<project folder>"}; attach the illustration as an image.',
  needsPrompt: false,
  build(input) {
    requireProject('avatar-create', input);
    const rev2d = rev2dCommand(input.env.rev2dBin);
    return [
      'Create an animated avatar from the illustration in this project folder.',
      '',
      'The project (your working directory)',
      `- ${SOURCE_FILE}: the illustration. Never modify it.`,
      `- ${SPEC_FILE}: the avatar spec, the one file you write. It holds landmarks placed on the illustration in SOURCE PIXELS (origin top-left, +x right, +y down) and starts as a draft in which every landmark is null.`,
      '- Built from those two by Rev2D, never edited by hand (every build regenerates them): <name>.r2d.json (the model), textures/ (the layer images and layers.json), review/ (pose sheets).',
      '- work/: your scratch images (grids, overlays). Create it as you go.',
      '',
      'How it works: Rev2D cuts the picture into layers along your polygons (eyes, hair, accessories), fills in what was behind them and generates an ordinary Rev2D model that blinks, talks, turns and tilts its head, breathes and sways its hair. How good the avatar looks is decided by how accurately the landmarks sit on the picture.',
      '',
      'The guide',
      `Run "${rev2d} docs avatar" and follow it: it is the working guide for exactly this job. If this version of Rev2D answers that the topic is unknown, use "${rev2d} avatar --help" (the commands, in the order they are used), "${rev2d} help avatar <command>" (flags and examples) and "${rev2d} avatar schema" (every field of ${SPEC_FILE}: what each landmark is and where it goes).`,
      '',
      'Steps',
      `1. Vision check, before anything else: "${rev2d} avatar vision-check make work/vision" writes a test picture with 12 crosshair markers. Find their centres the way you will read landmarks (grid images, magnified regions), write them to work/vision/answer.json and run "${rev2d} avatar vision-check score work/vision work/vision/answer.json". If you cannot pass it, stop and say so in your report: landmarks placed blind are worse than none.`,
      `2. Read the picture: "${rev2d} avatar grid . -o work/grid.png" draws the whole illustration with pixel coordinates; "--region x0,y0,x1,y1" magnifies a part. Make magnified grids of each eye, the mouth, the hairline, the neck and every accessory, and look at every image you make.`,
      `3. Place the landmarks in ${SPEC_FILE}, group by group: the head (an ellipse around the head and ALL hair, the neck pivot, the neck band), the face (oval; per eye the opening and the region around lashes and lids, the iris; nose, mouth corners and mouth area, chin; brows, cheeks and ears where they are visible), the hair strands (root to tip, one per lock that should sway), the attachments (things that swing, jiggle or lie in front of the head or body) and the body (sway pivot, fade band, chest, shoulders). "imageLeft" and "imageRight" are sides of the IMAGE, not of the character.`,
      `4. Validate after every group: "${rev2d} avatar validate ." lists what is still to place and what is wrong, each with a hint. Fix every error, and every warning you cannot explain.`,
      `5. Check the landmarks on the picture: "${rev2d} avatar overlay . -o work/overlay.png", then one part at a time, magnified: "${rev2d} avatar overlay . --part eyes.imageLeft --zoom -o work/eye-left.png" (eyes, mouth, face, head, strands, attachments, body). Correct whatever is off by more than a few pixels and look again.`,
      `6. Build: "${rev2d} avatar build ." cuts the layers and writes the model. Read its warnings (folds name the parameters and the place).`,
      `7. Review: "${rev2d} avatar poses ." writes review/poses.png, review/turn.png, review/eyes.png, review/mouth.png and review/summary.json (how far each landmark moves in each pose). Look at every sheet. The rest pose must be the illustration; closed eyes must be clean, with no iris or eye white left; turning and tilting must not tear the picture, cut the chin or the ears, or bend rigid accessories; the open mouth must not stretch the chin; hair must sway without dragging the face.`,
      `8. Fix what is wrong by correcting the landmark behind it in ${SPEC_FILE}, then repeat steps 4 to 7. Stop when the sheets look right, or when another round no longer improves them.`,
      '',
      'Rules for this task',
      `- Write ${SPEC_FILE} and your scratch files in work/, nothing else. To customise the generated model, add edit ops to the "post" list of ${SPEC_FILE} (they are applied after every build); never edit the model file.`,
      `- The person is watching the editor: every change of ${SPEC_FILE}, the layers and the model shows there at once, and they may move a landmark themselves. Read ${SPEC_FILE} again before you write it, and keep it valid JSON at every save.`,
      '- Do not generate, redraw or retouch pictures in this task.',
      '',
      'Hand-over note',
      `Finish with a short note for the person: what you built and how you checked it, then the parts you are LEAST sure about, the most doubtful first. Name each by its place in ${SPEC_FILE} (for example "face.eyes.imageRight.opening" or the strand "bang3") and say in one sentence what may be off, so the person knows which handles to check first in the editor.`,
      ...wishes(input.prompt),
    ].join('\n');
  },
};

const VARIANTS_HINT = `send "context": {"project": "<project folder>", "variants": ["eyes_closed", "mouth_a"]} with ids out of: ${VARIANT_IDS.join(', ')} (no "variants": the recommended ones, ${RECOMMENDED_VARIANTS.join(' and ')})`;

/** The requested variant ids, checked; empty when the request leaves the choice to the tool. */
function requestedVariants(context: Record<string, unknown>): VariantId[] {
  const raw = context.variants;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) throw new AgentError('invalid', '"context.variants" must be a list of variant ids', VARIANTS_HINT);
  const unknown = (raw as string[]).filter((v) => !(VARIANT_IDS as readonly string[]).includes(v));
  if (unknown.length) throw new AgentError('invalid', `unknown variant${unknown.length === 1 ? '' : 's'} ${unknown.map((v) => `"${v}"`).join(', ')} in "context.variants"`, VARIANTS_HINT);
  // Each one once, in the order the tool lists them.
  return VARIANT_IDS.filter((id) => (raw as string[]).includes(id));
}

export const avatarVariantsTask: TaskTemplate = {
  kind: 'avatar-variants',
  title: 'Draw eye and mouth variants',
  description:
    'Draws closed eyes and mouth shapes for a built avatar with the agent\'s own image generator, imports them as sprites and reviews the result. Context: {"project": "<project folder>", "variants"?: ["eyes_closed", "mouth_a", ...]}. The job must allow image generation ("allowImageGeneration": true).',
  needsPrompt: false,
  build(input) {
    const { env } = input;
    requireProject('avatar-variants', input);
    if (!env.allowImageGeneration) {
      throw new AgentError(
        'invalid',
        'the "avatar-variants" task draws pictures: it needs image generation to be allowed for the job',
        'send "allowImageGeneration": true with the job (the agent then uses its own built-in image generator, and only that one)',
      );
    }
    const provider = PROVIDERS[env.provider];
    if (!provider.features.imageGeneration) {
      const able = Object.values(PROVIDERS).filter((p) => p.features.imageGeneration);
      throw new AgentError(
        'invalid',
        `${provider.name} has no built-in image generator, so it cannot draw variants`,
        able.length ? `start the job with a provider that has one: ${able.map((p) => `"${p.id}" (${p.name})`).join(', ')}` : 'no provider with an image generator is available',
      );
    }
    if (env.sandbox === 'read-only') {
      throw new AgentError('invalid', 'the "avatar-variants" task saves pictures: it cannot run read-only', 'send "sandbox": "workspace-write" (the default)');
    }
    if (!existsSync(path.join(env.cwd, ...LAYERS_FILE.split('/')))) {
      throw new AgentError('invalid', `the avatar in ${env.cwd} is not built yet: variants are cut to fit its layers`, 'build it first (the Build button, POST /api/avatar/build, or "rev2d avatar build <project>"), then start this task');
    }
    const ids = requestedVariants(input.context);
    const rev2d = rev2dCommand(env.rev2dBin);
    const list = ids.length ? ids.join(', ') : `the recommended ones (the request command picks them when you name none; usually ${RECOMMENDED_VARIANTS.join(' and ')})`;
    return [
      'Draw eye and mouth variants of this avatar with your built-in image generator, then import them.',
      '',
      'The project (your working directory)',
      `A built avatar: ${SOURCE_FILE} (the illustration; never modify it), ${SPEC_FILE} (its landmarks), the model and textures/. A drawn variant is a full-size copy of the illustration in which ONE thing is redrawn: the eyes closed, the mouth saying "a", and so on. Rev2D cuts the redrawn area out as a sprite that replaces the mesh deformation, which is only a fallback.`,
      '',
      `Variants to draw: ${list}`,
      '',
      'Steps',
      `1. Request: "${rev2d} avatar variants request .${ids.length ? ` ${ids.join(' ')}` : ''}" ("${rev2d} help avatar variants" shows the exact arguments). For every variant it writes variant-requests/<id>.mask.png (the edit mask: TRANSPARENT pixels may change, OPAQUE pixels must stay identical), variant-requests/<id>.prompt.txt (what to draw) and variant-requests/README.md. Read the README and look at every mask.`,
      `2. Draw each variant with your built-in image generation tool, one at a time: edit ${SOURCE_FILE} as the prompt file says, changing only the area its mask leaves transparent. The drawing must have exactly the size of ${SOURCE_FILE}, the same style, colours and line weight, a transparent background wherever the illustration has one, and nothing moved or repainted outside the mask. Save it as variants/<id>.png and look at it next to ${SOURCE_FILE} before you go on.`,
      `3. Import: "${rev2d} avatar variants import ." checks every drawing (same size, unchanged outside its mask, changed inside it) and cuts the accepted ones into sprite layers. When a drawing is rejected, read the reason, draw it again and import again; after three failed attempts leave that variant out.`,
      `4. Rebuild and review: "${rev2d} avatar build .", then "${rev2d} avatar poses ."; look at review/eyes.png, review/mouth.png and review/poses.png. A sprite must sit exactly where the eyes or the mouth are, with no seam, halo or colour step around it, and the face must not jump between a sprite and the poses next to it. A variant that looks worse than the pose without it is drawn again or removed (delete variants/<id>.png, import, build).`,
      '5. Report: the variants that were accepted, the ones that were left out and why, and what still looks off.',
      '',
      'Rules for this task',
      '- Use ONLY your built-in image generator. Never send the illustration to an external image service, API or website.',
      `- Never modify ${SOURCE_FILE} or the files in variant-requests/, and do not move landmarks in ${SPEC_FILE}. You write variants/<id>.png, and scratch files in work/.`,
      '- Draw only the variants listed above.',
      ...wishes(input.prompt),
    ].join('\n');
  },
};

/** The task templates of avatar mode, in menu order. */
export const AVATAR_TASKS: readonly TaskTemplate[] = [avatarCreateTask, avatarVariantsTask];

for (const template of AVATAR_TASKS) registerTaskTemplate(template);
