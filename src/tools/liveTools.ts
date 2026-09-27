/**
 * The process's live tool catalog: a `Registry` (`@tools/liveRegistry`) of
 * every tool some plugin currently contributes, keyed by tool name.
 *
 * - **Built-in plugins** contribute their manifest table while their switch
 *   is on. `pinSwitched` reads the user's switches, reconciles the
 *   contributions with them and pins the generation that produces, as one
 *   serialized step: a plugin switched off withdraws its tools, one switched
 *   on contributes them again. A run's step opens through it
 *   (`@agent/runtime/loop/step`), so a switch flipped by any host, or by
 *   `texra tools` from another shell, reaches every open run at its next
 *   step.
 * - **Loaded plugins** (MCP servers, `@tools/toolTable`) contribute the tools
 *   their server listed while some run holds them (`hold`). Holds are
 *   counted per spec and keyed env revision, so runs naming the same server
 *   share one process, which stops with the last hold. An edited server's
 *   new process supersedes the older one in the catalog while both run, and
 *   its recorded revision differs, so a run moved onto it records the move.
 * - **Plugin layers** are built once per plugin while any pinned generation
 *   holds it, and released with the last one.
 *
 * Each entry carries its identity, the digest of its name and input schema
 * with its plugin's id and revision, which a call is checked against before
 * it runs.
 */
import { createHash } from 'node:crypto';

import {
  Context,
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  RcMap,
  Scope,
  SynchronizedRef,
} from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import stableStringify from 'safe-stable-stringify';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { toolDefinitionsFor } from '@agent/runtime/run/tools';
import {
  makeRegistry,
  type Generation,
  type Pinned,
  type Registry,
} from '@tools/liveRegistry';
import {
  ToolRegistry,
  type LoadedPlugin,
  type PluginLoader,
  type ToolTable,
} from '@tools/toolTable';
import { isObject } from '@utils/core';

/** One tool in the catalog, with the identity a step records. */
export interface ToolEntry {
  readonly tool: ITool;
  /** The contributing plugin's id. */
  readonly plugin: string;
  /** The plugin's revision, which rows record. `builtin` for a built-in
   *  plugin, whose code cannot change under a process: each tool's digest
   *  covers its own schema. A loaded plugin's is a digest of its spec and
   *  of which env-value edit this process runs (`envEdit`), never of the
   *  values themselves, so a run moved onto an edited server records it. */
  readonly revision: string;
  /** The tool's identity: sha256 over its name and input schema, every
   *  description left out. A call runs only while its tool still has it. */
  readonly digest: string;
  /** sha256 over the catalog's definition, descriptions included: a
   *  reworded tool is a new generation. What a step records as shown is the
   *  definition it sends (`resolveStepTools`). */
  readonly shown: string;
}

export type ToolGeneration = Generation<string, ToolEntry>;

/** What a hold found for each loaded plugin the declarations name. */
export interface HeldPlugins {
  /** The configuration problems the read found. */
  readonly warnings: readonly string[];
  /** Each configured plugin by id, with why it offers no tools, if so. */
  readonly loaded: ReadonlyMap<string, string | undefined>;
}

export class LiveTools extends Context.Service<
  LiveTools,
  {
    readonly registry: Registry<string, ToolEntry, Context.Context<never>>;
    /**
     * Read the switches, contribute exactly the built-in plugins they leave
     * on, and pin the generation that produces, as one serialized step: a
     * concurrent step's older read never reverts the catalog under it, and
     * no step pins a generation built from switches it did not read.
     */
    readonly pinSwitched: <E>(
      off: Effect.Effect<ReadonlySet<string>, E>,
    ) => Effect.Effect<
      Pinned<string, ToolEntry, Context.Context<never>>,
      E,
      Scope.Scope
    >;
    /** Hold the loaded plugins `declared` names until the caller's scope
     *  closes; their tools are in the catalog while held. */
    readonly hold: (
      declared: readonly string[],
    ) => Effect.Effect<HeldPlugins, never, Scope.Scope>;
  }
