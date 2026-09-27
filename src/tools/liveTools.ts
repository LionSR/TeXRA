/**
 * The process's live tool catalog: a `Registry` (`@tools/liveRegistry`) of
 * every tool some plugin currently contributes, keyed by tool name, and a
 * second of every continuation, keyed by the agent category it serves, and
 * a third of every prompt contribution, keyed by its plugin.
 *
 * - **Built-in plugins** contribute their manifest table while their switch
 *   is on, and their continuation and prompt contribution with them.
 *   `pinSwitched` reads the user's switches, reconciles the contributions
 *   with them and pins the generations that produces, as one serialized
 *   step: a plugin switched off withdraws all three, one switched on
 *   contributes them again. A run's step opens through it
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

import { Context, Effect, Exit, Layer, RcMap, Scope, Semaphore } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import stableStringify from 'safe-stable-stringify';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { toolDefinitionsFor } from '@agent/runtime/run/tools';
import type { AgentCategory } from '@shared/schemas';
import {
  makeRegistry,
  type Generation,
  type Pinned,
  type Registry,
} from '@tools/liveRegistry';
import {
  ToolRegistry,
  type Continuation,
  type LoadedPlugin,
  type PluginLoader,
  type PromptContribution,
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
   *  of its env values' keyed digest (`LoadedPlugin.revision`, keyed per
   *  install), so the same entry records the same revision across restarts
   *  and an edited one records a change, and no value can be read back. */
  readonly revision: string;
  /** The loaded server process the tool dispatches through, by its hold
   *  key; never recorded. A pinned generation holds each such process, so
   *  nothing it can dispatch to stops before its pin closes. */
  readonly server?: string;
  /** The tool's identity: sha256 over its name and input schema, every
   *  description left out. A call runs only while its tool still has it. */
  readonly digest: string;
  /** sha256 over the catalog's definition, descriptions included: a
   *  reworded tool is a new generation. What a step records as shown is the
   *  definition it sends (`resolveStepTools`). */
  readonly shown: string;
}

export type ToolGeneration = Generation<string, ToolEntry>;

