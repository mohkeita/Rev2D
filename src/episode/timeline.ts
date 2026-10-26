import type { Diagnostic } from '../core/types.js';
import { resolveCue, type WordTiming } from '../scene/alignment.js';
import { episodeDiagnostic, type Episode, type Shot, type Transition } from './schema.js';
export interface TimedShot {
  shot: Shot;
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  frames: number;
  duration: number;
  transition: Transition;
}
export interface EpisodeTimeline {
  episode: Episode;
  shots: TimedShot[];
  frames: number;
  duration: number;
}
export function resolveEpisode(
  episode: Episode,
  words: readonly WordTiming[],
  audioDuration: number,
): { timeline: EpisodeTimeline | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [],
    shots: TimedShot[] = [],
    ids = new Set<string>();
  let previous = 0,
    previousStart = -Infinity;
  const cue = (value: number | string, after: number) =>
    typeof value === 'string' && /^@end(?:[+-]\d+(?:\.\d+)?)?$/.test(value)
      ? audioDuration + Number(value.slice(4) || 0)
      : resolveCue(value, words, 0, after);
  episode.shots.forEach((shot, i) => {
    const p = '/shots/' + i;
    if (ids.has(shot.id))
      diagnostics.push(
        episodeDiagnostic(
          'episode-duplicate-id',
          p + '/id',
          `duplicate shot ${shot.id}`,
          'give every shot a unique id',
        ),
      );
    ids.add(shot.id);
    const start = cue(shot.start, previousStart),
      end = cue(shot.end, (start ?? 0) - 1e-6);
    if (start === null || end === null) {
      diagnostics.push(
        episodeDiagnostic(
          'episode-cue-not-found',
          p,
          start === null ? `unknown start cue ${shot.start}` : `unknown end cue ${shot.end}`,
          'use a phrase from the alignment, @word:N, @end or numeric seconds',
        ),
      );
      return;
    }
    if (start < 0 || end <= start)
      diagnostics.push(
        episodeDiagnostic(
          'episode-shot-range',
          p,
          'shot end must follow its nonnegative start',
          'use 0 <= start < end',
        ),
      );
    if (Math.abs(start - previous) > 1e-6)
      diagnostics.push(
        episodeDiagnostic(
          start > previous ? 'episode-gap' : 'episode-overlap',
          p + '/start',
          `shot starts at ${start}, previous end is ${previous}`,
          `set start to ${previous}`,
        ),
      );
    const startFrame = Math.round(start * episode.fps),
      endFrame = Math.round(end * episode.fps),
      frames = endFrame - startFrame,
      transition = i
        ? (shot.transition ?? episode.defaults.transition)
        : { type: 'cut' as const, duration: 0 };
    if (frames < 1)
      diagnostics.push(
        episodeDiagnostic(
          'episode-shot-too-short',
          p,
          'shot contains no complete frame',
          `use at least ${1 / episode.fps} seconds`,
        ),
      );
    const transitionFrames =
      transition.type === 'cut' ? 0 : Math.max(1, Math.round(transition.duration * episode.fps));
    if (transitionFrames >= frames)
      diagnostics.push(
        episodeDiagnostic(
          'episode-transition-range',
          p + '/transition',
          'transition must be shorter than its incoming shot',
          'reduce transition duration or extend the shot',
        ),
      );
    shots.push({
      shot,
      start,
      end,
      startFrame,
      endFrame,
      frames,
      duration: frames / episode.fps,
      transition: { ...transition, duration: transitionFrames / episode.fps },
    });
    previous = end;
    previousStart = start;
  });
  if (!Number.isFinite(audioDuration) || audioDuration <= 0)
    diagnostics.push(
      episodeDiagnostic(
        'episode-audio-duration',
        '/narration/audio',
        'narration duration is invalid',
        'provide nonempty PCM WAV audio',
      ),
    );
  if (Math.abs(previous - audioDuration) > 1 / episode.fps + 1e-6)
    diagnostics.push(
      episodeDiagnostic(
        'episode-duration',
        '/shots',
        `storyboard ends at ${previous}, narration lasts ${audioDuration}`,
        `end the last shot at ${audioDuration} or @end`,
      ),
    );
  const frames = Math.round(previous * episode.fps);
  return {
    timeline: diagnostics.some((d) => d.severity === 'error')
      ? null
      : { episode, shots, frames, duration: frames / episode.fps },
    diagnostics,
  };
}
/** Cover crop in source pixels, keeping the requested normalized focus near its center. */
export function coverCrop(
  source: [number, number],
  target: [number, number],
  focus: [number, number] = [0.5, 0.5],
): [number, number, number, number] {
  const ratio = target[0] / target[1],
    w = Math.min(source[0], source[1] * ratio),
    h = w / ratio;
  return [
    Math.max(0, Math.min(source[0] - w, focus[0] * source[0] - w / 2)),
    Math.max(0, Math.min(source[1] - h, focus[1] * source[1] - h / 2)),
    w,
    h,
  ];
}
export function speechIntervals(words: readonly WordTiming[], duration: number): [number, number][] {
  const out: [number, number][] = [];
  for (const w of words) {
    const start = Math.max(0, w.start - 0.05),
      end = Math.min(duration, w.end + 0.12),
      last = out.at(-1);
    if (last && start <= last[1] + 0.2) last[1] = Math.max(last[1], end);
    else if (end > start) out.push([start, end]);
  }
  return out;
}
export function musicGainAt(
  t: number,
  gain: number,
  amount: number,
  intervals: readonly [number, number][],
): number {
  return gain * (1 - (intervals.some(([s, e]) => t >= s && t <= e) ? amount : 0));
}