>()('@texra/tools/LiveTools') {}

const sha256 = (value: unknown): string =>
  createHash('sha256')
    .update(stableStringify(value) ?? '')
    .digest('hex');

/** Keywords whose value is one schema, or an array of schemas. */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'prefixItems',
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'contentSchema',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'anyOf',
  'oneOf',
  'allOf',
]);

/** Keywords whose value maps a name to a schema: keys are data, kept as is. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);

/**
 * A JSON Schema node with the `description` keyword dropped at every schema
 * position. It walks keywords, not keys: a property named `description` is a
 * name in a `properties` map and stays, and `enum`/`const`/`default` values
 * are data and are not entered.
 */
function withoutSchemaDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutSchemaDescriptions);
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'description') continue;
    if (SUBSCHEMA_KEYWORDS.has(keyword)) {
      out[keyword] = withoutSchemaDescriptions(value);
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          withoutSchemaDescriptions(schema),
        ]),
      );
    } else {
      out[keyword] = value;
    }
  }
  return out;
}

/**
 * A tool's identity digest and the digest of its definition as a request
 * carries it. The identity is the name and input schema only: a description,
 * the tool's own or a schema node's, can change without invalidating a call
 * the model already made.
 */
export const toolDigests = (
  tool: Pick<ITool, 'definition'>,
): { readonly digest: string; readonly shown: string } => {
  const [definition] = toolDefinitionsFor([tool.definition]);
  return {
    digest: sha256({
      name: definition!.name,
      parameters: withoutSchemaDescriptions(definition!.parameters),
    }),
    shown: sha256(definition),
  };
};

/** A plugin's tools as catalog entries under one revision. */
const entriesOf = (
  plugin: string,
  tools: ReadonlyMap<string, ITool>,
  revision = 'builtin',
): ReadonlyMap<string, ToolEntry> =>
  new Map(
    [...tools].map(([name, tool]) => [
      name,
      { tool, plugin, revision, ...toolDigests(tool) },
    ]),
  );

