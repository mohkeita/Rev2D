/**
 * Spine image sequences (4.1+): one part per frame, switched by stepped opacity keys from the sequence
 * timeline's mode / index / delay (Spine's SequenceTimeline rule). Regression tests for the official
 * dragon example, whose wings are 9-frame sequences that used to show only their setup frame.
 */
import { describe, expect, it } from 'vitest';
import { importSpine } from '../index.js';
import { sequenceFrameAt } from '../import-animations.js';
import { animation, codes, load, makeImage, part } from './helpers.js';

const ATLAS = 'p.png\n\tsize: 12, 4\nfx1\n\tbounds: 0, 0, 4, 4\nfx2\n\tbounds: 4, 0, 4, 4\nfx3\n\tbounds: 8, 0, 4, 4\n';

function skeleton(timeline: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    skeleton: { spine: '4.2.0' },
    bones: [{ name: 'root' }],
    slots: [{ name: 's', bone: 'root', attachment: 'fx' }],
    skins: [{ name: 'default', attachments: { s: { fx: { width: 4, height: 4, sequence: { count: 3 } } } } }],
    animations: { play: { attachments: { default: { s: { fx: { sequence: timeline } } } }, ...extra } },
  };
}

/** Frame (0-based) each part of slot s shows at time t, or -1 when none is drawn. */
function shownFrame(res: ReturnType<typeof importSpine>, t: number): number {
  const { rig } = load(res);
  const pose = rig.pose({ animations: ['play'], time: t });
  const drawn = ['s__1', 's__2', 's__3'].filter((id) => pose.parts[id].visible && pose.parts[id].opacity > 0);
  expect(drawn.length).toBeLessThanOrEqual(1);
  return drawn.length ? Number(drawn[0].slice(3)) - 1 : -1;
}

const pages = { 'p.png': makeImage(12, 4, () => [255, 255, 255, 255]) };

describe('spine import: image sequences', () => {
  it('computes the frame of every sequence mode like Spine', () => {
    const at = (mode: string, t: number, index = 0) => sequenceFrameAt([{ mode, index, delay: 0.1 }], 3, 0, t);
    const frames = (mode: string) => [0.05, 0.15, 0.25, 0.35, 0.45, 0.55].map((t) => at(mode, t));
    expect(frames('hold')).toEqual([0, 0, 0, 0, 0, 0]);
    expect(frames('once')).toEqual([0, 1, 2, 2, 2, 2]);
    expect(frames('loop')).toEqual([0, 1, 2, 0, 1, 2]);
    expect(frames('pingpong')).toEqual([0, 1, 2, 1, 0, 1]);
    expect(frames('onceReverse')).toEqual([2, 1, 0, 0, 0, 0]);
    expect(frames('loopReverse')).toEqual([2, 1, 0, 2, 1, 0]);
    expect(frames('pingpongReverse')).toEqual([2, 1, 0, 1, 2, 1]);
    // Before the first key: the setup frame; an index beyond the frames is clamped; a key without
    // delay keeps the previous key's delay.
    expect(sequenceFrameAt([{ time: 0.5, mode: 'loop' }], 3, 2, 0.2)).toBe(2);
    expect(sequenceFrameAt([{ index: 7 }], 3, 0, 0)).toBe(2);
    expect(sequenceFrameAt([{ mode: 'hold', delay: 0.2 }, { time: 1, mode: 'loop' }], 3, 0, 1.25)).toBe(1);
  });

  it('switches the frame parts with the sequence timeline', () => {
    const res = importSpine({ skeleton: skeleton([{ mode: 'loop', delay: 0.1 }, { time: 0.6, mode: 'hold', index: 1 }, { time: 1 }]), atlas: ATLAS, pages });
    expect([0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.95].map((t) => shownFrame(res, t))).toEqual([0, 1, 2, 0, 1, 2, 1, 1]);
    // Flipbook frames do not decide whether the animation loops.
    expect(animation(res.doc, 'play').loop).toBe(true);
    expect(codes(res)).not.toContain('spine-timeline-sequence');
    expect(res.report.stats).toMatchObject({ sequenceFrames: 3, sequenceTimelines: 1 });
  });

  it('hides every frame while the attachment timeline hides the attachment', () => {
    const res = importSpine({
      skeleton: skeleton([{ mode: 'loop', delay: 0.1 }], { slots: { s: { attachment: [{ time: 0.3, name: null }, { time: 0.5, name: 'fx' }, { time: 0.8, name: 'fx' }] } } }),
      atlas: ATLAS,
      pages,
    });
    expect([0.15, 0.35, 0.45, 0.55].map((t) => shownFrame(res, t))).toEqual([1, -1, -1, 2]);
  });

  it('keeps an animated slot alpha in the tint so it applies to whichever frame shows', () => {
    const res = importSpine({
      skeleton: skeleton([{ mode: 'loop', delay: 0.1 }], { slots: { s: { alpha: [{ value: 1 }, { time: 1, value: 0 }] } } }),
      atlas: ATLAS,
      pages,
    });
    const { rig } = load(res);
    const pose = rig.pose({ animations: ['play'], time: 0.55 });
    expect(pose.parts.s__3.opacity).toBe(1);
    expect(pose.parts.s__3.tint[3]).toBeCloseTo(0.45, 6);
    expect(pose.parts.s__1.opacity).toBe(0);
    expect(res.report.issues.find((i) => i.code === 'spine-slot-alpha-in-tint')?.where).toBe('slots[0] (s)');
    expect(part(res.doc, 's__2').opacity).toBe(0);
  });

  it('reports sequence timelines of attachments it did not import', () => {
    const res = importSpine({
      skeleton: {
        ...skeleton([]),
        animations: { play: { attachments: { default: { s: { other: { sequence: [{ mode: 'loop', delay: 0.1 }] } } }, gold: { s: { fx: { sequence: [{ mode: 'loop' }] } } } } } },
      },
      atlas: ATLAS,
      pages,
    });
    const where = (w: string) => res.report.issues.find((i) => i.where === w);
    expect(where('animations.play.attachments.default.s.other.sequence')).toMatchObject({ code: 'spine-timeline-target-missing', severity: 'warning' });
    expect(where('animations.play.attachments.gold.s.fx.sequence')).toMatchObject({ code: 'spine-timeline-skin-not-imported', severity: 'info' });
  });
});
