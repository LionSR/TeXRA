/**
 * Native plugins: the `Plugin` an installed plugin's native entry
 * (`harness.mjs`, `@common/plugins/nativeEntry`) returns, loaded while the
 * plugin is enabled and trusted at its digest.
 *
 * The entry runs on this process's own `effect` and harness: its default
 * export is a function the harness calls with both ({@link NativePluginHost}),
 * so the tags, layers and fibers it builds are the host's own, whether the
 * host is bundled or not; Node never resolves `effect` from the plugin's
 * folder. Each trust digest is imported once per process, from a copy of
 * the plugin made for that digest (`copyPlugin`), so an edited and
 * trusted-again plugin is fresh modules beside the old ones, the entry and
 * every module it imports: Node caches a module by its path, and the path
 * the plugin was installed at would answer the modules of the revision
 * imported first. The code that runs is the files that were trusted,
 * whatever is written to the plugin's folder afterwards, so the entry's
 * `import.meta.url` names its copy. This process's copies go when its
 * loader's scope closes.
 *
 * The returned value is checked at this boundary: its shape, its id (its
 * installed plugin's name), that it contributes exactly what its header's
 * `provides` declared to the trust review, and that it asks for nothing a
 * native plugin may not have: row kinds (a store reads them when it opens and
 * the rows outlive the plugin), a switch or a dependency probe (its switch
 * is its installed plugin's enable), injected tools (its tools reach the
 * runs that take installed plugins' tools) and a program result (it reads a
 * row kind). A module that fails any of it, or throws, is withheld with the
 * reason; it never fails a step or another plugin.
 *
 * The host, not the module, decides how its tools run ({@link hostRun}):
 * every call asks under the session's approval policy, as an MCP server's
 * tool does (`@tools/mcp/mcpServer`), whatever the tool's own definition
 * declares about approval, concurrency or scripts.
 */
// Node imports
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Third-party imports
import {
  Array as Arr,
  Cache,
  Cause,
  Clock,
  Config,
  Context,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Function as Fn,
  Hash,
  HashMap,
  HashSet,
  Layer,
  Option,
  Order,
  Predicate,
  PubSub,
  Queue,
  Record,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream,
  String as Str,
  Struct,
  SubscriptionRef,
} from 'effect';

// Local imports
import {
  NAMED_KINDS,
  NATIVE_ENTRY_FILE,
  SINGLE_KINDS,
  type NativeEntry,
} from '@common/plugins/nativeEntry';
import { copyPlugin } from '@common/plugins/pluginDigest';
import { PluginError } from '@common/plugins/pluginManifest';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import { installedPluginId } from '@common/plugins/pluginTrust';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { shortPluginId, type ToolResult } from '@shared/schemas';
import { findStorageRefusal } from '@shared/session/runHistory';
import type { ITool } from '@tools/core/ToolTypes';
import type { Plugin } from '@tools/plugins';
import * as plugins from '@tools/pluginSurface';
import { thirdPartyCommand, withinDeadline } from '@tools/thirdPartyTool';
import type { NativePlugin } from '@tools/toolTable';
import { sha256Hex } from '@utils/core/idHash';
import { ensureError } from '@utils/errors/errorMessage';

/**
 * The modules of `effect` a native entry is handed, as this process loaded
 * them: those a plugin's tools, layers and programs are written with. A
 * fixed list, not the whole package: handing every module would keep all
 * of `effect` in every host's bundle, most of it nothing else uses.
 */
const EFFECT = Object.freeze({
  Array: Arr,
  Cause,
  Clock,
  Config,
  Context,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  Function: Fn,
  HashMap,
  HashSet,
  Layer,
  Option,
  Order,
  Predicate,
  PubSub,
  Queue,
  Record,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream,
  String: Str,
  Struct,
  SubscriptionRef,
});

/** What a native entry's default export is called with: this process's
 *  plugin authoring surface and the modules of its `effect` a plugin is
 *  written with. */
export interface NativePluginHost {
  /** `@texra-ai/worldline/plugins`, as this process loaded it. */
  readonly plugins: typeof plugins;
  /** `effect`'s authoring modules, as this process loaded them: `Effect`,
   *  `Context`, `Layer`, `Schema`, `Stream`, `Scope` and the data and
   *  concurrency modules beside them, by their `effect` names. */
  readonly effect: typeof EFFECT;
}

/** A native entry module (`harness.mjs`): its default export returns the
 *  plugin, written with `harness.plugins.definePlugin`. */
export interface NativeEntryModule {
  readonly default: (harness: NativePluginHost) => Plugin;
}

const HOST: NativePluginHost = Object.freeze({ plugins, effect: EFFECT });

