// Third-party imports
import { Effect, Result, Schema } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import type {
  ConfigProvider,
  ConfigTarget,
  ConfigWriteFailed,
  StateStore,
  StateReadFailed,
} from '@platform/interfaces';
import type {
  SettingHost,
  StateSettingEntry,
} from '@shared/state/stateSettings';

const CHANNEL = 'settings';

/**
 * `Settings`: every read and write of a catalog setting, and the typed read
 * of a state key that is not a catalog row.
 *
 * A setting answers for the stores the caller holds as data. A session's
 * `WorkspaceRoots` carries all of them, so a tool call's `call.roots`, a run's
 * `session.roots` and a host command's `session.roots` are passed directly,
 * and the value answers for that project rather than for whichever roots the
 * calling fiber happens to carry. The row is looked up by key in the
 * catalog the stores' `ConfigProvider` carries (`config.catalog`); a key that
 * catalog lacks is a defect and throws.
 *
 * Reads go through the row's one declared `slot`: application-state Effects
 * for the state slots, a synchronous read for `config`.
 */

/** The setting slots a caller holds: a `WorkspaceRoots` is one. */
export interface SettingsStores {
  /** The host these stores belong to (`WorkspaceRoots.host`). */
  readonly host: SettingHost;
  readonly config: ConfigProvider;
  readonly workspaceState: StateStore;
  readonly repoState: StateStore;
  readonly globalState: StateStore;
}

/**
 * A stored value classified against its row's schema. `value` is always
 * schema-parsed: the stored value when it validates, the row's default when
 * the key is absent. A present value that no longer validates is `invalid`
 * and carries only the parse failure, never a substitute value, so a caller
 * that must not read corruption as the default cannot pick one up by accident.
 */
export type StoredSetting<T = unknown> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'invalid'; readonly cause: string };

/** A boolean state key that is off until something sets it. */
export const StateFlagSchema = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(false)),
);

function entryOf(config: ConfigProvider, key: string): StateSettingEntry {
  const entry = config.catalog.byKey(key);
  if (!entry) {
    throw new Error(`No setting catalog entry for key: ${key}`);
  }
  return entry;
}

/** A stored value against the row's schema; absent resolves to its default. */
function classifyStored(
  schema: Schema.Codec<unknown, unknown>,
  raw: unknown,
): StoredSetting {
  if (raw === undefined) {
    return {
      kind: 'value',
      value: Schema.decodeUnknownSync(schema)(undefined),
    };
  }
  const result = Schema.decodeUnknownResult(schema)(raw);
  return Result.isSuccess(result)
    ? { kind: 'value', value: result.success }
    : { kind: 'invalid', cause: result.failure.message };
}

/**
 * A stored value that no longer validates resolves to the schema default —
 * but only after warning: an invalid *persisted* value must not vanish
 * without a trace. Every reader warns with this text before it substitutes
 * the default.
 */
function invalidStoredMessage(key: string, cause: string): string {
  return `Ignoring invalid persisted value for setting "${key}": ${cause}`;
}

const valueOrDefault = (
  key: string,
  schema: Schema.Codec<unknown, unknown>,
  stored: StoredSetting,
): Effect.Effect<unknown> =>
  stored.kind === 'value'
    ? Effect.succeed(stored.value)
    : Effect.logWarning(invalidStoredMessage(key, stored.cause)).pipe(
        withLogChannel(CHANNEL),
        Effect.map(() => Schema.decodeUnknownSync(schema)(undefined)),
      );

/**
 * Read the scope the row is written to: `set` targets `entry.configTarget`,
 * so a global-target row read through the merged `get()` could report a
 * workspace value the settings view can never write.
 */
function rawConfigValue(
  entry: StateSettingEntry,
  config: ConfigProvider,
): unknown {
  return entry.configTarget === 'global'
    ? config.inspect<unknown>(entry.key).globalValue
    : config.get<unknown>(entry.key);
}

function inspectEntry(
  entry: StateSettingEntry,
  stores: SettingsStores,
): Effect.Effect<StoredSetting, StateReadFailed> {
  return Effect.suspend(() => {
    const slot = entry.slot;
    return slot === 'config'
      ? Effect.sync(() =>
          classifyStored(entry.schema, rawConfigValue(entry, stores.config)),
        )
      : Effect.map(stores[slot].get(entry.key), (raw) =>
          classifyStored(entry.schema, raw),
        );
  });
}

/**
 * Persist a value to an entry's slot. The only slot-specific detail is that
 * `config` writes carry a target while state stores do not, so the dispatch
 * lives here once for both `set` and `reset`. Each slot carries its store's
 * own failure (`ConfigWriteFailed`, the port's `StateWriteFailed`) unchanged.
 */
