/**
 * Native plugins: the `Plugin` an installed plugin's native entry
 * (`harness.mjs`, `@common/plugins/nativeEntry`) returns, loaded while the
 * plugin is enabled and trusted at its digest.
 *
 * The entry runs on this process's own `effect` and harness: its default
 * export is a function the harness calls with both ({@link NativePluginHost}),
 * so the tags, layers and fibers it builds are the host's own, whether the
 * host is bundled or not; Node never resolves `effect` from the plugin's
 * folder. Each trust digest is imported once per process, as a URL of its
 * own (`harness.mjs?rev=<revision>`), so an edited and trusted-again entry is a
 * fresh module beside the old one. A module the entry imports is cached by
 * Node under its own URL and imported once per process: a revision reaches
 * only what the entry itself holds.
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
 */
// Node imports
import { pathToFileURL } from 'node:url';

// Third-party imports
import * as effect from 'effect';
import { Effect, Layer, Predicate, Result, Schema } from 'effect';

// Local imports
import type { NativeEntry } from '@common/plugins/nativeEntry';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import { installedPluginId } from '@common/plugins/pluginTrust';
import type { Plugin } from '@tools/plugins';
import * as plugins from '@tools/pluginSurface';
import type { NativePlugin } from '@tools/toolTable';
import { sha256Hex } from '@utils/core/idHash';
import { ensureError } from '@utils/errors/errorMessage';

/** What a native entry's default export is called with: this process's
 *  plugin authoring surface and its `effect`. */
export interface NativePluginHost {
  /** `@texra-ai/harness/plugins`, as this process loaded it. */
  readonly plugins: typeof plugins;
  /** `effect`, as this process loaded it. */
  readonly effect: typeof effect;
}

/** A native entry module (`harness.mjs`): its default export returns the
 *  plugin, written with `harness.plugins.definePlugin`. */
export interface NativeEntryModule {
  readonly default: (harness: NativePluginHost) => Plugin;
}

const HOST: NativePluginHost = Object.freeze({ plugins, effect });

/** A native entry that did not load: the message names the plugin and
 *  why. */
export class NativePluginFailed extends Schema.TaggedError<NativePluginFailed>()(
  'NativePluginFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

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

/** What a plugin contributes, in `provides` words. */
const contributions = (plugin: Plugin): readonly string[] => [
  ...(plugin.tools ?? []).map(({ definition }) => `tool:${definition.name}`),
  ...Object.keys(plugin.programs ?? {}).map((name) => `program:${name}`),
  ...Object.keys(plugin.scriptModules ?? {}).map((name) => `module:${name}`),
  ...(plugin.processLayer === undefined ? [] : ['processLayer']),
  ...(plugin.sessionLayer === undefined ? [] : ['sessionLayer']),
  ...(plugin.prompt === undefined ? [] : ['prompt']),
];

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
  return Result.succeed({ ...plugin, id: installedPluginId(name) });
};

/** The plugin `source`'s native entry is not loaded, for `reason`. */
const failure = (source: LoadablePlugin, reason: string, cause?: unknown) =>
  new NativePluginFailed({
    message: `The native code of plugin ${source.record.name} is not loaded: ${reason}`,
    ...(cause === undefined ? {} : { cause }),
  });

/** Import `entry` of `source` as `revision` and call its default export;
 *  a failure is logged once, as the load is kept. */
const importEntry = (
  source: LoadablePlugin,
  entry: NativeEntry,
  revision: string,
): Effect.Effect<NativePlugin, NativePluginFailed> => {
  const failed = (reason: string, cause?: unknown) =>
    failure(source, reason, cause);
  const url = `${pathToFileURL(entry.file).href}?rev=${revision}`;
  return Effect.gen(function* () {
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
    Effect.tapError((error) =>
      Effect.logWarning(error.message).pipe(withLogChannel('plugins')),
    ),
    Effect.uninterruptible,
  );
};

/** The revision of `source`'s native entry `entry`: a digest of the
 *  entry's path and the trust digest, the module's identity, which its
 *  layers are kept under. */
const revisionOf = (source: LoadablePlugin, entry: NativeEntry): string =>
  sha256Hex(`${entry.file}\0${source.trust.digest}`);

/**
 * The process's native plugin loader: each installed plugin's entry at
 * each trust digest is imported and checked once (`load`), its plugin (or
 * why it did not load) kept for the life of the process, as the module
 * itself is. `imported` answers the plugin a load already gave, and imports
 * nothing: what a reader that must run no plugin's code reads.
 */
export const nativeLoader = (): {
  readonly load: (
    source: LoadablePlugin,
  ) => Effect.Effect<NativePlugin, NativePluginFailed>;
  readonly imported: (source: LoadablePlugin) => NativePlugin | undefined;
} => {
  const loads = new Map<
    string,
    Effect.Effect<NativePlugin, NativePluginFailed>
  >();
  const loaded = new Map<string, NativePlugin>();
  return {
    load: (source) =>
      Effect.suspend(() => {
        const entry = source.plugin.native;
        if (entry === null)
          return Effect.fail(failure(source, 'it has no native entry'));
        const revision = revisionOf(source, entry);
        const known = loads.get(revision);
        if (known !== undefined) return known;
        return Effect.flatMap(
          Effect.cached(
            importEntry(source, entry, revision).pipe(
              Effect.tap((native) =>
                Effect.sync(() => loaded.set(revision, native)),
              ),
            ),
          ),
          (load) => {
            const raced = loads.get(revision) ?? load;
            loads.set(revision, raced);
            return raced;
          },
        );
      }),
    imported: (source) => {
      const entry = source.plugin.native;
      return entry === null ? undefined : loaded.get(revisionOf(source, entry));
    },
  };
};
