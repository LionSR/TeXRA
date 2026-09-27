/**
 * The process's live tool catalog: `Registry`s (`@tools/liveRegistry`) of
 * every tool some plugin contributes (by tool name), every continuation (by
 * agent category) and every prompt contribution (by plugin).
 *
 * - **Built-in plugins** contribute all three while their switch is on.
 *   `pinSwitched` reads the switches, reconciles the contributions with them
 *   and pins the generations that produces, as one serialized step. A run's
 *   step opens through it (`@agent/runtime/loop/step`), so a switch flipped
 *   by any host, or by `texra tools` from another shell, reaches every open
 *   run at its next step.
 * - **Loaded plugins** (MCP servers, `@tools/toolTable`) contribute the tools
 *   their server listed while some run holds them (`hold`), counted per spec
 *   and keyed env revision: runs naming the same server share one process,
 *   which stops with the last hold, and an edited server's new process
 *   supersedes the older one and records a new revision.
 * - **Plugin layers** (`PLUGIN_PROCESS_LAYERS`) are up while their plugin is
 *   on or a pinned generation holds it (`@tools/pluginLayers` builds a
 *   session's `PLUGIN_SESSION_LAYERS` by the same rule).
 *
 * Each entry carries its identity (the digest of its name and input schema,
 * its plugin's id and revision), which a call is checked against.
 */
import { createHash } from 'node:crypto';

import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  RcMap,
  Scope,
  Semaphore,
} from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import stableStringify from 'safe-stable-stringify';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { toolDefinitionsFor } from '@agent/runtime/run/tools';
import type { PluginServices } from '@platform/processRuntime';
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
import { buildPluginLayer } from '@tools/pluginLayers';
import { isObject } from '@utils/core';

/** One tool in the catalog, with the identity a step records. */
export interface ToolEntry {
  readonly tool: ITool;
  /** The contributing plugin's id. */
  readonly plugin: string;
  /** The plugin's revision, which rows record: `builtin` for a built-in
   *  plugin (each tool's digest covers its schema); for a loaded one a
   *  digest of its spec and of its env values' keyed digest, stable across
   *  restarts, changed by an edit, and unreadable back to a value. */
  readonly revision: string;
  /** The loaded server process it dispatches through, by hold key; never
   *  recorded. A pinned generation holds each such process. */
  readonly server?: string;
  /** The tool's identity: sha256 over its name and input schema, every
   *  description left out. A call runs only while its tool still has it. */
  readonly digest: string;
  /** sha256 over the catalog's definition, descriptions included: a
   *  reworded tool is a new generation (a step records what it sends). */
  readonly shown: string;
}

export type ToolGeneration = Generation<string, ToolEntry>;

/** A continuation in the catalog, with the plugin that contributes it. */
export interface ContinuationEntry {
  readonly plugin: string;
  readonly continuation: Continuation;
}

/** What a hold found: the configuration problems the read found, and each
 *  configured plugin by id with why it offers no tools, if so. */
export interface HeldPlugins {
  readonly warnings: readonly string[];
  readonly loaded: ReadonlyMap<string, string | undefined>;
}

/** The services a pin serves: its plugins' layers'. */
type Services = Context.Context<PluginServices>;