/** A native entry that did not load: the message names the plugin, the
 *  revision and why ({@link notLoaded}). */
export class NativePluginFailed extends Schema.TaggedError<NativePluginFailed>()(
  'NativePluginFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The native code of the plugin `id` at `revision` (when it has one) is
 *  not loaded, for `reason`: whether its import, its value, the table's
 *  check or its layers refused it. */
export const notLoaded = (
  id: string,
  revision: string | undefined,
  reason: string,
  cause?: unknown,
): NativePluginFailed =>
  new NativePluginFailed({
    message: `The native code of ${id}${revision === undefined ? '' : ` at revision ${shortPluginId(revision)}`} is not loaded: ${reason}`,
    ...(cause === undefined ? {} : { cause }),
  });

// External values the harness only checks the kind of: a layer, an
// effect, a function.
const LayerValue = Schema.declare((value): value is Layer.Layer<never> =>
  Layer.isLayer(value),
);
const EffectValue = Schema.declare((value): value is Effect.Effect<void> =>
  Effect.isEffect(value),
);
const FunctionValue = Schema.declare(Predicate.isFunction);

/** The shape a native entry's plugin is checked against. Decoding only
 *  checks it: the plugin loaded is the value the module returned. */
const NativeShape = Schema.Struct({
  id: Schema.String,
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        definition: Schema.Struct({ name: Schema.String }),
        call: FunctionValue,
      }),
    ),
  ),
  processLayer: Schema.optional(
    Schema.Struct({ layer: LayerValue, drain: Schema.optional(EffectValue) }),
  ),
  sessionLayer: Schema.optional(LayerValue),
  prompt: Schema.optional(FunctionValue),
  scriptModules: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  programs: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.String,
        tools: Schema.Array(Schema.String),
        outputs: Schema.optional(Schema.Array(Schema.String)),
        fileArgs: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  requires: Schema.optional(Schema.Array(Schema.String)),
});

/** What a native plugin may not declare, and why, by field. */
const REFUSED_FIELDS = {
  factKinds:
    'it declares row kinds, which a store reads when it opens and which outlive the plugin',
  toggle:
    'it declares a switch; a native plugin is switched by enabling or disabling its installed plugin',
  availability:
    'it declares a dependency probe, which runs outside any step; a native plugin checks what it needs in its tools',
  injectedWhen:
    'it declares injected tools; its tools reach every run that takes the installed plugins’ tools',
} as const;

/** The names a plugin has of each named kind. */
const NAMED = {
  tool: (plugin) =>
    (plugin.tools ?? []).map(({ definition }) => definition.name),
  program: (plugin) => Object.keys(plugin.programs ?? {}),
  module: (plugin) => Object.keys(plugin.scriptModules ?? {}),
} satisfies Record<
  keyof typeof NAMED_KINDS,
  (plugin: Plugin) => readonly string[]
>;

/** What a plugin contributes, in `provides` words. */
const contributions = (plugin: Plugin): readonly string[] => [
  ...Object.entries(NAMED).flatMap(([word, names]) =>
    names(plugin).map((name) => `${word}:${name}`),
  ),
  ...Struct.keys(SINGLE_KINDS).filter((word) => plugin[word] !== undefined),
];

/**
 * The tool `tool` of the native plugin `name` as the host runs it: the
 * gate and deadline an MCP server's tool gets (`@tools/thirdPartyTool`).
 * Each call is a command the loop's one guard puts to the session's
 * approval policy, every call is a barrier, and it is not a script
 * function. Kept from the definition: its contract, whether a repeat is
 * safe, the host capability it needs and the paths it writes, which only
 * narrow what it may do. However its call ends but by interruption or a
 * store refusal (an error result, a failure, a defect, a throw outside any
 * effect, the deadline), it ends that call alone, with an error that names
 * the plugin.
 */
const hostRun = (
  name: string,
  tool: ITool<Error, PluginToolServices>,
): ITool<Error, PluginToolServices> => {
  const { definition, replay, hostCapability, guard } = tool;
  const what = `${definition.name} of plugin ${name}`;
  const failed = (message: string): ToolResult => ({
    status: 'error',
    error: `${what} failed: ${message}`,
  });
  return {
    definition,
    ...(replay !== undefined && { replay }),
    ...(hostCapability !== undefined && { hostCapability }),
    guard: {
      ...(guard?.writes !== undefined && { writes: guard.writes }),
      command: thirdPartyCommand(
        (input: unknown) =>
          `plugin ${name} ${definition.name} ${JSON.stringify(input)}`,
      ),
    },
    call: (input) =>
      withinDeadline(
        Effect.suspend(() => tool.call(input)).pipe(
          Effect.map((result) =>
            result.status === 'error'
              ? { ...result, ...failed(result.error) }
              : result,
          ),
          Effect.catch((error) =>
            findStorageRefusal(Cause.fail(error)) === undefined
              ? Effect.succeed(failed(error.message))
              : Effect.fail(error),
          ),
          Effect.catchDefect((defect) =>
            findStorageRefusal(Cause.die(defect)) === undefined
              ? Effect.as(
                  Effect.logWarning(
                    `${what} crashed: ${ensureError(defect).message}`,
                  ).pipe(withLogChannel('plugins')),
                  failed(ensureError(defect).message),
                )
              : Effect.die(defect),
          ),
        ),
        what,
      ),
  };
};

