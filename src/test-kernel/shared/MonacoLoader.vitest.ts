import { beforeEach, describe, expect, it, vi } from 'vitest';

// Monaco's ESM entry points and its `?worker` suffixed imports do not resolve
// under Vitest, so every one the loader touches is mocked. The point of this
// suite is the loader's own contract — which modules it pulls in, and what it
// registers — not Monaco's behavior.
const WORKER_MODULE_IDS = [
  'monaco-editor/editor/editor.worker?worker',
  'monaco-editor/language/json/json.worker?worker',
  'monaco-editor/language/css/css.worker?worker',
  'monaco-editor/language/html/html.worker?worker',
  'monaco-editor/language/typescript/ts.worker?worker',
];

const GRAMMAR_MODULE_ID = 'monaco-editor/languages/register.all.js';

class MockWorker {}

interface LanguageStub {
  register: ReturnType<typeof vi.fn>;
  setMonarchTokensProvider: ReturnType<typeof vi.fn>;
  setLanguageConfiguration: ReturnType<typeof vi.fn>;
}

describe('shared Monaco loader', () => {
  beforeEach(() => {
    vi.resetModules();
    // `self.MonacoEnvironment` is assigned by the worker setup; jsdom is not
    // running here, so give the loader a `self` to write to.
    (globalThis as { self?: unknown }).self = globalThis;
  });

  async function loadMockedMonaco() {
    const languages: LanguageStub = {
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
    };
    let loaded = false;

    vi.doMock('monaco-editor/editor/editor.api.js', () => ({
      editor: { create: vi.fn(), createModel: vi.fn(), setTheme: vi.fn() },
      languages,
    }));
    // Importing this module *is* the registration of Monaco's bundled grammars.
    vi.doMock(GRAMMAR_MODULE_ID, () => {
      loaded = true;
      return { default: undefined };
    });
    for (const id of WORKER_MODULE_IDS) {
      vi.doMock(id, () => ({ default: MockWorker }));
    }
    const loader = await import('@shared/monaco/monacoLoader');
    return { languages, grammarsLoaded: () => loaded, ...loader };
  }

  it('contributes the bundled grammars, which editor.api alone does not', async () => {
    const { grammarsLoaded, loadMonaco } = await loadMockedMonaco();

    await loadMonaco();

    expect(grammarsLoaded()).toBe(true);
  });

  it('registers latex and bibtex, which Monaco does not ship', async () => {
    const { languages, loadMonaco } = await loadMockedMonaco();

    await loadMonaco();

    const registered = languages.register.mock.calls.map(
      ([definition]) => definition as { id: string; extensions?: string[] },
    );
    const byId = new Map(registered.map((entry) => [entry.id, entry]));

    expect(byId.get('latex')?.extensions).toContain('.tex');
    expect(byId.get('bibtex')?.extensions).toContain('.bib');
    // A grammar registered without a tokenizer would highlight nothing, so the
    // id registration alone is not enough to assert.
    const tokenized = languages.setMonarchTokensProvider.mock.calls.map(
      ([id]) => id,
    );
    expect(tokenized).toContain('latex');
    expect(tokenized).toContain('bibtex');
  });

  it('caches the load so concurrent callers share one download', async () => {
    const { grammarsLoaded, loadMonaco } = await loadMockedMonaco();

    const [first, second] = await Promise.all([loadMonaco(), loadMonaco()]);

    expect(first).toBe(second);
    expect(grammarsLoaded()).toBe(true);
  });

  it('registers the TeX grammars only once across repeated loads', async () => {
    // Monarch registration is global. Re-registering on every load would stack
    // duplicate providers for the same language id.
    const { languages, loadMonaco } = await loadMockedMonaco();

    await loadMonaco();
    await loadMonaco();

    const latexRegistrations = languages.register.mock.calls.filter(
      ([definition]) => (definition as { id: string }).id === 'latex',
    );
    expect(latexRegistrations).toHaveLength(1);
  });
});
