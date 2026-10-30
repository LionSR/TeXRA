/**
 * Each probed integration's availability checks: the `availability` of its
 * plugin value in the integration's module (`zotero/plugin.ts` and the rest), built from the primitives in
 * {@link @texra/tools/availabilityProbes}.
 */

// Third-party imports
import { formatResultCount } from '@texra-ai/harness/transcript';
import { Effect, Option, Config } from 'effect';

// Local imports
import { apiKeyEnvName, lookupApiKeyOrigin } from '@texra-ai/llm';
import { Secrets, Settings, withLogChannel } from '@texra-ai/harness/host';
import { findCommand } from '@texra/utils/system/binaryResolver';
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
} from '@texra/tools/lean/leanServerRegistry';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import { ZOTERO_PORT_KEY } from '@texra/tools/zotero/bbtClient';
import { checkToolInstalled } from '@texra/utils/system/toolChecks';
import {
  probeSdkBinaryStatus,
  probeZoteroBbt,
  probeZoteroConnector,
} from '@texra/tools/availabilityProbes';
import { isGitRepository } from '@texra/utils/git/isGitRepository';
import type { ToolAvailabilityChecks } from '@texra-ai/harness/plugins';

const CHANNEL = 'pluginAvailability';

// Interruption reaches the spawned `wolframscript -version`, so an
// interrupted dashboard refresh kills the probe instead of abandoning it.
export const WOLFRAM_AVAILABILITY: ToolAvailabilityChecks = {
  check: () =>
    Effect.map(checkToolInstalled('wolframscript', false), (available) => ({
      available,
    })),
};

export const ZOTERO_AVAILABILITY: ToolAvailabilityChecks = {
  check: Effect.fn('pluginAvailability.zotero')(function* ({ config }) {
    const port = Settings.getConfig<number>(config, ZOTERO_PORT_KEY);
    const bbtOk = yield* probeZoteroBbt(port);
    const zoteroOk = yield* probeZoteroConnector(port);
    let statusDetail = `Zotero not detected on port ${port}. Make sure Zotero is running.`;
    if (zoteroOk)
      statusDetail = bbtOk
        ? `Zotero running on port ${port}, Better BibTeX responding.`
        : `Zotero detected on port ${port}, but Better BibTeX is not responding. Install the Better BibTeX plugin.`;
    return {
      available: bbtOk,
      statusDetail,
    };
  }),
};

/** The Lean 4 plugin's checks, reading the editor extension off the host's
 *  setup capabilities (VS Code's; none elsewhere). */
export const lean4Availability = (
  setup: SetupPlatformShape,
): ToolAvailabilityChecks => ({
  check: Effect.fn('pluginAvailability.lean4')(function* () {
    // A probe reads the plugin's roster while its layer is up; it never
    // brings that layer up itself.
    const lean = yield* Effect.serviceOption(LeanLanguageServices);
    const servers = Option.isSome(lean) ? lean.value.listServers() : [];
    const extensionAvailable =
      setup.extensions?.isInstalled(LEAN4_EXTENSION_ID) ?? false;
    const lakeAvailable = (yield* findCommand('lake')) !== null;
    const requiresExtension = setup.extensions !== undefined;
    // VS Code drives Lean through its extension; other hosts spawn lake.
    const available = requiresExtension ? extensionAvailable : lakeAvailable;
    const activeCount = servers.filter(isLeanServerActive).length;
    let statusLabel: string | undefined;
    if (!available) statusLabel = 'Needs setup';
    else if (activeCount > 0)
      statusLabel = `${formatResultCount(activeCount, 'server')} active`;
    const lines: string[] = [];
    if (extensionAvailable) lines.push('VS Code Lean 4 extension installed.');
    if (lakeAvailable && !requiresExtension)
      lines.push('Direct LSP mode available (`lake` on PATH).');
    if (!available)
      lines.push(
        requiresExtension
          ? 'The VS Code build drives Lean through the leanprover.lean4 extension; install it to enable Lean tools. `lake` on PATH alone is not enough here.'
          : 'No `lake` binary was detected. Install elan and make sure `lake` is on PATH to enable Lean tools.',
      );
    lines.push('', summarizeLeanServers(servers));
    return {
      available,
      statusLabel,
      statusDetail: lines.join('\n'),
    };
  }),
});

