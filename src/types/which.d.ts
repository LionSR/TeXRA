declare module 'which' {
  export interface WhichOptions {
    nothrow?: boolean;
    path?: string;
    pathExt?: string;
  }

  interface Which {
    sync(command: string, options?: WhichOptions): string | null;
  }

  const which: Which;
  export default which;
}
