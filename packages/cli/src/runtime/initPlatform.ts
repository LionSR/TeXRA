// Local imports - platform
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { JsonStore } from '@platform/defaults/jsonStore';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { SHUTDOWN_PHASE } from '@platform/interfaces/lifecycle';
import { initPlatform, tryPlatform } from '@platform/platform';

// Local imports - agent index
import { defaultSkillSources, setRuntimeSkillSources } from '@skills/index';
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';

// Local imports - auth
import {
  getServerSideKeyService,
  initializeServerSideKeyAccess,
} from '@auth/serverKeys';

// Local imports - common state
import { toErrorMessage } from '@common/errors';
import { GlobalStateKey } from '@common/state/stateKeys';

// Local imports - logger
import { setOutputChannelFactory } from '@logger/logUtils';

// Local imports - Lean direct LSP adapter
import { createDirectLspLeanAdapter } from '@tools/lean/direct/directLspAdapter';
import { setLeanLanguageServices } from '@tools/lean/leanLanguageServices';

// Local imports - CLI runtime
import { applyCliGitAuthorConfig } from './gitAuthor';
import { getCliSecrets } from './cliSecrets';
import { writeTextStderr } from './logSinks';
import { workspaceCliConfigPath } from './cliConfig';
import { getCliAuthProvider, initializeCliSupabaseAuth } from './supabaseAuth';
import { createCliStateStores } from './cliStateStores';

// Type imports - platform and CLI runtime
import type { LifecycleHost } from '@platform/interfaces/lifecycle';
import type { LogBackend } from './supabaseAuth';
import type { CliContext } from './cliContext';

let bootstrappedResourcesPath: string | undefined;
let serverSideKeysInitialized = false;
let cliWorkspaceCwd = '';
let quietPlatformLogs = false;
let shutdownHandlersInstalled = false;

type CliPlatformInitOptions = Pick<
  CliContext,
  'apiMode' | 'cwd' | 'resourcesPath' | 'helperModel'
> & {
  readonly installSignalHandlers?: boolean;
  readonly storageRoot?: string;
};

function logAt(
  level: 'debug' | 'info' | 'warn',
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
  error: (channel, message) => {
    if (quietPlatformLogs) return;
    writeTextStderr(`[error] [${channel}] ${message}`);
  },
};

function installCliShutdownSignalHandlers(lifecycle: LifecycleHost): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  const install = (signal: NodeJS.Signals) => {
    const handler = () => {
      void lifecycle.runShutdown().finally(() => {
        process.kill(process.pid, signal);
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
 * inspect paths (history/agents/memory/multi-agent list+show, orchestrate)
 * plus local-destructive paths (history delete). Quiet logs and skip the
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
      workspaceCliConfigPath(cliWorkspaceCwd),
    );
    const stateStores = await createCliStateStores({
      storageRoot: context.storageRoot,
      workspacePath: () => cliWorkspaceCwd,
    });
    const lifecycle = createLifecycleHost({
      onError: (phase, error) => {
        logAt(
          'warn',
          'cli.lifecycle',
          `${phase} handler failed: ${toErrorMessage(error)}`,
        );
      },
    });
    const config = new JsonConfigProvider({ workspace: configStore });
    initPlatform({
      config,
      globalState: stateStores.globalState,
      workspaceState: stateStores.workspaceState,
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => cliWorkspaceCwd),
      storage: stateStores.storage,
      secrets: getCliSecrets(),
      lifecycle,
      agentResume: { tryResumeStream: async () => false },
    });
    if (context.installSignalHandlers !== false) {
      installCliShutdownSignalHandlers(lifecycle);
    }
    // Direct LSP adapter for Lean tools — spawns `lake env lean --server`
    // lazily, one server per Lake project root. Errors are surfaced via the
    // Tools dashboard if `lake` isn't on PATH; nothing happens at startup
    // when no Lean tools are invoked.
    const leanAdapter = createDirectLspLeanAdapter();
    setLeanLanguageServices(leanAdapter);
    lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => leanAdapter.dispose());

    // Attribute agent-authored commits to the TeXRA identity by default;
    // configurable via `.texra/config.json` `texra.git.markCommits`.
    applyCliGitAuthorConfig(config);
  }

  if (!serverSideKeysInitialized) {
    initializeCliSupabaseAuth(cliPlatformLog);
    initializeServerSideKeyAccess(
      { state: tryPlatform()?.globalState, logger: cliPlatformLog },
      getCliAuthProvider(),
    );
    serverSideKeysInitialized = true;
  }

  const forcePersonalApiKeys =
    context.skipIncludedModelAccess === true || context.apiMode === 'personal';
  const authed = forcePersonalApiKeys
    ? false
    : await getCliAuthProvider().isAuthenticated();
  await getServerSideKeyService().setUseIncludedModelAccess(authed);
  await setCliHelperModel(context.helperModel);

  if (bootstrappedResourcesPath !== context.resourcesPath) {
    await bootstrapPlatformAgentDirectories({
      channel: 'cli',
      resourcesPath: context.resourcesPath,
      currentVersion: undefined,
      customDirectoryStore: { get: () => undefined },
      versionStore: {
        get: () => undefined,
        update: async () => {},
      },
    });
    bootstrappedResourcesPath = context.resourcesPath;
  }

  setRuntimeSkillSources(
    defaultSkillSources({
      cwd: context.cwd,
      resourcesPath: context.resourcesPath,
    }),
  );
}
