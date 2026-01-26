declare module 'markdown-it' {
  class MarkdownIt {
    constructor(options?: Record<string, unknown>);
    use(plugin: unknown, options?: Record<string, unknown>): this;
    render(content: string): string;
  }

  export = MarkdownIt;
}

declare module 'markdown-it-texmath' {
  const texmath: unknown;
  export = texmath;
}

declare module 'katex' {
  const katex: unknown;
  export = katex;
}
