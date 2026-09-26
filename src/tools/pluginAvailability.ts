/**
 * Each probed tool plugin's availability checks: what `@tools/plugins`
 * attaches to a plugin with an external dependency. Kept apart from the
 * manifest so the manifest stays data; built from the primitives in
 * {@link @tools/toolProbes}.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { lookupApiKeyOrigin } from '@model/apiProviders';
import { Secrets } from '@platform/secrets';
import { apiKeyEnvName } from '@shared/constants/providers';
import { importCodexClass, findCodexBinaryPath } from '@tools/codexImport';
import {
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from '@tools/claudeAgentImport';
import { hasClaudeCodeOauthToken } from '@tools/claudeAgentConfig';
import {
  getGitHubToken,
  GITHUB_TOKEN_STORAGE_KEY,
} from '@tools/github/githubAuth';
import { LEAN4_EXTENSION_ID } from '@tools/lean/leanTypes';
import { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import {
  isLeanServerActive,
  summarizeLeanServers,
  type LeanServerInfo,
} from '@tools/lean/leanServerRegistry';
import { SetupPlatform } from '@tools/setup/platform';
import {
  prerequisitesChecks,
  probeSdkBinaryAvailable,
  probeSdkBinaryStatus,
  probeZoteroBbt,
  probeZoteroConnector,
  zoteroProbePort,
  type ToolAvailabilityChecks,
} from '@tools/toolProbes';
import { ZOTERO_PORT_KEY } from '@tools/zotero/bbtClient';
import { isGitRepository } from '@utils/git/isGitRepository';
import { envVar } from '@utils/system/envFlags';
import { findToolInCommonPaths } from '@utils/system/binaryResolver';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { formatResultCount } from '@utils/text/stringUtils';

const CHANNEL = 'pluginAvailability';

/** A plugin that is probed but needs nothing installed: always available. */
export const ALWAYS_AVAILABLE: ToolAvailabilityChecks = {
  check: () => Effect.succeed(true),
};

// Interruption reaches the spawned `texcount --version`, so an interrupted
// dashboard refresh kills the probe instead of abandoning it.
export const TEXCOUNT_AVAILABILITY: ToolAvailabilityChecks = {
  check: () => checkToolInstalled('texcount', false),
};

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

export const LEAN4_AVAILABILITY = prerequisitesChecks({
  probe: () =>
    Effect.gen(function* () {
      const setup = yield* SetupPlatform;
      const lean = yield* LeanLanguageServices;
      const extensionAvailable =
        setup.extensions?.isInstalled(LEAN4_EXTENSION_ID) ?? false;
      const lakeAvailable = (yield* findToolInCommonPaths('lake')) !== null;
      // The setup port the probe already holds names the running product,
      // and only the VS Code build drives Lean through the extension.
      const requiresExtension = setup.host === 'vscode';
      return {
        extensionAvailable,
        lakeAvailable,
        requiresExtension,
        servers: lean.listServers(),
      };
    }),
  fallback: () =>
    Effect.map(LeanLanguageServices, (lean) => ({
      extensionAvailable: false,
      lakeAvailable: false,
      requiresExtension: false,
      servers: lean.listServers(),
    })),
  check: leanReady,
  statusLabel: (prerequisites) => {
    if (!leanReady(prerequisites)) return 'Needs setup';
    const activeCount = prerequisites.servers.filter(isLeanServerActive).length;
    return activeCount > 0
      ? `${formatResultCount(activeCount, 'server')} active`
      : undefined;
  },
  detailCheck: (prerequisites) => {
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
  },
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
    probe: ({ workspaceRoot }) => getGitHubPRPrerequisites(workspaceRoot),
    // Without a workspace to ask about, the token is still answerable.
    fallback: () => getGitHubPRPrerequisites(undefined),
    check: ({ tokenPresent, inGitRepo }) => tokenPresent && inGitRepo,
    statusLabel: ({ tokenPresent, inGitRepo }) => {
      if (tokenPresent && inGitRepo) return undefined;
      if (tokenPresent && !inGitRepo) return 'Needs git repo';
      if (!tokenPresent && inGitRepo) return 'Needs token';
      return 'Needs setup';
    },
    detailCheck: ({ tokenPresent, inGitRepo }) => {
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
    },
  }),
};

export const CODEX_AVAILABILITY: ToolAvailabilityChecks = {
  check: () => probeSdkBinaryAvailable(importCodexClass, findCodexBinaryPath),
  detailCheck: Effect.fn('pluginAvailability.codexDetail')(function* () {
    const status = yield* probeSdkBinaryStatus({
      importSdk: importCodexClass,
      findBinary: findCodexBinaryPath,
      missingPackageMessage:
        '@openai/codex-sdk not found. Install with: npm install -g @openai/codex',
      importFailedLabel: 'Codex SDK import failed',
      classifyImportError: (msg) =>
        msg.includes('Unsupported platform')
          ? `Platform not supported: ${msg}`
          : undefined,
      binaryNotFoundMessage:
        'Codex SDK loaded but native binary not found. ' +
        'Install with: npm install -g @openai/codex',
    });
    if (!status.ok) return status.message;
    return `Codex CLI ready. Binary: ${status.binaryPath}`;
  }),
};

export const CLAUDE_CODE_AVAILABILITY: ToolAvailabilityChecks = {
  check: () =>
    probeSdkBinaryAvailable(importClaudeAgentSdk, findClaudeBinaryPath),
  detailCheck: Effect.fn('pluginAvailability.claudeAgentDetail')(function* () {
    const status = yield* probeSdkBinaryStatus({
      importSdk: importClaudeAgentSdk,
      findBinary: findClaudeBinaryPath,
      missingPackageMessage:
        '@anthropic-ai/claude-agent-sdk not found. Reinstall TeXRA or run: npm install @anthropic-ai/claude-agent-sdk',
      importFailedLabel: 'Claude Code SDK import failed',
      binaryNotFoundMessage:
        'Claude Code SDK loaded but native `claude` binary not found. ' +
        'Install via: npm install -g @anthropic-ai/claude-code',
    });
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
    const hasOauthToken = hasClaudeCodeOauthToken();
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
};
