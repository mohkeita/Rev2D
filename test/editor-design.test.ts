/**
 * The design system (editor/src/design): the pure logic behind its components (value math, keyboard
 * maps, layout and queue reducers) and the consistency of its tokens, styles and icon set. No DOM:
 * the components themselves are exercised in Chrome by test/editor-design-e2e.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseComputedColor } from '../editor/src/design/appearance.js';
import { ICON_NAMES, Icon, iconStrokeWidth, isIconName } from '../editor/src/design/icons.js';
import { nextAppearance, parseAppearance, resolveAppearance, rubberBand, sheetDragOffset, sheetDragOutcome } from '../editor/src/design/logic/appearance.js';
import { dockKeyAction, dragDelta, initialDockState, layoutDock, paneLimits, resizeDock, toggleDock, type DockPaneSpec } from '../editor/src/design/logic/dock.js';
import { clamp, commitNumberInput, decimalsOf, formatNumber, parseNumberInput, roundTo, snapToStep, stepNumber } from '../editor/src/design/logic/number.js';
import { computePosition, parsePlacement, pointRect } from '../editor/src/design/logic/position.js';
import { rovingIndex, trapTabIndex, typeaheadIndex } from '../editor/src/design/logic/roving.js';
import { fillSegment, pointerToRatio, ratioToValue, sliderKeyValue, tickRatios, valueToRatio } from '../editor/src/design/logic/slider.js';
import { SPRINGS, springLinearEasing, springProgress, springSettleTime, springStep } from '../editor/src/design/logic/spring.js';
import { TOAST_LIMIT, toastDuration, toastReducer, type ToastData } from '../editor/src/design/logic/toast.js';
import { PACKAGE_ROOT } from '../src/api/templates.js';

const DESIGN = path.join(PACKAGE_ROOT, 'editor', 'src', 'design');
const read = (...parts: string[]): string => readFileSync(path.join(DESIGN, ...parts), 'utf8');

function filesUnder(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, ext));
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ numbers

describe('design: number math (Slider, Stepper, NumberField)', () => {
  it('clamps, also with a reversed or missing range', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(7)).toBe(7);
    expect(clamp(2, 5, 1)).toBe(5);
    expect(clamp(Number.NaN, 2, 9)).toBe(2);
  });

  it('counts the decimals of a step', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(decimalsOf(2.5e-3)).toBe(4);
    expect(decimalsOf(0)).toBe(0);
  });

  it('rounds without floating point noise and never returns -0', () => {
    expect(roundTo(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(Object.is(roundTo(-0.0001, 2), 0)).toBe(true);
  });

  it('snaps to a step grid anchored at the minimum and stays inside the range', () => {
    expect(snapToStep(0.37, { min: 0, max: 1, step: 0.25 })).toBe(0.25);
    expect(snapToStep(0.38, { min: 0, max: 1, step: 0.25 })).toBe(0.5);
    expect(snapToStep(7, { min: -30, max: 30, step: 5 })).toBe(5);
    expect(snapToStep(0.7, { min: 0, max: 1, step: 0.1 })).toBe(0.7);
    // The grid 0, 0.3, 0.6, 0.9 does not contain the maximum: stay on the grid.
    expect(snapToStep(1, { min: 0, max: 1, step: 0.3 })).toBe(0.9);
    expect(snapToStep(12.3456)).toBe(12.3456);
    expect(snapToStep(99, { min: 0, max: 10 })).toBe(10);
  });

  it('steps along the grid, to the next grid line from an off-grid value', () => {
    expect(stepNumber(1, 1)).toBe(2);
    expect(stepNumber(0.1, 1, { step: 0.1 })).toBe(0.2);
    expect(stepNumber(0.37, 1, { min: 0, max: 1, step: 0.25 })).toBe(0.5);
    expect(stepNumber(0.37, -1, { min: 0, max: 1, step: 0.25 })).toBe(0.25);
    expect(stepNumber(5, 1, { multiplier: 10 })).toBe(15);
    expect(stepNumber(5, -1, { step: 1, multiplier: 0.1 })).toBe(4.9);
    expect(stepNumber(9.5, 1, { min: 0, max: 10 })).toBe(10);
    expect(stepNumber(10, 1, { min: 0, max: 10 })).toBe(10);
  });

  it('parses what people type', () => {
    expect(parseNumberInput('12')).toBe(12);
    expect(parseNumberInput(' -3.5 ')).toBe(-3.5);
    expect(parseNumberInput('1,5')).toBe(1.5);
    expect(parseNumberInput('+7')).toBe(7);
    expect(parseNumberInput('−4')).toBe(-4);
    expect(parseNumberInput('30°')).toBe(30);
    expect(parseNumberInput('12 px')).toBe(12);
    expect(parseNumberInput('50%')).toBe(50);
    expect(parseNumberInput('1 000')).toBe(1000);
    expect(parseNumberInput('.5')).toBe(0.5);
    expect(parseNumberInput('1e3')).toBe(1000);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('1.2.3')).toBeNull();
    expect(parseNumberInput('1,2,3')).toBeNull();
  });

  it('formats values and commits typed text', () => {
    expect(formatNumber(12.5)).toBe('12.5');
    expect(formatNumber(0.1 + 0.2, { step: 0.01 })).toBe('0.3');
    expect(formatNumber(1.5, { precision: 2, padded: true })).toBe('1.50');
    expect(formatNumber(Number.NaN)).toBe('');
    expect(commitNumberInput('45', 10, { min: 0, max: 30 })).toBe(30);
    expect(commitNumberInput('oops', 10, { min: 0, max: 30 })).toBe(10);
    expect(commitNumberInput('12.3456', 0, { step: 1 })).toBe(12.346);
    expect(commitNumberInput('12.3456', 0, { precision: 1 })).toBe(12.3);
  });
});

// ------------------------------------------------------------------------------------------- slider

describe('design: slider value math and keyboard map', () => {
  const angle = { min: -30, max: 30, step: 1 };

  it('maps values to track positions and back', () => {
    expect(valueToRatio(0, -30, 30)).toBe(0.5);
    expect(valueToRatio(99, -30, 30)).toBe(1);
    expect(valueToRatio(5, 5, 5)).toBe(0);
    expect(ratioToValue(0.5, angle)).toBe(0);
    expect(ratioToValue(0.26, { min: 0, max: 1, step: 0.25 })).toBe(0.25);
    expect(ratioToValue(2, angle)).toBe(30);
  });

  it('turns a pointer position into a ratio, honouring the knob width and the grab offset', () => {
    // Track 0..220 px, knob 20 px: the knob centre travels from 10 to 210.
    expect(pointerToRatio(10, 0, 220, 20)).toBe(0);
    expect(pointerToRatio(110, 0, 220, 20)).toBe(0.5);
    expect(pointerToRatio(210, 0, 220, 20)).toBe(1);
    expect(pointerToRatio(500, 0, 220, 20)).toBe(1);
    // Grabbed 6 px right of the knob centre: the centre is 6 px left of the pointer.
    expect(pointerToRatio(116, 0, 220, 20, 6)).toBe(0.5);
    expect(pointerToRatio(60, 0, 220, 20, 0, true)).toBe(0.75);
    expect(pointerToRatio(50, 0, 20, 20)).toBe(0);
  });

  it('steps with the arrow keys, ten steps with Shift and the page keys, and jumps to the ends', () => {
    expect(sliderKeyValue('ArrowRight', 0, angle)).toBe(1);
    expect(sliderKeyValue('ArrowUp', 0, angle)).toBe(1);
    expect(sliderKeyValue('ArrowLeft', 0, angle)).toBe(-1);
    expect(sliderKeyValue('ArrowDown', 0, angle)).toBe(-1);
    expect(sliderKeyValue('ArrowRight', 0, angle, { shiftKey: true })).toBe(10);
    expect(sliderKeyValue('PageUp', 25, angle)).toBe(30);
    expect(sliderKeyValue('PageDown', 0, angle)).toBe(-10);
    expect(sliderKeyValue('Home', 3, angle)).toBe(-30);
    expect(sliderKeyValue('End', 3, angle)).toBe(30);
    expect(sliderKeyValue('ArrowRight', 30, angle)).toBe(30);
    expect(sliderKeyValue('a', 0, angle)).toBeNull();
    expect(sliderKeyValue('Enter', 0, angle)).toBeNull();
  });

  it('mirrors the horizontal arrows in right-to-left layouts and divides a stepless range into 100', () => {
    expect(sliderKeyValue('ArrowLeft', 0, angle, { rtl: true })).toBe(1);
    expect(sliderKeyValue('ArrowRight', 0, angle, { rtl: true })).toBe(-1);
    expect(sliderKeyValue('ArrowRight', 0.5, { min: 0, max: 1 })).toBe(0.51);
  });

  it('fills from the minimum or from a neutral origin', () => {
    expect(fillSegment(0, angle)).toEqual({ start: 0, end: 0.5 });
    expect(fillSegment(15, angle, 0)).toEqual({ start: 0.5, end: 0.75 });
    expect(fillSegment(-15, angle, 0)).toEqual({ start: 0.25, end: 0.5 });
  });

  it('places tick marks', () => {
    expect(tickRatios([-30, 0, 30, 99], angle)).toEqual([0, 0.5, 1]);
    expect(tickRatios(3, angle)).toEqual([0, 0.5, 1]);
    expect(tickRatios(true, { min: 0, max: 4, step: 1 })).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(tickRatios(true, angle)).toEqual([]); // 61 marks would be noise
    expect(tickRatios(true, { min: 0, max: 1 })).toEqual([]);
    expect(tickRatios(undefined, angle)).toEqual([]);
    expect(tickRatios(1, angle)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------- keyboard navigation

describe('design: roving focus, type-ahead and focus trap', () => {
  it('moves along the orientation and wraps', () => {
    expect(rovingIndex('ArrowRight', 0, 3)).toBe(1);
    expect(rovingIndex('ArrowRight', 2, 3)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(rovingIndex('ArrowDown', 0, 3)).toBeNull();
    expect(rovingIndex('ArrowDown', 0, 3, { orientation: 'vertical' })).toBe(1);
    expect(rovingIndex('ArrowRight', 0, 3, { orientation: 'vertical' })).toBeNull();
    expect(rovingIndex('ArrowUp', 1, 3, { orientation: 'both' })).toBe(0);
    expect(rovingIndex('Home', 2, 3)).toBe(0);
    expect(rovingIndex('End', 0, 3)).toBe(2);
    expect(rovingIndex('Enter', 0, 3)).toBeNull();
    expect(rovingIndex('ArrowRight', 0, 0)).toBeNull();
  });

  it('stops at the ends without loop, mirrors in right-to-left, starts from nothing focused', () => {
    expect(rovingIndex('ArrowRight', 2, 3, { loop: false })).toBeNull();
    expect(rovingIndex('ArrowLeft', 0, 3, { loop: false })).toBeNull();
    expect(rovingIndex('ArrowLeft', 0, 3, { rtl: true })).toBe(1);
    expect(rovingIndex('ArrowRight', -1, 3)).toBe(0);
    expect(rovingIndex('ArrowLeft', -1, 3)).toBe(2);
  });

  it('skips disabled items', () => {
    const isDisabled = (i: number): boolean => i === 1 || i === 3;
    expect(rovingIndex('ArrowRight', 0, 4, { isDisabled })).toBe(2);
    expect(rovingIndex('ArrowRight', 2, 4, { isDisabled })).toBe(0);
    expect(rovingIndex('End', 0, 4, { isDisabled })).toBe(2);
    expect(rovingIndex('Home', 2, 4, { isDisabled: (i) => i === 0 })).toBe(1);
    expect(rovingIndex('ArrowRight', 0, 2, { isDisabled: (i) => i === 1 })).toBeNull();
    expect(rovingIndex('ArrowRight', 0, 3, { isDisabled: () => true })).toBeNull();
  });

  it('finds items by typing', () => {
    const labels = ['Rename', 'Duplicate', 'Delete', 'Export'];
    expect(typeaheadIndex(labels, 'd', 0)).toBe(1);
    expect(typeaheadIndex(labels, 'd', 1)).toBe(2);
    expect(typeaheadIndex(labels, 'd', 2)).toBe(1);
    expect(typeaheadIndex(labels, 'dd', 1)).toBe(2); // the same letter again cycles
    expect(typeaheadIndex(labels, 'de', 1)).toBe(2);
    expect(typeaheadIndex(labels, 'du', 1)).toBe(1); // a longer query keeps a matching item
    expect(typeaheadIndex(labels, 'EX', -1)).toBe(3);
    expect(typeaheadIndex(labels, 'z', 0)).toBeNull();
    expect(typeaheadIndex(labels, '', 0)).toBeNull();
    expect(typeaheadIndex(labels, 'd', 0, (i) => i === 1)).toBe(2);
    expect(typeaheadIndex(['파츠', '파라미터', '본'], '파', 0)).toBe(1);
  });

  it('keeps Tab inside a focus trap', () => {
    expect(trapTabIndex(0, 3, false)).toBe(1);
    expect(trapTabIndex(2, 3, false)).toBe(0);
    expect(trapTabIndex(0, 3, true)).toBe(2);
    expect(trapTabIndex(-1, 3, false)).toBe(0);
    expect(trapTabIndex(-1, 3, true)).toBe(2);
    expect(trapTabIndex(0, 0, false)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------------------- positioning

describe('design: placement of floating surfaces', () => {
  const viewport = { x: 0, y: 0, width: 1000, height: 800 };
  const size = { width: 200, height: 300 };

  it('parses placements', () => {
    expect(parsePlacement('bottom-start')).toEqual({ side: 'bottom', align: 'start' });
    expect(parsePlacement('top')).toEqual({ side: 'top', align: 'center' });
    expect(parsePlacement()).toEqual({ side: 'bottom', align: 'start' });
  });

  it('places below the anchor, aligned to its start, with the offset', () => {
    const p = computePosition({ x: 100, y: 100, width: 80, height: 28 }, size, viewport, { placement: 'bottom-start', offset: 6 });
    expect(p).toMatchObject({ x: 100, y: 134, side: 'bottom', align: 'start' });
    expect(p.available).toBe(800 - 128 - 6 - 8);
    expect(p.origin).toBe('40px 0px');
  });

  it('centres and end-aligns', () => {
    expect(computePosition({ x: 400, y: 100, width: 100, height: 28 }, size, viewport, { placement: 'bottom' }).x).toBe(350);
    expect(computePosition({ x: 400, y: 100, width: 100, height: 28 }, size, viewport, { placement: 'bottom-end' }).x).toBe(300);
  });

  it('flips to the side with more room', () => {
    const p = computePosition({ x: 100, y: 700, width: 80, height: 28 }, size, viewport, { placement: 'bottom-start' });
    expect(p.side).toBe('top');
    expect(p.y).toBe(700 - 6 - 300);
    expect(p.origin).toBe('40px 100%');
    // Not enough room on either side: stays on the roomier one and reports what is available.
    const tight = computePosition({ x: 100, y: 200, width: 80, height: 28 }, { width: 200, height: 700 }, viewport, { placement: 'top' });
    expect(tight.side).toBe('bottom');
    expect(tight.available).toBe(800 - 228 - 6 - 8);
    const fixed = computePosition({ x: 100, y: 700, width: 80, height: 28 }, size, viewport, { placement: 'bottom-start', flip: false });
    expect(fixed.side).toBe('bottom');
  });

  it('shifts inside the viewport margins', () => {
    const right = computePosition({ x: 950, y: 100, width: 40, height: 28 }, size, viewport, { placement: 'bottom-start' });
    expect(right.x).toBe(1000 - 8 - 200);
    expect(right.origin).toBe('178px 0px');
    const left = computePosition({ x: 0, y: 100, width: 40, height: 28 }, size, viewport, { placement: 'bottom-end' });
    expect(left.x).toBe(8);
  });

  it('places beside the anchor and opens a context menu at a point', () => {
    const side = computePosition({ x: 100, y: 100, width: 80, height: 28 }, size, viewport, { placement: 'right-start', offset: 4 });
    expect(side).toMatchObject({ x: 184, y: 100, side: 'right' });
    const flipped = computePosition({ x: 900, y: 100, width: 80, height: 28 }, size, viewport, { placement: 'right-start', offset: 4 });
    expect(flipped).toMatchObject({ x: 900 - 4 - 200, side: 'left' });
    const menu = computePosition(pointRect(300, 400), size, viewport, { placement: 'bottom-start', offset: 2 });
    expect(menu).toMatchObject({ x: 300, y: 402, origin: '0px 0px' });
  });
});

// ------------------------------------------------------------------------------------------ split view

describe('design: dock layout of SplitView', () => {
  const specs: DockPaneSpec[] = [
    { id: 'toolbar', edge: 'top', size: 44, min: 44, max: 44 },
    { id: 'timeline', edge: 'bottom', size: 200, min: 120, max: 400, collapsible: true },
    { id: 'sidebar', edge: 'leading', size: 240, min: 200, max: 360, collapsible: true },
    { id: 'inspector', edge: 'trailing', size: 280, min: 240, max: 420, collapsible: true },
  ];
  const big = { width: 1440, height: 900 };

  it('tiles docked panes around the main area in array order', () => {
    const layout = layoutDock(specs, initialDockState(specs), big, { gap: 1 });
    expect(layout.main).toEqual({ top: 45, right: 281, bottom: 201, left: 241 });
    expect(layout.safe).toEqual(layout.main);
    const [toolbar, timeline, sidebar, inspector] = layout.panes;
    expect(toolbar!.inset).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    // The timeline was listed before the side panes: it spans the full width under the toolbar...
    expect(timeline!.inset).toMatchObject({ left: 0, right: 0, bottom: 0 });
    // ...and the side panes end above it.
    expect(sidebar!.inset).toMatchObject({ top: 45, bottom: 201, left: 0 });
    expect(inspector!.inset).toMatchObject({ top: 45, bottom: 201, right: 0 });
  });

  it('floats panes above a full-bleed main area and reports the covered space', () => {
    const layout = layoutDock(specs, initialDockState(specs), big, { floating: true, gap: 12 });
    expect(layout.main).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(layout.safe).toEqual({ top: 12 + 44 + 12, right: 12 + 280 + 12, bottom: 12 + 200 + 12, left: 12 + 240 + 12 });
    expect(layout.panes[2]!.inset).toEqual({ top: 68, right: 12, bottom: 224, left: 12 });
  });

  it('gives the space of a collapsed pane back', () => {
    const state = toggleDock(initialDockState(specs), 'sidebar');
    const layout = layoutDock(specs, state, big, { floating: true, gap: 12 });
    expect(layout.panes[2]!.collapsed).toBe(true);
    expect(layout.safe.left).toBe(0);
    expect(toggleDock(state, 'sidebar', true)).toBe(state);
    expect(toggleDock(state, 'sidebar', false).collapsed.sidebar).toBe(false);
    expect(initialDockState(specs, ['inspector']).collapsed).toMatchObject({ inspector: true, sidebar: false });
  });

  it('caps panes by a share of a small container but remembers the stored size', () => {
    const small = { width: 640, height: 480 };
    expect(paneLimits(specs[2]!, small)).toEqual({ min: 200, max: 288 });
    expect(paneLimits(specs[3]!, { width: 400, height: 480 })).toEqual({ min: 180, max: 180 });
    expect(paneLimits(specs[2]!, null)).toEqual({ min: 200, max: 360 });
    const state = resizeDock(specs, initialDockState(specs), 'sidebar', 360, big);
    expect(state.sizes.sidebar).toBe(360);
    expect(layoutDock(specs, state, small).panes[2]!.size).toBe(288);
    expect(layoutDock(specs, state, big).panes[2]!.size).toBe(360);
  });

  it('resizes within the limits, collapses below half the minimum and expands again', () => {
    const start = initialDockState(specs);
    expect(resizeDock(specs, start, 'sidebar', 300, big).sizes.sidebar).toBe(300);
    expect(resizeDock(specs, start, 'sidebar', 9999, big).sizes.sidebar).toBe(360);
    expect(resizeDock(specs, start, 'sidebar', 150, big).sizes.sidebar).toBe(200);
    expect(resizeDock(specs, start, 'sidebar', 240, big)).toBe(start);
    expect(resizeDock(specs, start, 'nope', 240, big)).toBe(start);
    const collapsed = resizeDock(specs, start, 'sidebar', 99, big);
    expect(collapsed.collapsed.sidebar).toBe(true);
    expect(collapsed.sizes.sidebar).toBe(240); // the size it had is kept for the next expand
    expect(resizeDock(specs, collapsed, 'sidebar', 50, big)).toBe(collapsed);
    const reopened = resizeDock(specs, collapsed, 'sidebar', 220, big);
    expect(reopened.collapsed.sidebar).toBe(false);
    expect(reopened.sizes.sidebar).toBe(220);
    // A pane that is not collapsible stops at its minimum.
    expect(resizeDock(specs, start, 'toolbar', 0, big).collapsed.toolbar).toBe(false);
  });

  it('maps pointer movement and keys to a change of size per edge', () => {
    expect(dragDelta('leading', 10, 99)).toBe(10);
    expect(dragDelta('trailing', 10, 99)).toBe(-10);
    expect(dragDelta('top', 99, 10)).toBe(10);
    expect(dragDelta('bottom', 99, 10)).toBe(-10);
    expect(dragDelta('leading', 10, 0, true)).toBe(-10);
    expect(dockKeyAction('leading', 'ArrowRight')).toEqual({ type: 'resize', delta: 16 });
    expect(dockKeyAction('trailing', 'ArrowRight')).toEqual({ type: 'resize', delta: -16 });
    expect(dockKeyAction('bottom', 'ArrowUp', { shiftKey: true })).toEqual({ type: 'resize', delta: 64 });
    expect(dockKeyAction('bottom', 'ArrowLeft')).toBeNull();
    expect(dockKeyAction('leading', 'ArrowUp')).toBeNull();
    expect(dockKeyAction('leading', 'Enter')).toEqual({ type: 'toggle' });
    expect(dockKeyAction('leading', 'Home')).toEqual({ type: 'min' });
    expect(dockKeyAction('leading', 'End')).toEqual({ type: 'max' });
    expect(dockKeyAction('leading', 'a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- toasts

describe('design: toast queue', () => {
  const toast = (id: string, extra: Partial<ToastData> = {}): ToastData => ({ id, title: `Toast ${id}`, ...extra });

  it('appends, replaces in place by id, drops the oldest beyond the limit', () => {
    let state = toastReducer([], { type: 'push', toast: toast('a') });
    state = toastReducer(state, { type: 'push', toast: toast('b') });
    state = toastReducer(state, { type: 'push', toast: toast('a', { title: 'Updated' }) });
    expect(state.map((t) => t.title)).toEqual(['Updated', 'Toast b']);
    for (const id of ['c', 'd']) state = toastReducer(state, { type: 'push', toast: toast(id) });
    expect(state.map((t) => t.id)).toEqual(['b', 'c', 'd']);
    expect(state).toHaveLength(TOAST_LIMIT);
    expect(toastReducer(state, { type: 'push', toast: toast('e') }, 1).map((t) => t.id)).toEqual(['e']);
  });

  it('dismisses and clears, returning the same state when nothing changes', () => {
    const state = [toast('a'), toast('b')];
    expect(toastReducer(state, { type: 'dismiss', id: 'a' }).map((t) => t.id)).toEqual(['b']);
    expect(toastReducer(state, { type: 'dismiss', id: 'zz' })).toBe(state);
    expect(toastReducer(state, { type: 'clear' })).toEqual([]);
    const empty: ToastData[] = [];
    expect(toastReducer(empty, { type: 'clear' })).toBe(empty);
  });

  it('shows short messages for 4 s, longer ones longer, errors until dismissed', () => {
    expect(toastDuration({ title: 'Saved' })).toBe(4000);
    expect(toastDuration({ title: 'Part deleted', actionLabel: 'Undo' })).toBe(6000);
    expect(toastDuration({ title: 'x'.repeat(80) })).toBe(4000 + 40 * 45);
    expect(toastDuration({ title: 'x'.repeat(400) })).toBe(10000);
    expect(toastDuration({ title: 'Could not save', tone: 'danger' })).toBe(0);
    expect(toastDuration({ title: 'Could not save', tone: 'danger', duration: 3000 })).toBe(3000);
    expect(toastDuration({ title: 'Sticky', duration: 0 })).toBe(0);
  });
});

// ----------------------------------------------------------------------------- appearance, sheet drag

describe('design: appearance preference and sheet drag', () => {
  it('parses, resolves and cycles the appearance', () => {
    expect(parseAppearance('dark')).toBe('dark');
    expect(parseAppearance('sepia')).toBe('auto');
    expect(parseAppearance(null, 'light')).toBe('light');
    expect(resolveAppearance('auto', true)).toBe('dark');
    expect(resolveAppearance('auto', false)).toBe('light');
    expect(resolveAppearance('light', true)).toBe('light');
    expect([nextAppearance('auto'), nextAppearance('light'), nextAppearance('dark')]).toEqual(['light', 'dark', 'auto']);
  });

  it('parses the colours a browser computes for a token', () => {
    expect(parseComputedColor('rgb(232, 232, 237)')).toEqual([232, 232, 237, 1]);
    expect(parseComputedColor('rgba(60, 60, 67, 0.74)')).toEqual([60, 60, 67, 0.74]);
    expect(parseComputedColor('rgb(0 113 227 / 50%)')).toEqual([0, 113, 227, 0.5]);
    expect(parseComputedColor('color(srgb 1 0.5 0 / 0.25)')).toEqual([255, 127.5, 0, 0.25]);
    expect(parseComputedColor('not a colour')).toEqual([0, 0, 0, 0]);
  });

  it('resists overscroll with a rubber band that levels off', () => {
    expect(rubberBand(0, 400)).toBe(0);
    const a = rubberBand(50, 400);
    const b = rubberBand(100, 400);
    const c = rubberBand(10000, 400);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(50);
    expect(b - a).toBeLessThan(a); // each further pixel moves it less
    expect(c).toBeLessThan(400);
    expect(rubberBand(-50, 400)).toBeCloseTo(-a);
    expect(rubberBand(50, 0)).toBe(0);
  });

  it('follows a sheet down, resists it up, and decides where it goes on release', () => {
    expect(sheetDragOffset(80, 400)).toBe(80);
    expect(sheetDragOffset(-80, 400)).toBeGreaterThan(-80);
    expect(sheetDragOffset(-80, 400)).toBeLessThan(0);
    expect(sheetDragOutcome({ distance: 140, velocity: 0, height: 400 })).toBe('dismiss');
    expect(sheetDragOutcome({ distance: 100, velocity: 0, height: 400 })).toBe('stay');
    expect(sheetDragOutcome({ distance: 190, velocity: 0, height: 900 })).toBe('dismiss'); // capped at 180 px
    expect(sheetDragOutcome({ distance: 40, velocity: 1.2, height: 400 })).toBe('dismiss'); // a flick
    expect(sheetDragOutcome({ distance: 10, velocity: 1.2, height: 400 })).toBe('stay');
    expect(sheetDragOutcome({ distance: -60, velocity: -2, height: 400 })).toBe('stay');
  });
});

// --------------------------------------------------------------------------------------------- springs

describe('design: spring easings', () => {
  it('starts at 0, ends at 1 and overshoots only when underdamped', () => {
    for (const zeta of [1, 0.72, 0.6]) {
      expect(springStep(0, zeta)).toBe(0);
      expect(springStep(springSettleTime(zeta), zeta)).toBeCloseTo(1, 2);
    }
    const peak = (damping: number): number => Math.max(...Array.from({ length: 201 }, (_, i) => springProgress(i / 200, { damping })));
    expect(peak(1)).toBeLessThanOrEqual(1);
    expect(peak(0.72)).toBeGreaterThan(1.02);
    expect(peak(0.72)).toBeLessThan(1.06);
    expect(peak(0.6)).toBeGreaterThan(1.08);
    expect(peak(0.6)).toBeLessThan(1.12);
    expect(springProgress(-1, { damping: 1 })).toBe(0);
    expect(springProgress(2, { damping: 0.6 })).toBe(1);
  });

  it('is what tokens.css ships (regenerate the tokens when a spring changes)', () => {
    const tokens = read('tokens.css');
    for (const [name, spec] of Object.entries(SPRINGS)) {
      const easing = springLinearEasing(spec);
      expect(easing.startsWith('linear(0, ')).toBe(true);
      expect(easing.endsWith(', 1)')).toBe(true);
      expect(tokens, `--r2-spring-${name}`).toContain(`--r2-spring-${name}: ${easing};`);
    }
  });
});

// ---------------------------------------------------------------------------------- tokens and styles

/** Declarations of the first `:root { ... }` block of tokens.css: name -> raw value. */
function rootTokens(): Map<string, string> {
  const css = read('tokens.css');
  const start = css.indexOf(':root {');
  let depth = 0;
  let end = start;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(css.indexOf('{', start) + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Map<string, string>();
  for (const m of body.matchAll(/(--r2-[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1]!, m[2]!.replace(/\s+/g, ' ').trim());
  return tokens;
}

type Rgba = [number, number, number, number];

function parseCssColor(text: string): Rgba {
  const t = text.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(t);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(t);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  throw new Error(`unsupported colour "${text}"`);
}

/** Both values of a colour token (following plain var() aliases). */
function schemeColors(tokens: Map<string, string>, name: string): { light: Rgba; dark: Rgba } {
  let value = tokens.get(name);
  for (let hops = 0; value && /^var\((--r2-[a-z0-9-]+)\)$/.test(value) && hops < 5; hops++) value = tokens.get(/^var\((--r2-[a-z0-9-]+)\)$/.exec(value)![1]!);
  if (!value) throw new Error(`token ${name} is not defined`);
  const m = /^light-dark\((.+)\)$/.exec(value);
  if (!m) {
    const c = parseCssColor(value);
    return { light: c, dark: c };
  }
  // Split at the comma that is not inside rgb( ... ).
  let depth = 0;
  let split = -1;
  for (let i = 0; i < m[1]!.length; i++) {
    const ch = m[1]![i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) split = i;
  }
  return { light: parseCssColor(m[1]!.slice(0, split)), dark: parseCssColor(m[1]!.slice(split + 1)) };
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

function luminance(c: Rgba): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const fg = luminance(over(foreground, background));
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

describe('design: tokens', () => {
  const tokens = rootTokens();

  it('defines every group of the naming scheme', () => {
    for (const name of [
      '--r2-font',
      '--r2-font-mono',
      '--r2-text-body',
      '--r2-space-4',
      '--r2-radius-capsule',
      '--r2-radius-panel',
      '--r2-control-md',
      '--r2-hit-touch',
      '--r2-label',
      '--r2-fill',
      '--r2-separator',
      '--r2-bg',
      '--r2-bg-grouped',
      '--r2-tint',
      '--r2-tint-solid',
      '--r2-danger',
      '--r2-canvas',
      '--r2-material-regular',
      '--r2-material-regular-solid',
      '--r2-glass-plate',
      '--r2-glass-solid',
      '--r2-glass-rim',
      '--r2-shadow-3',
      '--r2-duration-base',
      '--r2-spring-snappy',
      '--r2-focus-color',
      '--r2-z-overlay',
    ]) {
      expect(tokens.has(name), name).toBe(true);
    }
    expect(tokens.size).toBeGreaterThan(150);
  });

  it('uses the system font stack with Korean and Japanese faces and ships no font files', () => {
    const font = tokens.get('--r2-font')!;
    for (const face of ['-apple-system', 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', 'Hiragino Sans', 'Yu Gothic UI', 'sans-serif']) expect(font, face).toContain(face);
    expect(tokens.get('--r2-font-mono')).toContain('monospace');
    expect(filesUnder(DESIGN, /\.(woff2?|ttf|otf)$/i)).toEqual([]);
    for (const file of filesUnder(DESIGN, /\.css$/)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/@font-face|@import\s+url|fonts\.googleapis/);
  });

  it('writes every colour for both appearances (light-dark), with no duplicated dark block', () => {
    const css = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // "auto" follows the system through `color-scheme: light dark`, not through a second token block.
    expect(/prefers-color-scheme/.test(css)).toBe(false);
    for (const name of ['--r2-label', '--r2-label-2', '--r2-fill', '--r2-separator', '--r2-bg', '--r2-bg-2', '--r2-tint', '--r2-canvas', '--r2-material-regular', '--r2-glass-hairline']) {
      expect(tokens.get(name), name).toMatch(/^light-dark\(/);
    }
    expect(css).toMatch(/\[data-appearance='light'\]\s*\{\s*color-scheme: light;/);
    expect(css).toMatch(/\[data-appearance='dark'\]\s*\{\s*color-scheme: dark;/);
  });

  it('keeps small text and filled controls at WCAG AA contrast in both appearances', () => {
    const pairs: Array<[foreground: string, background: string, minimum: number]> = [
      ['--r2-label', '--r2-bg', 7],
      ['--r2-label-2', '--r2-bg', 4.5],
      ['--r2-label-2', '--r2-bg-2', 4.5],
      ['--r2-label-3', '--r2-bg', 3],
      ['--r2-tint', '--r2-bg', 4.5],
      ['--r2-tint', '--r2-bg-2', 4.5],
      ['--r2-on-tint', '--r2-tint-solid', 4.5],
      ['--r2-on-tint', '--r2-danger-solid', 4.5],
      ['--r2-danger-text', '--r2-bg', 4.5],
      ['--r2-warning-text', '--r2-bg', 4.5],
      ['--r2-success-text', '--r2-bg', 4.5],
      ['--r2-focus-color', '--r2-bg', 3],
    ];
    for (const [fg, bg, min] of pairs) {
      const f = schemeColors(tokens, fg);
      const b = schemeColors(tokens, bg);
      expect(contrast(f.light, b.light), `${fg} on ${bg} (light)`).toBeGreaterThanOrEqual(min);
      expect(contrast(f.dark, b.dark), `${fg} on ${bg} (dark)`).toBeGreaterThanOrEqual(min);
    }
  });

  it('gives every material and glass a solid fallback that the accessibility switches use', () => {
    const css = read('tokens.css');
    for (const m of ['ultrathin', 'thin', 'regular', 'thick']) {
      expect(tokens.has(`--r2-material-${m}-solid`), m).toBe(true);
      expect(css).toContain(`--r2-material-${m}: var(--r2-material-${m}-solid);`);
    }
    expect(css).toContain('--r2-glass-plate: var(--r2-glass-solid);');
    expect(css).toContain('--r2-glass-panel-filter: none;');
    for (const hook of ['prefers-reduced-transparency: reduce', "[data-transparency='reduce']", "[data-materials='solid']", 'prefers-contrast: more', "[data-contrast='more']", 'prefers-reduced-motion: reduce', "[data-motion='reduce']", 'pointer: coarse', '@supports not']) {
      expect(css, hook).toContain(hook);
    }
  });

  it('keeps the mirrored media / attribute blocks identical', () => {
    const css = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (selector: string): string[] => {
      const at = css.indexOf(selector);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      const open = css.indexOf('{', at);
      return css
        .slice(open + 1, css.indexOf('}', open))
        .split(';')
        .map((d) => d.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    };
    expect(block(":root:not([data-transparency='full'])")).toEqual(block("[data-transparency='reduce'],"));
    expect(block(":root:not([data-contrast='standard'])")).toEqual(block("[data-contrast='more'] {"));
    expect(block(":root:not([data-motion='full'])")).toEqual(block("[data-motion='reduce'] {"));
  });

  it('references only custom properties that are defined somewhere in the system', () => {
    const cssFiles = filesUnder(DESIGN, /\.css$/);
    const sources = [...cssFiles, ...filesUnder(DESIGN, /\.tsx?$/)];
    const defined = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(--(?:r2|g)-[a-z0-9-]+)\s*:/g)) defined.add(m[1]!);
      for (const m of text.matchAll(/['"`](--(?:r2|g)-[a-z0-9-]+)['"`]/g)) defined.add(m[1]!);
      for (const m of text.matchAll(/setProperty\('(--r2-[a-z0-9-]+)'/g)) defined.add(m[1]!);
    }
    const missing: string[] = [];
    for (const file of cssFiles) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      // var(--x) without a fallback must be defined; var(--x, fallback) may be an optional hook.
      for (const m of text.matchAll(/var\(\s*(--(?:r2|g)-[a-z0-9-]+)\s*\)/g)) {
        if (!defined.has(m[1]!)) missing.push(`${path.relative(DESIGN, file)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('prefixes every class of the system with r2- (gallery: g-)', () => {
    const offenders: string[] = [];
    for (const file of filesUnder(DESIGN, /\.css$/)) {
      const gallery = file.includes(`${path.sep}gallery${path.sep}`);
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of text.matchAll(/(?<![\w-])\.([a-zA-Z][\w-]*)(?=[\s,{:.>+~[)])/g)) {
        const name = m[1]!;
        if (name.startsWith('r2-') || (gallery && name.startsWith('g-'))) continue;
        offenders.push(`${path.relative(DESIGN, file)}: .${name}`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------- icons

describe('design: icon set', () => {
  it('covers every icon of the legacy editor set under the same name', () => {
    // The names of the editor's first icon set (editor/src/ui/icons.tsx, removed when the editor moved
    // to this one): screens written against it keep working by name.
    const names = [
      'play', 'pause', 'toStart', 'stepBack', 'stepFwd', 'repeat', 'eye', 'eyeOff', 'bone', 'part', 'warp', 'param', 'film', 'link', 'search',
      'fit', 'grid', 'mesh', 'bounds', 'label', 'help', 'bolt', 'undo', 'redo', 'save', 'physics', 'layers', 'reset', 'close', 'chevronRight',
      'chevronDown', 'chevronUp', 'warning', 'error', 'info', 'check', 'constraint', 'texture', 'model', 'sidebarLeft', 'sidebarRight', 'pin',
      'file', 'fileNew', 'fileClose', 'folder', 'folderOpen', 'download', 'upload', 'clock', 'refresh', 'arrowUp', 'home', 'plus', 'camera',
      'saveAs', 'menu', 'sparkle',
    ];
    expect(names.length).toBeGreaterThan(50);
    expect(names.filter((n) => !isIconName(n))).toEqual([]);
  });

  it('has the icons the brief asks for', () => {
    const wanted = [
      'sparkles', 'wand', 'play', 'pause', 'stop', 'mic', 'image', 'layers', 'eye', 'eyeOff', 'face', 'hair', 'body', 'sliders', 'timeline',
      'chevronLeft', 'chevronRight', 'chevronUp', 'chevronDown', 'plus', 'minus', 'close', 'check', 'warning', 'info', 'undo', 'redo', 'save',
      'folder', 'document', 'export', 'import', 'settings', 'globe', 'sun', 'moon', 'cursor', 'hand', 'zoomIn', 'zoomOut', 'fit', 'grid',
    ];
    expect(wanted.filter((n) => !isIconName(n))).toEqual([]);
    expect(isIconName('toString')).toBe(false);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  it('renders every icon as an inline SVG on the 24 px grid with well-formed paths inside it', () => {
    for (const name of ICON_NAMES) {
      const svg = renderToStaticMarkup(createElement(Icon, { name }));
      expect(svg, name).toContain('viewBox="0 0 24 24"');
      expect(svg, name).toContain('stroke-linecap="round"');
      expect(svg, name).toContain('aria-hidden="true"');
      const paths = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^M[0-9MmLlHhVvCcSsQqAaZz .,-]+$/);
        // Absolute coordinates stay on the grid (relative ones are checked by eye in the gallery).
        for (const m of d.matchAll(/[ML](-?[\d.]+)[ ,](-?[\d.]+)/g)) {
          for (const v of [Number(m[1]), Number(m[2])]) {
            expect(v, `${name}: ${m[0]}`).toBeGreaterThanOrEqual(1.5);
            expect(v, `${name}: ${m[0]}`).toBeLessThanOrEqual(22.5);
          }
        }
      }
    }
  });

  it('labels an icon when it is given a title and thickens small sizes', () => {
    const svg = renderToStaticMarkup(createElement(Icon, { name: 'warning', title: 'Warning', size: 16 }));
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Warning"');
    expect(svg).toContain('<title>Warning</title>');
    expect(svg).not.toContain('aria-hidden');
    expect(svg).toContain('stroke-width="2"');
    expect(iconStrokeWidth(16)).toBe(2);
    expect(iconStrokeWidth(20)).toBe(1.75);
    expect(renderToStaticMarkup(createElement(Icon, { name: 'play', size: 24 }))).toContain('stroke-width="1.75"');
  });

  it('uses no icon font, icon library or Apple symbol names', () => {
    const source = read('icons.tsx');
    expect(source).not.toMatch(/from '(lucide|feather|@heroicons|@phosphor|react-icons)/);
    expect(source).not.toMatch(/sf-symbols|SFSymbol|\.fill'|systemName/);
  });
});
