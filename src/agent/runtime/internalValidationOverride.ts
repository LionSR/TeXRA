/**
 * CI-only internal validation model-handler override.
 *
 * Package validation (`pnpm --filter @texra-ai/cli run build` with
 * `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1`) swaps the real provider
 * handlers for a deterministic stub at the provider boundary, so a `texra run`
 * smoke test exercises the full CLI + executeAgent path without reaching a live
 * model API. This gate is build-tooling scaffolding, not provider-routing
 * domain logic, so it lives apart from {@link ./ModelFactory} to keep
 * the factory's provider routing free of synchronous file reads and CI env
 * plumbing.
 *
 * All env reads use direct `process.env.<NAME>` property access (never computed
 * keys) so esbuild's `define` (`packages/cli/scripts/build-bundle.mjs`) inlines
 * them at bundle time. In the default CLI build the include flag is defined to
 * `''`, so {@link shouldUseInternalValidationModelHandler} constant-folds to
 * `return false` and minification tree-shakes the `node:fs` read out entirely.
 * The reads stay lazy (evaluated at call time, not module load) so they happen
 * after `initPlatform()` and can be overridden between test cases.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * True only inside a guarded package-validation run: the include flag is set,
 * the per-run handler env var is `1`, `CI=1`, and an absolute flag file holds
 * the expected sentinel. Any partial/forged activation throws rather than
 * silently falling through to real handlers.
 */
export function shouldUseInternalValidationModelHandler(): boolean {
  if (process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL !== '1')
    return false;

  const envKey =
    process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_ENV ?? '';
  const flagEnvKey =
    process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV ?? '';
  const expectedFlagContent =
    process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_CONTENT ?? '';

  if (process.env[envKey] !== '1') return false;

  const flagPath = process.env[flagEnvKey];
  if (process.env.CI !== '1' || !flagPath || !path.isAbsolute(flagPath)) {
    throw new Error(
      `${envKey}=1 is restricted to package validation with CI=1 and an absolute ${flagEnvKey} path.`,
    );
  }

  let flagContent: string;
  try {
    flagContent = readFileSync(flagPath, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `${envKey}=1 requires a readable validation flag file at ${flagPath}.`,
      { cause: error },
    );
  }

  if (flagContent !== expectedFlagContent) {
    throw new Error(`${envKey}=1 received an invalid validation flag file.`);
  }

  return true;
}

/** Env-var name that activates the override, for diagnostic log messages. */
export function internalValidationModelHandlerEnvName(): string {
  return process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_ENV ?? '';
}
