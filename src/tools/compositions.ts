/**
 * The process's open compositions: a `LayerMap` keyed by composition hash
 * (`@tools/composition`), one entry per composition some run has pinned.
 *
 * A run pins one composition for its lifetime (`resolveAgentTools`, in the
 * run's layer scope), and a delegated child joins its parent's instead of
 * resolving its own. An entry holds the process's plugin table restricted to
 * the composition's plugins, and the services of those plugins' layers (a
 * plugin that owns resources declares one; `@tools/registry` holds them).
 * A composition whose switches differ builds beside the one in use, and an
 * entry closes when the last run holding it ends: the map counts its
 * holders, with no idle retention.
 *
 * Every entry builds through the map's one `MemoMap`, and each plugin's
 * layer is one object for the life of the process, so a plugin layer that
 * two open compositions share is built once and released when the last of
 * them closes; a changed switch rebuilds only what it changed. A failed
 * build caches nothing, and its runs fail to open.
 *
 * A loaded plugin (an MCP server, `@tools/toolTable`) joins an entry the same
 * way: `load` records the latest resources for each spec it reads, one layer
 * object per spec and revision, so compositions naming the same server share
 * one process, and its tools join the entry's table once it is up. A plugin
 * that failed to start joins with no tools and its reason in `failures`.
 *
 * This module imports no tool, manifest or plugin layer: the table it reads
 * is the `ToolRegistry` service and the loaded plugins come from the loader
 * the process passes, so a reader of the tag loads none of them.
 */
import { createHash } from 'node:crypto';

import { Context, Effect, Equal, Hash, Layer, LayerMap, Scope } from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type { Composition } from '@tools/composition';
import {
  ToolRegistry,
  toolTable,
  type LoadedPlugin,
  type LoadedPluginTools,
  type PluginLoader,
  type ToolTable,
} from '@tools/toolTable';

/**
 * A composition and its hash: what a run pins, and a child joins. Equality is
 * the hash alone, which is sound because `compositionHash` is a sha256 over
 * the composition's canonical JSON: equal hashes mean equal compositions.
 */
export class CompositionKey implements Equal.Equal {
  constructor(
    readonly hash: string,
    readonly composition: Composition,
  ) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof CompositionKey && that.hash === this.hash;
  }

  [Hash.symbol](): number {
    return Hash.string(this.hash);
  }
}

/** An open composition, held for the pinning scope. */
export interface PinnedComposition {
  readonly key: CompositionKey;
  /** The process table restricted to the composition's plugins, with its
   *  loaded plugins' tools. */
  readonly table: ToolTable;
  /** Each loaded plugin that failed to start, by id: why it has no tools. */
  readonly failures: ReadonlyMap<string, string>;
  /**
   * The entry's services, its plugins' layers' among them, provided to each
   * of the run's tool calls. Typed as erased (see `PluginLayer`): a tool
   * reaches its plugin's service with `Effect.serviceOption` until the
   * first layered plugin widens the tool contract's requirements.
   */
  readonly services: Context.Context<never>;
}

/** The restricted table an entry holds, and its loaded plugins' failures. */
class CompositionTable extends Context.Service<
  CompositionTable,
  Pick<PinnedComposition, 'table' | 'failures'>
>()('@texra/tools/CompositionTable') {}

/** One spec's resources: the layer every entry naming it shares. */
interface LoadedEntry {
  readonly revision: string;
  readonly key: Context.Key<LoadedPluginTools, LoadedPluginTools>;
  readonly layer: Layer.Layer<LoadedPluginTools>;
}

const specKey = (plugin: Pick<LoadedPlugin, 'id' | 'spec'>): string =>
  `${plugin.id}#${createHash('sha256').update(stableStringify(plugin.spec)).digest('hex')}`;

export class Compositions extends Context.Service<
  Compositions,
  {
    /**
     * The loaded plugins `declared` names, with the configuration problems
     * the read found; each becomes the resources a pin of a composition
     * that records it builds.
     */
    readonly load: PluginLoader;
    /** Open (or join) `key`'s entry until the caller's scope closes. */
    readonly pin: (
      key: CompositionKey,
    ) => Effect.Effect<PinnedComposition, never, Scope.Scope>;
  }
