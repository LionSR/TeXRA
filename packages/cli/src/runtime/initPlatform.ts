// Node imports
import * as nodePath from 'node:path';

// Local imports - platform
import { JsonStore } from '@platform/defaults/jsonStore';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import {
  bootstrapNodeAgentDirectories,
  createNodePlatform,
  initNodeAgentRuntime,
  initializeNodeGoalPrompts,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { initPlatform, platform, tryPlatform } from '@platform/platform';

// Local imports - telemetry
import { UsageLogService } from '@telemetry/UsageLogService';

// Local imports - agent index
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';

// Local imports - auth
import {
  getServerSideKeyService,
  initializeServerSideKeyAccess,
} from '@auth/serverKeys';

// Local imports - logger
import { setOutputChannelFactory } from '@logger/logUtils';

// Local imports - model
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

// Local imports - shared state
import { GlobalStateKey } from '@shared/state/stateKeys';

// Local imports - setup tools
import {
  createDefaultSetupPlatform,
  setSetupPlatform,
} from '@tools/setup/platform';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - config
import { getUseOpenRouter } from '@utils/config/providerConfig';

// Local imports - CLI runtime
import { applyCliGitAuthorConfig } from './gitAuthor';
import { isCliResumeInFlight, tryResumeCliStream } from './agentResume';
import { getCliSecrets } from './cliSecrets';
import { isTexraCliEntrypointPath, readCliEntrypointPath } from './cliContext';
import { flushNdjsonStdout, writeTextStderr } from './logSinks';
import {
  getCliAuthProvider,
  initializeCliSupabaseAuth,
  signInCliSupabase,
} from './supabaseAuth';
import { createCliStateStores } from './cliStateStores';
import { CliExitCode } from './exitCodes';

// Type imports - platform and CLI runtime
import type { LifecycleHost } from '@platform/interfaces';
import type { LogBackend } from './supabaseAuth';
import type { CliContext } from './cliContext';

let serverSideKeysInitialized = false;
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
  | 'apiMode'
  | 'cwd'
  | 'helperModel'
  | 'resourcesPath'
  | 'skillSourceOptions'
  | 'version'
> & {
  readonly bestEffortIncludedModelAccess?: boolean;
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
  initialize() {},
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

  const exitCodeForSignal = (signal: CliShutdownSignal): number => {
    switch (signal) {
      case 'SIGINT':
        return CliExitCode.Interrupted;
      case 'SIGTERM':
        return CliExitCode.Terminated;
    }
  };

  const install = (signal: CliShutdownSignal) => {
    const handler = async () => {
      await runCliPlatformShutdownSequence(lifecycle);
      process.exit(exitCodeForSignal(signal));
    };
    installedShutdownHandlers[signal] = handler;
    process.once(signal, handler);
  };

  install('SIGINT');
  install('SIGTERM');
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
    skipIncludedModelAccess: true,
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
    Pick<CliContext, 'quietLogs'> & { skipIncludedModelAccess?: boolean },
): Promise<void> {
  await initCliPlatform(context);
}

export async function initCliPlatform(
  context: CliPlatformInitOptions &
    Pick<CliContext, 'quietLogs'> & { skipIncludedModelAccess?: boolean },
): Promise<void> {
  cliWorkspaceCwd = context.cwd;
  quietPlatformLogs = context.quietLogs;
  setOutputChannelFactory(
    quietPlatformLogs ? () => ({ appendLine: () => undefined }) : null,
  );

  if (!tryPlatform()) {
    const configStore = await JsonStore.open(
      workspaceTexraConfigPath(cliWorkspaceCwd),
      { corruptionPolicy: 'fail' },
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
      { corruptionPolicy: 'fail' },
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
          isResumeInFlight: isCliResumeInFlight,
        },
        agentDirectories,
        getWorkspacePath: () => cliWorkspaceCwd,
        toolAvailability: {
          isTexraCliEntrypoint: () =>
            isTexraCliEntrypointPath(readCliEntrypointPath()),
        },
      }),
    );
    if (context.installSignalHandlers !== false) {
      installCliShutdownSignalHandlers(lifecycle);
    }
    // Register the shared Node-host agent runtime: memory + goal tool
    // injections and the direct Lean language services (errors surface via the
    // Tools dashboard if `lake` isn't on PATH).
    initNodeAgentRuntime(lifecycle);

    // Attribute agent-authored commits to the TeXRA identity by default;
    // configurable via `.texra/config.json` `texra.git.markCommits`.
    applyCliGitAuthorConfig(platform().config);

    // Route CLI model traffic to the same Supabase usage log the extension
    // writes to, tagged with editorType 'cli' and the CLI version so relay
    // pricing stays version-aware. dispose() flushes any queued entries; it
    // runs on normal exit (bin/texra.ts finally) and on signals, both of
    // which call lifecycle.runShutdown().
    UsageLogService.initialize({}, context.version, 'cli');
    lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
      UsageLogService.dispose(),
    );
  }

  if (!serverSideKeysInitialized) {
    initializeCliSupabaseAuth(cliPlatformLog, context.storageRoot);
    initializeServerSideKeyAccess(
      { state: tryPlatform()?.globalState, logger: cliPlatformLog },
      getCliAuthProvider(),
    );
    serverSideKeysInitialized = true;
  }

  const defaultSetupPlatform = createDefaultSetupPlatform();
  setSetupPlatform({
    ...defaultSetupPlatform,
    auth: {
      ...defaultSetupPlatform.auth,
      signIn: async () => {
        await signInCliSupabase({ openBrowser: true });
        return getCliAuthProvider().canAccessRemoteAgentCatalog();
      },
    },
  });

  const useOpenRouter = getUseOpenRouter();
  if (context.apiMode === 'included' && useOpenRouter) {
    await tryPlatform()?.globalState.update(
      GlobalStateKey.USE_OPENROUTER,
      false,
    );
    invalidateModelOptionsCache();
  }

  const forcePersonalApiKeys =
    context.skipIncludedModelAccess === true ||
    context.apiMode === 'personal' ||
    (context.apiMode !== 'included' && useOpenRouter);
  let authed = false;
  if (!forcePersonalApiKeys) {
    try {
      authed = await getCliAuthProvider().isAuthenticated();
    } catch (error) {
      if (context.bestEffortIncludedModelAccess !== true) throw error;
      logAt(
        'warn',
        'cli.auth',
        `Included model access probe failed: ${toErrorMessage(error)}`,
      );
    }
  }
  await getServerSideKeyService().setUseIncludedModelAccess(authed);
  await setCliHelperModel(context.helperModel);
  initializeNodeGoalPrompts(context.resourcesPath);

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
