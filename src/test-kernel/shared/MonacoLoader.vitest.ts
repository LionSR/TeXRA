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

function mockMonaco(): {
  languages: LanguageStub;
  grammarsLoaded: () => boolean;
} {
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
  // Importing this module *is* the registration of Monaco's bundled grammars, so
  // observing that the import happened is the only way to assert it.
  vi.doMock(GRAMMAR_MODULE_ID, () => {
    loaded = true;
    return { default: undefined };
  });
  for (const id of WORKER_MODULE_IDS) {
    vi.doMock(id, () => ({ default: MockWorker }));
  }
  return { languages, grammarsLoaded: () => loaded };
}

describe('shared Monaco loader', () => {
  beforeEach(() => {
    vi.resetModules();
    // `self.MonacoEnvironment` is assigned by the worker setup; jsdom is not
    // running here, so give the loader a `self` to write to.
    (globalThis as { self?: unknown }).self = globalThis;
  });

  async function loadMockedMonaco() {
    const mock = mockMonaco();
    const loader = await import('@shared/monaco/monacoLoader');
    return { ...mock, ...loader };
  }

  it('contributes the bundled grammars, which editor.api alone does not', async () => {
    // editor.api.js is the bare editor core and registers no languages: without
    // this import every file renders as undifferentiated plain text no matter
    // what language id its model carries.
    const { grammarsLoaded, loadMonaco } = await loadMockedMonaco();

    await loadMonaco();

    expect(grammarsLoaded()).toBe(true);
  });

  it('registers latex and bibtex, which Monaco does not ship', async () => {
    // .tex is the most common file type in this app, and it is precisely the one
    // language Monaco has no grammar for.
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

  it('maps file extensions to the language ids it registered', async () => {
    const { monacoLanguageForPath } = await loadMockedMonaco();

    expect(monacoLanguageForPath('paper/main.tex')).toBe('latex');
    expect(monacoLanguageForPath('refs.bib')).toBe('bibtex');
    expect(monacoLanguageForPath('build.py')).toBe('python');
    expect(monacoLanguageForPath('Proof.lean')).toBe('lean');
    // An unknown extension must resolve to a real Monaco id, not undefined —
    // creating a model with an unregistered language throws.
    expect(monacoLanguageForPath('LICENSE')).toBe('plaintext');
  });

  it('maps general-programming extensions to the language ids Monaco bundles', async () => {
    const { monacoLanguageForPath } = await loadMockedMonaco();

    expect(monacoLanguageForPath('/workspace/src/index.ts')).toBe('typescript');
    expect(monacoLanguageForPath('src/component.tsx')).toBe('typescript');
    expect(monacoLanguageForPath('scripts/check.mjs')).toBe('javascript');
    expect(monacoLanguageForPath('config/settings.json')).toBe('json');
    expect(monacoLanguageForPath('styles/main.scss')).toBe('scss');
    expect(monacoLanguageForPath('styles/main.less')).toBe('less');
    expect(monacoLanguageForPath('README.md')).toBe('markdown');
    expect(monacoLanguageForPath('docs/guide.mdx')).toBe('mdx');
    expect(monacoLanguageForPath('Main.java')).toBe('java');
    expect(monacoLanguageForPath('Program.cs')).toBe('csharp');
    expect(monacoLanguageForPath('index.php')).toBe('php');
    expect(monacoLanguageForPath('app.rb')).toBe('ruby');
    expect(monacoLanguageForPath('query.sql')).toBe('sql');
    expect(monacoLanguageForPath('data.xml')).toBe('xml');
    expect(monacoLanguageForPath('widget.cxx')).toBe('cpp');
  });

  it('maps well-known basenames without an extension to their language id', async () => {
    const { monacoLanguageForPath } = await loadMockedMonaco();

    expect(monacoLanguageForPath('Dockerfile')).toBe('dockerfile');
    expect(monacoLanguageForPath('build/Makefile')).toBe('makefile');
  });
});
