// Third-party imports
import { Effect, Result, Schema } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import type {
  SettingsCatalog,
  StateSettingEntry,
} from '@shared/state/stateSettings';

const CHANNEL = 'settings';

/**
 * `Settings`: every read and write of a catalog setting, and the typed read
 * of a state key that is not a catalog row.
 *
 * A setting answers for the stores the caller holds as data. A session's
 * `WorkspaceRoots` carries all of them, so a tool call's `call.roots`, a run's
 * `SessionRoots` and a host command's `session.roots` are passed directly,
 * and the value answers for that project rather than for whichever roots the
 * calling fiber happens to carry. The row is looked up by key in the
 * catalog the stores' `ConfigProvider` carries (`config.catalog`); a key that
 * catalog lacks is a defect and throws.
 *
 * Reads go through the row's one declared `slot`: application-state Effects
 * for the state slots, a synchronous read for `config`.
 */

/**
 * Where a config write lands. `workspace` is the project's committable
 * `.texra/config.json`, which a cloned repository controls; `local` is this
 * user's private file for the workspace, under the storage root and never in
 * the project; `global` is the user's file for every workspace.
 */
export type ConfigTarget = 'global' | 'workspace' | 'local';

/** One key's stored values, by the scope that holds each. */
export type ConfigInspection<T = unknown> = Partial<
  Record<'globalValue' | 'workspaceValue', T>
>;

/**
 * A configuration write the store refused. Every implementation bottoms out in
 * the same `JsonStore` as the secret and state stores, so the reasons are that
 * store's: a filesystem error under the config path, or a config file whose
 * contents are no longer a JSON object.
 *
 * {@link ConfigProvider.update} raises it as the failure of the write itself,
 * so a caller inside a program composes the write rather than adopting a
 * rejection it cannot type.
 */
export class ConfigWriteFailed extends Schema.TaggedError<ConfigWriteFailed>()(
  'ConfigWriteFailed',
  {
    key: Schema.String,
    target: Schema.Literals(['global', 'workspace', 'local']),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Platform configuration provider interface.
 */
export interface ConfigProvider {
  /**
   * Resolution order an implementation must honor: stored workspace value,
   * stored global value, then the setting catalog's own default
   * (`catalog.configDefault`); a key no row owns reads as `undefined` when
   * absent.
   *
   * It is synchronous, and it casts: the value it returns is whatever the
   * store holds. A reader that needs the value checked reads through
   * `Settings.get`, which resolves the key's catalog row and safe-parses the
   * stored value against the row's schema; a hand-edited `"false"` in a
   * boolean row is a truthy string here and silently means the opposite.
   * Nothing may cache what either read returns: a setting the user changes
   * mid-process is read on the next call.
   *
   * Keys are relative to `catalog.namespace` (`memory.enabled`), which the
   * provider adds to every key it stores.
   */
  get<T>(key: string): T;
  /**
   * Persist one value to the target's store. The write is an `Effect` so it
   * composes directly into the caller's program: the store's own write is an
   * Effect, and a Promise face here could only be an injected runner that
   * executes that Effect on the caller's behalf.
   */
  update<T>(
    key: string,
    value: T,
    target?: ConfigTarget,
  ): Effect.Effect<void, ConfigWriteFailed>;
  inspect<T = unknown>(key: string): ConfigInspection<T>;
  /** The setting rows this provider resolves against: the harness's and
   *  its host's, built once per composition and carried with the stores. */
  readonly catalog: SettingsCatalog;
}

/** An authoritative state read failed; absence is a successful read. */
export class StateReadFailed extends Schema.TaggedError<StateReadFailed>()(
  'StateReadFailed',
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A host or database refused an application-state write. */
export class StateWriteFailed extends Schema.TaggedError<StateWriteFailed>()(
  'StateWriteFailed',
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Application state read from its authority when the Effect executes. A read
 * answers the stored JSON as `unknown`: the caller decodes it with its key's
 * schema (`readState`), which also owns the default of an absent key. Updates
 * finish after commit. A change
 * that depends on the current value goes through `modify`, never a `get`
 * then an `update`: the settings surfaces do not serialize their messages,
 * and hosts in separate processes share one store.
 */
export interface StateStore {
  get(key: string): Effect.Effect<unknown, StateReadFailed>;
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed>;
  /**
   * Read-modify-write of one key as one step at the store's authority:
   * `change` sees the stored value (`undefined` when absent) and returns the
   * next one, or refuses with its own error and nothing is written.
   */
  modify<T, E = never>(
    key: string,
    change: (current: unknown) => Result.Result<T, E>,
  ): Effect.Effect<T, E | StateWriteFailed>;
}

/** The setting slots a caller holds: a `WorkspaceRoots` is one. */
export interface SettingsStores {
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

function entryOf(catalog: SettingsCatalog, key: string): StateSettingEntry {
  const entry = catalog.byKey(key);
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

function inspectEntry(
  entry: StateSettingEntry,
  stores: SettingsStores,
): Effect.Effect<StoredSetting, StateReadFailed> {
  return Effect.suspend(() => {
    const slot = entry.slot;
    return slot === 'config'
      ? Effect.sync(() =>
          classifyStored(entry.schema, stores.config.get<unknown>(entry.key)),
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
  const entry = entryOf(stores.config.catalog, key);
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
  return inspectEntry(
    entryOf(stores.config.catalog, key),
    stores,
  ) as Effect.Effect<StoredSetting<T>, StateReadFailed>;
}

/**
 * {@link get} for a row whose slot is `config`, over a `ConfigProvider`
 * alone and synchronously. The CLI resolves its startup rows
 * (`approvalPolicy`, `outputFormat`) before the state stores of
 * that process exist, and this is the whole rule for a config-backed row, so
 * both readers run the same body rather than two that can drift.
 */
function getConfig<T>(config: ConfigProvider, key: string): T {
  const entry = entryOf(config.catalog, key);
  const stored = classifyStored(entry.schema, config.get<unknown>(entry.key));
  // cast: the caller names the row's value type; the row's schema parsed it.
  if (stored.kind === 'value') return stored.value as T;
  // Direct sink write: config reads are synchronous by ruling and this one
  // also serves the CLI's pre-runtime startup rows, so no fiber exists here.
  writeLogLine(CHANNEL, invalidStoredMessage(entry.key, stored.cause));
  return defaultOf<T>(config.catalog, key);
}

/** What a row reads as while its key is absent: the default its catalog
 *  gives it, `undefined` for a row that names none. */
function defaultOf<T>(catalog: SettingsCatalog, key: string): T {
  // cast: the caller names the row's value type; the row's schema produced it.
  return Schema.decodeUnknownSync(entryOf(catalog, key).schema)(undefined) as T;
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
  const entry = entryOf(stores.config.catalog, key);
  // A schema rejection is thrown rather than constructed as a typed failure:
  // a value the catalog's schema refuses is a defect of the caller, not a
  // `ConfigWriteFailed` the store reported.
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
  return writeSlot(
    entryOf(stores.config.catalog, key),
    undefined,
    stores,
    target,
  );
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
  defaultOf,
  set,
  reset,
  state,
} as const);
