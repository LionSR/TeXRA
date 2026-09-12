/**
 * External tool definitions — single source of truth.
 *
 * Each entry co-locates:
 *   - identity: id, tool names (typed via RegisteredToolName)
 *   - check function: how to detect availability at runtime
 *   - dashboard metadata: name, category, description, install guide
 *
 * Consumed by:
 *   - {@link @tools/toolAvailability} — reads id/tools/check for caching
 *   - {@link @controllers/settingsView/ToolDashboardData} — reads everything for the UI
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { hostPort } from '@common/hostPort';
import { apiKeyEnvName, lookupApiKeyOrigin } from '@model/apiProviders';
import { Secrets } from '@platform/secrets';
import type { ToolCategory } from '@shared/schemas';
import { DELEGATE_MULTI_AGENTS_TOOL_NAME } from '@shared/constants/delegationTools';
import type { RegisteredToolName } from '@tools/registry';
import { importCodexClass, findCodexBinaryPath } from '@tools/codexImport';
import {
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from '@tools/claudeAgentImport';
import { hasClaudeCodeOauthToken } from '@tools/claudeAgentConfig';
import { getGitHubToken } from '@tools/github/githubAuth';
import {
  MAX_CONCURRENT_PR_SUBSCRIPTIONS,
  MAX_CONCURRENT_REPO_SUBSCRIPTIONS,
  GITHUB_POLL_INTERVAL_MS,
} from '@tools/github/prSubscriptionConstants';
import { LEAN4_EXTENSION_ID } from '@tools/lean/leanTypes';
import {
  isLeanServerActive,
  listLeanServers,
  summarizeLeanServers,
} from '@tools/lean/leanServerRegistry';
import { SetupPlatform } from '@tools/setup/platform';
import { getZoteroPort } from '@tools/zotero/bbtClient';
import { BinaryResolver } from '@utils/system/binaryResolver';
import { IS_WINDOWS } from '@utils/system/platformPaths';
import { isWSL } from '@utils/system/wslDetect';
import {
  checkToolInstalled,
  hasPackageManager,
  SYSTEM_PACKAGE_MANAGERS,
  type SystemPackageManager,
} from '@utils/system/toolUtils';
import { isGitRepository } from '@utils/git/isGitRepository';
import { formatResultCount } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getProcessSettingHost } from '@utils/config/platformSettings';

/**
 * Node.js semver range the `texra` CLI supports; the same value
 * `packages/cli/package.json` declares as `engines.node`, so `texra doctor`
 * and npm never disagree about what runs.
 *
 * The official Effect SQLite client requires the `node:sqlite` backup,
 * columns and setReturnArrays APIs. Node 22.16.0 and Node 24 provide all
 * three; Node 23 lacks setReturnArrays.
 */
export const TEXRA_CLI_SUPPORTED_NODE_RANGE = '^22.16.0 || >=24.0.0';

const ZOTERO_PROBE_TIMEOUT_MS = 2000;

// ============================================================
// Type
// ============================================================

/**
 * The process services a group's availability callbacks read: provider
 * credentials, and the host's setup capabilities for the one group whose
 * availability depends on the editor host (Lean 4's VS Code extension).
 */
export type ToolProbeServices = Secrets | SetupPlatform;