export class LiveTools extends Context.Service<
  LiveTools,
  {
    readonly registry: Registry<string, ToolEntry, Services>;
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
      Pinned<string, ToolEntry, Services> & {
        readonly continuations: Generation<AgentCategory, ContinuationEntry>;
        /** Each switched-on plugin's prompt contribution, by plugin id. */
        readonly sections: Generation<string, PromptContribution>;
      },
      E,
      Scope.Scope
    >;
    /** A switched-on plugin's process services for the caller's scope, for
     *  a host that shows, ends or drains its state (none while it is off). */
    readonly processServices: (
      plugin: string,
    ) => Effect.Effect<Option.Option<Services>, never, Scope.Scope>;
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
 * A JSON Schema node with `description` dropped at every schema position. It
 * walks keywords, not keys: a property named `description` stays, and
 * `enum`/`const`/`default` values are data and are not entered.
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
 * A tool's identity digest (its name and input schema only, so a reworded
 * description never invalidates a call the model already made) and the
 * digest of its definition as a request carries it.
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
  closed: ReadonlySet<string>,
): Layer.Layer<LiveTools, never, ToolRegistry | ChildProcessSpawner> =>
  Layer.effect(
    LiveTools,
    Effect.gen(function* () {
      const table: ToolTable = yield* ToolRegistry;
      const spawner = yield* ChildProcessSpawner;
      const scope = yield* Effect.scope;
      // Each plugin's process layer, in its map entry's scope: its switch and
      // each generation that includes it hold a reference. It may read this
      // catalog (Copilot's tools follow it), built by then.
      const self: { service?: LiveTools['Service'] } = {};
      const layers = yield* RcMap.make({
        lookup: (id: string) =>
          buildPluginLayer(id, table.processLayers.get(id)!.layer).pipe(
            Effect.provideService(LiveTools, self.service!),
          ),
      });
      // Each held server process by hold key, with its hold count (runs and
      // pins). Read and written only under the catalog's lock, as is:
      const servers = new Map<
        string,
        {
          count: number;
          readonly scope: Scope.Closeable;
          readonly failure: string | undefined;
        }
      >();
      // each built-in plugin's open contribution, closed when switched off.
      const builtIns = new Map<string, Scope.Closeable>();
      // The catalog's lock: what runs under it is short and uninterruptible,
      // so a cancelled step never leaves a scope and its map out of step.
      const lock = yield* Semaphore.make(1);
      const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        lock.withPermits(1)(Effect.uninterruptible(effect));
      /** Drop one hold of a server; the last withdraws it and stops it. */
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
      const registry = yield* makeRegistry<string, ToolEntry, Services>({
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
                table.processLayers.has(id),
              ),
              () => Context.empty() as Services,
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
       *  continuation, prompt contribution and process layer, in one
       *  scope) to match `off`. */
      const reconcile = (off: ReadonlySet<string>) =>
        Effect.gen(function* () {
          for (const id of new Set([
            ...table.plugins.keys(),
            ...table.continuations.keys(),
            ...table.prompt.keys(),
            ...table.processLayers.keys(),
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
              // The switch's own hold on the plugin's process services.
              if (table.processLayers.has(id))
                yield* RcMap.get(layers, id).pipe(Scope.provide(contribution));
              builtIns.set(id, contribution);
            } else if (!on && held !== undefined) {
              builtIns.delete(id);
              yield* Scope.close(held, Exit.void);
            }
          }
        });
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
      const processServices = (id: string) =>
        locked(
          builtIns.has(id) && table.processLayers.has(id)
            ? Effect.map(RcMap.get(layers, id), Option.some)
            : Effect.succeed(Option.none()),
        );
      self.service = { registry, pinSwitched, hold, processServices };
      yield* locked(reconcile(closed));
      return self.service;
    }),
  );

/** Loads no plugins from configuration. */
const noLoadedPlugins: PluginLoader = () =>
  Effect.succeed({ plugins: [], warnings: [] });

/**
 * `table` as the `ToolRegistry`, and the live catalog over it and the
 * plugins `loader` reads (none when omitted), holding the `closed` plugins
 * off until a step or a caller first applies the switches.
 */
export const toolTableLayer = (
  table: ToolTable,
  loader: PluginLoader = noLoadedPlugins,
  closed: ReadonlySet<string> = new Set(),
): Layer.Layer<LiveTools | ToolRegistry, never, ChildProcessSpawner> =>
  liveToolsLayer(loader, closed).pipe(
    Layer.provideMerge(Layer.succeed(ToolRegistry)(table)),
  );
