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
} from '@platform/defaults/nodeHost';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { initPlatform, platform, tryPlatform } from '@platform/platform';

// Local imports - telemetry
import { UsageLogService } from '@telemetry/UsageLogService';

// Local imports - agent index
import { defaultSkillSources, setRuntimeSkillSources } from '@skills/index';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';
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
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - config
import { getUseOpenRouter } from '@utils/config/providerConfig';

// Local imports - CLI runtime
import { applyCliGitAuthorConfig } from './gitAuthor';
import { getCliSecrets } from './cliSecrets';
import { isTexraCliEntrypointPath, readCliEntrypointPath } from './cliContext';
import { writeTextStderr } from './logSinks';
import { getCliAuthProvider, initializeCliSupabaseAuth } from './supabaseAuth';
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
    const handler = () => {
      void lifecycle.runShutdown().finally(() => {
        process.exit(exitCodeForSignal(signal));
      });
    };
    process.once(signal, handler);
  };

  install('SIGINT');
  install('SIGTERM');
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

export async function initCliPlatform(
  context: CliPlatformInitOptions &
    Pick<CliContext, 'quietLogs'> & { skipIncludedModelAccess?: boolean },
): Promise<void> {
  cliWorkspaceCwd = context.cwd;
  quietPlatformLogs = context.quietLogs ?? false;
  setOutputChannelFactory(
    quietPlatformLogs ? () => ({ appendLine: () => undefined }) : null,
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
        agentResume: { tryResumeStream: async () => false },
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

  setRuntimeSkillSources(
    defaultSkillSources(
      {
        cwd: context.cwd,
        resourcesPath: context.resourcesPath,
      },
      context.skillSourceOptions,
    ),
  );
}
