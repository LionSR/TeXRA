// Node imports
import * as nodePath from 'node:path';

// Local imports
import {
  initializeBundledPrompts,
  teardownDefaultSession,
  tryDefaultSession,
} from '@agent/runtime';
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { SupabaseClient } from '@auth/SupabaseClient';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import { setOutputChannelFactory } from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { initPlatform, platform, tryPlatform } from '@platform/platform';
import type { LifecycleHost } from '@platform/interfaces';
import { JsonStore } from '@platform/defaults/jsonStore';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import {
  bootstrapNodeAgentDirectories,
  createNodePlatform,
  initNodeAgentRuntime,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import { registerAgentShutdownHandlers } from '@tools/agentCliSessionStores';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { setSetupPlatform } from '@tools/setup/platform';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { applyCliGitAuthorConfig } from './gitAuthor';
import { tryResumeCliStream } from './agentResume';
import { getCliSecrets } from './cliSecrets';
import { isTexraCliEntrypointPath, readCliEntrypointPath } from './cliContext';
import { flushNdjsonStdout, writeTextStderr } from './logSinks';
import { initializeCliSupabaseAuth, signInCliSupabase } from './supabaseAuth';
import { createCliStateStores } from './cliStateStores';
import { CliExitCode } from './exitCodes';
import type { LogBackend } from './supabaseAuth';
import type { CliContext } from './cliContext';

let supabaseAuthInitialized = false;
let cliWorkspaceCwd = '';
let quietPlatformLogs = false;
let shutdownHandlersInstalled = false;
type CliShutdownSignal = 'SIGINT' | 'SIGTERM';
// Handler function references installed by installCliShutdownSignalHandlers,
// keyed by signal — kept so handOffCliShutdownSignalHandlers can remove
// exactly the listeners it installed (not every SIGINT/SIGTERM listener on
// the process) once an exclusive owner (the chat TUI) is about to install its
// own.
const installedShutdownHandlers: Partial<
  Record<CliShutdownSignal, () => void>
> = {};

type CliPlatformInitOptions = Pick<
  CliContext,
  'cwd' | 'helperModel' | 'resourcesPath' | 'skillSourceOptions' | 'version'
> & {
  readonly installSignalHandlers?: boolean;
  readonly storageRoot?: string;
};

function logAt(
  level: 'debug' | 'info' | 'warn' | 'error',
  channel: string,
  message: string,
): void {
  if (quietPlatformLogs) return;
  writeTextStderr(`[${level}] [${channel}] ${message}`);
}

const cliPlatformLog: LogBackend = {
  debug: (channel, message) => logAt('debug', channel, message),
  info: (channel, message) => logAt('info', channel, message),
  warn: (channel, message) => logAt('warn', channel, message),
  error: (channel, message) => logAt('error', channel, message),
};

/**
 * The canonical "shut down the CLI platform" sequence — lifecycle shutdown
 * hooks (notably `UsageLogService.dispose()`) then the NDJSON stdout flush —
 * shared by every process.exit()-ing teardown path: the headless signal
 * handlers below AND the interactive chat TUI's own signal handlers (see
 * `initInteractiveCliPlatform` and `handOffCliShutdownSignalHandlers`), which
 * take over SIGINT/SIGTERM exclusively once mounted and must perform the
 * same sequence the platform's own (now handed-off) handlers would have. One
 * definition means the two paths can't drift.
 */
export async function runCliPlatformShutdownSequence(
  lifecycle: LifecycleHost | undefined,
): Promise<void> {
  try {
    await lifecycle?.runShutdown();
  } catch {
    // Signal shutdown is best effort; output still gets one final flush.
  }
  try {
    await flushNdjsonStdout();
  } catch {
    // A closed stdout pipe must not prevent signal-based termination.
  }
}

export function installCliShutdownSignalHandlers(
  lifecycle: LifecycleHost,
): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  const install = (signal: CliShutdownSignal, exitCode: number) => {
    const handler = async () => {
      await runCliPlatformShutdownSequence(lifecycle);
      process.exit(exitCode);
    };
    installedShutdownHandlers[signal] = handler;
    process.once(signal, handler);
  };

  install('SIGINT', CliExitCode.Interrupted);
  install('SIGTERM', CliExitCode.Terminated);
}

/**
 * Hands exclusive SIGINT/SIGTERM ownership from the platform's own handlers
 * (installed by `installCliShutdownSignalHandlers` above) to a caller that is
 * about to install its own — the chat TUI, immediately before it calls
 * `process.on('SIGINT'/'SIGTERM', ...)` once Ink mounts. Removes exactly the
 * listeners this module installed (tracked in `installedShutdownHandlers`),
 * not every SIGINT/SIGTERM listener on the process, and resets
 * `shutdownHandlersInstalled` so a later `initCliPlatform` first-init could
 * reinstall if the platform is ever torn down and reinitialized.
 *
 * Call this right at the handoff point, not any earlier: everything between
 * `initInteractiveCliPlatform()` and this call (onboarding, model
 * resolution, the orchestration launcher) still needs a graceful handler, so
 * the platform's stays live for that whole window instead of being
 * suppressed for the entire span up front.
 *
 * A no-op if the platform handlers were never installed (e.g. a headless
 * `initCliPlatform` call with `installSignalHandlers: false`, or a second
 * call after an earlier handoff already ran).
 */
export function handOffCliShutdownSignalHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = installedShutdownHandlers[signal];
    if (!handler) continue;
    process.removeListener(signal, handler);
    delete installedShutdownHandlers[signal];
  }
  shutdownHandlersInstalled = false;
}

export async function setCliHelperModel(
  model: string | undefined,
): Promise<void> {
  if (!model) return;
  await tryPlatform()?.globalState.update(GlobalStateKey.HELPER_MODEL, model);
}

/**
 * Init for commands that act on local state only (no model invocation):
 * inspect paths (history/agents/memory/multi-agent list+show) plus
 * local-destructive paths (history delete). Quiet logs and skip the
 * included-model-access probe, since no model is run.
 *
 * Not actually read-only — the name describes the boundary (local-only,
 * no provider calls), not safety. Destructive local operations belong here.
 */
export async function initLocalCliPlatform(
  context: CliPlatformInitOptions,
): Promise<void> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
  });
}

/**
 * Init for the REAL interactive entry points that hand control to the chat
 * TUI once the terminal-capability gate has already confirmed a usable TTY:
 * `texra chat`, the default-command launcher (`texra`/`texra orchestrate`),
 * `texra setup`, and `texra resume`. All four eventually call
 * `runChatTui.tsx`'s `runChat()`, which installs its own SIGINT/SIGTERM/
 * SIGHUP handlers once Ink mounts and owns teardown (terminal-mode restore,
 * persistence drain, `runCliPlatformShutdownSequence`) from there.
 *
 * Unlike `initLocalCliPlatform`, this does *not* suppress the platform's own
 * signal handlers up front — every one of the four call sites still does
 * real async I/O (onboarding, model resolution, the orchestration launcher)
 * between this call and the moment Ink actually mounts, and that window
 * needs a graceful handler just as much as a headless command does. The
 * platform handler stays installed through that window; `runChat()` calls
 * `handOffCliShutdownSignalHandlers()` immediately before installing its own
 * `process.on('SIGINT'/'SIGTERM', ...)` pair, at which point ownership
 * transfers exclusively and the two handler sets can never both be live.
 *
 * The type omits `installSignalHandlers` so a caller can't accidentally
 * suppress the platform handler early and reopen the pre-handoff gap this
 * function exists to close.
 */
export async function initInteractiveCliPlatform(
  context: Omit<CliPlatformInitOptions, 'installSignalHandlers'> &
    Pick<CliContext, 'quietLogs'>,
): Promise<void> {
  await initCliPlatform(context);
}

