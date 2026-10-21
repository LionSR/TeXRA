/**
 * How the harness reads the process environment.
 *
 * Effect programs read env through Effect `Config`, served by the
 * `ConfigProvider` `processLayer` installs over the live `process.env`
 * (`nodePlatform`'s, the project's `.env` over it). Tests replace it with a
 * provider record instead of mutating `process.env`.
 *
 * - `fromEnvRecord(process.env)`, not a bare `fromEnv()`: the latter copies
 *   `process.env` once, and the reference default is cached per process, so the
 *   extension's own PATH write, per-call keychain toggles and the per-turn
 *   validation switch would go unseen. `fromEnvRecord` looks each leaf up live.
 * - Not `Config.Boolean`: it accepts only a fixed case-sensitive vocabulary and
 *   fails on anything else. Harness flags read "any non-off value is on".
 * - `orDie`: `Config.String` under `Config.option` fails only on a provider
 *   source error, which `fromEnvRecord` never raises, so the unreachable case is
 *   a loud defect rather than a widened error channel.
 *
 * Every host had grown its own spelling of the flag check, so
 * `TEXRA_NO_UPDATE_CHECK=0` disabled update checks in one host and not in
 * another. A user who writes `=0` means off in all of them.
 */
import { Config, Effect, Option } from 'effect';

import {
  API_KEY_ENV_NAMES,
  apiKeyEnvName,
  type ApiKeyProviderId,
} from '@texra-ai/llm';

import { environment } from '@utils/system/nodeWorkspace';
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

/** One variable; unset and `''` both read as undefined. */
export const envVar = (name: string): Effect.Effect<string | undefined> =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
    Effect.orDie,
  );

/**
 * Whether `name` is set to something that means "on" (see
 * `isEnvFlagValueOn`): in the process environment, read through the ambient
 * `ConfigProvider`, or in `env` when the caller holds one (the environment a
 * run read).
 */
export const envFlag = (
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Effect.Effect<boolean> =>
  env === undefined
    ? Effect.map(envVar(name), isEnvFlagValueOn)
    : Effect.succeed(isEnvFlagValueOn(env[name]));

/**
 * The environment a child process the harness spawns starts from: this
 * process's with its project's `.env` variables over it (`environment`),
 * minus every provider API-key variable the harness reads as its own credential
 * ({@link API_KEY_ENV_NAMES}) and the requested approval policy
 * (`TEXRA_APPROVAL_POLICY`). What a child prints lands in tool results and
 * the transcript, so the key is never there to print. `keep` names the one
 * provider whose key a child agent CLI authenticates with itself. Windows
 * matches variable names case-insensitively, as its environment does.
 */
export const inheritedEnv = (
  keep?: ApiKeyProviderId,
): Effect.Effect<Record<string, string>> =>
  Effect.gen(function* () {
    const env = yield* environment;
    const fold = (name: string) => (IS_WINDOWS ? name.toUpperCase() : name);
    const kept = keep === undefined ? undefined : apiKeyEnvName(keep);
    // A project's `.env` never reaches a nested harness process as a requested
    // approval policy: only the user's own invocation asks for one.
    const withheld = new Set(
      [
        ...API_KEY_ENV_NAMES.filter((name) => name !== kept),
        'TEXRA_APPROVAL_POLICY',
      ].map(fold),
    );
    return Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !withheld.has(fold(entry[0])),
      ),
    );
  });
