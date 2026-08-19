// Standard library imports
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { type ToolResult } from '@shared/schemas';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latexToolchain';
import { executed } from '@tools/core/result';
import { detectPackageManager } from '@utils/system/toolUtils';
import { extendEnvPath, safeHomedir } from '@utils/system/platformPaths';

// Local file imports
import { defineTool } from '../core/define';
import {
  getChatGptSubscriptionStatus,
  getSetupPlatform,
  setupSecrets,
} from './platform';
import { collectCoreSetupStatus, locateTool } from './toolProbing';

const ProbeEnvironmentInputSchema = z
  .strictObject({})
  .describe(
    'No inputs: returns a structured JSON summary of the host environment.',
  );

type ProbeInput = z.infer<typeof ProbeEnvironmentInputSchema>;

const OPTIONAL_TOOLS = ['git', 'node', 'python3'] as const;

/**
 * Read-only probe of the host environment.
 *
 * Returns a single structured JSON document covering OS, PATH, package
 * manager, core TeXRA dependencies, LaTeX Workshop extension, usable API-key
 * origins, broader usable credential status, and Researcher Access status.
 * No approval gate — purely read-only, akin to `ls` / `glob`.
 */
export class ProbeEnvironmentTool extends defineTool({
  name: 'probe_environment',
  description: `Probe the active host and environment and return a structured JSON summary covering host kind, OS, shell, PATH, detected package manager (brew/apt/scoop), installation status of TeXRA's core LaTeX dependencies (pdflatex, latexmk, latexindent, perl, gs, gm/magick, texcount, latexdiff), the LaTeX Workshop VS Code extension, each provider API key's origin (TeXRA secrets, environment, or absent; values are never returned), ChatGPT subscription state, broader usable credential status, and Researcher Access sign-in status. Read-only, no approval required. Call this first in any setup session to decide what to do next.`,
  schema: ProbeEnvironmentInputSchema,
}) {
  protected async execute(_input: ProbeInput): Promise<ToolResult> {
    const platform = getSetupPlatform();

    // `os.homedir()` can throw UV_ENOENT in container/remote environments
    // where the home directory is not resolvable; fall back to a string
    // sentinel so the probe still produces a useful environment report.
    const homedir = safeHomedir() ?? '<unresolved>';
    const extendedPath = extendEnvPath();
    const pm = detectPackageManager();
    const [
      core,
      optionalTools,
      apiKeys,
      credentialReadiness,
      githubToken,
      chatGptStatus,
    ] = await Promise.all([
      collectCoreSetupStatus(platform),
      Promise.all(OPTIONAL_TOOLS.map((name) => locateTool(name))),
      Promise.all(
        setupSecrets.providers.map(async (provider) => {
          const origin = await setupSecrets
            .apiKeyOrigin(provider)
            .catch(() => 'unknown' as const);
          return { provider, origin };
        }),
      ),
      setupSecrets
        .anyUsableCredentialExists()
        .then((available) => ({ available, status: 'known' as const }))
        .catch(() => ({ available: false, status: 'unknown' as const })),
      setupSecrets.gitHubTokenExists().catch(() => 'none' as const),
      getChatGptSubscriptionStatus().catch(() => ({
        signedIn: false,
        enabled: false,
      })),
    ]);

    const { auth, coreTools, missingCore, latexWorkshopInstalled } = core;

    const summary = {
      host: platform.host,
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
      },
      shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
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
        // array below). A Researcher-Access-only user would have
        // had this come out true under the previous adapter-backed
        // check, which contradicted the per-provider detail and
        // misled credential planning.
        anyApiKeySet: apiKeys.some(
          (key) => key.origin === 'secret' || key.origin === 'env',
        ),
        // `hasAnyUsableCredential` is the broader "can setup launch a
        // model right now" signal — a direct provider API key or a
        // provider subscription (ChatGPT/Codex, Grok). Kept as a
        // separate field so the agent can reason about API keys
        // separately.
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
    const origins = new Set(
      summary.credentials.apiKeys.map((key) => key.origin),
    );
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
    if (
      summary.credentials.hasAnyUsableCredential &&
      !summary.credentials.anyApiKeySet &&
      !summary.credentials.chatGptSubscription.enabled
    ) {
      creds.push('usable credential');
    }
    parts.push(`credentials: ${creds.length > 0 ? creds.join(' + ') : 'none'}`);
    // Account sign-in is reported apart from credentials: it unlocks the
    // hosted agent catalog, never model access.
    parts.push(
      `TeXRA account: ${summary.credentials.researcherAccess.authenticated ? 'signed in' : 'signed out'}`,
    );
    const headline = parts.join('; ');

    return executed(
      headline +
        '\n\n<probe-json>\n' +
        JSON.stringify(summary, null, 2) +
        '\n</probe-json>',
      headline,
    );
  }
}
