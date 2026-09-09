/**
 * Ambient module declarations for untyped third-party packages and
 * non-TS asset imports. Formerly one file per module in this folder.
 */

declare module 'bibtex' {
  export interface BibEntry {
    _id?: string;
    type?: string;
    fields: Record<string, unknown>;
    getField(field: string): unknown;
  }

  export interface BibLibrary {
    entries_raw: BibEntry[];
    entries$: Record<string, BibEntry | undefined>;
    getEntry(id: string): BibEntry | undefined;
  }

  export function parseBibFile(content: string): BibLibrary;

  // No default export on purpose: bibtex's UMD bundle sets `__esModule: true`
  // on its CJS exports, so a default import type-checks but bundles to
  // `undefined` under esbuild's ESM interop. Named imports only.
}

/**
 * Type declarations for CSS imports.
 *
 * Supports Vite's ?inline suffix for importing CSS as string.
 * Webpack uses type: 'asset/source' to achieve the same result.
 */

// CSS as string (Vite ?inline suffix)
declare module '*.css?inline' {
  const content: string;
  export default content;
}

// Standard CSS imports (Vite)
declare module '*.css' {
  const content: string;
  export default content;
}

/** Embedded by every Node host through esbuild's binary loader. */
declare module '@jitl/quickjs-wasmfile-release-sync/wasm' {
  const bytes: Uint8Array;
  export default bytes;
}

declare module 'highlightjs-lean' {
  import { LanguageFn } from 'highlight.js';
  const lean: LanguageFn;
  export default lean;
}

declare module 'markdown-it-texmath' {
  interface TexmathRule {
    name: string;
    rex: RegExp;
    tmpl: string;
    tag: string;
    displayMode?: boolean;
  }

  interface TexmathRules {
    brackets: {
      inline: TexmathRule[];
      block: TexmathRule[];
    };
    dollars: {
      inline: TexmathRule[];
      block: TexmathRule[];
    };
    beg_end: {
      block: TexmathRule[];
    };
  }

  interface Texmath {
    block: (rule: TexmathRule) => MarkdownItBlockRule;
    rules: TexmathRules;
  }

  type MarkdownItBlockRule = (
    state: unknown,
    startLine: number,
    endLine: number,
    silent: boolean,
  ) => boolean;

  const texmath: Texmath;
  export = texmath;
}

/** LaTeX template imports — loaded as text by esbuild's text loader. */
declare module '*.tex' {
  const content: string;
  export default content;
}

declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';

  export type TurndownPlugin = (service: TurndownService) => void;

  export const gfm: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
}

/// <reference types="vite/client" />

/**
 * Monaco's ESM entry points. TypeScript's legacy Node resolver cannot follow the
 * package export map, so each subpath we import needs an ambient declaration.
 *
 * `languages` is re-exported alongside `editor` because registering a grammar
 * (Monaco ships none for TeX) goes through `monaco.languages`.
 */
declare module 'monaco-editor/editor/editor.api.js' {
  export { editor, languages } from 'monaco-editor';
}

/**
 * Contributes Monaco's ~80 bundled Monarch grammars. Imported purely for its
 * side effect: `editor.api.js` is the bare editor core and registers no
 * languages, so without this every file renders as plain text.
 */
declare module 'monaco-editor/languages/register.all.js' {
  const registered: void;
  export default registered;
}

declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

declare module 'which' {
  export interface WhichOptions {
    nothrow?: boolean;
    path?: string;
    pathExt?: string;
  }

  interface Which {
    sync(command: string, options?: WhichOptions): string | null;
  }

  const which: Which;
  export default which;
}
