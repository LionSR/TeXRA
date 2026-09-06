// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  initializeBundledPrompts,
  teardownDefaultSession,
  tryDefaultSession,
} from '@agent/runtime';
import { createPlatformAgentDirectories } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { SupabaseSessionLog } from '@auth/SupabaseSession';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import { disposeProcessRuntime } from '@controllers/session/sessionLayer';
import { setOutputChannelFactory } from '@logger/logUtils';
import { refreshModelListAndLog } from '@model/modelListRefresh';
import { initPlatform, tryPlatform } from '@platform/platform';
import { initProcessWorkspaceRoots } from '@platform/workspaceRoots';
import type { AgentResumePort, LifecycleHost } from '@platform/interfaces';
import { DisposableStore } from '@platform/disposable';
import { effectRuntime } from '@platform/processRuntime';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { initNodeAgentRuntime } from '@platform/defaults/nodeAgentRuntime';
import {
  bootstrapNodeAgentDirectories,
  createNodePlatform,
  createNodeWorkspaceRoots,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { setSetupPlatform } from '@tools/setup/platform';
import { initProcessSettingHost } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { installCliProcessRuntime } from './cliProcessRuntime';
import { getCliSecrets } from './cliSecrets';
import { isTexraCliEntrypointPath, readCliEntrypointPath } from './cliContext';
import {
  flushNdjsonStdout,
  flushTextStderr,
  writeTextStderr,
} from './logSinks';
import { initializeCliSupabaseAuth, signInCliSupabase } from './supabaseAuth';
import { createCliStateStores } from './cliStateStores';
import { CliExitCode } from './exitCodes';
import type { CliContext } from './cliContext';

let supabaseAuthInitialized = false;
let quietPlatformLogs = false;
type CliShutdownSignal = 'SIGINT' | 'SIGTERM';
// Removers for the listeners installCliShutdownSignalHandlers put on the
// process — kept so handOffCliShutdownSignalHandlers can remove exactly those
// (not every SIGINT/SIGTERM listener on the process) once an exclusive owner
// (the chat TUI) is about to install its own. Undefined means no platform
// handlers are currently installed.
let shutdownHandlers: DisposableStore | undefined;

type CliPlatformInitOptions = Pick<
  CliContext,
  'cwd' | 'resourcesPath' | 'skillSourceOptions' | 'version'
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

// Malformed project config is actionable degradation, not routine progress
// noise, so this deliberately bypasses quietLogs.
function showPersistentConfigWarning(message: string): void {
  writeTextStderr(`[warn] [cli.config] ${message}`);
}

// A shutdown-handler failure is actionable degradation by the same rule, so it
// bypasses quietLogs too — every CLI command passes quietLogs:true, and routing
// this through logAt would make the cross-host parity below unreachable.
function showLifecycleError(message: string): void {
  writeTextStderr(`[error] [cli.lifecycle] ${message}`);
}

/** `Effect.tryPromise` with the identity catch every Promise boundary below
 *  wants: the rejection value flows through unchanged as the error. */
const tryPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (error) => error });

const cliPlatformLog: SupabaseSessionLog = {
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
 *
 * Runs on the default runtime rather than `effectRuntime()`: the lifecycle
 * shutdown below disposes the process runtime (`disposeProcessRuntime`)
 * before the flushes run, and a teardown path must not depend on the thing
 * it is tearing down.
 */
export async function runCliPlatformShutdownSequence(
  lifecycle: LifecycleHost | undefined,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      // Signal shutdown is best effort; output still gets one final flush.
      yield* Effect.ignoreCause(
        tryPromise(() => lifecycle?.runShutdown() ?? Promise.resolve()),
      );
      // A closed stderr pipe must not prevent signal-based termination.
      yield* Effect.ignoreCause(tryPromise(flushTextStderr));
      // A closed stdout pipe must not prevent signal-based termination.
      yield* Effect.ignoreCause(tryPromise(flushNdjsonStdout));
    }),
  );
}

export function installCliShutdownSignalHandlers(
  lifecycle: LifecycleHost,
): void {
  if (shutdownHandlers) return;
  const handlers = new DisposableStore();
  shutdownHandlers = handlers;

  const install = (signal: CliShutdownSignal, exitCode: number) => {
    const handler = async () => {
      await runCliPlatformShutdownSequence(lifecycle);
      process.exit(exitCode);
    };
    process.once(signal, handler);
    handlers.add(() => process.removeListener(signal, handler));
  };

  install('SIGINT', CliExitCode.Interrupted);
  install('SIGTERM', CliExitCode.Terminated);
}

/**
 * Hands exclusive SIGINT/SIGTERM ownership from the platform's own handlers
 * (installed by `installCliShutdownSignalHandlers` above) to a caller that is
 * about to install its own — the chat TUI, immediately before it calls
 * `process.on('SIGINT'/'SIGTERM', ...)` once Ink mounts. Removes exactly the
 * listeners this module installed (tracked in `shutdownHandlers`), not every
 * SIGINT/SIGTERM listener on the process, and clears that store so a later
 * `initCliPlatform` first-init could reinstall if the platform is ever torn
 * down and reinitialized.
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
  shutdownHandlers?.dispose();
  shutdownHandlers = undefined;
}

/**
 * The chat TUI's stream resume, installed while a chat session is mounted.
 * The platform port above forwards to it; outside a chat there is no host
 * that can resume, so the port answers `false`.
 */
