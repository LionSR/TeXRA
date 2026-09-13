// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { hostPort } from '@common/hostPort';
import { createLog } from '@logger/logUtils';
import { API_PROVIDERS, lookupApiKeyOrigin } from '@model/apiProviders';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { Secrets } from '@platform/secrets';
import { nodeHostEnvironment } from '@platform/defaults/nodeHostEnvironment';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latexToolchain';
import { executed } from '@tools/core/result';
import { resolveGitHubTokenSource } from '@tools/github/githubAuth';
import { detectPackageManager } from '@utils/system/toolUtils';
import { extendEnvPath, safeHomedir } from '@utils/system/platformPaths';

// Local file imports
import { defineTool } from '../core/define';
import { getChatGptSubscriptionStatus, SetupPlatform } from './platform';
import { collectCoreSetupStatus, locateTool } from './toolProbing';

const credentialLog = createLog('Setup Credentials');

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

  // `os.homedir()` can throw UV_ENOENT in container/remote environments
  // where the home directory is not resolvable; fall back to a string
  // sentinel so the probe still produces a useful environment report.
  const homedir = safeHomedir() ?? '<unresolved>';
  const extendedPath = extendEnvPath();
  const pm = detectPackageManager();
  const hostInfo = nodeHostEnvironment.hostInfo();
  const [
    core,
    optionalTools,
    apiKeys,
    credentialReadiness,
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
        API_PROVIDERS.map((provider) =>
          hostPort(() => lookupApiKeyOrigin(secrets, provider)).pipe(
            Effect.catch(() => Effect.succeed('unknown' as const)),
            Effect.map((origin) => ({ provider, origin })),
          ),
        ),
        { concurrency: 'unbounded' },
      ),
      hostPort(() =>
        hasUsableSetupCredential(secrets, credentialLog.warn),
      ).pipe(
        Effect.map((available) => ({ available, status: 'known' as const })),
        Effect.catch(() =>
          Effect.succeed({ available: false, status: 'unknown' as const }),
        ),
      ),
      hostPort(() => resolveGitHubTokenSource(secrets)).pipe(
        Effect.catch(() => Effect.succeed('none' as const)),
      ),
      getChatGptSubscriptionStatus().pipe(
        Effect.catch(() => Effect.succeed({ signedIn: false, enabled: false })),
      ),
    ],
    { concurrency: 'unbounded' },
  );

  const { auth, coreTools, missingCore, latexWorkshopInstalled } = core;

  const summary = {
    host: platform.host,
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
      // array below). A TeXRA-account-only user would have
      // had this come out true under the previous adapter-backed
      // check, which contradicted the per-provider detail and
      // misled credential planning.
      anyApiKeySet: apiKeys.some(
        (key) => key.origin === 'secret' || key.origin === 'env',
      ),
      // `hasAnyUsableCredential` is the broader "can setup launch a
      // model right now" signal — direct key, ChatGPT subscription,
      // or server-side TeXRA account. Kept as a separate field
      // so the agent can reason about API keys separately.
      hasAnyUsableCredential: credentialReadiness.available,
      usableCredentialStatus: credentialReadiness.status,
      apiKeys,
      researcherAccess: {
        authenticated: auth.authenticated,
        email: auth.authenticated ? auth.email : undefined,
      },
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
  const creds: string[] = [];
  const origins = new Set(summary.credentials.apiKeys.map((key) => key.origin));
  if (origins.has('secret')) creds.push('provider API key saved');
  if (origins.has('env')) creds.push('provider API key in environment');
  if (origins.has('unknown')) {
    creds.push('provider API key status unavailable');
  }
  if (summary.credentials.usableCredentialStatus === 'unknown') {
    creds.push('overall credential status unavailable');
  }
  if (summary.credentials.chatGptSubscription.enabled) {
    creds.push('ChatGPT subscription enabled');
  }
  if (summary.credentials.researcherAccess.authenticated)
    creds.push('signed in');
  if (
    summary.credentials.hasAnyUsableCredential &&
    !summary.credentials.anyApiKeySet &&
    !summary.credentials.researcherAccess.authenticated &&
    !summary.credentials.chatGptSubscription.enabled
  ) {
    creds.push('usable credential');
  }
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
 * origins, broader usable credential status, and TeXRA account status.
 * No approval gate — purely read-only, akin to `ls` / `glob`.
 */
export const ProbeEnvironmentTool = defineTool({
  name: 'probe_environment',
  description: `Probe the active host and environment and return a structured JSON summary covering host kind, OS, shell, PATH, detected package manager (brew/apt/scoop), installation status of TeXRA's core LaTeX dependencies (pdflatex, latexmk, latexindent, perl, gs, gm/magick, texcount, latexdiff), the LaTeX Workshop VS Code extension, each provider API key's origin (TeXRA secrets, environment, or absent; values are never returned), ChatGPT subscription state, broader usable credential status, and TeXRA account sign-in status. Read-only, no approval required. Call this first in any setup session to decide what to do next.`,
  schema: ProbeEnvironmentInputSchema,
  execute: (_input: ProbeInput) => probe(),
});
