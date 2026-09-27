/**
 * The server processes the live tool catalog (`@tools/liveTools`) holds:
 * each MCP server by hold key (its plugin, spec and env revision) with a
 * count of what holds it, the runs that name it, the installed plugin that
 * loaded it and the generations that pinned its tools. The last hold to go
 * stops it. Every count changes under the catalog's lock.
 */
import { Effect, Exit, Scope } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { entriesOf, sha256, type ToolEntry } from '@tools/catalogEntries';
import type { Generation, Registry } from '@tools/liveRegistry';
import type { InstalledToolPlugin, LoadedPlugin } from '@tools/toolTable';

/** An installed plugin loaded at a key: its contribution, which closes under
 *  the catalog's lock, and its server holds, which close after it (a
 *  release takes the lock). */
export interface InstalledLoad {
  readonly id: string;
  readonly key: string;
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
   *  configured server); an installed plugin contributes them itself. */
  const holdServer = (plugin: LoadedPlugin, own: boolean) =>
    Effect.gen(function* () {
      const id = `${plugin.id}#${sha256(plugin.spec)}#${plugin.revision}`;
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
      const serverScope = yield* Scope.fork(scope);
      const answered = yield* plugin.acquire.pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Scope.provide(serverScope),
      );
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
      );
      return { id, revision, ...open };
    });

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
    /** Load an installed plugin at its key: hold its servers and contribute
     *  their tools under its one id. */
    loadInstalled: (plugin: InstalledToolPlugin) =>
      Effect.gen(function* () {
        const holds = yield* Scope.fork(scope);
        const contribution = yield* Scope.fork(scope);
        const held = yield* Effect.forEach(plugin.servers, (server) =>
          Effect.acquireRelease(holdServer(server, false), ({ id }) =>
            release(id),
          ),
        ).pipe(Scope.provide(holds));
        const conflict = yield* locked(
          contribute(
            plugin.id,
            new Map(
              held.flatMap(({ id, revision, tools }) => [
                ...entriesOf(plugin.id, tools, { revision, server: id }),
              ]),
            ),
            contribution,
          ),
        );
        return {
          id: plugin.id,
          key: plugin.key,
          contribution,
          holds,
          failures: [
            ...held.flatMap(({ failure }) => failure ?? []),
            ...(conflict === undefined ? [] : [conflict]),
          ],
        } satisfies InstalledLoad;
      }),
  };
}