export async function initCliPlatform(
  context: CliPlatformInitOptions & Pick<CliContext, 'quietLogs'>,
): Promise<void> {
  cliWorkspaceCwd = context.cwd;
  quietPlatformLogs = context.quietLogs;
  setOutputChannelFactory(
    quietPlatformLogs ? () => ({ appendLine: () => undefined }) : null,
    { trusted: true },
  );

  if (!tryPlatform()) {
    const configStore = await JsonStore.open(
      workspaceTexraConfigPath(cliWorkspaceCwd),
    );
    const stateStores = await createCliStateStores({
      storageRoot: context.storageRoot,
      workspacePath: () => cliWorkspaceCwd,
    });
    // User-level config (`~/.texra/global-storage/config.json`, the same file
    // chatDefaults reads) backs the global target, mirroring the desktop host:
    // workspace values shadow global on read and `update(..., 'global')` has
    // somewhere to write instead of throwing.
    const globalConfigStore = await JsonStore.open(
      nodePath.join(
        stateStores.storage.getGlobalStoragePath(),
        TEXRA_CONFIG_FILE_NAME,
      ),
    );
    // Same severity and wording as the extension/desktop hosts: a shutdown
    // handler failure is an error everywhere, not a warning in one host.
    const lifecycle = createLifecycleHost({
      onError: (phase, error) => {
        logAt(
          'error',
          'cli.lifecycle',
          `Lifecycle ${phase} handler failed: ${toErrorMessage(error)}`,
        );
      },
    });
    const agentDirectories = createPlatformAgentDirectories({
      channel: 'cli',
      customDirectoryStore: { get: () => undefined },
    });
    initPlatform(
      createNodePlatform({
        configStores: { workspace: configStore, global: globalConfigStore },
        globalState: stateStores.globalState,
        workspaceState: stateStores.workspaceState,
        storage: stateStores.storage,
        secrets: getCliSecrets(context.storageRoot),
        lifecycle,
        agentResume: {
          tryResumeStream: tryResumeCliStream,
        },
        agentDirectories,
        getWorkspacePath: () => cliWorkspaceCwd,
        toolAvailability: {
          isTexraCliEntrypoint: () =>
            isTexraCliEntrypointPath(readCliEntrypointPath()),
        },
      }),
    );
    // TeXRA's account plane (ChatGPT / Grok sign-in). Without
    // this the model layer is bring-your-own-key. See installTexraAccountProbes.
    installTexraAccountProbes();

    // Reconcile the persisted enabled-models list against the current curated
    // defaults, as the extension and desktop hosts do at startup. The list
    // lives in shared `~/.texra` state. Preferred defaults reconcile when
    // MODEL_LIST_VERSION changes; retired entries are swept on every startup.
    try {
      const { added, removed, reordered, routePreferencesCleared } =
        await refreshModelListStateIfNeeded(stateStores.globalState);
      const changed = added.length > 0 || removed.length > 0 || reordered;
      const clearedRoutes = routePreferencesCleared.length > 0;
      if (changed || clearedRoutes) {
        invalidateModelOptionsCache();
        if (changed) {
          logAt(
            'info',
            'cli.models',
            `Refreshed enabled models: added [${added.join(', ')}], removed [${removed.join(', ')}]${reordered ? ', reordered' : ''}`,
          );
        }
        if (clearedRoutes) {
          logAt(
            'info',
            'cli.models',
            `Cleared stale Copilot route preferences: [${routePreferencesCleared.join(', ')}]`,
          );
        }
      }
    } catch (error) {
      logAt(
        'error',
        'cli.models',
        `Failed to refresh model list: ${toErrorMessage(error)}`,
      );
    }

    // Seed first-install defaults (e.g. disabled tools) before anything
    // writes CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION (the bundled-agent sync
    // below), so upgrading users are not affected. Mirrors the
    // extension/desktop ordering — same seeding function, CLI's own version
    // key since the CLI tracks its bundled-agent version independently.
    await seedDisabledToolDefaults(
      GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION,
    );

    if (context.installSignalHandlers !== false) {
      installCliShutdownSignalHandlers(lifecycle);
    }
    // Register the shared Node-host agent runtime: memory + goal tool
    // injections and the direct Lean language services (errors surface via the
    // Tools dashboard if `lake` isn't on PATH).
    initNodeAgentRuntime(lifecycle);

    // Kill agent-spawned OS children before the process dies, exactly as the
    // extension and desktop hosts do. Background `bash` runs are spawned
    // `detached` (their own process group, see execUtils) so they survive
    // `texra` exiting and can never deliver their follow-up result — without
    // this drain they are orphaned. Registered before the usage-log flush
    // below so the kills (all synchronous) land first, matching the other
    // hosts' ordering.
    registerAgentShutdownHandlers(lifecycle);

    // Same session teardown the extension and desktop hosts run: drain the
    // session's durable writers once the agent kills above have landed, then
    // dispose the session last so pending host interactions settle after
    // persistence. `tryDefaultSession` because the session is installed later,
    // by whichever entry point opens transcripts.
    lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
      tryDefaultSession()?.flushArtifacts(),
    );
    lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => teardownDefaultSession());

    // Attribute agent-authored commits to the TeXRA identity by default;
    // configurable via `.texra/config.json` `texra.git.markCommits`.
    applyCliGitAuthorConfig(platform().config);

    // Route CLI model traffic to the same Supabase usage log the extension
    // writes to, tagged with editorType 'cli' and the CLI version.
    // dispose() flushes any queued entries; it
    // runs on normal exit (bin/texra.ts finally) and on signals, both of
    // which call lifecycle.runShutdown().
    UsageLogService.initialize({}, context.version, 'cli');
    lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
      UsageLogService.dispose(),
    );
  }

  if (!supabaseAuthInitialized) {
    initializeCliSupabaseAuth(cliPlatformLog);
    supabaseAuthInitialized = true;
  }

  setSetupPlatform({
    host: 'cli',
    signIn: async () => {
      await signInCliSupabase({ openBrowser: true });
      return SupabaseClient.isAuthenticated();
    },
  });

  await setCliHelperModel(context.helperModel);
  initializeBundledPrompts(context.resourcesPath);

  await bootstrapNodeAgentDirectories({
    channel: 'cli',
    resourcesPath: context.resourcesPath,
    currentVersion: context.version,
    versionStateKey: GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION,
  });

  initializeNodeRuntimeSkills({
    cwd: context.cwd,
    resourcesPath: context.resourcesPath,
    skillSourceOptions: context.skillSourceOptions,
  });
}
