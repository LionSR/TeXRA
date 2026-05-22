// Standard library imports
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { toErrorMessage } from '@common/errors';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latex';
import { ToolError, type ToolResult } from '@tools/result';
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
 * manager, core TeXRA dependencies, LaTeX Workshop extension, API-key
 * presence, and Researcher Access status. No approval gate — purely
 * read-only, akin to `ls` / `glob`.
 */
export class ProbeEnvironmentTool extends defineTool({
  name: 'probe_environment',
  description: `Probe the host environment and return a structured JSON summary covering OS, shell, PATH, detected package manager (brew/apt/scoop), installation status of TeXRA's core LaTeX dependencies (pdflatex, latexmk, latexindent, perl, gs, gm/magick, texcount, latexdiff), the LaTeX Workshop VS Code extension, per-provider API-key presence (names only — secrets are never read), and Researcher Access sign-in status. Read-only, no approval required. Call this first in any setup session to decide what to do next.`,
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

    const [coreTools, optionalTools, apiKeys, anyKeySet, auth, githubToken] =
      await Promise.all([
        Promise.all(PROBED_CORE_TOOLS.map(checkTool)),
        Promise.all(OPTIONAL_TOOLS.map(checkTool)),
        Promise.all(
          // Use `hasUsableApiKey` so the per-provider report matches
          // what the setup-launch path considers a working credential —
          // a stale `PROVIDER_API_KEY=""` env var must not surface as
          // `hasKey: true` and mislead the agent's credential planning.
          platform.secrets.providers.map(async (provider) => ({
            provider,
            hasKey: await platform.secrets
              .hasUsableApiKey(provider)
              .catch(() => false),
          })),
        ),
        platform.secrets.anyApiKeyExists().catch((err) => {
          throw new ToolError(
            `Failed to probe API key status: ${toErrorMessage(err)}`,
            { cause: err },
          );
        }),
        platform.auth.getStatus().catch(() => ({
          authenticated: false as const,
        })),
        platform.secrets.gitHubTokenExists().catch(() => 'none' as const),
      ]);

    const missingCore = coreTools
      .filter((t) => !t.installed && t.name !== 'gm' && t.name !== 'magick')
      .map((t) => t.name);
    const hasImageTool =
      coreTools.find((t) => t.name === 'gm')?.installed ||
      coreTools.find((t) => t.name === 'magick')?.installed;
    if (!hasImageTool) missingCore.push('gm/magick');

    const latexWorkshopInstalled = platform.extensions.isInstalled(
      LATEX_WORKSHOP_EXT_ID,
    );

    const summary = {
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
        installed: latexWorkshopInstalled,
      },
      credentials: {
        // `anyApiKeySet` is literal — only true if at least one
        // per-provider API key is present (matches the `apiKeys`
        // array below). A Researcher-Access-only user would have
        // had this come out true under the previous adapter-backed
        // check, which contradicted the per-provider detail and
        // misled credential planning.
        anyApiKeySet: apiKeys.some((k) => k.hasKey),
        // `hasAnyUsableCredential` is the broader "can setup launch a
        // model right now" signal — direct key OR server-side
        // Researcher Access. Kept as a separate field so the agent
        // can reason about the two independently.
        hasAnyUsableCredential: anyKeySet,
        apiKeys,
        researcherAccess: {
          authenticated: auth.authenticated,
          email: auth.authenticated ? auth.email : undefined,
          tier: auth.authenticated ? auth.tier : undefined,
        },
        githubToken,
      },
    };

    const headline = buildHeadline(summary);

    return {
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
  latexWorkshop: { installed: boolean };
  credentials: {
    anyApiKeySet: boolean;
    researcherAccess: { authenticated: boolean };
  };
}): string {
  const parts: string[] = [];
  parts.push(`OS: ${summary.os.platform}`);
  parts.push(`package manager: ${summary.packageManager ?? 'none detected'}`);
  if (summary.missingCore.length === 0) {
    parts.push('all core LaTeX tools installed');
  } else {
    parts.push(`missing: ${summary.missingCore.join(', ')}`);
  }
  parts.push(
    `LaTeX Workshop: ${summary.latexWorkshop.installed ? 'installed' : 'not installed'}`,
  );
  const creds: string[] = [];
  if (summary.credentials.anyApiKeySet) creds.push('API key set');
  if (summary.credentials.researcherAccess.authenticated)
    creds.push('signed in');
  parts.push(`credentials: ${creds.length > 0 ? creds.join(' + ') : 'none'}`);
  return parts.join('; ');
}
