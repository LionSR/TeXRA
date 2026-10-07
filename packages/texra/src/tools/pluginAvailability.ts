/**
 * Each probed integration's availability checks: the `availability` of its
 * plugin value in `@tools/integrationPlugins`, built from the primitives in
 * {@link @texra/tools/availabilityProbes}.
 */

// Third-party imports
import { Effect, Option } from 'effect';

// Local imports
import { apiKeyEnvName, lookupApiKeyOrigin } from '@texra-ai/llm';
import {
  Secrets,
  type ToolAvailabilityChecks,
  type ToolProbeServices,
} from '@texra-ai/harness';
import { withLogChannel } from '@logger/effectLog';
import {
  importCodexClass,
  findCodexBinaryPath,
} from '@texra/tools/codexImport';
import {
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from '@texra/tools/claudeAgentImport';
import {
  getGitHubToken,
  GITHUB_TOKEN_STORAGE_KEY,
} from '@texra/tools/github/githubAuth';
import { LEAN4_EXTENSION_ID } from '@texra/tools/lean/leanTypes';
import { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import {
  isLeanServerActive,
  summarizeLeanServers,
  type LeanServerInfo,
} from '@texra/tools/lean/leanServerRegistry';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { ZOTERO_PORT_KEY } from '@texra/tools/zotero/bbtClient';
import { checkToolInstalled } from '@texra/utils/system/toolChecks';
import {
  prerequisitesChecks,
  probeSdkBinaryStatus,
  probeZoteroBbt,
  probeZoteroConnector,
  zoteroProbePort,
  type SdkBinaryStatus,
} from '@texra/tools/availabilityProbes';
import { isGitRepository } from '@texra/utils/git/isGitRepository';
import { envVar } from '@utils/system/envFlags';
import { findToolInCommonPaths } from '@utils/system/binaryResolver';
import { formatResultCount } from '@utils/text/stringUtils';

const CHANNEL = 'pluginAvailability';

// Interruption reaches the spawned `wolframscript -version`, so an
// interrupted dashboard refresh kills the probe instead of abandoning it.
export const WOLFRAM_AVAILABILITY: ToolAvailabilityChecks = {
  check: () => checkToolInstalled('wolframscript', false),
};

export const ZOTERO_AVAILABILITY: ToolAvailabilityChecks = {
  probe: ({ config }) => Effect.succeed(config.get<number>(ZOTERO_PORT_KEY)),
  check: (probeResult) => probeZoteroBbt(zoteroProbePort(probeResult)),
  detailCheck: Effect.fn('pluginAvailability.zoteroDetail')(function* (
    probeResult?: unknown,
  ) {
    const port = zoteroProbePort(probeResult);
    const zoteroOk = yield* probeZoteroConnector(port);
    const bbtOk = yield* probeZoteroBbt(port);
    if (zoteroOk && bbtOk) {
      return `Zotero running on port ${port}, Better BibTeX responding.`;
    }
    if (zoteroOk && !bbtOk) {
      return `Zotero detected on port ${port}, but Better BibTeX is not responding. Install the Better BibTeX plugin.`;
    }
    return `Zotero not detected on port ${port}. Make sure Zotero is running.`;
  }),
};

interface Lean4Prerequisites {
  extensionAvailable: boolean;
  lakeAvailable: boolean;
  /** The VS Code build drives Lean through the lean4 extension; other hosts spawn `lake` directly. */
  requiresExtension: boolean;
  /** The host adapter's roster at probe time, read through the Lean port. */
  servers: readonly LeanServerInfo[];
}

/** Lean tools work through the extension in VS Code and through `lake` elsewhere. */
function leanReady(prerequisites: Lean4Prerequisites): boolean {
  return prerequisites.requiresExtension
    ? prerequisites.extensionAvailable
    : prerequisites.lakeAvailable;
}

/** The Lean plugin's server roster, from its own services while its layer
 *  is up; none before (a probe never brings the layer up). */
const leanServers = Effect.map(
  Effect.serviceOption(LeanLanguageServices),
  Option.match({
    onNone: (): readonly LeanServerInfo[] => [],
    onSome: (lean) => lean.listServers(),
  }),
);

/** The Lean 4 plugin's checks, reading the editor extension off the host's
 *  setup capabilities (VS Code's; none elsewhere). */
export const lean4Availability = (setup: SetupPlatformShape) =>
  prerequisitesChecks({
    probe: (inputs) =>
      Effect.gen(function* () {
        const servers = yield* leanServers;
        const extensionAvailable =
          setup.extensions?.isInstalled(LEAN4_EXTENSION_ID) ?? false;
        const lakeAvailable = (yield* findToolInCommonPaths('lake')) !== null;
        // Only the VS Code build drives Lean through the extension.
        const requiresExtension = inputs.host === 'vscode';
        return {
          extensionAvailable,
          lakeAvailable,
          requiresExtension,
          servers,
        };
      }),
    fallback: () =>
      Effect.map(leanServers, (servers) => ({
        extensionAvailable: false,
        lakeAvailable: false,
        requiresExtension: false,
        servers,
      })),
    check: leanReady,
    statusLabel: (prerequisites) => {
      if (!leanReady(prerequisites)) return 'Needs setup';
      const activeCount =
        prerequisites.servers.filter(isLeanServerActive).length;
      return activeCount > 0
        ? `${formatResultCount(activeCount, 'server')} active`
        : undefined;
    },
    detailCheck: (prerequisites) =>
      Effect.sync(() => {
        const { extensionAvailable, lakeAvailable, requiresExtension } =
          prerequisites;
        const lines: string[] = [];
        if (extensionAvailable) {
          lines.push('VS Code Lean 4 extension installed.');
        }
        if (lakeAvailable && !requiresExtension) {
          lines.push('Direct LSP mode available (`lake` on PATH).');
        }
        if (!leanReady(prerequisites)) {
          lines.push(
            requiresExtension
              ? 'The VS Code build drives Lean through the leanprover.lean4 extension; install it to enable Lean tools. `lake` on PATH alone is not enough here.'
              : 'No `lake` binary was detected. Install elan and make sure `lake` is on PATH to enable Lean tools.',
          );
        }
        lines.push('');
        lines.push(summarizeLeanServers(prerequisites.servers));
        return lines.join('\n');
      }),
  });

const getGitHubPRPrerequisites = Effect.fn('getGitHubPRPrerequisites')(
  function* (workspaceRoot: string | undefined) {
    const secrets = yield* Secrets;
    const tokenPresent = (yield* getGitHubToken(secrets)) !== undefined;
    // The probe reports "not a repository" as `false` and never fails;
    // interrupting a dashboard refresh kills its `git` process instead of
    // abandoning it. An availability probe carries the workspace root and
    // nothing else: `ToolAvailabilityChecks.probe` takes no setting slots.
    const inGitRepo = yield* isGitRepository(workspaceRoot, undefined);
    return { tokenPresent, inGitRepo };
  },
);

export const GITHUB_AVAILABILITY: ToolAvailabilityChecks = {
  // The token gates the `github_subscription` tool group, so setting or
  // clearing it re-probes the Tools tab and the next run's tool list.
  reprobeOnSecrets: [GITHUB_TOKEN_STORAGE_KEY],
  ...prerequisitesChecks({
    probe: ({ workspace }) => getGitHubPRPrerequisites(workspace),
    // Without a workspace to ask about, the token is still answerable.
    fallback: () => getGitHubPRPrerequisites(undefined),
    check: ({ tokenPresent, inGitRepo }) => tokenPresent && inGitRepo,
    statusLabel: ({ tokenPresent, inGitRepo }) => {
      if (tokenPresent && inGitRepo) return undefined;
      if (tokenPresent && !inGitRepo) return 'Needs git repo';
      if (!tokenPresent && inGitRepo) return 'Needs token';
      return 'Needs setup';
    },
    detailCheck: ({ tokenPresent, inGitRepo }) =>
      Effect.sync(() => {
        if (tokenPresent && inGitRepo) {
          return 'GitHub token detected and workspace is a git repo. Ready to subscribe to PR activity.';
        }
        if (!tokenPresent && !inGitRepo) {
          return 'Open a git-tracked folder, or run git init and add a github.com remote. Then set a token in /config → GitHub token or Settings → General.';
        }
        if (!tokenPresent) {
          return 'This workspace is a git repo. Set a GitHub personal access token in /config → GitHub token or Settings → General to enable PR activity subscriptions.';
        }
        return 'GitHub token is set. Open a git-tracked folder, or run git init and add a github.com remote, to use PR activity subscriptions.';
      }),
  }),
};

// The SDK import and binary lookup run once, as the shared probe; a lookup
// that errors (EACCES, EMFILE) stays on the error channel, so the dashboard
// reports the check as failed rather than the tool as not installed.
const CODEX_SDK_PROBE = {
  importSdk: importCodexClass,
  findBinary: findCodexBinaryPath,
  importFailedLabel: 'Codex SDK import failed',
  classifyImportError: (msg: string) =>
    msg.includes('Unsupported platform')
      ? `Platform not supported: ${msg}`
      : undefined,
  binaryNotFoundMessage:
    'Codex SDK loaded but native binary not found. ' +
    'Install with: npm install -g @openai/codex',
};

const CLAUDE_CODE_SDK_PROBE = {
  importSdk: importClaudeAgentSdk,
  findBinary: findClaudeBinaryPath,
  importFailedLabel: 'Claude Code SDK import failed',
  binaryNotFoundMessage:
    'Claude Code SDK loaded but native `claude` binary not found. ' +
    'Install via: npm install -g @anthropic-ai/claude-code',
};

export const CODEX_AVAILABILITY = prerequisitesChecks<
  SdkBinaryStatus,
  ToolProbeServices
>({
  probe: () => probeSdkBinaryStatus(CODEX_SDK_PROBE),
  fallback: () => probeSdkBinaryStatus(CODEX_SDK_PROBE),
  check: (status) => status.ok,
  detailCheck: (status) =>
    Effect.succeed(
      status.ok
        ? `Codex CLI ready. Binary: ${status.binaryPath}`
        : status.message,
    ),
});

export const CLAUDE_CODE_AVAILABILITY = prerequisitesChecks<
  SdkBinaryStatus,
  ToolProbeServices
>({
  probe: () => probeSdkBinaryStatus(CLAUDE_CODE_SDK_PROBE),
  fallback: () => probeSdkBinaryStatus(CLAUDE_CODE_SDK_PROBE),
  check: (status) => status.ok,
  detailCheck: Effect.fn('pluginAvailability.claudeAgentDetail')(function* (
    status: SdkBinaryStatus,
  ) {
    if (!status.ok) return status.message;
    const claudePath = status.binaryPath;

    const anthropicApiKeyEnv = apiKeyEnvName('anthropic');
    const secrets = yield* Secrets;
    const keyOrigin = yield* lookupApiKeyOrigin(secrets, 'anthropic').pipe(
      // A secret store that will not answer is not the same fact as an
      // unset key, so the environment fallback names the failure.
      Effect.catchTag('SecretsFailed', (failure) =>
        Effect.logWarning(
          `Reading the Anthropic API key failed; reporting the environment instead: ${failure.message}`,
        ).pipe(
          withLogChannel(CHANNEL),
          Effect.andThen(envVar(anthropicApiKeyEnv)),
          Effect.map((value) => (value ? ('env' as const) : ('none' as const))),
        ),
      ),
    );
    const hasOauthToken =
      (yield* envVar('CLAUDE_CODE_OAUTH_TOKEN')) !== undefined;
    const authBits: string[] = [];
    if (keyOrigin === 'secret') {
      authBits.push(`${anthropicApiKeyEnv} (TeXRA Settings)`);
    }
    if (keyOrigin === 'env') {
      authBits.push(`${anthropicApiKeyEnv} (environment)`);
    }
    if (hasOauthToken) authBits.push('CLAUDE_CODE_OAUTH_TOKEN');
    const authNote =
      authBits.length > 0
        ? `Auth detected: ${authBits.join(', ')}.`
        : 'No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN detected: the CLI will use whatever `claude login` session you have.';

    return `Claude CLI ready. Binary: ${claudePath}. ${authNote}`;
  }),
});
