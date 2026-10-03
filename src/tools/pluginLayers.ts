/**
 * Plugin layers: the services a plugin owns at process lifetime
 * (a plugin's `processLayer`, built by the live catalog, `@tools/liveTools`)
 * and at session lifetime (its `sessionLayer`, built per session here).
 * Either is up while its plugin is switched on or a step pins it, and its
 * services reach a tool or continuation only through that step.
 */
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

import { Runs, type RunRegistry } from '@agent/runtime/runRegistry';
import { withLogChannel } from '@logger/effectLog';
import type { PluginContext } from '@platform/processRuntime';
import type { LiveTools } from '@tools/liveTools';
import { PluginHold, ToolRegistry } from '@tools/toolTable';

/**
 * A plugin layer built in the caller's scope, its services typed as the
 * plugin services it serves (a plugin's layer serves its own tools), and its
 * coming up and going down logged where the step that caused it is.
 */
export const buildPluginLayer = <R>(
  plugin: string,
  layer: Layer.Layer<never, never, R>,
): Effect.Effect<PluginContext, never, Scope.Scope | R> =>
  Effect.acquireRelease(Effect.logDebug(`Plugin ${plugin}: services up.`), () =>
    Effect.logDebug(`Plugin ${plugin}: services down.`),
  ).pipe(
    Effect.andThen(Layer.build(layer)),
    Effect.map((services) => services as PluginContext),
    withLogChannel('PluginLayers'),
  );

/**
 * One session's plugin layers (the table's), built in the caller's scope, the
 * session's, over the session's `Runs`. The pin it answers reconciles the session's
 * standing builds with the plugins a step found switched on (each on plugin
 * holds its build, an off one lets go) and pins the services of the ones
 * the step uses for its scope, so a plugin switched off keeps its services until the
 * last step that pinned them, and the last work holding them
 * (`PluginHold`), releases.
 */
export const sessionPluginLayers = Effect.fnUntraced(function* (
  runs: () => RunRegistry,
) {
  const layers = (yield* ToolRegistry).sessionLayers;
  const scope = yield* Effect.scope;
  // A hold on one plugin's build, taken now, released when `until` ends (or
  // the session closes).
  const holdFor =
    (id: string) =>
    (until: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const hold = yield* Scope.fork(scope);
        yield* RcMap.get(built, id).pipe(Scope.provide(hold));
        yield* until.pipe(
          Effect.ensuring(Scope.close(hold, Exit.void)),
          Effect.forkIn(scope),
        );
      });
  const built: RcMap.RcMap<string, PluginContext> = yield* RcMap.make({
    lookup: (id: string) =>
      buildPluginLayer(id, layers.get(id)!).pipe(
        Effect.provideService(Runs, runs()),
        Effect.provideService(PluginHold, holdFor(id)),
      ),
  });
  const standing = new Map<string, Scope.Closeable>();
  // The newest catalog generation the standing builds were reconciled with:
  // a step that pinned an older one (its switch read predates a newer
  // step's) pins what it uses but never restores a standing build.
  let applied = 0;
  const lock = yield* Semaphore.make(1);
  return (
    generation: number,
    on: ReadonlySet<string>,
    used: ReadonlySet<string>,
  ) =>
    lock.withPermits(1)(
      // Only the builds are interruptible: the standing map and its scopes
      // never fall out of step, and a cancelled step is not held behind a
      // slow plugin layer.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = generation >= applied;
          if (current) applied = generation;
          for (const id of current ? layers.keys() : []) {
            const held = standing.get(id);
            if (on.has(id) && held === undefined) {
              const hold = yield* Scope.fork(scope);
              yield* restore(
                RcMap.get(built, id).pipe(Scope.provide(hold)),
              ).pipe(
                // Any exit but success, an interrupt of the build included.
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : Scope.close(hold, Exit.void),
                ),
              );
              standing.set(id, hold);
            } else if (!on.has(id) && held !== undefined) {
              standing.delete(id);
              yield* Scope.close(held, Exit.void);
            }
          }
          return yield* Effect.reduce(
            [...used].filter((id) => on.has(id) && layers.has(id)),
            () => Context.empty() as PluginContext,
            (merged, id) =>
              Effect.map(restore(RcMap.get(built, id)), (services) =>
                Context.merge(merged, services),
              ),
          );
        }),
      ),
    );
});

/**
 * The core shutdown protocol's plugin step, before the sessions close: the
 * `drain` of every plugin whose process layer is up, switched on or only
 * pinned by a step (what it admitted for a session, such as a poll round's
 * delivery), while its services are still up.
 */
export const drainPlugins = Effect.fnUntraced(function* (
  live: LiveTools['Service'],
) {
  const layers = (yield* ToolRegistry).processLayers;
  yield* Effect.forEach(
    [...layers].filter(([, entry]) => entry.drain),
    ([id, entry]) =>
      Effect.flatMap(live.processServices(id), (services) =>
        Option.isSome(services)
          ? Effect.provide(entry.drain!, services.value)
          : Effect.void,
      ),
    { concurrency: 'unbounded', discard: true },
  ).pipe(Effect.scoped);
});
