// Third-party imports
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { FileList } from '@progressView/frontend/components/FileList';
import type { ProgressFileActionDetail } from '@progressView/frontend/events';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { OutputFileInfo } from '@shared/schemas';

// Local imports - shared schemas

// Local imports - test utilities
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
  MutationObserver: globalThis.MutationObserver,
  Event: globalThis.Event,
  CustomEvent: globalThis.CustomEvent,
  KeyboardEvent: globalThis.KeyboardEvent,
  ResizeObserver: globalThis.ResizeObserver,
  localStorage: globalThis.localStorage,
  Node: (globalThis as { Node?: unknown }).Node,
  HTMLSlotElement: globalThis.HTMLSlotElement,
  MouseEvent: globalThis.MouseEvent,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  requestAnimationFrame: (globalThis as { requestAnimationFrame?: unknown })
    .requestAnimationFrame,
  cancelAnimationFrame: (globalThis as { cancelAnimationFrame?: unknown })
    .cancelAnimationFrame,
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
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.ResizeObserver = NoopResizeObserver;
  globalThis.localStorage = dom.window.localStorage;
  (globalThis as { Node: unknown }).Node = dom.window.Node;
  // <wa-tooltip> attaches anchor listeners with an AbortSignal and positions
  // via requestAnimationFrame. Bind the jsdom-backed implementations so the
  // signal identity matches the EventTarget (jsdom rejects a foreign signal).
  globalThis.HTMLSlotElement = dom.window.HTMLSlotElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.AbortController = dom.window.AbortController;
  globalThis.AbortSignal = dom.window.AbortSignal;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as (
    cb: FrameRequestCallback,
  ) => number;
  globalThis.cancelAnimationFrame = ((handle: number) =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)) as (
    handle: number,
  ) => void;
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
  globalThis.MutationObserver = originalGlobals.MutationObserver;
  globalThis.Event = originalGlobals.Event;
  globalThis.CustomEvent = originalGlobals.CustomEvent;
  globalThis.KeyboardEvent = originalGlobals.KeyboardEvent;
  globalThis.ResizeObserver = originalGlobals.ResizeObserver;
  globalThis.localStorage = originalGlobals.localStorage;
  globalThis.AbortController = originalGlobals.AbortController;
  globalThis.AbortSignal = originalGlobals.AbortSignal;
  // HTMLSlotElement/MouseEvent aren't Node globals, so they captured undefined;
  // route them through restoreOptionalGlobal to delete rather than set undefined.
  restoreOptionalGlobal('HTMLSlotElement', originalGlobals.HTMLSlotElement);
  restoreOptionalGlobal('MouseEvent', originalGlobals.MouseEvent);
  restoreOptionalGlobal(
    'requestAnimationFrame',
    originalGlobals.requestAnimationFrame,
  );
  restoreOptionalGlobal(
    'cancelAnimationFrame',
    originalGlobals.cancelAnimationFrame,
  );
  restoreOptionalGlobal('Node', originalGlobals.Node);
}

function restoreOptionalGlobal(key: string, value: unknown): void {
  if (value === undefined) {
    delete (globalThis as Record<string, unknown>)[key];
  } else {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

function outputFile(): OutputFileInfo {
  return {
    source: 'paper_revised.tex',
    location: {
      kind: 'workspace',
      absolutePath: '/workspace/paper_revised.tex',
      relativePath: 'paper_revised.tex',
    },
    round: 1,
    lineage: {
      original: {
        kind: 'workspace',
        absolutePath: '/workspace/paper.tex',
        relativePath: 'paper.tex',
      },
      diffBase: null,
      diffFile: null,
    },
    diff: { added: 2, removed: 1 },
  };
}

async function mountFileList(): Promise<FileList> {
  const element = document.createElement('file-list') as FileList;
  element.filesByRound = { '1': [outputFile()] };
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function dispatchSpace(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

beforeAll(async () => {
  installDom();
  await import('@progressView/frontend/components/FileList');
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => {
  restoreDom();
});

describe('file-list keyboard activation', () => {
  it('opens file paths on Space without hijacking native action buttons', async () => {
    const element = await mountFileList();
    const actions: ProgressFileActionDetail[] = [];
    element.addEventListener('file-action', (event) => {
      actions.push((event as CustomEvent<ProgressFileActionDetail>).detail);
    });

    const filePath = element.shadowRoot?.querySelector('.file-path');
    expect(filePath).toBeInstanceOf(HTMLElement);
    dispatchSpace(filePath!);

    expect(actions).toEqual([
      {
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file: '/workspace/paper_revised.tex',
        base: undefined,
        prev: undefined,
      },
    ]);

    const nativeButton = element.shadowRoot?.querySelector(
      'wa-button[data-command]',
    );
    expect(nativeButton).toBeInstanceOf(HTMLElement);
    dispatchSpace(nativeButton!);

    expect(actions).toHaveLength(1);
  });
});
