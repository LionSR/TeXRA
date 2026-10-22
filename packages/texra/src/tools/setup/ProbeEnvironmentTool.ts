// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as os from 'node:os';
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import {
  API_KEY_PROVIDER_IDS,
  apiProviderOfSecretName,
  lookupApiKeyOrigin,
} from '@texra-ai/llm';
import {
  defineTool,
  Secrets,
  ToolContext,
  withLogChannel,
} from '@texra-ai/harness';
import { withExtendedPath } from '@texra-ai/harness/node';
import { executed, ToolError } from '@texra-ai/harness/plugins';
import { ensureError } from '@texra-ai/harness/schemas';
import { nodeHostEnvironment } from '@texra/platform/defaults/nodeHostEnvironment';
import { hasUsableSetupCredential } from '@texra/model/setupCredentialAccess';
import {
  IMAGE_TOOL_LABEL,
  LATEX_WORKSHOP_EXT_ID,
  PROBED_LATEX_TOOLS,
} from '@texra/shared/constants/latexToolchain';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@texra/tools/github/githubAuth';
import { detectPackageManager } from '@texra/utils/system/toolChecks';

// Local file imports

import { getChatGptSubscriptionStatus, SetupPlatform } from './platform';
import { locateTool, missingCoreTools } from './toolProbing';

const CHANNEL = 'Setup Credentials';
const ProbeEnvironmentInputSchema = z.strictObject({
  tool: z
    .string()
    .nullish()
    .describe(
      'If provided, re-checks just this one tool on PATH (e.g. "pdflatex") and answers in one line. Otherwise returns the full JSON report.',
    ),
});

type ProbeInput = z.infer<typeof ProbeEnvironmentInputSchema>;

const OPTIONAL_TOOLS = ['git', 'node', 'python3'] as const;

const probe = Effect.fn('ProbeEnvironmentTool.execute')(function* (
  input: ProbeInput,
) {
  if (input.tool != null) {
    const name = input.tool.trim();
    if (!name) {
      return yield* Effect.fail(
        new ToolError(
          'tool must be a non-empty command name (e.g. "pdflatex"). Call probe_environment with no arguments for the full report.',
        ),
      );
    }
    // Accept the image-capability label as an alias since that's how the
    // full report names a missing image tool; the agent naturally reuses
    // that token.
    if (name === IMAGE_TOOL_LABEL) {
      const [gm, magick] = yield* Effect.all(
        [locateTool('gm'), locateTool('magick')],
        { concurrency: 'unbounded' },
      );
      const ok = gm.installed || magick.installed;
      return executed(
        ok
          ? `Verified: ${gm.installed ? '"gm"' : '"magick"'} is installed and on PATH.`
          : `Not found: neither "gm" nor "magick" is on PATH. The install may not have completed, or the shell PATH needs to be refreshed.`,
        `Verify ${IMAGE_TOOL_LABEL}: ${ok ? 'ok' : 'missing'}`,
      );
    }
    // First char must be alphanumeric — rejects punctuation-only
    // tokens like `"."` or `".."`, which would otherwise path-join
    // through the common-paths search to existing directories (e.g.
    // `/usr/bin/.`) and produce a false "ok" verification result.
    if (!/^[A-Za-z0-9][A-Za-z0-9._+\-]*$/.test(name)) {
      return yield* Effect.fail(
        new ToolError(
          `Invalid tool name "${name}". Must start with an alphanumeric character; only \`A-Za-z0-9._+-\` are allowed thereafter (or the alias "${IMAGE_TOOL_LABEL}").`,
        ),
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

  const platform = yield* SetupPlatform;
  const secrets = yield* Secrets;
  const { roots } = (yield* ToolContext).env;

  // `os.homedir()` can throw UV_ENOENT in container/remote environments
  // where the home directory is not resolvable; the report names it
  // unresolved and the cause is logged, so the probe still answers.
  const homedir = yield* Effect.try({
    try: () => os.homedir(),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `The home directory could not be resolved: ${error.message}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as('<unresolved>')),
    ),
  );
  const extendedPath = withExtendedPath({ PATH: process.env.PATH }).PATH ?? '';
  const pm = detectPackageManager();
  const hostInfo = yield* nodeHostEnvironment.hostInfo();
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
      Effect.all(
        PROBED_LATEX_TOOLS.map((name) => locateTool(name)),
        { concurrency: 'unbounded' },
      ),
      Effect.all(
        OPTIONAL_TOOLS.map((name) => locateTool(name)),
        { concurrency: 'unbounded' },
      ),
      Effect.all(
        API_KEY_PROVIDER_IDS.map((provider) =>
          lookupApiKeyOrigin(secrets, provider).pipe(
            Effect.catchTag('SecretsFailed', () =>
              Effect.succeed('unknown' as const),
            ),
            Effect.map((origin) => ({ provider, origin })),
          ),
        ),
        { concurrency: 'unbounded' },
      ),
      hasUsableSetupCredential(roots, secrets).pipe(
        withLogChannel('Setup Credentials'),
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
            `ChatGPT subscription probe failed; reporting signed-out: ${failure.message}`,
          ).pipe(
            withLogChannel(CHANNEL),
            Effect.as({ signedIn: false, enabled: false }),
          ),
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

  const missingCore = missingCoreTools(coreTools);
  const latexWorkshopInstalled = platform.extensions?.isInstalled(
    LATEX_WORKSHOP_EXT_ID,
  );

  const summary = {
    host: roots.host,
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
                if (!key.startsWith('apiKey.')) return false;
                const provider = apiProviderOfSecretName(key);
                if (provider === undefined) return true;
                const origin = apiKeys.find(
                  (entry) => entry.provider === provider,
                )?.origin;
                return origin === 'env' || origin === 'none';
              }),
              otherRedactedCount: storedKeys.filter(
                (key) =>
                  !key.startsWith('apiKey.') &&
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
  const creds = [
    origins.has('secret') && 'provider API key saved',
    origins.has('env') && 'provider API key in environment',
    origins.has('unknown') && 'provider API key status unavailable',
    credentials.chatGptSubscription.enabled && 'ChatGPT subscription enabled',
    credentials.hasAnyUsableCredential &&
      !credentials.anyApiKeySet &&
      !credentials.chatGptSubscription.enabled &&
      'usable credential',
    credentials.storedSecrets === 'unavailable' &&
      'credential store unreadable',
  ].filter((cred): cred is string => typeof cred === 'string');
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
