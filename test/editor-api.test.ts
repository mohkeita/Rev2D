/**
 * Editor protocol client (editor/src/api.ts) against a scripted EventSource, and the keyboard
 * routing helpers (editor/src/ui/keys.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, type EventHandlers } from '../editor/src/api.js';
import { isTypingTarget, keepsNavigationKeys } from '../editor/src/ui/keys.js';

/** Minimal EventSource: tests drive open/error/close and dispatch named events. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onerror: ((e: Event) => void) | null = null;
  private readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  emit(name: string, data: unknown): void {
    this.readyState = FakeEventSource.OPEN;
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }

  /** Network error: the browser keeps the source and retries by itself. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  /** Non-200 answer (e.g. a dev proxy's 502 while the editor server is down): the source gives up. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function handlers(): EventHandlers & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onOpen: (file) => log.push(`open ${file}`),
    onError: () => log.push('error'),
    onModelChanged: (e) => log.push(`changed ${e.origin} ${e.mtimeMs}`),
    onCommand: (c) => log.push(`command ${c.type}`),
    onProtocolError: (m) => log.push(`protocol ${m}`),
  };
}

describe('editor event stream client', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('parses events and rejects unknown commands', () => {
    const h = handlers();
    const dispose = connectEvents(h);
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe('/api/events');
    es.emit('hello', { file: '/m.r2d.json', mtimeMs: 5 });
    es.emit('model-changed', { origin: 'editor', mtimeMs: 7, files: ['m.r2d.json'] });
    es.emit('command', { type: 'pause' });
    es.emit('command', { type: 'explode' });
    expect(h.log).toEqual(['open /m.r2d.json', 'changed editor 7', 'command pause', 'protocol unknown command type "explode"']);
    dispose();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('leaves transient drops to the browser (no duplicate sources)', () => {
    const h = handlers();
    const dispose = connectEvents(h);
    FakeEventSource.instances[0].drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(h.log).toEqual(['error']);
    dispose();
  });

  it('reconnects by itself after the browser gave up on the stream', () => {
    const h = handlers();
    const dispose = connectEvents(h);
    FakeEventSource.instances[0].fail();
    expect(h.log).toEqual(['error']);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    // Still failing: retries back off but never stop.
    FakeEventSource.instances[1].fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);
    FakeEventSource.instances[2].emit('hello', { file: '/m.r2d.json' });
    expect(h.log.at(-1)).toBe('open /m.r2d.json');
    // After a successful connection the back-off starts over.
    FakeEventSource.instances[2].fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);
    dispose();
    expect(FakeEventSource.instances[3].readyState).toBe(FakeEventSource.CLOSED);
    FakeEventSource.instances[3].fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });
});

describe('keyboard routing', () => {
  const el = (tagName: string, type = '') => ({ tagName, type, isContentEditable: false }) as unknown as EventTarget;

  it('leaves arrow / Home / End keys to focused sliders, selects and radios', () => {
    expect(keepsNavigationKeys(el('INPUT', 'range'))).toBe(true);
    expect(keepsNavigationKeys(el('SELECT'))).toBe(true);
    expect(keepsNavigationKeys(el('INPUT', 'radio'))).toBe(true);
    expect(keepsNavigationKeys(el('INPUT', 'text'))).toBe(true);
    expect(keepsNavigationKeys(el('TEXTAREA'))).toBe(true);
    expect(keepsNavigationKeys(el('BUTTON'))).toBe(false);
    expect(keepsNavigationKeys(el('INPUT', 'checkbox'))).toBe(false);
    expect(keepsNavigationKeys(el('DIV'))).toBe(false);
    expect(keepsNavigationKeys(null)).toBe(false);
  });

  it('treats only text entry as typing', () => {
    expect(isTypingTarget(el('INPUT', 'text'))).toBe(true);
    expect(isTypingTarget(el('INPUT', 'search'))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el('INPUT', 'range'))).toBe(false);
    expect(isTypingTarget(el('SELECT'))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
  });
});
