// Third-party imports
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { TexraDiffView } from '@desktop/renderer/TexraDiffView';
import { DESKTOP_THEME_KIND } from '@shared/schemas/commonViewMessages';

const workerModuleIds = [
  'monaco-editor/editor/editor.worker?worker',
  'monaco-editor/language/json/json.worker?worker',
  'monaco-editor/language/css/css.worker?worker',
  'monaco-editor/language/html/html.worker?worker',
  'monaco-editor/language/typescript/ts.worker?worker',
];

/**
 * The shared loader also imports Monaco's grammar contributions for their side
 * effect (editor.api.js alone registers no languages), so the mock has to satisfy
 * that import or the whole load promise rejects and no editor is created.
 */
const GRAMMAR_MODULE_ID = 'monaco-editor/languages/register.all.js';

/** Globals the component (and Monaco) read off `globalThis`. */
const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'customElements',
  'HTMLElement',
  'Element',
  'Document',
  'ShadowRoot',
  'CSSStyleSheet',
  'MutationObserver',
  'ResizeObserver',
  'self',
] as const;

const originalGlobals = Object.fromEntries(
  DOM_GLOBAL_NAMES.map((name) => [
    name,
    (globalThis as Record<string, unknown>)[name],
  ]),
);

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

function installDom(): void {
  const dom = new JSDOM('<!doctype html><body class="vscode-dark"></body>', {
    url: 'http://localhost',
  });
  const globals = globalThis as Record<string, unknown>;
  for (const name of DOM_GLOBAL_NAMES) {
    globals[name] = dom.window[name as keyof typeof dom.window];
  }
  globals.ResizeObserver = MockResizeObserver;
}

function restoreDom(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const name of DOM_GLOBAL_NAMES) {
    globals[name] = originalGlobals[name];
  }
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
      // The loader registers TeX grammars, which Monaco does not bundle. Stubbed
      // rather than asserted here: this test covers the diff editor, and the
      // grammar registration has its own coverage.
      languages: {
        register: vi.fn(),
        setMonarchTokensProvider: vi.fn(),
        setLanguageConfiguration: vi.fn(),
      },
    }));
    vi.doMock(GRAMMAR_MODULE_ID, () => ({ default: undefined }));
    for (const workerModuleId of workerModuleIds) {
      vi.doMock(workerModuleId, () => ({ default: MockWorker }));
    }

    await import('@desktop/renderer/TexraDiffView');
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

    for (const [hostTheme, monacoTheme] of [
      [DESKTOP_THEME_KIND.LIGHT, 'vs'],
      [DESKTOP_THEME_KIND.HIGH_CONTRAST, 'hc-black'],
      [DESKTOP_THEME_KIND.DARK, 'vs-dark'],
    ] as const) {
      element.hostTheme = hostTheme;
      await vi.waitFor(() =>
        expect(setTheme).toHaveBeenCalledWith(monacoTheme),
      );
    }
  });
});
