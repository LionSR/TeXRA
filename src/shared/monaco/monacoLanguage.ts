// Monaco's file-path -> language-id table, deliberately kept in its own module
// with no `monaco-editor` import of any kind.
//
// This is a pure lookup that non-editor code legitimately needs (a panel that
// only labels a diff, say), and it must stay importable without dragging Monaco
// in. Vite emits a worker bundle for every `import('...?worker')` expression it
// sees in the module graph, at transform time, *before* tree-shaking — so one
// import of this table from monacoLoader.ts wrote all five Monaco language
// workers (~12MB) into the extension build even though the tree-shaker then
// dropped `loadMonaco` itself as unreachable. Keeping the table here means
// importing it costs a switch statement, not a build artifact.

/**
 * Monaco language id for a file path, covering the extensions TeXRA users
 * actually open. Monaco's own registry is keyed by language id, not extension,
 * so this mapping has to live on our side. This is the single owner of that
 * mapping across every host — do not add a second one.
 */
export function monacoLanguageForPath(filePath: string): string {
  const name = filePath.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const lowerName = name.toLowerCase();
  if (lowerName === 'dockerfile') return 'dockerfile';
  if (lowerName === 'makefile') return 'makefile';
  const dotIndex = name.lastIndexOf('.');
  const extension =
    dotIndex === -1 ? '' : name.slice(dotIndex + 1).toLowerCase();
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
    case 'mdx':
      return 'mdx';
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
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
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'html':
    case 'htm':
      return 'html';
    case 'toml':
      return 'ini';
    case 'xml':
      return 'xml';
    case 'sql':
      return 'sql';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'cs':
      return 'csharp';
    case 'php':
      return 'php';
    case 'rb':
      return 'ruby';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return 'cpp';
    default:
      return 'plaintext';
  }
}