/** Full definition for an external tool group. */
export interface ExternalToolDef {
  /** Unique group identifier (matches ToolDashboardItem.id). */
  readonly id: string;
  /** Tool names belonging to this group — must match registry keys. */
  readonly tools: readonly RegisteredToolName[];
  /** Optional shared probe result passed to check/status/detail callbacks. */
  readonly probe?: () => Effect.Effect<unknown, unknown, ToolProbeServices>;
  /** Returns true if the external dependency is available. */
  readonly check: (
    probeResult?: unknown,
  ) => Effect.Effect<boolean, unknown, ToolProbeServices>;
  /** Optional detailed status string resolved at check time (shown below description). */
  readonly detailCheck?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, unknown, ToolProbeServices>;
  /** Optional short status label for the dashboard badge. */
  readonly statusLabel?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, unknown, ToolProbeServices>;
  // Dashboard UI metadata
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  readonly installGuide?: string;
  readonly installUrl?: string;
  /** VS Code extension ID — when present, the dashboard offers a direct "Install" button. */
  readonly installExtensionId?: string;
  /** Shell command the dashboard can run in an integrated terminal to install the tool. */
  readonly installCommand?: string;
  /** Shell command the dashboard can run to sign the user in (e.g. `codex login`). */
  readonly authCommand?: string;
  readonly configNotes?: string;
  /** When true, the tool is checked for availability but not shown in the Tools tab dashboard. */
  readonly hideFromDashboard?: boolean;
  /** Short auth/billing note shown as a badge (e.g. "Uses ChatGPT subscription"). */
  readonly authNote?: string;
  /** When true, the dashboard shows an enable/disable toggle for this tool group. */
  readonly toggleable?: boolean;
}

// ============================================================
// Zotero probe helpers
// ============================================================

function fetchLocalhost(
  url: string,
  timeoutMs = ZOTERO_PROBE_TIMEOUT_MS,
): Effect.Effect<Pick<Response, 'ok' | 'status'>, unknown> {
  return Effect.acquireUseRelease(
    hostPort(() => fetch(url, { signal: AbortSignal.timeout(timeoutMs) })),
    (response) => Effect.succeed({ ok: response.ok, status: response.status }),
    // The probe never reads the body; releasing it frees the socket, and a
    // cancel that itself fails says nothing about availability.
    (response) => Effect.ignore(hostPort(() => response.body?.cancel())),
  );
}

