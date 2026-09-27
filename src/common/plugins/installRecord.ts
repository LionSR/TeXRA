// The install record (`texra.plugins.installed`) and the trust decisions
// (`texra.plugins.trusted`) in the global state every host shares: read and
// validated whole, and changed only as one read-modify-write at the store's
// authority, so two hosts changing them at once lose nothing and no lock is
// taken.

import { Effect, Result } from 'effect';
import { z } from 'zod';

import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  InstalledPluginSchema,
  PluginTrustSchema,
  type InstalledPlugin,
  type PluginTrust,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { PluginError, PluginRequestError } from './pluginManifest';

/**
 * The roots every host's plugin actions run over: the global state the
 * record lives in, and the global storage the managed plugins live under,
 * the same two for the CLI, the extension and the desktop.
 */
export type PluginEnv = Pick<SettingsStores, 'globalState'> & {
  readonly globalStorage: string;
};

const InstalledPluginsSchema = z.array(InstalledPluginSchema);
const PluginTrustListSchema = z.array(PluginTrustSchema);

/** One stored list as its schema reads it: absent is empty, anything that
 *  does not validate refuses, so a change never writes over it and loses it. */
function storedList<T>(key: string, schema: z.ZodType<T[]>, stored: unknown) {
  if (stored === undefined) return Result.succeed([] as T[]);
  const parsed = schema.safeParse(stored);
  return parsed.success
    ? Result.succeed(parsed.data)
    : Result.fail(
        new PluginError({
          message: `The stored list ${key} is unreadable: ${z.prettifyError(parsed.error)}`,
        }),
      );
}

/** The install record and the trust decisions, as one step reads them. */
export function readPluginState(stores: Pick<SettingsStores, 'globalState'>) {
  return Effect.gen(function* () {
    const read = <T>(key: string, schema: z.ZodType<T[]>) =>
      stores.globalState.get<unknown>(key).pipe(
        Effect.mapError((error) => new PluginError({ message: error.message })),
        Effect.flatMap((stored) =>
          Effect.fromResult(storedList(key, schema, stored)),
        ),
      );
    return {
      installed: yield* read<InstalledPlugin>(
        GlobalStateKey.INSTALLED_PLUGINS,
        InstalledPluginsSchema,
      ),
      trusted: yield* read<PluginTrust>(
        GlobalStateKey.PLUGIN_TRUST,
        PluginTrustListSchema,
      ),
    };
  });
}

/**
 * Change one stored list as one read-modify-write at the store's authority
 * (`StateStore.modify`), so two hosts changing it at once never lose each
 * other's change. `change` may refuse, and nothing is written.
 */
function modifyList<T, A>(
  stores: Pick<SettingsStores, 'globalState'>,
  key: string,
  schema: z.ZodType<T[]>,
  change: (
    current: T[],
  ) => Result.Result<readonly [T[], A], PluginError | PluginRequestError>,
) {
  let answer: A | undefined;
  return stores.globalState
    .modify(key, (stored) =>
      Result.flatMap(storedList(key, schema, stored), (current) =>
        Result.map(change(current), ([next, value]) => {
          answer = value;
          return next;
        }),
      ),
    )
    .pipe(
      Effect.mapError((error) =>
        error._tag === 'StateWriteFailed'
          ? new PluginError({ message: error.message })
          : error,
      ),
      Effect.map(() => answer as A),
    );
}

export const modifyInstalled = <A>(
  stores: Pick<SettingsStores, 'globalState'>,
  change: (
    current: InstalledPlugin[],
  ) => Result.Result<
    readonly [InstalledPlugin[], A],
    PluginError | PluginRequestError
  >,
) =>
  modifyList(
    stores,
    GlobalStateKey.INSTALLED_PLUGINS,
    InstalledPluginsSchema,
    change,
  );

export const modifyTrusted = (
  stores: Pick<SettingsStores, 'globalState'>,
  change: (current: PluginTrust[]) => PluginTrust[],
) =>
  modifyList(
    stores,
    GlobalStateKey.PLUGIN_TRUST,
    PluginTrustListSchema,
    (current) => Result.succeed([change(current), undefined] as const),
  );

/** The recorded plugin named `name`, or a request error naming the rest. */
export function findInstalled(
  installed: readonly InstalledPlugin[],
  name: string,
): Result.Result<InstalledPlugin, PluginRequestError> {
  const found = installed.find((plugin) => plugin.name === name);
  if (found) return Result.succeed(found);
  const names = installed.map((plugin) => plugin.name);
  return Result.fail(
    new PluginRequestError({
      message:
        names.length === 0
          ? `No plugin named ${name} is installed. No plugins are installed.`
          : `No plugin named ${name} is installed. Installed: ${names.join(', ')}.`,
    }),
  );
}
