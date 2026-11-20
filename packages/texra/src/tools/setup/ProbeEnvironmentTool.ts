// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as os from 'node:os';
import { Config, Effect, Option, Predicate, Schema } from 'effect';

// Local imports
import { API_KEY_PROVIDER_IDS, apiKeyEntry, apiKey } from '@texra-ai/llm';
import { SubscriptionAccounts } from '@texra-ai/llm/node';
import type { SettingsStores } from '@texra-ai/harness/plugins';
import { CHATGPT_SETUP_MODEL } from '@texra/model/setupModelDefaults';
import { ToolContext } from '@texra-ai/harness/plugins';
import {
  CommandDirs,
  homeDirectory,
  withExtendedPath,
} from '@texra-ai/harness/node';
import {
  executed,
  ToolError,
  defineTool,
  Secrets,
  withLogChannel,
  optionalInput,
} from '@texra-ai/harness/plugins';
import { probeLatexTools } from '@latex/latexToolchain';
import { EditorIntegration } from '@texra/hosts/editorIntegration';
import {
  hasUsableSetupCredential,
  loadModelOptions,
} from '@texra/model/setupCredentialAccess';
import {
  IMAGE_LATEX_TOOLS,
  IMAGE_TOOL_LABEL,
  LATEX_TOOL_ENTRIES,
  LATEX_WORKSHOP_EXT_ID,
  type LatexToolName,
  missingLatexTools,
  PROBED_LATEX_TOOLS,
} from '@texra/shared/constants/latexToolchain';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@texra/tools/github/githubAuth';
import { findCommand } from '@texra/utils/system/binaryResolver';
import { detectPackageManager } from '@texra/utils/system/toolChecks';

import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Local file imports

import { SetupHost } from './platform';

/**
 * The ChatGPT subscription routing probe could not answer. It reads the
 * routing built from the stored OAuth session; it never reports "no
 * subscription" this way, which is a value.
 */