>()('@texra/tools/Compositions') {}

/** The process's compositions, over its `ToolRegistry` table. */
const compositionsLayer = (
  loader: PluginLoader,
): Layer.Layer<Compositions, never, ToolRegistry> =>
  Layer.effect(
    Compositions,
    Effect.gen(function* () {
      const table = yield* ToolRegistry;
      // The latest resources of every spec a load has read, for the life of
      // the process: a pin builds from here, and a child joining its
      // parent's key finds the spec its parent loaded.
      const loadedEntries = new Map<string, LoadedEntry>();
      // Each layer's own service key: two revisions of one spec never share.
      let loadedSequence = 0;
      const load: PluginLoader = (declared) =>
        loader(declared).pipe(
          Effect.tap(({ plugins }) =>
            Effect.sync(() => {
              for (const plugin of plugins) {
                const id = specKey(plugin);
                if (loadedEntries.get(id)?.revision === plugin.revision)
                  continue;
                loadedSequence += 1;
                const key = Context.Service<LoadedPluginTools>(
                  `@texra/tools/LoadedPlugin/${loadedSequence}`,
                );
                loadedEntries.set(id, {
                  revision: plugin.revision,
                  key,
                  layer: Layer.effect(key)(plugin.acquire),
                });
              }
            }),
          ),
        );
      const map = yield* LayerMap.make((key: CompositionKey) => {
        const { plugins } = key.composition;
        const statics = Object.fromEntries(
          plugins.flatMap((id) => {
            const tools = table.plugins.get(id);
            return tools ? [[id, Object.fromEntries(tools)]] : [];
          }),
        );
        const loaded = key.composition.loaded.map((plugin) => ({
          id: plugin.id,
          entry: loadedEntries.get(specKey(plugin)),
        }));
        const tableLayer = Layer.effect(CompositionTable)(
          Effect.gen(function* () {
            const tools: Record<string, Record<string, ITool>> = {
              ...statics,
            };
            const failures = new Map<string, string>();
            for (const { id, entry } of loaded) {
              // `load` records every spec before a composition can name it,
              // so a spec it never read is a defect, not a missing plugin.
              if (!entry)
                return yield* Effect.die(
                  new Error(
                    `Composition ${key.hash} names loaded plugin ${id}, which no load recorded.`,
                  ),
                );
              const answered = yield* entry.key;
              tools[id] = Object.fromEntries(answered.tools);
              if (answered.failure !== undefined)
                failures.set(id, answered.failure);
            }
            return { table: toolTable(tools), failures };
          }),
        );
        return tableLayer.pipe(
          Layer.provideMerge(
            loaded.reduce<Layer.Layer<LoadedPluginTools>>(
              (merged, { entry }) =>
                entry ? Layer.merge(merged, entry.layer) : merged,
              Layer.empty as Layer.Layer<LoadedPluginTools>,
            ),
          ),
          Layer.provideMerge(
            plugins.reduce<Layer.Layer<never>>((merged, id) => {
              const layer = table.layers.get(id);
              return layer ? Layer.merge(merged, layer) : merged;
            }, Layer.empty),
          ),
        );
      });
      return {
        load,
        pin: (key) =>
          map.contextEffect(key).pipe(
            Effect.map((services) => ({
              key,
              ...Context.get(services, CompositionTable),
              services,
            })),
          ),
      };
    }),
  );

/** A loader for a process that loads no plugins from configuration. */
const noLoadedPlugins: PluginLoader = () =>
  Effect.succeed({ plugins: [], warnings: [] });

/**
 * `table` as the `ToolRegistry`, and the compositions built over it and the
 * plugins `loader` reads (none when omitted).
 */
export const toolTableLayer = (
  table: ToolTable,
  loader: PluginLoader = noLoadedPlugins,
): Layer.Layer<Compositions | ToolRegistry> =>
  compositionsLayer(loader).pipe(
    Layer.provideMerge(Layer.succeed(ToolRegistry)(table)),
  );
