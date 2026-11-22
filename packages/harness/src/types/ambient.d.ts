/**
 * Ambient module declarations the harness sources need: untyped third-party
 * packages they import and the build-embedded modules (QuickJS WASM bytes,
 * the code sandbox worker, script sources). App and host declarations live with the app.
 */

/** Embedded by every Node host through esbuild's binary loader. */
declare module '@jitl/quickjs-wasmfile-release-sync/wasm' {
  const bytes: Uint8Array;
  export default bytes;
}

/**
 * The bundled code sandbox worker (`packages/harness/src/agent/codeSandbox/worker.ts`) as
 * CommonJS source text, embedded by every host build through
 * `scripts/code-sandbox-worker.mjs`.
 */
declare module 'virtual:code-sandbox-worker' {
  const source: string;
  export default source;
}

/**
 * A JavaScript file as its source text: the code a script's realm evaluates,
 * embedded by every host build through `scripts/code-sandbox-worker.mjs`
 * and read by Vite itself in the suites.
 */
declare module '*.js?raw' {
  const source: string;
  export default source;
}

declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';

  export const gfm: (service: TurndownService) => void;
}

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