let cliResumeHandler: AgentResumePort['tryResumeStream'] | undefined;

export function setCliAgentResumeHandler(
  handler: AgentResumePort['tryResumeStream'],
): () => void {
  cliResumeHandler = handler;
  return () => {
    if (cliResumeHandler === handler) cliResumeHandler = undefined;
  };
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
  quietPlatformLogs = context.quietLogs;
  setOutputChannelFactory(
    quietPlatformLogs ? () => ({ appendLine: () => undefined }) : null,
    { trusted: true },
  );

  if (!tryPlatform()) {
    // The one Effect runtime of this process (PRD 7.7) comes first: the
    // stores below open as Effect programs, and the session graph and every
    // Promise-facing fiber run on it. Disposed after the default session has
    // released its graph. An entry that ran before any platform existed --
    // the update check, `clone` -- may already have installed it; this then
    // adopts that one rather than building a second and leaving the first
    // undisposed.
    await installCliProcessRuntime();
    // The project `.texra/config.json` backs the workspace target and
    // user-level config (`~/.texra/global-storage/config.json`, the same file
    // chatDefaults reads) backs the global target — the same pair of stores
    // the extension and desktop hosts open, including the fallback to the
    // internal workspace store when the project file cannot be read or its
    // directory cannot be written.
    const { stateStores, configStores } = await effectRuntime().runPromise(
      Effect.gen(function* () {
        const stores = yield* createCliStateStores({
          storageRoot: context.storageRoot,
          workspacePath: context.cwd,
        });
        return {
          stateStores: stores,
          configStores: yield* openTexraConfigStores(
            stores.storage,
            context.cwd,
            showPersistentConfigWarning,
          ),
        };
      }),
    );
    // Same severity and wording as the extension/desktop hosts: a shutdown
    // handler failure is an error everywhere, not a warning in one host.
    const lifecycle = createLifecycleHost({
      onError: (phase, error) => {
        showLifecycleError(
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
        globalState: stateStores.globalState,
        storage: stateStores.storage,
        secrets: getCliSecrets(context.storageRoot),
        lifecycle,
        agentResume: {
          tryResumeStream: async (streamId, recovery) =>
            (await cliResumeHandler?.(streamId, recovery)) ?? false,
        },
        agentDirectories,
        toolAvailability: {
          isTexraCliEntrypoint: () =>
            isTexraCliEntrypointPath(readCliEntrypointPath()),
        },
      }),
    );
    // One process, one paper: the process roots are the `--cwd` workspace.
    const roots = createNodeWorkspaceRoots({
      workspacePath: context.cwd,
      storage: stateStores.storage.getStoragePath(),
      config: configStores,
      workspaceState: stateStores.workspaceState,
    });
    initProcessWorkspaceRoots(roots);
    initProcessSettingHost('cli');
    // TeXRA's account plane (ChatGPT / Grok sign-in). Without
    // this the model layer is bring-your-own-key. See installTexraAccountProbes.
    installTexraAccountProbes();

    // Reconcile the persisted enabled-models list against the current curated
    // defaults, as the extension and desktop hosts do at startup. The list
    // lives in shared `~/.texra` state. Preferred defaults reconcile when
    // MODEL_LIST_VERSION changes; retired entries are swept on every startup.
    await effectRuntime().runPromise(
      tryPromise(() => refreshModelListAndLog(stateStores.globalState)).pipe(
        Effect.tap(({ messages }) =>
          Effect.sync(() => {
            for (const message of messages)
              logAt('info', 'cli.models', message);
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            logAt(
              'error',
              'cli.models',
              `Failed to refresh model list: ${toErrorMessage(error)}`,
            );
          }),
        ),
      ),
    );

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
    registerRuntimeShutdownHandlers(lifecycle, {
      // The default session is installed later by whichever entry point opens
      // transcripts, so its shutdown lookup remains lazy.
      flushArtifacts: () => tryDefaultSession()?.flushArtifacts(),
      afterFlushArtifacts: [() => UsageLogService.dispose()],
      afterExecutionSettlement: [
        () => teardownDefaultSession(),
        () => disposeProcessRuntime(),
      ],
    });

    // Route CLI model traffic to the same Supabase usage log the extension
    // writes to, tagged with editorType 'cli' and the CLI version.
    // dispose() flushes any queued entries; it
    // runs on normal exit (bin/texra.ts finally) and on signals, both of
    // which call lifecycle.runShutdown().
    UsageLogService.initialize({}, context.version, 'cli');
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

  initializeBundledPrompts(context.resourcesPath);

  await effectRuntime().runPromise(
    bootstrapNodeAgentDirectories({
      channel: 'cli',
      resourcesPath: context.resourcesPath,
      currentVersion: context.version,
      versionStateKey: GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION,
    }),
  );

  initializeNodeRuntimeSkills({
    resourcesPath: context.resourcesPath,
    skillSourceOptions: context.skillSourceOptions,
  });
}
