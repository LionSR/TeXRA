// Third-party imports
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { TexraDiffView } from '@progressView/frontend/components/TexraDiffView';
import { DESKTOP_THEME_KIND } from '@shared/schemas/commonViewMessages';

const workerModuleIds = [
  'monaco-editor/editor/editor.worker?worker',
  'monaco-editor/language/json/json.worker?worker',
  'monaco-editor/language/css/css.worker?worker',
  'monaco-editor/language/html/html.worker?worker',
  'monaco-editor/language/typescript/ts.worker?worker',
];

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
  ResizeObserver: globalThis.ResizeObserver,
  self: globalThis.self,
};

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

class MockWorker {
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null;
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;

  addEventListener = vi.fn();
  dispatchEvent = vi.fn(() => true);
  postMessage = vi.fn();
  removeEventListener = vi.fn();
  terminate = vi.fn();
}

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><body class="vscode-dark"></body>', {
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
  globalThis.ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver;
  globalThis.self = dom.window as unknown as Window & typeof globalThis;
  return dom;
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
  globalThis.ResizeObserver = originalGlobals.ResizeObserver;
  globalThis.self = originalGlobals.self;
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  restoreDom();
});

describe('texra-diff-view', () => {
  it('mounts with mock content and creates a read-only Monaco diff editor', async () => {
    installDom();
    const disposeOriginal = vi.fn();
    const disposeProposed = vi.fn();
    const diffEditor = {
      dispose: vi.fn(),
      layout: vi.fn(),
      setModel: vi.fn(),
    };
    const createModel = vi
      .fn()
      .mockReturnValueOnce({ dispose: disposeOriginal })
      .mockReturnValueOnce({ dispose: disposeProposed });
    const createDiffEditor = vi.fn(() => diffEditor);
    const setTheme = vi.fn();

    vi.doMock('monaco-editor/editor/editor.api.js', () => ({
      editor: {
        createDiffEditor,
        createModel,
        setTheme,
      },
    }));
    for (const workerModuleId of workerModuleIds) {
      vi.doMock(workerModuleId, () => ({ default: MockWorker }));
    }

    await import('@progressView/frontend/components/TexraDiffView');
    const element = document.createElement('texra-diff-view') as TexraDiffView;
    element.originalText = 'alpha\nbeta\n';
    element.proposedText = 'alpha\ngamma\n';
    element.language = 'latex';
    document.body.append(element);

    await element.updateComplete;
    await vi.waitFor(() => expect(createDiffEditor).toHaveBeenCalledTimes(1));

    expect(createDiffEditor).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        readOnly: true,
        originalEditable: false,
      }),
    );
    expect(createModel).toHaveBeenNthCalledWith(1, 'alpha\nbeta\n', 'latex');
    expect(createModel).toHaveBeenNthCalledWith(2, 'alpha\ngamma\n', 'latex');
    expect(diffEditor.setModel).toHaveBeenCalledWith({
      original: { dispose: disposeOriginal },
      modified: { dispose: disposeProposed },
    });
    expect(setTheme).toHaveBeenCalledWith('vs-dark');

    element.hostTheme = DESKTOP_THEME_KIND.LIGHT;
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith('vs'));

    element.hostTheme = DESKTOP_THEME_KIND.HIGH_CONTRAST;
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith('hc-black'));

    element.hostTheme = DESKTOP_THEME_KIND.DARK;
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith('vs-dark'));
  });
});
