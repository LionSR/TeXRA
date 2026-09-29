/**
 * The process's agent catalog: this layer loads it when the process runtime
 * is built, so no program ever runs against an unloaded catalog, and keeps it
 * current. A plugin's bundled agents follow its tool switch, an installed
 * plugin's agents the install record, and a custom agent's file its own
 * edits: after a change to any of them, written by this process or another
 * sharing the global state (`AppState.changes`) or made in the custom
 * directory (`FileSystem.watch`, on every host), the catalog reloads and
 * every roster view repaints (`agentRosterChanged`). No plugin writer
 * refreshes it itself. The one other reload is a file tool's approved write
 * into the custom agents directory (`applyApprovedFileEdit` in
 * `@tools/fileEditFlow`): the `creator` agent tests the agent it just wrote
 * in its next call, so that reload is part of the write rather than a
 * watcher's later event. A launch that misses an agent reloads once
 * (`prepareAgentDefinition`).
 *
 * A host that packages a catalog (its agent directories name a resources
 * root) or names a custom directory of its own (an embedder's) gets the
 * catalog. The CLI entries that run no agents, and must create nothing under
 * a possibly read-only storage root (`texra clone`), get none. As it is
 * built, before its first load, it registers the tool plugins' agent
 * directories under the resources root (`<resources>/plugins/<id>/agents`),
 * so no load or reload scans without them.
 *
 * It also registers the agent directories with the file tools' external-root
 * allowlist, for every packaged host alike: the packaged built-in agents and
 * the agent-creation docs read-only, the custom agents directory writable.
 * The `creator` agent reads and writes them through the ordinary file tools,
 * and its prompt names them (`CUSTOM_AGENTS_DIR`, ...). The custom directory
 * is a global setting, so it is registered again, and watched anew, whenever
 * that setting changes.
 */
import * as path from 'node:path';

import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  type PlatformError,
  Schedule,
  Stream,
} from 'effect';

import { installPluginAgentDirectories } from '@agent/index/BundledAgentDirectories';
import { refresh as refreshAgentCatalog } from '@agent/index/agentRegistry';
import { emitAppSignal } from '@eventBus/AppSignals';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { TOOL_PLUGINS } from '@tools/plugins';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { registerExternalRoot } from '@utils/files/externalRoots';

/** Register one agent directory root; a failure is logged and leaves the
 *  other roots registered. */
const registerRoot = <E, R>(
  directory: Effect.Effect<string, E, R>,
  options: Parameters<typeof registerExternalRoot>[1],
) =>
  directory.pipe(
    Effect.flatMap((absolutePath) =>
      Effect.sync(() => registerExternalRoot(absolutePath, options)),
    ),
    Effect.catchCause((cause) =>
      Effect.logError(
        `Failed to register the ${options.label.toLowerCase()} directory with the file tools: ${toErrorMessage(Cause.squash(cause))}`,
      ),
    ),
  );

/**
 * Register the custom agents directory the setting names now, writable.
 * Registering the same kind replaces its slot, so a changed setting needs no
 * unregister step. The settings view runs it in the same step that writes
 * the setting, so a run launched right after sees the new directory; the
 * follower runs it for a change written anywhere else.
 */
export const registerCustomAgentRoot = Effect.flatMap(
  AgentDirectories,
  (directories) =>
    registerRoot(directories.custom(), {
      kind: 'custom',
      writable: true,
      label: 'Custom agents',
    }),
);

/** Rescan the agent catalog and repaint every roster view. */
export const reloadAgentCatalog = Effect.suspend(() =>
  refreshAgentCatalog(),
).pipe(
  Effect.andThen(
    Effect.sync(() => emitAppSignal('agentRosterChanged', undefined)),
  ),
);

/**
 * An edit under the custom directory, as a stream of "something changed".
 * Only a `.yaml` update counts; a create or remove always does (a deleted
 * folder reports only itself). A watcher that fails mid-life (Node's JS
 * recursive watcher on Linux can, reported as `Unknown`) is retried on a
 * bounded backoff; a missing or unreadable directory fails fast. Either way
 * the end is logged, and edits then apply when the directory setting changes
 * or the process restarts.
 */
