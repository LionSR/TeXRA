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
      counter: number
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
      options?: MarkOptions
    ): void;
    unmark(options?: UnmarkOptions): void;
  }

  export default Mark;
}
