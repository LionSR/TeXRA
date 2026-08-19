/**
 * True under `npm test` or with `TEXRA_DEV_ASSERTIONS=1` set. Gates
 * dev/test-only runtime assertions (e.g. schema-validating payloads that
 * production sends unchecked for performance) so they cost nothing in prod.
 *
 * Deliberately reaches the ambient `process` off `globalThis` rather than
 * importing `node:process` — `dispatcher.ts` (one of this function's two
 * consumers) is in the import closure of the webview frontends' and the
 * desktop renderer's bundles, and an explicit Node-builtin import here would
 * put `node:process` on those browser module graphs. Reading it off
 * `globalThis` also keeps the module compiling in TypeScript projects that
 * carry no Node types, and returns `false` in a browser instead of throwing.
 */
export function isDevAssertionMode(): boolean {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return env?.NODE_ENV === 'test' || env?.TEXRA_DEV_ASSERTIONS === '1';
}
