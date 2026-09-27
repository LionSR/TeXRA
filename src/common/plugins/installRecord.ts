// The install record (`texra.plugins.installed`) in the global state every
// host shares, the trust given to each plugin included: read and validated
// whole, and changed only as one read-modify-write at the store's authority,
// so two hosts changing it at once lose nothing and no lock is taken.

// Third-party imports
import { Effect, Result } from 'effect';
import { z } from 'zod';

// Local imports - shared contracts
import type { SettingsStores } from '@shared/config/settingsAccess';
import { InstalledPluginSchema, type InstalledPlugin } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

// Local imports - plugin reading
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

/** The record as its schema reads it: absent is empty, anything that does
 *  not validate refuses, so a change never writes over it and loses it. */
function storedRecord(stored: unknown) {
  if (stored === undefined) return Result.succeed([] as InstalledPlugin[]);
  const parsed = InstalledPluginsSchema.safeParse(stored);
  return parsed.success
    ? Result.succeed(parsed.data)
    : Result.fail(
        new PluginError({
          message: `The installed plugin record (${GlobalStateKey.INSTALLED_PLUGINS}) is unreadable: ${z.prettifyError(parsed.error)}`,
        }),
      );
}

/** The install record, as one read. */
export function readInstalled(stores: Pick<SettingsStores, 'globalState'>) {
  return stores.globalState.get<unknown>(GlobalStateKey.INSTALLED_PLUGINS).pipe(
    Effect.mapError((error) => new PluginError({ message: error.message })),
    Effect.flatMap((stored) => Effect.fromResult(storedRecord(stored))),
  );
}

/**
 * Change the record as one read-modify-write at the store's authority
 * (`StateStore.modify`), so two hosts changing it at once never lose each
 * other's change. `change` may refuse, and nothing is written.
 */
export function modifyInstalled<A>(
  stores: Pick<SettingsStores, 'globalState'>,
  change: (
    current: InstalledPlugin[],
  ) => Result.Result<
    readonly [InstalledPlugin[], A],
    PluginError | PluginRequestError
  >,
) {
  let answer: A | undefined;
  return stores.globalState
    .modify(GlobalStateKey.INSTALLED_PLUGINS, (stored) =>
      Result.flatMap(storedRecord(stored), (current) =>
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

/** Replace the recorded plugin named `name` with `update(found)`. */
export const updateInstalled = (
  stores: Pick<SettingsStores, 'globalState'>,
  name: string,
  update: (found: InstalledPlugin) => InstalledPlugin,
) =>
  modifyInstalled(stores, (current) =>
    Result.map(
      findInstalled(current, name),
      (found) =>
        [
          current.map((entry) => (entry === found ? update(found) : entry)),
          undefined,
        ] as const,
    ),
  );
