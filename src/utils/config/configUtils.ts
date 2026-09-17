// Local imports
import { createLog } from '@logger/logUtils';
import type { ConfigProvider } from '@platform/interfaces';
import { tryWorkspaceRoots, workspaceRoots } from '@platform/workspaceRoots';
import { getCoreSettingDefault } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Third-party imports
import type { ZodType } from 'zod';

const log = createLog('configUtils');

/**
 * Gets a value from the host's native TeXRA configuration.
 *
 * Path conventions:
 * - Use dot notation with or without the canonical `texra.` prefix.
 * - Host settings such as `latex-workshop.*` must use the host adapter rather
 *   than this shared configuration path.
 *
 * @param path Configuration path (e.g., 'agents' or 'api.engine')
 * Cataloged keys resolve their schema default even when an SDK consumer
 * supplies a structurally valid provider that only honors caller fallbacks.
 *
 * @param defaultValue Optional fallback for keys the catalog does not own
 * @returns The configured, catalog-default, or caller-fallback value
 *
 * This reads the config-tree slot only, and — unless the caller reaches for
 * {@link getValidatedConfig} — does no runtime validation against the
 * setting's schema, so a hand-edited `settings.json` value of the wrong
 * shape passes through uninspected. It also only knows the catalog default
 * for a `CORE_TREE_SETTINGS` entry; a `STATE_SETTINGS` key (one whose slot is
 * `workspaceState`/`globalState` for this host) is invisible to it and
 * silently falls back to `defaultValue` instead of the real persisted value.
 * For a catalog-modeled setting whose slot is `workspaceState`/`globalState`
 * for this host, use `readPlatformSetting` in `./platformSettings` instead —
 * it resolves whichever slot the entry declares and always validates. But
 * for a catalog-modeled config-slot key whose runtime must honor a workspace
 * override over a `configTarget: 'global'` write (the Models-tab provider
 * toggles — see `stateSettings.ts`'s note above `model.gpt5ReasoningSummary`,
 * and their `readConfig` call sites in `modelBinding.ts`), keep reading
 * through `getConfig`/`readConfig`/`getValidatedConfig`: `readPlatformSetting`
 * resolves a `configTarget: 'global'` row to `inspect(key).globalValue` only
 * and would silently drop the override.
 */
export function getConfig<T>(path: string, defaultValue?: T): T {
  return readConfig(workspaceRoots().config, path, defaultValue);
}

/**
 * {@link getConfig} over an explicit provider: the configuration of the
 * workspace the caller was handed (a tool call's `roots.config`), resolved
 * the same way — configured value, else the catalog default, else the
 * caller's fallback.
 */
export function readConfig<T>(
  config: ConfigProvider,
  path: string,
  defaultValue?: T,
): T {
  const configured = config.get<T | undefined>(path);
  if (configured !== undefined) return configured;
  const catalogDefault = getCoreSettingDefault(path) as T | undefined;
  return catalogDefault === undefined ? (defaultValue as T) : catalogDefault;
}

/**
 * Read configuration for an explicitly pre-initialization caller. Keep this
 * exception narrow: ordinary product paths must use {@link getConfig} so an
 * initialization-order defect remains observable.
 */
export function getConfigBeforePlatformInit<T>(
  path: string,
  defaultValue: T,
): T {
  return tryWorkspaceRoots()?.config.get(path, defaultValue) ?? defaultValue;
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
  return readValidatedConfig(
    workspaceRoots().config,
    path,
    schema,
    defaultValue,
  );
}

/**
 * {@link getValidatedConfig} over an explicit provider. Session-owned code
 * uses this form so the setting comes from the session it already holds,
 * without re-entering an ambient workspace-roots frame.
 */
export function readValidatedConfig<T>(
  config: ConfigProvider,
  path: string,
  schema: ZodType<T>,
  defaultValue: T,
): T {
  const raw = readConfig<unknown>(config, path);
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  // Warn only when the user explicitly set the value (global, workspace, or
  // workspace folder); an unset setting failing the schema is normal.
  if (config.isExplicitlySet(path)) {
    log.warn(
      `Ignoring invalid value for setting "${path}": ${toErrorMessage(result.error)}`,
    );
  }
  return defaultValue;
}