/** `value` as the plugin `source`'s native entry may return it, or why
 *  not. */
const checked = (
  value: unknown,
  source: LoadablePlugin,
  provides: readonly string[],
): Result.Result<Plugin, string> => {
  const { name } = source.record;
  const shape = Schema.decodeUnknownResult(NativeShape)(value, {
    errors: 'all',
  });
  if (Result.isFailure(shape))
    return Result.fail(
      `its default export returned no plugin: ${shape.failure.message}`,
    );
  // cast: the shape above checked every field the harness reads; the value
  // kept is the module's own, not the decoded copy.
  const plugin = value as Plugin;
  if (plugin.id !== name)
    return Result.fail(
      `its plugin's id is ${JSON.stringify(plugin.id)}, not its installed name ${JSON.stringify(name)}`,
    );
  const refused = Object.entries(REFUSED_FIELDS).find(([field]) =>
    Object.hasOwn(plugin, field),
  );
  if (refused !== undefined) return Result.fail(refused[1]);
  const withResult = Object.entries(plugin.programs ?? {}).find(
    ([, program]) => program.result !== undefined,
  );
  if (withResult !== undefined)
    return Result.fail(
      `its program ${withResult[0]} declares a result, which reads a row kind of its plugin`,
    );
  const contributed = new Set(contributions(plugin));
  const declared = new Set(provides);
  const undeclared = [...contributed].filter((item) => !declared.has(item));
  const absent = [...declared].filter((item) => !contributed.has(item));
  if (undeclared.length > 0 || absent.length > 0)
    return Result.fail(
      [
        ...(undeclared.length === 0
          ? []
          : [
              `it contributes ${undeclared.join(', ')}, which its header does not declare`,
            ]),
        ...(absent.length === 0
          ? []
          : [
              `its header declares ${absent.join(', ')}, which it does not contribute`,
            ]),
      ].join('; '),
    );
  return Result.succeed({
    ...plugin,
    id: installedPluginId(name),
    ...(plugin.tools !== undefined && {
      tools: plugin.tools.map((tool) => hostRun(name, tool)),
    }),
  });
};

/** Whether a process with the id `pid` is running on this machine. */
const running = (pid: number): boolean => {
  try {
    // Signal 0 sends nothing: it only checks that the process can be signalled.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process is refused, and is running.
    return Predicate.hasProperty(error, 'code') && error.code === 'EPERM';
  }
};

/**
 * This process's directory under `dir`, where it copies the native code it
 * loads, removed with the scope. A process that is killed leaves its
 * directory behind, so the directories of processes no longer running are
 * removed first (one whose process id another process took since stays
 * until that one exits).
 */
const processCopies = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* Effect.forEach(yield* fs.readDirectory(dir), (name) => {
    const pid = /^(\d+)-/.exec(name)?.[1];
    return pid === undefined || running(Number.parseInt(pid, 10))
      ? Effect.void
      : fs.remove(path.join(dir, name), { recursive: true, force: true });
  }).pipe(
    // Another process may be removing the same ones.
    Effect.catch((error) =>
      Effect.logWarning(
        `Copies of native code that exited processes left in ${dir} were not all removed: ${error.message}`,
      ).pipe(withLogChannel('plugins')),
    ),
  );
  return yield* fs.makeTempDirectoryScoped({
    directory: dir,
    prefix: `${process.pid}-`,
  });
});

/** Import `entry` of `source` as `revision`, from a copy of its plugin
 *  under `copies`, and call its default export; a failure is logged once,
 *  as the load is kept. */
