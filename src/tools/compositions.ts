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
 * This module imports no tool, manifest or plugin layer: the table it reads
 * is the `ToolRegistry` service, so a reader of the tag loads none of them.
 */
import { Context, Effect, Equal, Hash, Layer, LayerMap, Scope } from 'effect';

import type { Composition } from '@tools/composition';
import { ToolRegistry, toolTable, type ToolTable } from '@tools/toolTable';

/** A composition and its hash: what a run pins, and a child joins. */
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
  /** The process table restricted to the composition's plugins. */
  readonly table: ToolTable;
  /** The entry's services, its plugins' layers' among them. */
  readonly services: Context.Context<never>;
}

/** The restricted table an entry holds. */
class CompositionTable extends Context.Service<CompositionTable, ToolTable>()(
  '@texra/tools/CompositionTable',
) {}

export class Compositions extends Context.Service<
  Compositions,
  {
    /** Open (or join) `key`'s entry until the caller's scope closes. */
    readonly pin: (
      key: CompositionKey,
    ) => Effect.Effect<PinnedComposition, never, Scope.Scope>;
  }
>()('@texra/tools/Compositions') {}

/** The process's compositions, over its `ToolRegistry` table. */
const compositionsLayer: Layer.Layer<Compositions, never, ToolRegistry> =
  Layer.effect(
    Compositions,
    Effect.gen(function* () {
      const table = yield* ToolRegistry;
      const map = yield* LayerMap.make((key: CompositionKey) => {
        const { plugins } = key.composition;
        const restricted = toolTable(
          Object.fromEntries(
            plugins.flatMap((id) => {
              const tools = table.plugins.get(id);
              return tools ? [[id, Object.fromEntries(tools)]] : [];
            }),
          ),
        );
        return Layer.succeed(CompositionTable)(restricted).pipe(
          Layer.provideMerge(
            plugins.reduce<Layer.Layer<never>>((merged, id) => {
              const layer = table.layers.get(id);
              return layer ? Layer.merge(merged, layer) : merged;
            }, Layer.empty),
          ),
        );
      });
      return {
        pin: (key) =>
          map.contextEffect(key).pipe(
            Effect.map((services) => ({
              key,
              table: Context.get(services, CompositionTable),
              services,
            })),
          ),
      };
    }),
  );

/** `table` as the `ToolRegistry`, and the compositions built over it. */
export const toolTableLayer = (
  table: ToolTable,
): Layer.Layer<Compositions | ToolRegistry> =>
  compositionsLayer.pipe(
    Layer.provideMerge(Layer.succeed(ToolRegistry)(table)),
  );
