import process from 'node:process';

/**
 * True under `npm test` or with `TEXRA_DEV_ASSERTIONS=1` set. Gates
 * dev/test-only runtime assertions (e.g. schema-validating payloads that
 * production sends unchecked for performance) so they cost nothing in prod.
 */
export function isDevAssertionMode(): boolean {
  return (
    process.env.NODE_ENV === 'test' || process.env.TEXRA_DEV_ASSERTIONS === '1'
  );
}
