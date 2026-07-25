// Third-party imports
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Local imports
import type { WorktreeChip } from '@progressView/frontend/components/WorktreeChip';
import type { WorktreeInfo } from '@shared/schemas';

// Local file imports
import { installAttachInternalsFallback } from '../settings/litComponentTestUtils';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  customElements: globalThis.customElements,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Document: globalThis.Document,
  ShadowRoot: globalThis.ShadowRoot,
  CSSStyleSheet: globalThis.CSSStyleSheet,
  Event: globalThis.Event,
  CustomEvent: globalThis.CustomEvent,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  HTMLSlotElement: globalThis.HTMLSlotElement,
  requestAnimationFrame: (globalThis as { requestAnimationFrame?: unknown })
    .requestAnimationFrame,
  cancelAnimationFrame: (globalThis as { cancelAnimationFrame?: unknown })
    .cancelAnimationFrame,
  ResizeObserver: globalThis.ResizeObserver,
  Node: (globalThis as { Node?: unknown }).Node,
};

class NoopResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

function installDom(): void {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'http://localhost',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.customElements = dom.window.customElements;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Document = dom.window.Document;
  globalThis.ShadowRoot = dom.window.ShadowRoot;
  globalThis.CSSStyleSheet = dom.window.CSSStyleSheet;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.AbortController = dom.window.AbortController;
  globalThis.AbortSignal = dom.window.AbortSignal;
  globalThis.HTMLSlotElement = dom.window.HTMLSlotElement;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as (
    cb: FrameRequestCallback,
  ) => number;
  globalThis.cancelAnimationFrame = ((handle: number) =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)) as (
    handle: number,
  ) => void;
  globalThis.ResizeObserver = NoopResizeObserver;
  (globalThis as { Node: unknown }).Node = dom.window.Node;
  installAttachInternalsFallback(
    dom.window as unknown as Parameters<
      typeof installAttachInternalsFallback
    >[0],
  );
}

function restoreDom(): void {
  globalThis.document = originalGlobals.document;
  globalThis.window = originalGlobals.window;
  globalThis.customElements = originalGlobals.customElements;
  globalThis.HTMLElement = originalGlobals.HTMLElement;
  globalThis.Element = originalGlobals.Element;
  globalThis.Document = originalGlobals.Document;
  globalThis.ShadowRoot = originalGlobals.ShadowRoot;
  globalThis.CSSStyleSheet = originalGlobals.CSSStyleSheet;
  globalThis.Event = originalGlobals.Event;
  globalThis.CustomEvent = originalGlobals.CustomEvent;
  globalThis.AbortController = originalGlobals.AbortController;
  globalThis.AbortSignal = originalGlobals.AbortSignal;
  restoreOptionalGlobal('HTMLSlotElement', originalGlobals.HTMLSlotElement);
  restoreOptionalGlobal(
    'requestAnimationFrame',
    originalGlobals.requestAnimationFrame,
  );
  restoreOptionalGlobal(
    'cancelAnimationFrame',
    originalGlobals.cancelAnimationFrame,
  );
  globalThis.ResizeObserver = originalGlobals.ResizeObserver;
  if (originalGlobals.Node === undefined) {
    delete (globalThis as { Node?: unknown }).Node;
  } else {
    (globalThis as { Node: unknown }).Node = originalGlobals.Node;
  }
}

function restoreOptionalGlobal(key: string, value: unknown): void {
  if (value === undefined) {
    delete (globalThis as Record<string, unknown>)[key];
  } else {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

async function mountChip(info: WorktreeInfo): Promise<WorktreeChip> {
  const element = document.createElement('worktree-chip') as WorktreeChip;
  element.info = info;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

beforeAll(async () => {
  installDom();
  await import('@progressView/frontend/components/WorktreeChip');
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => {
  restoreDom();
});

describe('worktree-chip', () => {
  it('renders a working-directory fallback when git metadata is absent', async () => {
    const element = await mountChip({
      workingDirectory: '/tmp/texra/issue-4018',
    });

    expect(element.shadowRoot?.textContent).toContain('issue-4018');
  });

  it('uses shared tooltips for PR metadata without duplicate ids', async () => {
    const element = await mountChip({
      workingDirectory: '/tmp/texra/issue-4018',
      branch: 'issue-4018',
      pr: {
        number: 42,
        state: 'open',
        title: 'Tooltip migration',
        additions: 3,
        deletions: 1,
        ciState: 'success',
      },
    });
    const shadow = element.shadowRoot!;
    const ids = [...shadow.querySelectorAll<HTMLElement>('[id]')].map(
      (node) => node.id,
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(shadow.querySelector('[title]')).toBeNull();
    expect(shadow.querySelectorAll('wa-tooltip')).toHaveLength(6);
    expect(
      shadow.querySelector('wa-tooltip[for="worktree-pr-title"]')?.textContent,
    ).toBe('Tooltip migration');
  });

  it('exposes dirty state to assistive technology', async () => {
    const element = await mountChip({
      workingDirectory: '/tmp/texra/issue-4018',
      branch: 'issue-4018',
      dirty: true,
    });

    const dirty = element.shadowRoot?.querySelector('.dirty-dot');
    expect(dirty?.getAttribute('role')).toBe('img');
    expect(dirty?.getAttribute('aria-label')).toBe('uncommitted changes');
    expect(element.shadowRoot?.textContent).toContain('uncommitted changes');
  });
});