/** Probe the Zotero connector endpoint (responds if Zotero is running). */
function probeZoteroConnector(port: number): Effect.Effect<boolean> {
  return fetchLocalhost(`http://127.0.0.1:${port}/connector/ping`).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

/** Probe the Better BibTeX JSON-RPC endpoint. */
function probeZoteroBbt(port: number): Effect.Effect<boolean> {
  return fetchLocalhost(`http://127.0.0.1:${port}/better-bibtex/json-rpc`).pipe(
    Effect.map((response) => response.ok || response.status === 405),
    Effect.catch(() => Effect.succeed(false)),
  );
}

interface GitHubPRPrerequisites {
  tokenPresent: boolean;
  inGitRepo: boolean;
}

const getGitHubPRPrerequisites = Effect.fn('getGitHubPRPrerequisites')(
  function* () {
    const secrets = yield* Secrets;
    const tokenPresent =
      (yield* hostPort(() => getGitHubToken(secrets))) !== undefined;
    const inGitRepo = yield* hostPort(isGitRepository);
    return { tokenPresent, inGitRepo };
  },
);

function resolveGitHubPRPrerequisites(
  probeResult: unknown,
): Effect.Effect<GitHubPRPrerequisites, unknown, Secrets> {
  // The probe runs in-process and its result is handed straight back here, so
  // the shape is structurally guaranteed; only a failed probe (probeResult
  // undefined) needs the re-probe fallback.
  return probeResult === undefined
    ? getGitHubPRPrerequisites()
    : Effect.succeed(probeResult as GitHubPRPrerequisites);
}

interface Lean4Prerequisites {
  extensionAvailable: boolean;
  lakeAvailable: boolean;
  /** The VS Code build drives Lean through the lean4 extension; other hosts spawn `lake` directly. */
  requiresExtension: boolean;
}

function resolveLean4Prerequisites(probeResult: unknown): Lean4Prerequisites {
  // In-process probe shape is structurally guaranteed; only a missing/absent
  // probe (probeResult undefined) falls back to the not-detected defaults.
  return probeResult === undefined
    ? {
        extensionAvailable: false,
        lakeAvailable: false,
        requiresExtension: false,
      }
    : (probeResult as Lean4Prerequisites);
}

/** Lean tools work through the extension in VS Code and through `lake` elsewhere. */
function leanReady(prerequisites: Lean4Prerequisites): boolean {
  return prerequisites.requiresExtension
    ? prerequisites.extensionAvailable
    : prerequisites.lakeAvailable;
}

/** True when an SDK import failure means the package simply isn't installed. */
function isMissingPackageError(message: string): boolean {
  return (
    message.includes('not found') ||
    message.includes('MODULE_NOT_FOUND') ||
    message.includes('Cannot find package')
  );
}

/** Appended to install hints when running under WSL, where side matters. */
function wslInstallHint(): string {
  return isWSL ? ' (run this inside WSL, not on the Windows side)' : '';
}

/**
 * Availability check shared by the SDK-backed CLI integrations (Codex, Claude
 * Code): the dependency is present when its SDK imports and the native binary
 * resolves. Any import or resolution failure counts as unavailable.
 */
function probeSdkBinaryAvailable(
  importSdk: () => Promise<unknown>,
  findBinary: () => Promise<string | undefined>,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    yield* hostPort(importSdk);
    return (yield* hostPort(findBinary)) != null;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

/** Resolved status of an SDK-backed CLI integration for the dashboard. */
type SdkBinaryStatus =
  { ok: false; message: string } | { ok: true; binaryPath: string };

/**
 * Human-readable probe shared by the SDK-backed CLI integrations (Codex,
 * Claude Code): import the SDK (classifying a missing package specially),
 * then resolve the native binary (appending {@link wslInstallHint} when it is
 * absent). Callers own only the final "ready" line, so the import/binary
 * narrative lives in one place instead of once per entry.
 */
function probeSdkBinaryStatus(config: {
  importSdk: () => Promise<unknown>;
  findBinary: () => Promise<string | undefined>;
  missingPackageMessage: string;
  importFailedLabel: string;
  binaryNotFoundMessage: string;
  classifyImportError?: (msg: string) => string | undefined;
}): Effect.Effect<SdkBinaryStatus, unknown> {
  return Effect.gen(function* () {
    // Only the import is classified into a message; a binary-resolution
    // failure stays on the error channel, as it did when it threw past the
    // import's try/catch.
    const importFailure = yield* hostPort(config.importSdk).pipe(
      Effect.as(undefined),
      Effect.catch((err: unknown) => {
        const msg = toErrorMessage(err);
        if (isMissingPackageError(msg)) {
          return Effect.succeed(config.missingPackageMessage);
        }
        const classified = config.classifyImportError?.(msg);
        if (classified != null) return Effect.succeed(classified);
        return Effect.succeed(`${config.importFailedLabel}: ${msg}`);
      }),
    );
    if (importFailure !== undefined) {
      return { ok: false as const, message: importFailure };
    }

    const binaryPath = yield* hostPort(config.findBinary);
    if (!binaryPath) {
      return {
        ok: false as const,
        message: config.binaryNotFoundMessage + wslInstallHint(),
      };
    }
    return { ok: true as const, binaryPath };
  });
}

/**
 * Wire a prerequisites-style availability entry. `probe` runs once and its
 * result is cached by the availability layer, then handed back to every
 * callback as `probeResult`. `resolve` turns that (possibly absent) cached
 * value into a typed prerequisites object which `check`/`statusLabel`/
 * `detailCheck` receive directly — so each entry declares the
 * `resolve(probeResult)` step once instead of repeating it in all three
 * callbacks, and those callbacks stay pure functions of the resolved value.
 */
function prerequisitesChecks<T>(config: {
  probe: () => Effect.Effect<T, unknown, ToolProbeServices>;
  resolve: (
    probeResult: unknown,
  ) => Effect.Effect<T, unknown, ToolProbeServices>;
  check: (prereqs: T) => boolean;
  statusLabel: (prereqs: T) => string | undefined;
  detailCheck: (prereqs: T) => string | undefined;
}): Pick<ExternalToolDef, 'probe' | 'check' | 'statusLabel' | 'detailCheck'> {
  const { probe, resolve, check, statusLabel, detailCheck } = config;
  return {
    probe,
    check: (probeResult) => Effect.map(resolve(probeResult), check),
    statusLabel: (probeResult) => Effect.map(resolve(probeResult), statusLabel),
    detailCheck: (probeResult) => Effect.map(resolve(probeResult), detailCheck),
  };
}

/**
 * Pick the install command to offer for a CLI on this machine.
 *
 * `npm install -g` assumes Node is on PATH, which desktop-app users who
 * installed TeXRA from a .dmg or .exe often do not have. When the system
 * package manager also ships the CLI, offer that command instead.
 *
 * `win32` takes precedence over any package manager: a global npm install
 * leaves only shell shims on Windows, which TeXRA cannot spawn (see
 * support/externalBinaryUtils.ts), so a CLI with a Windows installer has to
 * use it rather than npm.
 *
 * Only managers this command map actually names are probed, so a Linux box
 * with both apt and Linuxbrew still gets the brew command rather than falling
 * through to npm.
 *
 * Definitions call this from an `installCommand` getter so the probe stays
 * lazy — `hasPackageManager()` probes once per manager and caches, so reading
 * the property repeatedly costs nothing after the first access.
 */
function preferredInstallCommand(
  commands: Partial<Record<SystemPackageManager | 'win32', string>> & {
    default: string;
  },
): string {
  if (commands.win32 != null && IS_WINDOWS) return commands.win32;
  for (const manager of SYSTEM_PACKAGE_MANAGERS) {
    const command = commands[manager];
    if (command != null && hasPackageManager(manager)) return command;
  }
  return commands.default;
}

// ============================================================
// Definitions
// ============================================================

export const EXTERNAL_TOOL_DEFS: readonly ExternalToolDef[] = [
  {
    id: 'texcount',
    tools: ['texcount'],
    name: 'TeXcount',
    category: 'latex',
    description:
      'Count words, headers, figures, and other elements in LaTeX documents.',
    installGuide:
      'TeXcount is a Perl script for counting words in LaTeX files.\n\n' +
      'Installation:\n' +
      '  Mac:     brew install texcount\n' +
      '  Ubuntu:  sudo apt-get install texlive-extra-utils\n' +
      '  Windows: Install via MiKTeX or TeX Live package manager',
    installUrl: 'https://app.uio.no/ifi/texcount/',
    configNotes: 'Part of most TeX Live distributions.',
    hideFromDashboard: true, // Shown in LaTeX settings tab instead
    check: () => hostPort(() => checkToolInstalled('texcount', false)),
  },
  {
    id: 'wolfram',
    tools: ['wolfram'],
    name: 'Wolfram Language',
    category: 'computation',
    description:
      'Execute Wolfram Language code for symbolic math, computation, and data analysis.',
    installGuide:
      'Requires the "wolframscript" command-line tool.\n\n' +
      'Install the free Wolfram Engine:\n' +
      '  Mac:     brew install --cask wolfram-engine\n' +
      '  Ubuntu:  Download from wolfram.com/engine\n' +
      '  Windows: Download from wolfram.com/engine\n\n' +
      'Note: A Mathematica installation alone is not enough: you\n' +
      'need WolframScript on your PATH. The Wolfram Engine includes\n' +
      'it automatically. Free licenses are available for development use.',
    installUrl: 'https://www.wolfram.com/engine/',
    configNotes: 'Requires the free Wolfram Engine (provides wolframscript).',
    check: () => hostPort(() => checkToolInstalled('wolframscript', false)),
  },
  {
    id: 'zotero',
    tools: [
      'zotero_collections',
      'zotero_search',
      'zotero_add',
      'zotero_export',
    ],
    name: 'Zotero Integration',
    category: 'ai-agents',
    description:
      'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
    installGuide:
      'Requires Zotero with the Better BibTeX plugin installed.\n\n' +
      'Setup:\n' +
      '  1. Install Zotero (zotero.org)\n' +
      '  2. Install Better BibTeX plugin:\n' +
      '     - Download from retorque.re/zotero-better-bibtex\n' +
      '     - In Zotero: Tools > Add-ons > Install from File\n' +
      '  3. Keep Zotero running while using TeXRA\n\n' +
      'Better BibTeX exposes a JSON-RPC API on localhost:23119\n' +
      'that TeXRA uses to communicate with your library.',
    installUrl: 'https://retorque.re/zotero-better-bibtex/installation/',
    configNotes:
      'Zotero must be running with Better BibTeX installed. Port configurable via texra.bib.zoteroPort.',
    toggleable: true,
    check: () => probeZoteroBbt(getZoteroPort()),
    detailCheck: Effect.fn('externalToolDefs.zoteroDetail')(function* () {
      const port = getZoteroPort();
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
  },
  {
    id: 'lean4',
    tools: ['lean_diagnostics', 'lean_file', 'lean_project', 'lean_inspect'],
    name: 'Lean 4 Proof Assistant',
    category: 'lean',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, and manage files. Active language servers are listed below. (lean_loogle needs only network access and is always available.)',
    installGuide:
      'TeXRA can drive Lean 4 in two ways:\n\n' +
      '  • VS Code build: uses the "lean4" extension\n' +
      '    (leanprover.lean4) and its running language server.\n' +
      '  • CLI / desktop build: spawns `lake env lean --server`\n' +
      '    directly (one process per Lake project; idle ones stop\n' +
      '    after thirty minutes). Requires `lake` (from elan/Lean) on\n' +
      '    PATH; install via\n' +
      '    https://leanprover-community.github.io/install/.\n\n' +
      'Setup (VS Code):\n' +
      '  1. Install the "lean4" extension from VS Code Marketplace\n' +
      '  2. Open a Lean 4 project (with lakefile.lean or lakefile.toml)\n' +
      '  3. The extension will auto-install elan and Lean toolchain\n\n' +
      'Setup (CLI / desktop):\n' +
      '  1. Install elan: `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`\n' +
      '  2. Make sure `lake` is on PATH in a fresh shell\n' +
      '  3. Open a folder containing a lakefile.lean / lakefile.toml',
    installUrl:
      'https://marketplace.visualstudio.com/items?itemName=leanprover.lean4',
    installExtensionId: LEAN4_EXTENSION_ID,
    configNotes:
      'VS Code build: requires the leanprover.lean4 extension. ' +
      'CLI / desktop builds: requires `lake` on PATH; each Lake project can have its own language server, and idle ones stop after thirty minutes, surfaced below.',
    ...prerequisitesChecks({
      probe: () =>
        Effect.gen(function* () {
          const setup = yield* SetupPlatform;
          const extensionAvailable =
            setup.extensions?.isInstalled(LEAN4_EXTENSION_ID) ?? false;
          const lakeAvailable = BinaryResolver.findPath('lake') !== null;
          const requiresExtension = getProcessSettingHost() === 'vscode';
          return { extensionAvailable, lakeAvailable, requiresExtension };
        }),
      resolve: (probeResult) =>
        Effect.succeed(resolveLean4Prerequisites(probeResult)),
      check: leanReady,
      statusLabel: (prerequisites) => {
        if (!leanReady(prerequisites)) return 'Needs setup';
        const activeCount = listLeanServers().filter(isLeanServerActive).length;
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
        lines.push(summarizeLeanServers());
        return lines.join('\n');
      },
    }),
  },
  {
    id: 'workflow-script',
    tools: [DELEGATE_MULTI_AGENTS_TOOL_NAME],
    name: 'Multi-Agent Workflow',
    category: 'workflow',
    description:
      'Run deterministic JavaScript workflow scripts that fan out, pipeline, and join calls to sub-agents, resuming safely after interruption. An agent only gets this tool if its own configuration names it: this switch is an additional kill switch on top of that per-agent opt-in.',
    configNotes:
      'No local install required. Turning this off removes delegate_multi_agents from every agent tool list, even agents whose configuration names it explicitly.',
    toggleable: true,
    check: () => Effect.succeed(true),
  },

  {
    // ID kept as `github-pr-subscription` for back-compat with persisted
    // disabled-tool preferences. The user-facing name has expanded to
    // cover repos and issues but the persistence key is stable.
    id: 'github-pr-subscription',
    tools: ['github_subscription'],
    name: 'GitHub Activity Subscription',
    category: 'ai-agents',
    description:
      'Poll GitHub for pull request, issue, and repository activity. Path mirrors GitHub URL shape: "owner/repo" for coarse repo-wide events, "owner/repo/pulls/N" for per-PR comments/reviews/CI, "owner/repo/issues/N" for issue comments and lifecycle.',
    installGuide:
      'Requires a git-tracked workspace and a GitHub personal access token:\n\n' +
      '  1. Open the folder as a git repo (or `git init` + set a github.com remote).\n' +
      '  2. In the CLI, /config → GitHub token can store a token or open the token page with the right scopes pre-filled. In VS Code, use TeXRA settings → Git tab.\n' +
      '  3. Scopes: "repo" for private repositories, "public_repo" for public only.\n' +
      '  4. Store the token in host secret storage, or export GITHUB_TOKEN/GH_TOKEN for CLI and automation.',
    installUrl: 'https://github.com/settings/tokens',
    configNotes: `Token stored in host secret storage or read from GITHUB_TOKEN/GH_TOKEN. The CLI /config → GitHub token row and the VS Code Git tab both manage the stored token. Requires a git repository in the workspace. Polls every ${GITHUB_POLL_INTERVAL_MS / 1000}s; cap: ${MAX_CONCURRENT_PR_SUBSCRIPTIONS} concurrent PRs and ${MAX_CONCURRENT_REPO_SUBSCRIPTIONS} concurrent repos. Bot-authored events are dropped end-to-end by policy.`,
    authNote: 'Uses personal access token',
    toggleable: true,
    ...prerequisitesChecks({
      probe: getGitHubPRPrerequisites,
      resolve: resolveGitHubPRPrerequisites,
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
          return 'Open a git-tracked folder, or run git init and add a github.com remote. Then set a token in /config → GitHub token or the Git tab.';
        }
        if (!tokenPresent) {
          return 'This workspace is a git repo. Set a GitHub personal access token in /config → GitHub token or the Git tab to enable PR activity subscriptions.';
        }
        return 'GitHub token is set. Open a git-tracked folder, or run git init and add a github.com remote, to use PR activity subscriptions.';
      },
    }),
  },

  {
    id: 'external-inquiry',
    tools: ['inquiry'],
    name: 'External Inquiry',
    category: 'ai-agents',
    description:
      'Use premium chat subscriptions such as ChatGPT Pro, Claude Opus, Gemini Deep Think, and Grok without an API key. The agent drafts a question, you paste the answer back, and the run continues. Useful for the deep-reasoning tiers that aren’t available through the API.',
    configNotes:
      'No local install required. Uses your own external chat subscription through a human-in-the-loop copy/paste flow.',
    authNote: 'Uses your premium chat subscription',
    toggleable: true,
    check: () => Effect.succeed(true),
  },

  {
    id: 'codex',
    tools: ['codex'],
    name: 'OpenAI Codex CLI',
    category: 'ai-agents',
    description:
      'OpenAI Codex agent runtime. Required by the Codex SDK for local code generation and analysis.',
    installGuide:
      'Install the Codex CLI (choose one):\n\n' +
      '  npm install -g @openai/codex\n' +
      '  brew install codex          (macOS)\n\n' +
      'On Windows, use WSL or the Codex app.\n' +
      'In WSL, install inside the WSL environment (not on the Windows side).\n' +
      'See: https://developers.openai.com/codex/cli\n\n' +
      'Authentication (choose one):\n' +
      '  • codex login       : sign in with ChatGPT account (recommended)\n' +
      '  • OPENAI_API_KEY    : environment variable with API key',
    installUrl: 'https://github.com/openai/codex',
    get installCommand() {
      return preferredInstallCommand({
        brew: 'brew install codex',
        default: 'npm install -g @openai/codex',
      });
    },
    authCommand: 'codex login',
    configNotes:
      'Requires @openai/codex npm package with platform binaries. Used by @openai/codex-sdk. ' +
      'Supports OAuth via `codex login` or OPENAI_API_KEY env var.',
    authNote: 'Uses ChatGPT subscription (free with Plus/Pro)',
    toggleable: true,
    check: () => probeSdkBinaryAvailable(importCodexClass, findCodexBinaryPath),
    detailCheck: Effect.fn('externalToolDefs.codexDetail')(function* () {
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
  },

  {
    // ID kept as `claude-agent` for back-compat with persisted disabled-tool
    // preferences. The user-facing name has been rebranded to "Claude Code CLI"
    // and the tool name string is `claude_code`, but the persistence key is
    // stable.
    id: 'claude-agent',
    tools: ['claude_code'],
    name: 'Claude Code CLI',
    category: 'ai-agents',
    description:
      'Spin off a Claude Code CLI agent that works in your workspace. It can read files, run commands, edit code, and search the web on your behalf. Use it to delegate focused exploration or implementation while another agent stays in charge.',
    installGuide:
      'Install the Claude Code CLI (choose one):\n\n' +
      '  npm install -g @anthropic-ai/claude-code\n' +
      '  brew install --cask claude-code     (macOS)\n' +
      '  winget install Anthropic.ClaudeCode (Windows)\n\n' +
      'Or use the native installer from https://claude.com/code (recommended).\n' +
      'See: https://code.claude.com/docs/en/setup\n\n' +
      'Authentication (choose one):\n' +
      '  • Set ANTHROPIC_API_KEY in TeXRA Settings → API Keys → Anthropic\n' +
      '  • claude login         : OAuth sign-in (Pro/Max subscription, recommended)\n' +
      '  • claude setup-token   : long-lived OAuth token (CLAUDE_CODE_OAUTH_TOKEN)\n' +
      '  • ANTHROPIC_API_KEY    : environment variable with Console API key',
    installUrl: 'https://code.claude.com/docs/en/setup',
    get installCommand() {
      return preferredInstallCommand({
        brew: 'brew install --cask claude-code',
        win32: 'winget install Anthropic.ClaudeCode',
        default: 'npm install -g @anthropic-ai/claude-code',
      });
    },
    authCommand: 'claude login',
    configNotes:
      'Requires the native `claude` binary. Supports OAuth (`claude login`), long-lived tokens (`claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN), or ANTHROPIC_API_KEY (resolved from TeXRA Settings → API Keys or the environment).',
    authNote: 'OAuth, OAuth token, or API key',
    toggleable: true,
    check: () =>
      probeSdkBinaryAvailable(importClaudeAgentSdk, findClaudeBinaryPath),
    detailCheck: Effect.fn('externalToolDefs.claudeAgentDetail')(function* () {
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
      const keyOrigin = yield* hostPort(() =>
        lookupApiKeyOrigin(secrets, 'anthropic'),
      ).pipe(
        Effect.catch(() =>
          Effect.succeed(process.env[anthropicApiKeyEnv] ? 'env' : 'none'),
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
  },

  // System dependencies (latexindent, image processing) have moved to the
  // LaTeX settings tab — see LaTeXTab.ts and SettingsViewMessageHandler.ts.
];

/**
 * Tool definitions indexed by id. The array above stays the ordered source of
 * truth (dashboard renders in declaration order); this map is the native
 * lookup structure for id resolution.
 */
const EXTERNAL_TOOL_DEFS_BY_ID: ReadonlyMap<string, ExternalToolDef> = new Map(
  EXTERNAL_TOOL_DEFS.map((d) => [d.id, d]),
);

/** Look up a tool definition by id. */
export function findExternalToolDef(id: string): ExternalToolDef | undefined {
  return EXTERNAL_TOOL_DEFS_BY_ID.get(id);
}