/** One spec revision of a loaded plugin: the key its holds are counted by. */
class LoadedKey implements Equal.Equal {
  readonly id: string;
  constructor(readonly plugin: LoadedPlugin) {
    this.id = `${plugin.id}#${sha256(plugin.spec)}#${plugin.revision}`;
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof LoadedKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

const liveToolsLayer = (
  loader: PluginLoader,
): Layer.Layer<LiveTools, never, ToolRegistry | ChildProcessSpawner> =>
  Layer.effect(
    LiveTools,
    Effect.gen(function* () {
      const table: ToolTable = yield* ToolRegistry;
      const spawner = yield* ChildProcessSpawner;
      const scope = yield* Effect.scope;
      // Each plugin's layer, built once while any pinned generation holds
      // the plugin, in the map entry's own scope: it outlives every
      // generation that shares it and is released with the last.
      const layers = yield* RcMap.make({
        lookup: (id: string) =>
          Layer.build(table.layers.get(id) ?? Layer.empty),
      });
      const registry = yield* makeRegistry<
        string,
        ToolEntry,
        Context.Context<never>
      >({
        digest: (entries) =>
          sha256(
            [...entries]
              .map(([name, e]) => [
                name,
                e.digest,
                e.shown,
                e.plugin,
                e.revision,
              ])
              .toSorted(([a], [b]) => Number(a > b) - Number(a < b)),
          ),
        acquire: (generation) =>
          Effect.reduce(
            [...new Set(generation.owners.values())].filter((id) =>
              table.layers.has(id),
            ),
            () => Context.empty(),
            (merged, id) =>
              Effect.map(RcMap.get(layers, id), (services) =>
                Context.merge(merged, services),
              ),
          ),
      });

      // Each built-in plugin's open contribution, by id: its scope closes
      // when the plugin is switched off.
      const builtIns = yield* SynchronizedRef.make(
        new Map<string, Scope.Closeable>(),
      );
      /** Open and close the built-in contributions to match `off`. */
      const reconcile = (
        open: ReadonlyMap<string, Scope.Closeable>,
        off: ReadonlySet<string>,
      ) =>
        Effect.gen(function* () {
          const next = new Map(open);
          for (const [id, tools] of table.plugins) {
            const on = !off.has(id);
            const held = next.get(id);
            if (on && held === undefined) {
              const contribution = yield* Scope.fork(scope);
              // The manifest rules out a name two plugins share, so a
              // conflict between built-in plugins is a defect.
              yield* registry
                .contribute(id, entriesOf(id, tools))
                .pipe(Scope.provide(contribution), Effect.orDie);
              next.set(id, contribution);
            } else if (!on && held !== undefined) {
              yield* Scope.close(held, Exit.void);
              next.delete(id);
            }
          }
          return next;
        });
      yield* SynchronizedRef.updateEffect(builtIns, (open) =>
        reconcile(open, new Set()),
      );
      const pinSwitched = <E>(off: Effect.Effect<ReadonlySet<string>, E>) =>
        SynchronizedRef.modifyEffect(builtIns, (open) =>
          Effect.gen(function* () {
            const next = yield* reconcile(open, yield* off);
            return [yield* registry.pin, next] as const;
          }),
        );

      // Per spec digest, each keyed env revision's ordinal.
      const envEdits = new Map<string, Map<string, number>>();
      const servers = yield* RcMap.make({
        lookup: (key: LoadedKey) =>
          Effect.gen(function* () {
            const answered = yield* key.plugin.acquire.pipe(
              Effect.provideService(ChildProcessSpawner, spawner),
            );
            if (answered.failure !== undefined) return answered.failure;
            // The recorded revision: the spec, and which env-value edit of
            // it this is, counted in the order this process met them.
            const spec = sha256(key.plugin.spec);
            const seen = envEdits.get(spec) ?? new Map<string, number>();
            envEdits.set(spec, seen);
            const envEdit = seen.get(key.plugin.revision) ?? seen.size;
            seen.set(key.plugin.revision, envEdit);
            // Withdrawn when the last hold of this revision closes.
            return yield* registry
              .contribute(
                key.plugin.id,
                entriesOf(
                  key.plugin.id,
                  answered.tools,
                  sha256({ spec: key.plugin.spec, envEdit }),
                ),
              )
              .pipe(
                Effect.as(undefined),
                Effect.catchTag('RegistryConflict', (conflict) =>
                  Effect.succeed(
                    `${key.plugin.id} was not loaded: ${conflict.message}`,
                  ),
                ),
              );
          }),
      });
      const hold = Effect.fn('LiveTools.hold')(function* (
        declared: readonly string[],
      ) {
        const read = yield* loader(declared);
        const loaded = new Map<string, string | undefined>();
        for (const plugin of read.plugins)
          loaded.set(
            plugin.id,
            yield* RcMap.get(servers, new LoadedKey(plugin)),
          );
        return { warnings: read.warnings, loaded };
      });
      return { registry, pinSwitched, hold };
    }),
  );

/** A loader for a process that loads no plugins from configuration. */
const noLoadedPlugins: PluginLoader = () =>
  Effect.succeed({ plugins: [], warnings: [] });

/**
 * `table` as the `ToolRegistry`, and the live catalog over it and the
 * plugins `loader` reads (none when omitted).
 */
export const toolTableLayer = (
  table: ToolTable,
  loader: PluginLoader = noLoadedPlugins,
): Layer.Layer<LiveTools | ToolRegistry, never, ChildProcessSpawner> =>
  liveToolsLayer(loader).pipe(
    Layer.provideMerge(Layer.succeed(ToolRegistry)(table)),
  );