function writeSlot(
  entry: StateSettingEntry,
  value: unknown,
  stores: SettingsStores,
  target: ConfigTarget | undefined,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  const slot = entry.slot;
  if (slot === 'config') {
    return stores.config.update(
      entry.key,
      value,
      target ?? entry.configTarget ?? 'workspace',
    );
  }
  return stores[slot].update(entry.key, value);
}

/**
 * A setting's value: the stored value when it validates against the row's
 * schema, else the row's default (after a warning when a present value fails
 * it).
 */
function get<T>(
  stores: SettingsStores,
  key: string,
): Effect.Effect<T, StateReadFailed> {
  const entry = entryOf(stores.config, key);
  // cast: the caller names the row's value type; the row's schema parsed it.
  return Effect.flatMap(inspectEntry(entry, stores), (stored) =>
    valueOrDefault(entry.key, entry.schema, stored),
  ) as Effect.Effect<T, StateReadFailed>;
}

/**
 * {@link get} without the snap to the default: a present value that fails
 * the row's schema comes back as `invalid` with its cause. For a permission
 * gate whose absent default is permissive, where corruption of a deliberate
 * denial must deny rather than re-permit.
 */
function inspect<T>(
  stores: SettingsStores,
  key: string,
): Effect.Effect<StoredSetting<T>, StateReadFailed> {
  // cast: the caller names the row's value type; the row's schema parsed it.
  return inspectEntry(entryOf(stores.config, key), stores) as Effect.Effect<
    StoredSetting<T>,
    StateReadFailed
  >;
}

/**
 * {@link get} for a row whose slot is `config`, over a `ConfigProvider`
 * alone and synchronously. The CLI resolves its startup rows
 * (`texra.approvalPolicy`, `texra.outputFormat`) before the state stores of
 * that process exist, and this is the whole rule for a config-backed row, so
 * both readers run the same body rather than two that can drift.
 */
function getConfig<T>(config: ConfigProvider, key: string): T {
  const entry = entryOf(config, key);
  const stored = classifyStored(entry.schema, rawConfigValue(entry, config));
  // cast: the caller names the row's value type; the row's schema parsed it.
  if (stored.kind === 'value') return stored.value as T;
  // Direct sink write: config reads are synchronous by ruling and this one
  // also serves the CLI's pre-runtime startup rows, so no fiber exists here.
  writeLogLine(CHANNEL, invalidStoredMessage(entry.key, stored.cause));
  // cast: the row's schema produced its own default.
  return Schema.decodeUnknownSync(entry.schema)(undefined) as T;
}

/**
 * Validate and persist a setting to its row's slot, so the read and the
 * write cannot answer for two different workspaces and every write path
 * validates.
 *
 * A value the row's schema rejects is a defect of the program, not a member
 * of the `ConfigWriteFailed | Error` channel: it is thrown, so it will not
 * arrive as a catchable failure. Callers pass a value they already know is
 * valid; user input is validated upstream (a settings-UI write is decoded
 * by the app before it reaches here).
 *
 * A config-slot row is written to `target` when given (the one caller that
 * keeps a value in whichever scope already holds it: the "prefer my
 * subscription" switches), else the row's `configTarget`, else
 * `'workspace'`. State slots ignore `target`.
 */
function set(
  stores: SettingsStores,
  key: string,
  value: unknown,
  target?: ConfigTarget,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  const entry = entryOf(stores.config, key);
  // A schema rejection is thrown rather than constructed as a typed failure:
  // `src/shared` may take only type imports from `src/platform`.
  return Effect.suspend(() =>
    writeSlot(
      entry,
      Schema.decodeUnknownSync(entry.schema)(value),
      stores,
      target,
    ),
  );
}

/**
 * Reset a setting to its default by **deleting** the stored key, so the
 * schema's decoding default reappears on the next read. Never writes the
 * literal default value.
 */
function reset(
  stores: SettingsStores,
  key: string,
  target?: ConfigTarget,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  return writeSlot(entryOf(stores.config, key), undefined, stores, target);
}

/**
 * Read a state key that is not a catalog row (onboarding flags, the custom
 * agent directory, the reasoning overrides) as `schema` decodes it: the
 * schema's default when the key is absent, and, as for a catalog row, the
 * default after a warning when a present value fails it. The one decode of
 * these keys, so no reader casts the store's `unknown` to the type it hopes
 * for.
 */
function state<S extends Schema.Codec<unknown, unknown>>(
  store: Pick<StateStore, 'get'>,
  key: string,
  schema: S,
): Effect.Effect<S['Type'], StateReadFailed> {
  // cast: `valueOrDefault` returns the value `schema` parsed.
  return Effect.flatMap(store.get(key), (raw) =>
    valueOrDefault(key, schema, classifyStored(schema, raw)),
  ) as Effect.Effect<S['Type'], StateReadFailed>;
}

/** Every read and write of a setting; see the module comment. */
export const Settings = Object.freeze({
  get,
  inspect,
  getConfig,
  set,
  reset,
  state,
} as const);