/** A continuation in the catalog, with the plugin that contributes it. */
export interface ContinuationEntry {
  readonly plugin: string;
  readonly continuation: Continuation;
}

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
     * on, and pin the tool, continuation and prompt generations that produces, as
     * one serialized step: a concurrent step's older read never reverts the
     * catalog under it, and no step pins a generation built from switches
     * it did not read.
     */
    readonly pinSwitched: <E>(
      off: Effect.Effect<ReadonlySet<string>, E>,
    ) => Effect.Effect<
      Pinned<string, ToolEntry, Context.Context<never>> & {
        readonly continuations: Generation<AgentCategory, ContinuationEntry>;
        /** Each switched-on plugin's prompt contribution, by plugin id. */
        readonly sections: Generation<string, PromptContribution>;
      },
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
  loaded?: { readonly revision: string; readonly server: string },
): ReadonlyMap<string, ToolEntry> =>
  new Map(
    [...tools].map(([name, tool]) => [
      name,
      { tool, plugin, revision: 'builtin', ...loaded, ...toolDigests(tool) },
    ]),
  );

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
      // Each held server process by hold key, with its count of holds (runs
      // and pins). Read and written only under the catalog's lock.
      const servers = new Map<
        string,
        {
          count: number;
          readonly scope: Scope.Closeable;
          readonly failure: string | undefined;
        }
      >();
      // Each built-in plugin's open contribution, by id: its scope closes
      // when the plugin is switched off. Read and written only under the
      // catalog's lock.
      const builtIns = new Map<string, Scope.Closeable>();
      // The catalog's lock. What runs under it is short and uninterruptible,
      // so a cancelled step never leaves a scope opened or closed without
      // the maps that track it saying so.
      const lock = yield* Semaphore.make(1);
      const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        lock.withPermits(1)(Effect.uninterruptible(effect));
      /** Drop one hold of a server; the last withdraws its tools and stops
       *  its process. */
      const release = (id: string) =>
        locked(
          Effect.gen(function* () {
            const open = servers.get(id)!;
            open.count -= 1;
            if (open.count > 0) return;
            servers.delete(id);
            yield* Scope.close(open.scope, Exit.void);
          }),
        );
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
          Effect.andThen(
            // The server processes the generation dispatches through, held
            // for the pin. Pins are taken only under the catalog's lock
            // (`pinSwitched`), where a server in `current` is still up.
            Effect.forEach(
              new Set(
                [...generation.entries.values()].flatMap(
                  (entry) => entry.server ?? [],
                ),
              ),
              (server) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    servers.get(server)!.count += 1;
                  }),
                  () => release(server),
                ),
              { discard: true },
            ),
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
          ),
      });

      // Each built-in plugin's continuation, by category; it holds nothing.
      const continuations = yield* makeRegistry<
        AgentCategory,
        ContinuationEntry,
        void
      >({
        digest: (entries) =>
          sha256(
            [...entries]
              .map(([category, { plugin }]) => [category, plugin])
              .toSorted(([a], [b]) => Number(a > b) - Number(a < b)),
          ),
        acquire: () => Effect.void,
      });
      // Each built-in plugin's prompt contribution, by plugin id.
      const sections = yield* makeRegistry<string, PromptContribution, void>({
        digest: (entries) => sha256([...entries.keys()].toSorted()),
        acquire: () => Effect.void,
      });

      /** Open and close the built-in contributions (a plugin's tools,
       *  continuation and prompt contribution, in one scope) to match
       *  `off`. */
      const reconcile = (off: ReadonlySet<string>) =>
        Effect.gen(function* () {
          for (const id of new Set([
            ...table.plugins.keys(),
            ...table.continuations.keys(),
            ...table.prompt.keys(),
          ])) {
            const on = !off.has(id);
            const held = builtIns.get(id);
            if (on && held === undefined) {
              const contribution = yield* Scope.fork(scope);
              const continuation = table.continuations.get(id);
              const prompt = table.prompt.get(id);
              // The manifest rules out a name two plugins share, so a
              // conflict between built-in plugins is a defect.
              yield* Effect.all([
                registry.contribute(
                  id,
                  entriesOf(id, table.plugins.get(id) ?? new Map()),
                ),
                continuations.contribute(
                  id,
                  new Map(
                    continuation === undefined
                      ? []
                      : [[continuation.category, { plugin: id, continuation }]],
                  ),
                ),
                sections.contribute(
                  id,
                  new Map(prompt === undefined ? [] : [[id, prompt]]),
                ),
              ]).pipe(Scope.provide(contribution), Effect.orDie);
              builtIns.set(id, contribution);
            } else if (!on && held !== undefined) {
              builtIns.delete(id);
              yield* Scope.close(held, Exit.void);
            }
          }
        });
      yield* locked(reconcile(new Set()));
      const pinSwitched = <E>(off: Effect.Effect<ReadonlySet<string>, E>) =>
        locked(
          Effect.gen(function* () {
            yield* reconcile(yield* off);
            const { generation } = yield* continuations.pin;
            const pinned = yield* sections.pin;
            return {
              ...(yield* registry.pin),
              continuations: generation,
              sections: pinned.generation,
            };
          }),
        );

      /** Hold a loaded plugin's server: the process it runs, its tools'
       *  contribution while it runs, or why it offers none. */
      const acquireServer = (plugin: LoadedPlugin) =>
        Effect.gen(function* () {
          const id = `${plugin.id}#${sha256(plugin.spec)}#${plugin.revision}`;
          const held = yield* locked(
            Effect.sync(() => {
              const open = servers.get(id);
              if (open) open.count += 1;
              return open;
            }),
          );
          if (held) return { id, failure: held.failure };
          // Started outside the lock: a slow server does not hold up every
          // run's step. A concurrent hold of the same key keeps the first.
          const serverScope = yield* Scope.fork(scope);
          const answered = yield* plugin.acquire.pipe(
            Effect.provideService(ChildProcessSpawner, spawner),
            Scope.provide(serverScope),
          );
          const failure = yield* locked(
            Effect.gen(function* () {
              const open = servers.get(id);
              if (open) {
                open.count += 1;
                yield* Scope.close(serverScope, Exit.void);
                return open.failure;
              }
              const failure =
                answered.failure ??
                (yield* registry
                  .contribute(
                    plugin.id,
                    entriesOf(plugin.id, answered.tools, {
                      revision: sha256({
                        spec: plugin.spec,
                        env: plugin.revision,
                      }),
                      server: id,
                    }),
                  )
                  .pipe(
                    Scope.provide(serverScope),
                    Effect.as(undefined),
                    Effect.catchTag('RegistryConflict', (conflict) =>
                      Effect.succeed(
                        `${plugin.id} was not loaded: ${conflict.message}`,
                      ),
                    ),
                  ));
              servers.set(id, { count: 1, scope: serverScope, failure });
              return failure;
            }),
          );
          return { id, failure };
        });
      const hold = Effect.fn('LiveTools.hold')(function* (
        declared: readonly string[],
      ) {
        const read = yield* loader(declared);
        const loaded = new Map<string, string | undefined>();
        for (const plugin of read.plugins) {
          const { failure } = yield* Effect.acquireRelease(
            acquireServer(plugin),
            ({ id }) => release(id),
          );
          loaded.set(plugin.id, failure);
        }
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
