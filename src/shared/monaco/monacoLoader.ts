// Shared Monaco loader for every webview/renderer host.
//
// Extracted from progressView's TexraDiffView, which owned the only copy. The
// desktop editor pane needs the identical setup, and Monaco's worker
// configuration is a module-global (`self.MonacoEnvironment`) — two independent
// copies would race to install it and whichever lost would silently hand the
// wrong worker to a language service. One loader, one `MonacoEnvironment`
// assignment, shared promise cache.

import { DESKTOP_THEME_KIND } from '@shared/schemas/commonViewMessages';

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
 * Loads Monaco and installs its workers once per host. The promise is cached so
 * concurrent callers share one download; a failure clears the cache so a later
 * attempt can retry rather than being stuck with a rejected promise forever.
 */
export async function loadMonaco(): Promise<MonacoModule> {
  monacoLoad ??= Promise.all([
    import('monaco-editor/editor/editor.api.js'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/language/json/json.worker?worker'),
    import('monaco-editor/language/css/css.worker?worker'),
    import('monaco-editor/language/html/html.worker?worker'),
    import('monaco-editor/language/typescript/ts.worker?worker'),
  ])
    .then(
      ([monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker]) => {
        setupMonacoWorkers({
          editor: (editorWorker as MonacoWorkerModule).default,
          json: (jsonWorker as MonacoWorkerModule).default,
          css: (cssWorker as MonacoWorkerModule).default,
          html: (htmlWorker as MonacoWorkerModule).default,
          ts: (tsWorker as MonacoWorkerModule).default,
        });
        return monaco;
      },
    )
    .catch((error: unknown) => {
      monacoLoad = undefined;
      throw error;
    });
  return monacoLoad;
}

export function monacoThemeForHostTheme(
  themeKind: string,
): 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' {
  if (themeKind === DESKTOP_THEME_KIND.LIGHT) return 'vs';
  if (themeKind === DESKTOP_THEME_KIND.HIGH_CONTRAST) return 'hc-black';
  return 'vs-dark';
}

/**
 * Monaco language id for a file path, covering the extensions TeXRA users
 * actually open. Monaco's own registry is keyed by language id, not extension,
 * so this mapping has to live on our side.
 */
export function monacoLanguageForPath(filePath: string): string {
  const name = filePath.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const extension = name.includes('.')
    ? (name.split('.').at(-1) ?? '').toLowerCase()
    : '';
  switch (extension) {
    case 'tex':
    case 'sty':
    case 'cls':
    case 'bbl':
      return 'latex';
    case 'bib':
      return 'bibtex';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'py':
      return 'python';
    case 'lean':
      return 'lean';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'toml':
      return 'ini';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'hpp':
      return 'cpp';
    default:
      return 'plaintext';
  }
}
