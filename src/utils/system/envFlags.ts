/**
 * How TeXRA reads the process environment.
 *
 * Effect programs read env through Effect `Config`, served by one
 * `ConfigProvider` over the live `process.env` (`processEnvConfigLayer`,
 * installed by `installProcessRuntime` and the CLI's pre-runtime run). Tests
 * replace it with a provider record instead of mutating `process.env`.
 *
 * - `fromEnvRecord(process.env)`, not a bare `fromEnv()`: the latter copies
 *   `process.env` once, and the reference default is cached per process, so the
 *   extension's own PATH write, per-call keychain toggles and the per-turn
 *   validation switch would go unseen. `fromEnvRecord` looks each leaf up live.
 * - Not `Config.Boolean`: it accepts only a fixed case-sensitive vocabulary and
 *   fails on anything else. TeXRA flags read "any non-off value is on".
 * - `orDie`: `Config.String` under `Config.option` fails only on a provider
 *   source error, which `fromEnvRecord` never raises, so the unreachable case is
 *   a loud defect rather than a widened error channel.
 *
 * Every host had grown its own spelling of the flag check, so
 * `TEXRA_NO_UPDATE_CHECK=0` disabled update checks in one host and
 * `TEXRA_DISABLE_KEYCHAIN=yes` did nothing in another. A user who writes `=0`
 * means off in both.
 */
import { Config, ConfigProvider, Effect, Layer, Option } from 'effect';

import type { ApiKeyProviderId } from '@shared/constants/modelProviderPlugins';
import { API_KEY_ENV_NAMES, apiKeyEnvName } from '@shared/constants/providers';
import { IS_WINDOWS } from '@utils/system/platformPaths';

const ENV_FLAG_OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Unset, empty, and the explicit off spellings (`0`, `false`, `no`, `off`,
 * case-insensitive, trimmed) are false; any other value is true, so `=1`,
 * `=true`, and a bare `=yes` all work.
 */
function isEnvFlagValueOn(value: string | undefined): boolean {
  if (value == null) return false;
  return !ENV_FLAG_OFF_VALUES.has(value.trim().toLowerCase());
}

/** The process environment as Effect's ConfigProvider, read live. */
export const processEnvConfigLayer: Layer.Layer<never> = ConfigProvider.layer(
  Effect.sync(() => ConfigProvider.fromEnvRecord(process.env)),
);

/** One variable; unset and `''` both read as undefined. */
export const envVar = (name: string): Effect.Effect<string | undefined> =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
    Effect.orDie,
  );

/** Whether `name` is set to something that means "on" (see `isEnvFlagValueOn`). */
export const envFlag = (name: string): Effect.Effect<boolean> =>
  Effect.map(envVar(name), isEnvFlagValueOn);

/** Sync face of `envFlag` for non-Effect callers (telemetry gate, `texra doctor`, CLI update notice). */
export function isEnvFlagEnabled(name: string): boolean {
  return isEnvFlagValueOn(process.env[name]);
}

/**
 * The environment a child process TeXRA spawns starts from: this process's,
 * minus every provider API-key variable TeXRA reads as its own credential
 * ({@link API_KEY_ENV_NAMES}). What a child prints lands in tool results and
 * the transcript, so the key is never there to print. `keep` names the one
 * provider whose key a child agent CLI authenticates with itself. Windows
 * matches variable names case-insensitively, as its environment does.
 */
export function inheritedEnv(keep?: ApiKeyProviderId): Record<string, string> {
  const fold = (name: string) => (IS_WINDOWS ? name.toUpperCase() : name);
  const kept = keep === undefined ? undefined : apiKeyEnvName(keep);
  const withheld = new Set(
    API_KEY_ENV_NAMES.filter((name) => name !== kept).map(fold),
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !withheld.has(fold(entry[0])),
    ),
  );
}
