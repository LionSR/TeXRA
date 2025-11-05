declare module 'citation-js' {
  interface CiteName {
    given?: string;
    family?: string;
    literal?: string;
  }

  interface CiteDateParts {
    'date-parts'?: Array<Array<number | string>>;
  }

  interface CiteData {
    id?: string;
    DOI?: string;
    title?: string;
    type?: string;
    author?: CiteName[];
    editor?: CiteName[];
    issued?: CiteDateParts;
    published?: CiteDateParts;
    abstract?: string;
    'container-title'?: string | string[];
    publisher?: string;
    volume?: string;
    issue?: string;
    page?: string;
    URL?: string;
    [key: string]: unknown;
  }

  class Cite {
    constructor(data?: unknown);
    static async(
      data: unknown,
      options?: Record<string, unknown>,
    ): Promise<Cite>;
    data: CiteData[];
    format(type: string, options?: Record<string, unknown>): string;
    get(options?: Record<string, unknown>): unknown;
  }

  export default Cite;
}

declare module 'zotero-api-client' {
  interface ZoteroApiConfig {
    [key: string]: unknown;
  }

  interface ZoteroApiResponse<T = unknown> {
    getData(): T;
    getMeta(): Record<string, unknown> | undefined;
    getTotalResults?(): number | string | undefined;
  }

  interface ZoteroChainedApi {
    library(typeOrKey: string, id?: number): ZoteroChainedApi;
    items(key?: string | null): ZoteroChainedApi;
    collections(key?: string | null): ZoteroChainedApi;
    publications(key?: string | null): ZoteroChainedApi;
    top(): ZoteroChainedApi;
    get<T = unknown>(opts?: ZoteroApiConfig): Promise<ZoteroApiResponse<T>>;
  }

  type ZoteroApiFactory = (
    apiKey?: string,
    opts?: ZoteroApiConfig,
  ) => ZoteroChainedApi;

  const api: ZoteroApiFactory;
  export default api;
  export type { ZoteroApiConfig, ZoteroApiResponse, ZoteroChainedApi };
}

declare module 'dblp-json' {
  interface DblpPublication {
    key?: string;
    title?: string;
    year?: string;
    doi?: string;
    ee?: string | string[];
    url?: string;
    journal?: string;
    booktitle?: string;
    type?: string;
    [key: string]: unknown;
  }

  interface DblpCoauthor {
    name?: string;
    pid?: string;
    url?: string;
    count?: string;
  }

  interface DblpPersonSummary {
    name?: string;
    url?: string;
    homepage?: string;
    pid?: string;
    ['n-publications']?: string;
    [key: string]: unknown;
  }

  interface DblpPublicationsResult {
    n: string;
    pubs: DblpPublication[];
  }

  interface DblpCoauthorsResult {
    n: string;
    coauthors: DblpCoauthor[];
  }

  interface DblpPerson {
    getPerson(): DblpPersonSummary;
    getPublications(): DblpPublicationsResult;
    getCoauthors(): DblpCoauthorsResult;
  }

  export default class DBLP {
    constructor();
    getByName(first: string, last: string): Promise<DblpPerson>;
    getByPID(pid: string): Promise<DblpPerson>;
    getByHomepage(homepage: string): Promise<DblpPerson>;
  }

  export type {
    DblpCoauthor,
    DblpCoauthorsResult,
    DblpPublication,
    DblpPublicationsResult,
    DblpPerson,
    DblpPersonSummary,
  };
}
