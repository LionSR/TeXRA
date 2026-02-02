declare module 'markdown-it' {
  class MarkdownIt {
    constructor(options?: Record<string, unknown>);
    use(plugin: unknown, options?: Record<string, unknown>): this;
    render(content: string): string;
  }

  export = MarkdownIt;
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
