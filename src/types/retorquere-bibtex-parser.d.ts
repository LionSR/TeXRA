declare module '@retorquere/bibtex-parser' {
  export interface ParseOptions {
    verbatimFields?: string[];
  }

  export interface BibTeXEntry {
    key: string;
    type: string;
    fields: Record<string, string | number | boolean | string[]>;
  }

  export interface ParseResult {
    entries: BibTeXEntry[];
    errors: string[];
    comments: string[];
    preamble: string[];
    strings: Record<string, string>;
  }

  export function parse(
    input: string,
    options?: ParseOptions,
  ): ParseResult;

  export function stringify(
    entries: BibTeXEntry[],
    options?: { format?: 'bibtex' | 'biblatex' },
  ): string;
}
