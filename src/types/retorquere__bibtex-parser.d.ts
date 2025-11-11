declare module '@retorquere/bibtex-parser' {
  export interface BibTeXEntry {
    entryType: string;
    key?: string | null;
    input: string;
    fields: Record<string, unknown>;
  }

  export interface BibTeXLibrary {
    entries: BibTeXEntry[];
  }

  export function parse(content: string): BibTeXLibrary;
}
