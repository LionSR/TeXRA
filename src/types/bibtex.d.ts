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
