/**
 * True under `npm test` or with `TEXRA_DEV_ASSERTIONS=1` set. Gates
 * dev/test-only runtime assertions (e.g. schema-validating payloads that
 * production sends unchecked for performance) so they cost nothing in prod.
 *
 * Deliberately reads the ambient `process` global rather than importing
 * `node:process` — `dispatcher.ts` (one of this function's two consumers)
 * is in the import closure of the webview frontends' Vite bundles, and an
 * explicit Node-builtin import here would put `node:process` on that
 * browser module graph. Safe in those bundles today only because no
 * frontend caller reaches this function (Rollup tree-shakes it out); do
 * not import it from webview frontend code.
 */
export function isDevAssertionMode(): boolean {
  return (
    process.env.NODE_ENV === 'test' || process.env.TEXRA_DEV_ASSERTIONS === '1'
  );
}
