/**
 * The server processes the live tool catalog (`@tools/liveTools`) holds:
 * each MCP server by hold key (its plugin, spec and env revision) with a
 * count of what holds it, the runs that name it, the installed plugin that
 * loaded it and the generations that pinned its tools. The last hold to go
 * stops it. Every count changes under the catalog's lock.
 */
// Third-party imports
import { Effect, Exit, Scope } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

// Local imports - agent runtime
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import type { LoadablePlugin } from '@common/plugins/pluginTrust';
import { entriesOf, sha256, type ToolEntry } from '@tools/catalogEntries';
import type { Generation, Registry } from '@tools/liveRegistry';
import type { InstalledToolPlugin, LoadedPlugin } from '@tools/toolTable';

/** An installed plugin loaded at a key: its servers' tools, which enter the
 *  catalog only when the load is accepted (`publish`), its contribution,
 *  which closes under the catalog's lock, and its server holds, which close
 *  after it (a release takes the lock). */
export interface InstalledLoad {
  readonly id: string;
  readonly key: string;
  readonly source: LoadablePlugin;
  readonly entries: ReadonlyMap<string, ToolEntry>;
  readonly contribution: Scope.Closeable;
  readonly holds: Scope.Closeable;
  /** Why a server offers no tools, or the plugin was not loaded. */
  readonly failures: readonly string[];
}

/** The catalog's holds over its server processes, in the catalog's scope. */
export function makeServerHolds(catalog: {
  readonly scope: Scope.Scope;
  readonly spawner: ChildProcessSpawner['Service'];
  readonly locked: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** The tool registry, read when a server first contributes. */
  readonly registry: () => Registry<string, ToolEntry, void>;
}) {
  const { scope, spawner, locked } = catalog;
  const servers = new Map<
    string,
    {
      count: number;
      readonly scope: Scope.Closeable;
      readonly tools: ReadonlyMap<string, ITool>;
      readonly failure: string | undefined;
    }
  >();
  const contribute = (
    owner: string,
    entries: ReadonlyMap<string, ToolEntry>,
    into: Scope.Scope,
  ) =>
    catalog
      .registry()
      .contribute(owner, entries)
      .pipe(
        Scope.provide(into),
        Effect.as(undefined),
        Effect.catchTag('RegistryConflict', (conflict) =>
          Effect.succeed(`${owner} was not loaded: ${conflict.message}`),
        ),
      );

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

  /** Hold a loaded plugin's server: its process and tools, or why it has
   *  none. `own` contributes its tools under its own id while it runs (a
   *  configured server); an installed plugin contributes them itself, and
   *  its `load` key (its trust) is part of the hold key, so a re-trusted
   *  plugin whose files changed starts new processes. */
  const holdServer = (plugin: LoadedPlugin, own: boolean, load = '') =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = `${plugin.id}#${sha256(plugin.spec)}#${plugin.revision}${load && `#${load}`}`;
        const revision = sha256({ spec: plugin.spec, env: plugin.revision });
        const held = yield* locked(
          Effect.sync(() => {
            const open = servers.get(id);
            if (open) open.count += 1;
            return open;
          }),
        );
        if (held) return { id, revision, ...held };
        // Started outside the lock: a slow server does not hold up every
        // run's step. A concurrent hold of the same key keeps the first.
        // Until it is published, the scope is this call's: a failure or an
        // interruption at any point before then (only the start itself is
        // interruptible) stops the process it started.
        const serverScope = yield* Scope.fork(scope);
        const answered = yield* restore(
          plugin.acquire.pipe(
            Effect.provideService(ChildProcessSpawner, spawner),
            Scope.provide(serverScope),
          ),
        ).pipe(Effect.onError(() => Scope.close(serverScope, Exit.void)));
        const open = yield* locked(
          Effect.gen(function* () {
            const open = servers.get(id);
            if (open) {
              open.count += 1;
              yield* Scope.close(serverScope, Exit.void);
              return open;
            }
            const failure =
              answered.failure ??
              (own
                ? yield* contribute(
                    plugin.id,
                    entriesOf(plugin.id, answered.tools, {
                      revision,
                      server: id,
                    }),
                    serverScope,
                  )
                : undefined);
            const created = {
              count: 1,
              scope: serverScope,
              tools: answered.tools,
              failure,
            };
            servers.set(id, created);
            return created;
          }),
        ).pipe(Effect.onError(() => Scope.close(serverScope, Exit.void)));
        return { id, revision, ...open };
      }),
    );

  return {
    release,
    holdServer,
    /** Hold, for a pin, the servers a generation dispatches through. Pins
     *  are taken only under the catalog's lock, where a server in `current`
     *  is still up. */
    pinHolds: (generation: Generation<string, ToolEntry>) =>
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
    /** Prepare an installed plugin at its key: hold its servers, privately
     *  until the load is published. */
    loadInstalled: (plugin: InstalledToolPlugin) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // The holds are this call's until it returns: a failure or an
          // interruption at any point (only the server starts are
          // interruptible) closes them, and so stops what they hold.
          const holds = yield* Scope.fork(scope);
          const held = yield* restore(
            Effect.forEach(plugin.servers, (server) =>
              Effect.acquireRelease(
                holdServer(server, false, plugin.key),
                ({ id }) => release(id),
                { interruptible: true },
              ),
            ).pipe(Scope.provide(holds)),
          ).pipe(Effect.onError(() => Scope.close(holds, Exit.void)));
          return {
            id: plugin.id,
            key: plugin.key,
            source: plugin.source,
            entries: new Map(
              held.flatMap(({ id, revision, tools }) => [
                ...entriesOf(plugin.id, tools, { revision, server: id }),
              ]),
            ),
            contribution: yield* Scope.fork(scope),
            holds,
            failures: held.flatMap(({ failure }) => failure ?? []),
          } satisfies InstalledLoad;
        }),
      ),
    /** Contribute an accepted load's tools under its plugin's one id, under
     *  the catalog's lock: what a load prepares is in no generation before
     *  it is accepted as current. */
    publish: (load: InstalledLoad) =>
      Effect.map(
        contribute(load.id, load.entries, load.contribution),
        (conflict): InstalledLoad =>
          conflict === undefined
            ? load
            : { ...load, failures: [...load.failures, conflict] },
      ),
  };
}