class SubscriptionProbeFailed extends Schema.TaggedError<SubscriptionProbeFailed>()(
  'SubscriptionProbeFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Subscription access reported separately from provider API keys. */
export const getChatGptSubscriptionStatus = Effect.fn(
  'getChatGptSubscriptionStatus',
)(function* (
  stores: SettingsStores,
): Effect.fn.Return<
  { signedIn: boolean; enabled: boolean },
  SubscriptionProbeFailed,
  Secrets | SubscriptionAccounts
> {
  const accounts = yield* SubscriptionAccounts;
  const status = yield* accounts['chatgpt-subscription'].getStatus().pipe(
    Effect.mapError(
      (cause) =>
        new SubscriptionProbeFailed({
          message: 'The ChatGPT subscription session could not be read.',
          cause,
        }),
    ),
  );
  // Routing is consulted only for a signed-in account.
  if (!status.signedIn) return { signedIn: false, enabled: false };
  const [option] = yield* loadModelOptions(stores, [CHATGPT_SETUP_MODEL]).pipe(
    Effect.mapError(
      (cause) =>
        new SubscriptionProbeFailed({
          message: 'ChatGPT subscription routing could not be resolved.',
          cause,
        }),
    ),
  );
  return {
    signedIn: true,
    enabled: option?.usageRoute === 'chatgpt-subscription',
  };
});

const CHANNEL = 'Setup Credentials';
const ProbeEnvironmentInputSchema = Schema.Struct({
  tool: optionalInput(
    Schema.String,
    'If provided, re-checks just this one tool on PATH (e.g. "pdflatex") and answers in one line. Otherwise returns the full JSON report.',
  ),
});

type ProbeInput = typeof ProbeEnvironmentInputSchema.Type;

const OPTIONAL_TOOLS = ['git', 'node', 'python3'] as const;

/** Installation status of one probed tool, with its path when discoverable. */
interface ToolStatus {
  readonly name: string;
  readonly installed: boolean;
  readonly path: string | undefined;
}

/**
 * Whether one tool is installed: a catalog tool as the toolchain probe
 * reports it, any other binary (`node`, `python3`, one the user asks about)
 * by a PATH search, which also supplies the path presented beside the flag.
 */
const locateTool = Effect.fn('locateTool')(function* (
  name: string,
): Effect.fn.Return<ToolStatus, never, ChildProcessSpawner> {
  if (Object.hasOwn(LATEX_TOOL_ENTRIES, name)) {
    // cast: `hasOwn` just found `name` among the catalog's keys.
    const { tools } = yield* probeLatexTools([name as LatexToolName]);
    return tools[0];
  }
  const found = yield* findCommand(name);
  return { name, installed: found !== null, path: found?.resolvedPath };
});

/** OS, arch and shell; the shell comes from the ambient ConfigProvider. */
const readHostInfo = Effect.map(
  Effect.all([
    Config.String('SHELL').pipe(Config.option, Effect.orDie),
    Config.String('ComSpec').pipe(Config.option, Effect.orDie),
  ]),
  ([shell, comSpec]) => ({
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    shell:
      Option.getOrUndefined(Option.orElse(shell, () => comSpec)) ?? 'unknown',
  }),
);

const probe = Effect.fn('ProbeEnvironmentTool.execute')(function* (
  input: ProbeInput,
) {
  if (input.tool != null) {
    const name = input.tool.trim();
    if (!name) {
      return yield* new ToolError(
        'tool must be a non-empty command name (e.g. "pdflatex"). Call probe_environment with no arguments for the full report.',
      );
    }
    // Accept the image-capability label as an alias since that's how the
    // full report names a missing image tool; the agent naturally reuses
    // that token.
    if (name === IMAGE_TOOL_LABEL) {
      const { tools: images } = yield* probeLatexTools(IMAGE_LATEX_TOOLS);
      const found = images.find((tool) => tool.installed);
      return executed(
        found
          ? `Verified: "${found.name}" is installed and on PATH.`
          : `Not found: none of ${IMAGE_LATEX_TOOLS.map((name) => `"${name}"`).join(', ')} is on PATH. The install may not have completed, or the shell PATH needs to be refreshed.`,
        `Verify ${IMAGE_TOOL_LABEL}: ${found ? 'ok' : 'missing'}`,
      );
    }
    // First char must be alphanumeric — rejects punctuation-only
    // tokens like `"."` or `".."`, which would otherwise path-join
    // through the common-paths search to existing directories (e.g.
    // `/usr/bin/.`) and produce a false "ok" verification result.
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
      return yield* new ToolError(
        `Invalid tool name "${name}". Must start with an alphanumeric character; only \`A-Za-z0-9._+-\` are allowed thereafter (or the alias "${IMAGE_TOOL_LABEL}").`,
      );
    }
    const { installed: ok } = yield* locateTool(name);
    return executed(
      ok
        ? `Verified: "${name}" is installed and on PATH.`
        : `Not found: "${name}" is still missing. The install may not have completed, or the shell PATH needs to be refreshed.`,
      `Verify ${name}: ${ok ? 'ok' : 'missing'}`,
    );
  }

  const editor = yield* EditorIntegration;
  const host = yield* SetupHost;
  const secrets = yield* Secrets;
  const { roots } = (yield* ToolContext).env;

  // Where no home directory resolves (logged by `homeDirectory`), the
  // report names it unresolved, so the probe still answers.
  const homedir = (yield* homeDirectory) ?? '<unresolved>';
  const appDirs = (yield* CommandDirs)();
  const extendedPath =
    withExtendedPath({ PATH: process.env.PATH }, appDirs).PATH ?? '';
  const pm = detectPackageManager(appDirs);
  const hostInfo = yield* readHostInfo;
  const [
    coreTools,
    optionalTools,
    apiKeys,
    hasAnyUsableCredential,
    githubToken,
    chatGptStatus,
    storedKeys,
  ] = yield* Effect.all(
    [
      Effect.map(probeLatexTools(PROBED_LATEX_TOOLS), ({ tools }) => tools),
      Effect.all(
        OPTIONAL_TOOLS.map((name) => locateTool(name)),
        { concurrency: 'unbounded' },
      ),
      Effect.all(
        API_KEY_PROVIDER_IDS.map((provider) =>
          apiKey(secrets, provider).pipe(
            Effect.map((key) => key.origin),
            Effect.catchTag('SecretsFailed', () =>
              Effect.succeed('unknown' as const),
            ),
            Effect.map((origin) => ({ provider, origin })),
          ),
        ),
        { concurrency: 'unbounded' },
      ),
      hasUsableSetupCredential(roots).pipe(
        // A check that cannot be answered is not "no credential"; advice
        // built on it would send a configured user to sign in again.
        Effect.catch((failure) =>
          Effect.logWarning(
            `Setup credential check failed: ${failure.message}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as('unknown' as const)),
        ),
      ),
      resolveGitHubTokenSource(secrets).pipe(
        // A store the host cannot read is neither a token nor its absence:
        // report it unknown (as a provider key's origin is) and log why, so
        // an unreadable token is never listed as a blank, stale entry.
        Effect.catch((failure) =>
          Effect.logWarning(
            `GitHub token check failed; reporting it unknown: ${failure.message}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as('unknown' as const)),
        ),
      ),
      getChatGptSubscriptionStatus(roots).pipe(
        // A probe that fails is not the fact "signed out"; setup advice built
        // on it would tell a signed-in user to sign in.
        Effect.catch((failure) =>
          Effect.logWarning(
            `ChatGPT subscription probe failed: ${failure.message}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as('unknown' as const)),
        ),
      ),
      secrets.listStoredKeys().pipe(
        // An unreadable store is not an empty one: the report names it
        // unavailable rather than listing no stored secrets.
        Effect.catch((failure) =>
          Effect.logWarning(
            `Credential store listing failed; reporting it unavailable: ${failure.message}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as('unavailable' as const)),
        ),
      ),
    ],
    { concurrency: 'unbounded' },
  );

  const missing = missingLatexTools(coreTools);
  // One entry for the image capability: either tool satisfies it.
  const missingCore = [
    ...missing.filter((tool) => !tool.interchangeable).map((tool) => tool.name),
    ...(missing.some((tool) => tool.interchangeable) ? [IMAGE_TOOL_LABEL] : []),
  ];
  const latexWorkshopInstalled = editor?.installed(LATEX_WORKSHOP_EXT_ID);

  const summary = {
    host,
    os: {
      platform: hostInfo.platform,
      arch: hostInfo.arch,
      release: hostInfo.osRelease,
    },
    shell: hostInfo.shell,
    home: homedir,
    path: extendedPath.split(path.delimiter).filter(Boolean),
    packageManager: pm,
    coreTools,
    optionalTools,
    missingCore,
    latexWorkshop: {
      extensionId: LATEX_WORKSHOP_EXT_ID,
      supported: latexWorkshopInstalled !== undefined,
      installed: latexWorkshopInstalled ?? false,
    },
    credentials: {
      // `anyApiKeySet` is literal — only true if at least one
      // per-provider API key is present (matches the `apiKeys`
      // array below).
      anyApiKeySet: apiKeys.some(
        (key) => key.origin === 'secret' || key.origin === 'env',
      ),
      // `hasAnyUsableCredential` is the broader "can setup launch a
      // model right now" signal — direct key or provider subscription.
      // Kept as a separate field so the agent can reason about API keys
      // separately.
      hasAnyUsableCredential,
      apiKeys,
      chatGptSubscription: chatGptStatus,
      githubToken,
      // Stored entries the fields above do not name. `staleSecrets` lists,
      // by raw key name, every stored credential entry that is not counted as
      // a saved credential: an `apiKey.*` entry for no known provider, or a
      // known provider's key or the GitHub token whose stored value is blank
      // (its origin then reads env or none, yet the store still holds it).
      // The rest is a count, since those names may carry user-derived
      // identifiers.
      storedSecrets:
        storedKeys === 'unavailable'
          ? storedKeys
          : {
              staleSecrets: storedKeys.filter((key) => {
                if (key === GITHUB_TOKEN_STORAGE_KEY) {
                  return githubToken === 'env' || githubToken === 'none';
                }
                const provider = apiKeyEntry(key);
                if (provider === undefined) return false;
                if (provider === 'unknown') return true;
                const origin = apiKeys.find(
                  (entry) => entry.provider === provider,
                )?.origin;
                return origin === 'env' || origin === 'none';
              }),
              otherRedactedCount: storedKeys.filter(
                (key) =>
                  apiKeyEntry(key) === undefined &&
                  key !== GITHUB_TOKEN_STORAGE_KEY,
              ).length,
            },
    },
  };

  const parts: string[] = [
    `OS: ${summary.os.platform}`,
    `package manager: ${summary.packageManager ?? 'none detected'}`,
    summary.missingCore.length === 0
      ? 'all core LaTeX tools installed'
      : `missing: ${summary.missingCore.join(', ')}`,
    summary.latexWorkshop.supported
      ? `LaTeX Workshop: ${summary.latexWorkshop.installed ? 'installed' : 'not installed'}`
      : 'LaTeX Workshop: not applicable',
  ];
  const origins = new Set(summary.credentials.apiKeys.map((key) => key.origin));
  const { credentials } = summary;
  const chatGptEnabled =
    credentials.chatGptSubscription !== 'unknown' &&
    credentials.chatGptSubscription.enabled;
  const creds = [
    origins.has('secret') && 'provider API key saved',
    origins.has('env') && 'provider API key in environment',
    origins.has('unknown') && 'provider API key status unavailable',
    chatGptEnabled && 'ChatGPT subscription enabled',
    credentials.chatGptSubscription === 'unknown' &&
      'ChatGPT subscription status unavailable',
    credentials.githubToken === 'unknown' && 'GitHub token status unavailable',
    credentials.hasAnyUsableCredential === 'unknown' &&
      'credential status unavailable',
    credentials.hasAnyUsableCredential === true &&
      !credentials.anyApiKeySet &&
      !chatGptEnabled &&
      'usable credential',
    credentials.storedSecrets === 'unavailable' &&
      'credential store unreadable',
  ].filter(Predicate.isString);
  parts.push(`credentials: ${creds.length > 0 ? creds.join(' + ') : 'none'}`);
  const headline = parts.join('; ');

  return executed(
    headline +
      '\n\n<probe-json>\n' +
      JSON.stringify(summary, null, 2) +
      '\n</probe-json>',
    headline,
  );
});

