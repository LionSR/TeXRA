/**
 * The agent catalog follows the plugins: a plugin's bundled agents its tool
 * switch, an installed plugin's agents the install record. After a change
 * to either, written by this process or another sharing the global state
 * (`AppState.changes`), the catalog reloads and every roster view repaints
 * (`agentRosterChanged`). No plugin writer refreshes it itself. The one
 * other reload is a file tool's approved write into the custom agents
 * directory (`@tools/approval/approvedWrite`): the `creator` agent tests the
 * agent it just wrote in its next call, so that reload is part of the write
 * rather than a watcher's later event.
 *
 * It follows a host's packaged catalog, so it runs only where the agent
 * directories name a packaged resources root: an embedder, and the CLI
 * entries that load no agents and must create nothing under a possibly
 * read-only storage root (`texra clone`), get no follower. As it is built,
 * before its first reload, it registers the tool plugins' agent directories
 * under that root (`<resources>/plugins/<id>/agents`), so no load or reload
 * scans without them.
 *
 * It also registers the agent directories with the file tools' external-root
 * allowlist, for every host alike: the packaged built-in agents and the
 * agent-creation docs read-only, the custom agents directory writable. The
 * `creator` agent reads and writes them through the ordinary file tools, and
 * its prompt names them (`CUSTOM_AGENTS_DIR`, …). The custom directory is a
 * global setting, so it is registered again whenever that setting changes.
 */
import * as path from 'node:path';

import { Cause, Effect, Layer, Schedule, Stream } from 'effect';

import { installPluginAgentDirectories } from '@agent/index/BundledAgentDirectories';
import { refresh as refreshAgentCatalog } from '@agent/index/agentRegistry';
import { followerOwnsInitialLoad } from '@agent/index/catalogReadiness';
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

export const agentCatalogFollower = Layer.effectDiscard(
  Effect.gen(function* () {
    const appState = yield* AppState;
    const directories = yield* AgentDirectories;
    const { resourcesRoot } = directories;
    if (resourcesRoot === undefined || resourcesRoot === '') return;
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
          { kind: 'agentDocs', writable: false, label: 'Agent creation docs' },
        ),
        registerCustomAgentRoot,
      ],
      { discard: true },
    );
    // A change written by another process, or by a writer other than the
    // settings view.
    yield* appState.changes([GlobalStateKey.CUSTOM_AGENT_DIR]).pipe(
      Stream.runForEach(() => registerCustomAgentRoot),
      Effect.forkScoped,
    );
    installPluginAgentDirectories(
      resourcesRoot,
      TOOL_PLUGINS.flatMap((plugin) =>
        plugin.agents === true ? [plugin.id] : [],
      ),
    );
    // The first element's reload is the catalog's initial load: a host's
    // `loadAgents` waits for it rather than scanning beside it.
    const landed = yield* followerOwnsInitialLoad;
    const reload = reloadAgentCatalog.pipe(
      Effect.ensuring(landed),
      // A transient read failure is tried again: 200 ms doubling, six times.
      Effect.retry({ schedule: Schedule.exponential('200 millis'), times: 6 }),
      Effect.catchCause((cause) =>
        Effect.logError(
          `The agent catalog was not reloaded after a plugin change, after seven tries; it lists the agents it had until the next change: ${toErrorMessage(Cause.squash(cause))}`,
        ),
      ),
    );
    // The first element reloads too: a write that lands between the host's
    // startup scan and the feed's first read is folded into that element.
    yield* appState
      .changes([
        GlobalStateKey.DISABLED_TOOLS,
        GlobalStateKey.INSTALLED_PLUGINS,
      ])
      .pipe(
        Stream.runForEach(() => reload),
        Effect.forkScoped,
      );
  }),
);
