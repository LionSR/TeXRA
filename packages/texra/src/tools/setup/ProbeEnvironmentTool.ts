// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as os from 'node:os';
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { API_KEY_PROVIDER_IDS, lookupApiKeyOrigin } from '@texra-ai/llm';
import {
  defineTool,
  Secrets,
  ToolContext,
  withLogChannel,
} from '@texra-ai/harness';
import { withExtendedPath } from '@texra-ai/harness/node';
import { executed } from '@texra-ai/harness/plugins';
import { ensureError } from '@texra-ai/harness/schemas';
import { nodeHostEnvironment } from '@texra/platform/defaults/nodeHostEnvironment';
import { hasUsableSetupCredential } from '@texra/model/setupCredentialAccess';
import {
  IMAGE_TOOL_LABEL,
  LATEX_WORKSHOP_EXT_ID,
} from '@texra/shared/constants/latexToolchain';
import { resolveGitHubTokenSource } from '@texra/tools/github/githubAuth';
import { detectPackageManager } from '@texra/utils/system/toolChecks';

// Local file imports

import { getChatGptSubscriptionStatus, SetupPlatform } from './platform';
import { collectCoreSetupStatus, locateTool } from './toolProbing';

const CHANNEL = 'Setup Credentials';
const ProbeEnvironmentInputSchema = z
  .strictObject({})
  .describe(
    'No inputs: returns a structured JSON summary of the host environment.',
  );

type ProbeInput = z.infer<typeof ProbeEnvironmentInputSchema>;

const OPTIONAL_TOOLS = ['git', 'node', 'python3'] as const;

const probe = Effect.fn('ProbeEnvironmentTool.execute')(function* () {
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
    core,
    optionalTools,
    apiKeys,
    hasAnyUsableCredential,
    githubToken,
    chatGptStatus,
  ] = yield* Effect.all(
    [
      collectCoreSetupStatus(platform),
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
      // The probe runs on every host and cannot tell whether its host's setup
      // launch turns OpenRouter on, so it counts a key as the extension does.
      hasUsableSetupCredential(roots, secrets, {
        openRouterFallback: true,
      }).pipe(
        // A check that cannot be answered is not "no credential"; advice
        // built on it would send a configured user to sign in again.
        Effect.catch((failure) =>
          Effect.logWarning(
            `Setup credential check failed: ${failure.message}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as('unknown' as const)),
        ),
      ),
      resolveGitHubTokenSource(secrets).pipe(
        // A store the host cannot read is not a token: the report says the
        // status is unknown, as it does for an unreadable API key.
        Effect.catch((failure) =>
          Effect.logWarning(
            `GitHub token check failed: ${failure.message}`,
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
    ],
    { concurrency: 'unbounded' },
  );

  const { coreTools, missingCore, latexWorkshopInstalled } = core;

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
 * Read-only probe of the host environment.
 *
 * Returns a single structured JSON document covering OS, PATH, package
 * manager, core TeXRA dependencies, LaTeX Workshop extension, usable API-key
 * origins, and broader usable credential status.
 * No approval gate — purely read-only, akin to `ls` / `glob`.
 */
export const ProbeEnvironmentTool = defineTool({
  name: 'probe_environment',
  replay: 'safe',
  description: `Probe the active host and environment and return a structured JSON summary covering host kind, OS, shell, PATH, detected package manager (brew/apt/scoop), installation status of TeXRA's core LaTeX dependencies (pdflatex, latexmk, latexindent, perl, gs, ${IMAGE_TOOL_LABEL}, texcount, latexdiff), the LaTeX Workshop VS Code extension, each provider API key's origin (TeXRA secrets, environment, or absent; values are never returned), ChatGPT subscription state, and broader usable credential status. Read-only, no approval required. Call this first in any setup session to decide what to do next.`,
  schema: ProbeEnvironmentInputSchema,
  execute: (_input: ProbeInput) => probe(),
});
