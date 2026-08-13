// Shared Monaco loader for every webview/renderer host.
//
// Extracted from progressView's TexraDiffView, which owned the only copy. The
// desktop editor pane needs the identical setup, and Monaco's worker
// configuration is a module-global (`self.MonacoEnvironment`) — two independent
// copies would race to install it and whichever lost would silently hand the
// wrong worker to a language service. One loader, one `MonacoEnvironment`
// assignment, shared promise cache.
//
// Everything in here reaches `monaco-editor`. The path -> language-id table
// lives in monacoLanguage.ts precisely so callers that only need a language id
// do not import this module — see the comment there for what that costs.

import { DESKTOP_THEME_KIND, type Theme } from '@shared/schemas';

export type MonacoModule = typeof import('monaco-editor/editor/editor.api.js');
type MonacoWorkerModule = { default: new () => Worker };
type MonacoEnvironmentHost = typeof self & {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
};

interface MonacoWorkerConstructors {
  editor: new () => Worker;
  json: new () => Worker;
  css: new () => Worker;
  html: new () => Worker;
  ts: new () => Worker;
}

let monacoLoad: Promise<MonacoModule> | undefined;
let workersConfigured = false;

function setupMonacoWorkers(workers: MonacoWorkerConstructors): void {
  if (workersConfigured) return;
  (self as MonacoEnvironmentHost).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new workers.json();
        case 'css':
        case 'scss':
        case 'less':
          return new workers.css();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new workers.html();
        case 'typescript':
        case 'javascript':
          return new workers.ts();
        default:
          return new workers.editor();
      }
    },
  };
  workersConfigured = true;
}

/**
 * Loads Monaco, registers its languages, and installs its workers once per host.
 *
 * The promise is cached so concurrent callers share one download; a failure
 * clears the cache so a later attempt can retry rather than being stuck with a
 * rejected promise forever.
 *
 * `editor.api.js` is deliberately paired with `languages/register.all.js`. The
 * api entry is the bare editor *core*: it ships no grammars at all, so on its
 * own every file renders as undifferentiated plain text regardless of the model's
 * language id. register.all contributes the ~80 bundled Monarch grammars, each
 * behind a lazy `loader: () => import(...)`, so registering them all costs a
 * table of ids up front and downloads a grammar only when a file of that type is
 * actually opened.
 */
export async function loadMonaco(): Promise<MonacoModule> {
  monacoLoad ??= Promise.all([
    import('monaco-editor/editor/editor.api.js'),
    import('monaco-editor/languages/register.all.js'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/language/json/json.worker?worker'),
    import('monaco-editor/language/css/css.worker?worker'),
    import('monaco-editor/language/html/html.worker?worker'),
    import('monaco-editor/language/typescript/ts.worker?worker'),
  ])
    .then(
      ([
        monaco,
        ,
        editorWorker,
        jsonWorker,
        cssWorker,
        htmlWorker,
        tsWorker,
      ]) => {
        setupMonacoWorkers({
          editor: (editorWorker as MonacoWorkerModule).default,
          json: (jsonWorker as MonacoWorkerModule).default,
          css: (cssWorker as MonacoWorkerModule).default,
          html: (htmlWorker as MonacoWorkerModule).default,
          ts: (tsWorker as MonacoWorkerModule).default,
        });
        registerTexLanguages(monaco);
        return monaco;
      },
    )
    .catch((error: unknown) => {
      monacoLoad = undefined;
      throw error;
    });
  return monacoLoad;
}

let texLanguagesRegistered = false;

/**
 * Registers `latex` and `bibtex` grammars.
 *
 * Monaco bundles no TeX support — the closest it ships is `restructuredtext` —
 * yet .tex is the single most common file type in this app, so the one language
 * users most need highlighted is the one Monaco cannot provide. These Monarch
 * definitions are small on purpose: commands, math, comments, and the
 * environment name inside \begin/\end, which is what makes a source file
 * scannable. Full TeX tokenization is not the goal.
 */
function registerTexLanguages(monaco: MonacoModule): void {
  if (texLanguagesRegistered) return;
  texLanguagesRegistered = true;

  monaco.languages.register({
    id: 'latex',
    extensions: ['.tex', '.sty', '.cls', '.bbl'],
    aliases: ['LaTeX', 'latex', 'TeX'],
  });
  monaco.languages.setMonarchTokensProvider('latex', {
    // `defaultToken: ''` leaves prose unstyled, so highlighting marks up the
    // markup rather than recoloring the author's text.
    defaultToken: '',
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        // \begin{...} / \end{...}: the environment name carries more meaning
        // than the command itself, so it gets its own token.
        [
          /(\\(?:begin|end))(\s*)(\{)([^}]*)(\})/,
          ['keyword', '', 'delimiter.curly', 'type', 'delimiter.curly'],
        ],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        // Escaped literals, before the math rules below claim the $.
        [/\\[^a-zA-Z@]/, 'string.escape'],
        [/\$\$/, { token: 'string', next: '@displayMath' }],
        [/\$/, { token: 'string', next: '@inlineMath' }],
        [/[{}]/, 'delimiter.curly'],
        [/[[\]]/, 'delimiter.square'],
        [/[&~^_]/, 'operator'],
      ],
      // Math runs are tokenized as one span: inside math, TeX's own syntax
      // matters less to a reader than seeing where the math starts and stops.
      inlineMath: [
        [/[^\\$]+/, 'string'],
        [/\\[a-zA-Z@]+/, 'keyword'],
        [/\\./, 'string.escape'],
        [/\$/, { token: 'string', next: '@pop' }],
      ],
      displayMath: [
        [/[^\\$]+/, 'string'],
        [/\\[a-zA-Z@]+/, 'keyword'],
        [/\\./, 'string.escape'],
        [/\$\$/, { token: 'string', next: '@pop' }],
        [/\$/, 'string'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '$', close: '$' },
    ],
  });

  monaco.languages.register({
    id: 'bibtex',
    extensions: ['.bib'],
    aliases: ['BibTeX', 'bibtex'],
  });
  monaco.languages.setMonarchTokensProvider('bibtex', {
    defaultToken: '',
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        // @article{key, ... — the entry type and citation key are what you scan
        // a .bib file for.
        [/(@[a-zA-Z]+)(\s*)([{(])/, ['keyword', '', 'delimiter.curly']],
        [/[a-zA-Z][\w-]*(?=\s*=)/, 'attribute.name'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/[{}()]/, 'delimiter.curly'],
        [/=/, 'operator'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('bibtex', {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '"', close: '"' },
    ],
  });
}

export function monacoThemeForHostTheme(
  theme: Theme,
): 'vs' | 'vs-dark' | 'hc-black' {
  if (theme === DESKTOP_THEME_KIND.LIGHT) return 'vs';
  if (theme === DESKTOP_THEME_KIND.HIGH_CONTRAST) return 'hc-black';
  return 'vs-dark';
}