/**
 * Read-only probe of the host environment: the setup assistant's one report.
 *
 * Returns a single structured JSON document covering OS, PATH, package
 * manager, core TeXRA dependencies, LaTeX Workshop extension, usable API-key
 * origins, the persisted credential store's other entries, and broader usable
 * credential status; with `tool`, a one-line PATH recheck of that tool.
 * No approval gate — purely read-only, akin to `ls` / `glob`.
 */
export const ProbeEnvironmentTool = defineTool({
  name: 'probe_environment',
  replay: 'safe',
  description: `Probe the active host and environment and return a structured JSON summary covering host kind, OS, shell, PATH, detected package manager (brew/apt/scoop), installation status of TeXRA's core LaTeX dependencies (pdflatex, latexmk, latexindent, perl, gs, ${IMAGE_TOOL_LABEL}, texcount, latexdiff), the LaTeX Workshop VS Code extension, each provider API key's origin (TeXRA secrets, environment, or absent; values are never returned), ChatGPT subscription state, broader usable credential status, and the rest of TeXRA's persisted credential store (\`storedSecrets\`: \`staleSecrets\`, the stored credential entries that do not count as a saved credential (an \`apiKey.*\` entry for an unknown provider, or a known provider's key or the GitHub token whose stored value is blank), by raw key name, and a redacted count of other secret names; \`"unavailable"\` when the store cannot be read). Recognised providers' keys can be removed with unset_api_key, the GitHub token through the host's GitHub token setting, and other entries only through the current host's credential-management surface. With {"tool": "<name>"}, re-checks only that tool on PATH and answers in one line (use after an install command to confirm it worked). Read-only, no approval required. Call this first in any setup session to decide what to do next, and again as the final check.`,
  schema: ProbeEnvironmentInputSchema,
  execute: probe,
});