const importEntry = (
  source: LoadablePlugin,
  entry: NativeEntry,
  revision: string,
  copies: Effect.Effect<string, PluginError>,
): Effect.Effect<NativePlugin, NativePluginFailed, FileSystem.FileSystem> => {
  const failed = (reason: string, cause?: unknown) =>
    notLoaded(installedPluginId(source.record.name), revision, reason, cause);
  return Effect.gen(function* () {
    const copy = yield* Effect.map(copies, (dir) => path.join(dir, revision));
    yield* copyPlugin(path.dirname(entry.file), copy);
    const url = pathToFileURL(path.join(copy, NATIVE_ENTRY_FILE)).href;
    const module: unknown = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ url),
      catch: (cause) =>
        failed(`importing it threw: ${ensureError(cause).message}`, cause),
    });
    const make = Predicate.hasProperty(module, 'default')
      ? module.default
      : undefined;
    if (!Predicate.isFunction(make))
      return yield* failed(
        'its default export is not a function of the harness it runs on',
      );
    const value = yield* Effect.try({
      try: (): unknown => make(HOST),
      catch: (cause) =>
        failed(
          `its default export threw: ${ensureError(cause).message}`,
          cause,
        ),
    });
    const loaded = checked(value, source, entry.provides);
    if (Result.isFailure(loaded)) return yield* failed(loaded.failure);
    return { plugin: loaded.success, revision };
  }).pipe(
    Effect.catchTag('PluginError', (error) =>
      Effect.fail(failed(error.message, error)),
    ),
    Effect.tapError((error) =>
      Effect.logWarning(error.message).pipe(withLogChannel('plugins')),
    ),
    Effect.uninterruptible,
  );
};

/** The revision of the native entry `file` trusted at `digest`: a digest
 *  of both, the module's identity, which its layers are kept under. */
export const nativeRevision = (file: string, digest: string): string =>
  sha256Hex(`${file}\0${digest}`);

/** One revision of an installed plugin's native entry, the loader's key:
 *  equal to another of the same revision, whichever read found it. */
class EntryRevision implements Equal.Equal {
  readonly revision: string;
  readonly source: LoadablePlugin;
  readonly entry: NativeEntry;

  constructor(source: LoadablePlugin, entry: NativeEntry) {
    this.source = source;
    this.entry = entry;
    this.revision = nativeRevision(entry.file, source.trust.digest);
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof EntryRevision && that.revision === this.revision;
  }

  [Hash.symbol](): number {
    return Hash.string(this.revision);
  }
}

/**
 * The process's native plugin loader: each installed plugin's entry at
 * each trust digest is imported and checked once (`load`; concurrent loads
 * of one revision share the import), its plugin (or why it did not load)
 * kept for the life of the process, as the module itself is, and so is a
 * revision whose services did not come up (`reject`): `load` answers its
 * failure from then on. `imported` answers the plugin a load already gave,
 * and imports nothing: what a reader that must run no plugin's code reads.
 * Each revision is imported from a copy of its plugin in this process's
 * directory under `copies`, made at the first load and removed with the
 * loader's scope.
 */
export const nativeLoader = Effect.fnUntraced(function* (copies: string) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  // Made at the first load: a process that loads no native code makes none.
  const home = yield* Effect.cached(
    processCopies(copies).pipe(
      Scope.provide(scope),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(
        (error) =>
          new PluginError({
            message: `no directory could be made for its copy: ${error.message}`,
          }),
      ),
    ),
  );
  const cache = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    lookup: ({ source, entry, revision }: EntryRevision) =>
      importEntry(source, entry, revision, home).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
  });
  const rejected = new Map<string, NativePluginFailed>();
  const loader: {
    readonly load: (
      source: LoadablePlugin,
    ) => Effect.Effect<NativePlugin, NativePluginFailed>;
    readonly imported: (
      source: LoadablePlugin,
    ) => Effect.Effect<Option.Option<NativePlugin>>;
    readonly reject: (
      native: NativePlugin,
      reason: string,
    ) => Effect.Effect<void>;
    /** Whether `native` was rejected. */
    readonly rejected: (native: NativePlugin) => boolean;
  } = {
    load: (source) =>
      Effect.suspend(() => {
        const entry = source.plugin.native;
        if (entry === null)
          return Effect.fail(
            notLoaded(
              installedPluginId(source.record.name),
              undefined,
              'it has no native entry',
            ),
          );
        const key = new EntryRevision(source, entry);
        const failed = rejected.get(key.revision);
        return failed === undefined
          ? Cache.get(cache, key)
          : Effect.fail(failed);
      }),
    imported: (source) => {
      const entry = source.plugin.native;
      return entry === null
        ? Effect.succeedNone
        : Cache.getSuccess(cache, new EntryRevision(source, entry));
    },
    reject: ({ plugin, revision }, reason) =>
      Effect.sync(() =>
        rejected.set(revision, notLoaded(plugin.id, revision, reason)),
      ),
    rejected: ({ revision }) => rejected.has(revision),
  };
  return loader;
});