export const GITHUB_AVAILABILITY: ToolAvailabilityChecks = {
  // The token gates the tool, so a change re-probes every held workspace.
  reprobeOnSecrets: [GITHUB_TOKEN_STORAGE_KEY],
  check: Effect.fn('pluginAvailability.github')(function* ({ workspace }) {
    const secrets = yield* Secrets;
    // The token read and the git probe run at once. The probe reports "not a
    // repository" as `false` and never fails; interrupting a dashboard
    // refresh kills its `git` process instead of abandoning it.
    const [token, inGitRepo] = yield* Effect.all(
      [getGitHubToken(secrets), isGitRepository(workspace, undefined)],
      { concurrency: 'unbounded' },
    );
    const tokenPresent = token !== undefined;
    if (tokenPresent && inGitRepo)
      return {
        available: true,
        statusDetail:
          'GitHub token detected and workspace is a git repo. Ready to subscribe to PR activity.',
      };
    if (!tokenPresent && !inGitRepo)
      return {
        available: false,
        statusLabel: 'Needs setup',
        statusDetail:
          'Open a git-tracked folder, or run git init and add a github.com remote. Then set a token in /config → GitHub token or Settings → General.',
      };
    if (!tokenPresent)
      return {
        available: false,
        statusLabel: 'Needs token',
        statusDetail:
          'This workspace is a git repo. Set a GitHub personal access token in /config → GitHub token or Settings → General to enable PR activity subscriptions.',
      };
    return {
      available: false,
      statusLabel: 'Needs git repo',
      statusDetail:
        'GitHub token is set. Open a git-tracked folder, or run git init and add a github.com remote, to use PR activity subscriptions.',
    };
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

export const CODEX_AVAILABILITY: ToolAvailabilityChecks = {
  check: () =>
    Effect.map(probeSdkBinaryStatus(CODEX_SDK_PROBE), (status) => ({
      available: status.ok,
      statusDetail: status.ok
        ? `Codex CLI ready. Binary: ${status.binaryPath}`
        : status.message,
    })),
};

export const CLAUDE_CODE_AVAILABILITY: ToolAvailabilityChecks = {
  check: Effect.fn('pluginAvailability.claudeAgent')(function* () {
    const status = yield* probeSdkBinaryStatus(CLAUDE_CODE_SDK_PROBE);
    if (!status.ok) return { available: false, statusDetail: status.message };
    const claudePath = status.binaryPath;

    const anthropicApiKeyEnv = apiKeyEnvName('anthropic');
    const secrets = yield* Secrets;
    // A secret store that will not answer is not the same fact as an unset
    // key. An environment key is still known (the launch uses it first);
    // without one the origin is unknown, and the detail says why.
    const key = yield* lookupApiKeyOrigin(secrets, 'anthropic').pipe(
      Effect.map((origin) => ({ origin, failure: null })),
      Effect.catchTag('SecretsFailed', (failure) =>
        Effect.logWarning(
          `Reading the Anthropic API key failed: ${failure.message}`,
        ).pipe(
          withLogChannel(CHANNEL),
          Effect.annotateLogs({ data: failure }),
          Effect.andThen(
            Config.String(anthropicApiKeyEnv).pipe(Config.option, Effect.orDie),
          ),
          Effect.map((env) => ({
            origin:
              Option.isSome(env) && env.value
                ? ('env' as const)
                : ('unknown' as const),
            failure: failure.message,
          })),
        ),
      ),
    );
    const hasOauthToken = Option.isSome(
      yield* Config.String('CLAUDE_CODE_OAUTH_TOKEN').pipe(
        Config.option,
        Effect.orDie,
      ),
    );
    const authBits: string[] = [];
    if (key.origin === 'secret') {
      authBits.push(`${anthropicApiKeyEnv} (TeXRA Settings)`);
    }
    if (key.origin === 'env') {
      authBits.push(`${anthropicApiKeyEnv} (environment)`);
    }
    if (hasOauthToken) authBits.push('CLAUDE_CODE_OAUTH_TOKEN');
    let authNote =
      authBits.length > 0
        ? `Auth detected: ${authBits.join(', ')}.`
        : 'No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN detected: the CLI will use whatever `claude login` session you have.';
    if (key.failure !== null)
      authNote = `${authBits.length > 0 ? authNote : 'No CLAUDE_CODE_OAUTH_TOKEN detected.'} The ${anthropicApiKeyEnv} in TeXRA Settings could not be read (${key.failure}).`;

    return {
      available: true,
      statusDetail: `Claude CLI ready. Binary: ${claudePath}. ${authNote}`,
    };
  }),
};
