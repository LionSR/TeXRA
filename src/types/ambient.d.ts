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
}

/**
 * Type declarations for CSS and font imports.
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

// Font imports - returns URL (or base64 data URI if inlined)
declare module '*.ttf' {
  const url: string;
  export default url;
}

declare module '*.woff' {
  const url: string;
  export default url;
}

declare module '*.woff2' {
  const url: string;
  export default url;
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

declare module 'markdown-it' {
  class MarkdownIt {
    constructor(options?: Record<string, unknown>);
    use(plugin: unknown, options?: Record<string, unknown>): this;
    render(content: string): string;
  }

  export = MarkdownIt;
}

declare module 'markdown-it/lib/index.mjs' {
  import type { RenderRule } from 'markdown-it/lib/renderer.mjs';

  class MarkdownIt {
    constructor(options?: Record<string, unknown>);
    block: {
      ruler: {
        before(
          beforeName: string,
          ruleName: string,
          rule: MarkdownItBlockRule,
          options?: { alt?: string[] },
        ): void;
      };
    };
    renderer: {
      rules: Record<string, RenderRule | undefined>;
      render(tokens: unknown[], options: unknown, env: unknown): string;
    };
    options: {
      highlight?: (code: string, lang: string, attrs: string) => string;
    };
    use(plugin: unknown, options?: Record<string, unknown>): this;
    render(content: string): string;
  }

  export default MarkdownIt;

  type MarkdownItBlockRule = (
    state: unknown,
    startLine: number,
    endLine: number,
    silent: boolean,
  ) => boolean;
}

declare module 'markdown-it/lib/renderer.mjs' {
  interface RenderToken {
    readonly type: string;
    readonly tag: string;
    readonly content: string;
    readonly info: string;
    readonly markup: string;
    readonly hidden: boolean;
  }

  export type RenderRule = (
    tokens: RenderToken[],
    idx: number,
    options: unknown,
    env: unknown,
    self: unknown,
  ) => string;
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

declare module 'katex' {
  const katex: unknown;
  export = katex;
}

/**
 * Type declarations for mark.js text highlighting library.
 * @see https://markjs.io/
 */

declare module 'mark.js' {
  interface MarkOptions {
    element?: string;
    className?: string;
    exclude?: string[];
    separateWordSearch?: boolean;
    accuracy?: 'partially' | 'complementary' | 'exactly' | object;
    diacritics?: boolean;
    synonyms?: Record<string, string>;
    iframes?: boolean;
    iframesTimeout?: number;
    acrossElements?: boolean;
    caseSensitive?: boolean;
    ignoreJoiners?: boolean;
    ignorePunctuation?: string[];
    wildcards?: 'disabled' | 'enabled' | 'withSpaces';
    each?: (element: Element) => void;
    filter?: (
      node: Text,
      term: string,
      totalCounter: number,
      counter: number,
    ) => boolean;
    noMatch?: (term: string) => void;
    done?: (counter: number) => void;
    debug?: boolean;
    log?: object;
  }

  interface UnmarkOptions {
    element?: string;
    className?: string;
    exclude?: string[];
    iframes?: boolean;
    iframesTimeout?: number;
    done?: () => void;
    debug?: boolean;
    log?: object;
  }

  class Mark {
    constructor(context: Element | Element[] | DocumentFragment | string);
    mark(term: string | string[], options?: MarkOptions): void;
    markRegExp(regexp: RegExp, options?: MarkOptions): void;
    markRanges(
      ranges: Array<{ start: number; length: number }>,
      options?: MarkOptions,
    ): void;
    unmark(options?: UnmarkOptions): void;
  }

  export default Mark;
}

declare module 'sortablejs' {
  export interface SortableOptions {
    animation?: number;
    group?: string | Record<string, unknown>;
    draggable?: string;
    handle?: string;
    onEnd?: (event: unknown) => void;
  }

  export default class Sortable {
    constructor(element: HTMLElement, options?: SortableOptions);
    destroy(): void;
  }
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

declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

declare module '*?inline' {
  const content: string;
  export default content;
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
