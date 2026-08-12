// Local imports
import { createLog } from '@logger/logUtils';
import { tryPlatform } from '@platform/platform';
import type { ConfigTarget, Disposable } from '@platform/interfaces';
import { ensureArray } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Third-party imports
import type { ZodType } from 'zod';

const log = createLog('configUtils');

interface UpdateConfigOptions {
  target?: ConfigTarget;
  prefix?: boolean;
  ifUnset?: boolean;
}

function configProvider() {
  return tryPlatform()?.config;
}

/**
 * Gets a value from the host's native TeXRA configuration.
 *
 * Path conventions:
 * - Use dot notation with or without the canonical `texra.` prefix.
 * - Host settings such as `latex-workshop.*` must use the host adapter rather
 *   than this shared configuration path.
 *
 * @param path Configuration path (e.g., 'agents' or 'api.engine')
 * @param defaultValue Optional default value if configuration is not found
 * @returns The configuration value or default value
 */
export function getConfig<T>(path: string, defaultValue?: T): T {
  const provider = configProvider();
  return provider ? provider.get(path, defaultValue) : (defaultValue as T);
}

/**
 * Reads a configuration value and validates it against a Zod schema, returning
 * `defaultValue` when the setting is unset or fails validation.
 *
 * Prefer this over `getConfig<T>(path, default)` whenever the value has a
 * constrained shape (enums, bounded numbers, structured records). `getConfig`
 * only *asserts* the type at the call site — a stale or hand-edited
 * `settings.json` can still feed through a value that violates it. Passing the
 * authoritative schema (e.g. the `z.enum(...)` built from a `coreSettings.ts`
 * constant) makes that schema the single shared contract for both the type and
 * the runtime check, so drift surfaces as a clean fallback rather than an
 * invalid value flowing downstream.
 *
 * An unset setting parses as `undefined` and is expected to fail most
 * schemas (enums, bounded numbers) — that's normal, not corruption, so it
 * falls back to `defaultValue` silently. A setting the user *did* set but
 * that fails validation (hand-edited/stale `settings.json`) instead warns
 * before falling back, so an invalid user setting doesn't silently drop.
 */
export function getValidatedConfig<T>(
  path: string,
  schema: ZodType<T>,
  defaultValue: T,
): T {
  const raw = getConfig<unknown>(path);
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  // Warn only when the user explicitly set the value (global, workspace, or
  // workspace folder); an unset setting failing the schema is normal.
  if (configProvider()?.isExplicitlySet(path)) {
    log.warn(
      `Ignoring invalid value for setting "${path}": ${toErrorMessage(result.error)}`,
    );
  }
  return defaultValue;
}

/**
 * Updates a value in the host's native TeXRA configuration.
 *
 * Path conventions:
 * - Use dot notation with or without the canonical `texra.` prefix.
 * - `prefix: false` is retained for callers that already pass a canonical key.
 *
 * @param path Configuration path
 * @param value The value to set
 * @param options Additional options for the update
 * @returns Promise that resolves when configuration is updated
 */
export async function updateConfig<T>(
  path: string,
  value: T,
  options: UpdateConfigOptions = {},
): Promise<void> {
  const { target = 'workspace', prefix = true, ifUnset = false } = options;

  const key = prefix && !path.startsWith('texra.') ? `texra.${path}` : path;
  const provider = configProvider();
  if (!provider) return;

  if (ifUnset && provider.isExplicitlySet(key)) {
    return; // Setting already exists, don't update
  }

  await provider.update(key, value, target);
}

/**
 * Register a listener for configuration changes on the given keys.
 *
 * @param context Extension context used to dispose the listener
 * @param keys Configuration keys to watch
 * @param callback Callback executed when any watched key changes
 * @returns Disposable for the registered listener
 */
export function watchConfig(
  context: { subscriptions: Disposable[] },
  keys: string | string[],
  callback: () => void,
): Disposable {
  const keyArray = ensureArray(keys);
  const provider = configProvider();
  const disposable = provider?.watch(keyArray, callback) ?? {
    dispose: () => {},
  };

  context.subscriptions.push(disposable);
  return disposable;
}
