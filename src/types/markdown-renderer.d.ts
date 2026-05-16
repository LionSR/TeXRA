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
    rules: TexmathRules;
  }

  const texmath: Texmath;
  export = texmath;
}

declare module 'katex' {
  const katex: unknown;
  export = katex;
}
