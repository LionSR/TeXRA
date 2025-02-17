declare module 'nunjucks' {
  interface Environment {
    renderString(str: string, context?: object): string;
  }

  interface ConfigureOptions {
    autoescape?: boolean;
    throwOnUndefined?: boolean;
    trimBlocks?: boolean;
    lstripBlocks?: boolean;
    watch?: boolean;
    noCache?: boolean;
    web?: {
      useCache?: boolean;
      async?: boolean;
    };
    express?: any;
    tags?: {
      blockStart?: string;
      blockEnd?: string;
      variableStart?: string;
      variableEnd?: string;
      commentStart?: string;
      commentEnd?: string;
    };
  }

  function configure(options: ConfigureOptions): Environment;
  function configure(
    path?: string | string[],
    options?: ConfigureOptions,
  ): Environment;
}
