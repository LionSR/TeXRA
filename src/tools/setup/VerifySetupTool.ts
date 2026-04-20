// Third-party imports
import { z } from 'zod';

// Local imports
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latex';
import { ToolError, type ToolResult } from '@tools/result';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { findToolInCommonPaths } from '@utils/system/platformPaths';

// Local file imports
import { defineTool } from '../core/define';
import { getSetupPlatform } from './platform';

const VerifySetupInputSchema = z.strictObject({
  tool: z
    .string()
    .nullish()
    .describe(
      'If provided, verifies just this one tool (e.g. "pdflatex"). Otherwise runs a full core-dependency check.',
    ),
});

type VerifySetupInput = z.infer<typeof VerifySetupInputSchema>;

/**
 * Tools checked by the no-argument `verify_setup` call.
 * Must stay aligned with the tool's description and ProbeEnvironmentTool's
 * CORE_TOOLS so the agent's "ready" claim reflects what's actually verified.
 */
const CORE_TOOLS = [
  'pdflatex',
  'latexmk',
  'latexindent',
  'latexdiff',
  'texcount',
  'perl',
  'gs',
] as const;

/**
 * Resolve a tool as installed by (1) the known-tool check which spawns
 * `<tool> --version`, or (2) a PATH search for tools without a config entry
 * (e.g. `node`, `git`, or an arbitrary binary the user asks about).
 */
async function isToolPresent(name: string): Promise<boolean> {
  if (await checkToolInstalled(name, false)) return true;
  return findToolInCommonPaths(name) !== null;
}

export class VerifySetupTool extends defineTool({
  name: 'verify_setup',
  description: `Verify installation status. With no input, runs a full check of TeXRA's core LaTeX dependencies (pdflatex, latexmk, latexindent, perl, gs, gm or magick, texcount, latexdiff) and the LaTeX Workshop extension, returning a short plain-text report. With {"tool": "<name>"}, checks only that tool (falls back to a PATH search for names that don't have a known --version command). Use after running an install command to confirm it worked, or as the final step of a setup session.`,
  schema: VerifySetupInputSchema,
}) {
  protected async execute(input: VerifySetupInput): Promise<ToolResult> {
    const platform = getSetupPlatform();

    if (input.tool !== undefined && input.tool !== null) {
      const name = input.tool.trim();
      if (!name) {
        throw new ToolError(
          'tool must be a non-empty command name (e.g. "pdflatex"). Call verify_setup with no arguments for a full check.',
        );
      }
      if (!/^[A-Za-z0-9._+\-]+$/.test(name)) {
        throw new ToolError(
          `Invalid tool name "${name}". Only alphanumeric characters and \`._+-\` are allowed.`,
        );
      }
      const ok = await isToolPresent(name);
      return {
        summary: `Verify ${name}: ${ok ? 'ok' : 'missing'}`,
        output: ok
          ? `Verified: "${name}" is installed and on PATH.`
          : `Not found: "${name}" is still missing. The install may not have completed, or the shell PATH needs to be refreshed.`,
      };
    }

    const [coreResults, hasMagick, hasGm, anyKey, auth] = await Promise.all([
      Promise.all(CORE_TOOLS.map(isToolPresent)),
      isToolPresent('magick'),
      isToolPresent('gm'),
      platform.secrets.anyApiKeyExists(),
      platform.auth.getStatus().catch(() => ({
        authenticated: false as const,
      })),
    ]);

    const missingCore: string[] = CORE_TOOLS.filter((_, i) => !coreResults[i]);
    if (!hasMagick && !hasGm) missingCore.push('gm/magick');

    const latexWorkshopInstalled =
      platform.extensions.isInstalled(LATEX_WORKSHOP_EXT_ID);

    const lines: string[] = [];
    if (missingCore.length === 0) {
      lines.push('Core LaTeX tools: all present.');
    } else {
      lines.push(`Core LaTeX tools MISSING: ${missingCore.join(', ')}.`);
    }
    lines.push(
      `LaTeX Workshop extension: ${latexWorkshopInstalled ? 'installed' : 'NOT installed'}.`,
    );
    // `anyKey` (from SecretManager.anyApiKeyExists) is already the
    // authoritative signal — it covers both direct provider keys and
    // Researcher Access signed-in users who have Included Access on. A
    // bare auth.authenticated without usable server-side keys is NOT a
    // working credential, so we don't let it count toward "ready".
    const credSummary = anyKey
      ? auth.authenticated
        ? 'API key or Researcher Access available'
        : 'API key set'
      : auth.authenticated
        ? 'signed in but Included Access is OFF — need an API key or re-enable it'
        : 'NONE — need an API key or sign-in';
    lines.push(`Credentials: ${credSummary}.`);

    const ready =
      missingCore.length === 0 && latexWorkshopInstalled && anyKey;

    return {
      summary: ready
        ? 'Setup verification: ready to go'
        : `Setup verification: ${missingCore.length > 0 ? missingCore.length + ' missing tools' : 'gaps remain'}`,
      output: lines.join('\n'),
    };
  }
}
