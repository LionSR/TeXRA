// Standard library imports
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latex';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { detectPackageManager } from '@utils/system/toolUtils';
import { extendEnvPath, safeHomedir } from '@utils/system/platformPaths';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';
import { CORE_LATEX_TOOLS, IMAGE_TOOLS, locateTool } from './toolProbing';

const ProbeEnvironmentInputSchema = z
  .strictObject({})
  .describe(
    'No inputs — returns a structured JSON summary of the host environment.',
  );

type ProbeInput = z.infer<typeof ProbeEnvironmentInputSchema>;

interface ToolStatus {
  name: string;
  installed: boolean;
  path?: string;
}

/** Tools probed by `probe_environment`: LaTeX toolchain + both image-tool
 *  candidates. The image tool is satisfied by either; `missingCore` logic
 *  below reports a single `gm/magick` entry when both are absent. */
const PROBED_CORE_TOOLS = [...CORE_LATEX_TOOLS, ...IMAGE_TOOLS] as const;

const OPTIONAL_TOOLS = ['git', 'node', 'python3'] as const;

async function checkTool(name: string): Promise<ToolStatus> {
  const located = await locateTool(name);
  return { name, ...located };
}

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
    // Authentication verifies a configured relay token and primes the shared
    // status cache. Credential readiness must read that settled state.
    const auth = await platform.auth.getStatus().catch(() => ({
      authenticated: false as const,
    }));

    const [
      coreTools,
      optionalTools,
      apiKeys,
      hasUsableCredential,
      githubToken,
      chatGptStatus,
    ] = await Promise.all([
      Promise.all(PROBED_CORE_TOOLS.map(checkTool)),
      Promise.all(OPTIONAL_TOOLS.map(checkTool)),
      Promise.all(
        platform.secrets.providers.map(async (provider) => ({
          provider,
          origin: await platform.secrets.apiKeyOrigin(provider),
        })),
      ),
      platform.secrets.anyUsableCredentialExists().catch((err) => {
        throw new ToolError(
          `Failed to probe credential status: ${toErrorMessage(err)}`,
          { cause: err },
        );
      }),
      platform.secrets.gitHubTokenExists().catch(() => 'none' as const),
      platform.modelAccess.getChatGptSubscriptionStatus().catch(() => ({
        signedIn: false,
        enabled: false,
      })),
    ]);

    const missingCore = coreTools
      .filter((t) => !t.installed && t.name !== 'gm' && t.name !== 'magick')
      .map((t) => t.name);
    const hasImageTool = coreTools.some(
      (t) => (t.name === 'gm' || t.name === 'magick') && t.installed,
    );
    if (!hasImageTool) missingCore.push('gm/magick');

    const latexWorkshopInstalled = platform.extensions?.isInstalled(
      LATEX_WORKSHOP_EXT_ID,
    );

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
        anyApiKeySet: apiKeys.some((key) => key.origin !== 'none'),
        // `hasAnyUsableCredential` is the broader "can setup launch a
        // model right now" signal — direct key, ChatGPT subscription,
        // or server-side Researcher Access. Kept as a separate field
        // so the agent can reason about API keys separately.
        hasAnyUsableCredential: hasUsableCredential,
        apiKeys,
        researcherAccess: {
          authenticated: auth.authenticated,
          email: auth.authenticated ? auth.email : undefined,
          tier: auth.authenticated ? auth.tier : undefined,
        },
        chatGptSubscription: chatGptStatus,
        githubToken,
      },
    };

    const headline = buildHeadline(summary);

    return {
      status: 'executed',
      summary: headline,
      output:
        headline +
        '\n\n<probe-json>\n' +
        JSON.stringify(summary, null, 2) +
        '\n</probe-json>',
    };
  }
}

function buildHeadline(summary: {
  os: { platform: string };
  packageManager: string | null;
  missingCore: string[];
  latexWorkshop: { supported: boolean; installed: boolean };
  credentials: {
    anyApiKeySet: boolean;
    hasAnyUsableCredential: boolean;
    apiKeys: Array<{ origin: 'secret' | 'env' | 'none' }>;
    researcherAccess: { authenticated: boolean };
    chatGptSubscription: { enabled: boolean };
  };
}): string {
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
  return parts.join('; ');
}