const watchCustomDirectory = Stream.unwrap(
  Effect.gen(function* () {
    const directory = yield* Effect.flatMap(AgentDirectories, (directories) =>
      directories.custom(),
    );
    const fs = yield* FileSystem.FileSystem;
    return fs.watch(directory, { recursive: true }).pipe(
      Stream.filter(
        (event) => event._tag !== 'Update' || event.path.endsWith('.yaml'),
      ),
      Stream.retry(
        Schedule.exponential('1 second').pipe(
          Schedule.upTo({ times: 5 }),
          Schedule.while(
            ({ input }: { readonly input: PlatformError.PlatformError }) =>
              input.reason._tag === 'Unknown',
          ),
        ),
      ),
      // fs.watch can also throw synchronously (ENOENT after a race, EMFILE,
      // ENOSPC), which surfaces as a defect.
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logWarning(
            `Stopped watching the custom agents directory ${directory}; edits there apply after the directory setting changes or the process restarts: ${toErrorMessage(Cause.squash(cause))}`,
          ),
        ).pipe(Stream.drain),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `The custom agents directory is not watched: ${toErrorMessage(Cause.squash(cause))}`,
      ).pipe(Effect.as(Stream.empty)),
    ),
  ),
);

/** Whether the custom directory is one the user or embedder named. */
const namedCustomDirectory = Effect.flatMap(AgentDirectories, (directories) =>
  directories.customConfigured(),
).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning(
      `The custom agents directory setting was not read; no agent catalog is loaded: ${toErrorMessage(Cause.squash(cause))}`,
    ).pipe(Effect.as(false)),
  ),
);

export const agentCatalogFollower = Layer.effectDiscard(
  Effect.gen(function* () {
    const appState = yield* AppState;
    const directories = yield* AgentDirectories;
    const { resourcesRoot } = directories;
    const packaged = resourcesRoot !== undefined && resourcesRoot !== '';
    if (!packaged && !(yield* namedCustomDirectory)) return;
    if (packaged) {
      yield* Effect.all(
        [
          registerRoot(directories.builtIn(), {
            kind: 'builtInWorkflow',
            writable: false,
            label: 'Built-in workflow agents',
          }),
          registerRoot(directories.builtInToolUse(), {
            kind: 'builtInToolUse',
            writable: false,
            label: 'Built-in tool-use agents',
          }),
          registerRoot(
            Effect.succeed(path.join(resourcesRoot, 'docs', 'agent-creation')),
            {
              kind: 'agentDocs',
              writable: false,
              label: 'Agent creation docs',
            },
          ),
          registerCustomAgentRoot,
        ],
        { discard: true },
      );
      installPluginAgentDirectories(
        resourcesRoot,
        TOOL_PLUGINS.flatMap((plugin) =>
          plugin.agents === true ? [plugin.id] : [],
        ),
      );
    }
    const reload = reloadAgentCatalog.pipe(
      // A transient read failure is tried again: 200 ms doubling, six times.
      // A directory that cannot be resolved will not resolve on a retry, and
      // the first load holds the runtime build.
      Effect.retry({
        schedule: Schedule.exponential('200 millis'),
        times: 6,
        while: (error) => error._tag !== 'AgentCatalogLoadError',
      }),
      Effect.catchCause((cause) =>
        Effect.logError(
          `The agent catalog was not reloaded, after seven tries; it lists the agents it had until the next change: ${toErrorMessage(Cause.squash(cause))}`,
        ),
      ),
    );
    // The custom directory: its registration with the file tools and its
    // watcher follow the setting, written by this process, another, or a
    // writer other than the settings view. A burst of edits reloads once.
    yield* appState.changes([GlobalStateKey.CUSTOM_AGENT_DIR]).pipe(
      Stream.switchMap(() =>
        Stream.unwrap(
          Effect.as(
            packaged ? registerCustomAgentRoot : Effect.void,
            watchCustomDirectory.pipe(
              Stream.debounce('300 millis'),
              Stream.mapEffect(() => reload),
            ),
          ),
        ),
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );
    // The first element is the catalog's load, and the build waits for it,
    // so nothing runs against a catalog that is not there. Later elements
    // are a plugin's switch or install record written anywhere.
    const loaded = yield* Deferred.make<void>();
    const landed = Deferred.succeed(loaded, undefined);
    yield* appState
      .changes([
        GlobalStateKey.DISABLED_TOOLS,
        GlobalStateKey.INSTALLED_PLUGINS,
      ])
      .pipe(
        Stream.runForEach(() => Effect.ensuring(reload, landed)),
        // Whatever ends the feed, the build is not held for it.
        Effect.ensuring(landed),
        Effect.forkScoped,
      );
    yield* Deferred.await(loaded);
  }),
);
