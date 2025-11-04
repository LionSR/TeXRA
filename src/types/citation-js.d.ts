declare module 'citation-js' {
  export class Cite {
    data: any[];

    constructor(input: string | any, options?: any);

    static async(input: string | any, options?: any): Promise<Cite>;

    format(
      format: 'bibtex' | 'bibliography' | 'data' | 'json',
      options?: {
        format?: 'text' | 'html' | 'rtf';
        template?: string;
        lang?: string;
        type?: 'string' | 'json' | 'html';
      },
    ): string;

    get(options?: any): any;
    set(data: any): Cite;
    add(data: any): Cite;
    reset(): Cite;
  }

  export default Cite;
}
