// Third-party imports
import { z } from 'zod';

// Local imports
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latex';
import { type ToolResult } from '@tools/result';
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

    if (input.tool) {
      const name = input.tool.trim();
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
    const creds: string[] = [];
    if (anyKey) creds.push('API key set');
    if (auth.authenticated) creds.push('Researcher Access signed in');
    lines.push(
      `Credentials: ${creds.length > 0 ? creds.join(' + ') : 'NONE — need an API key or sign-in'}.`,
    );

    const ready =
      missingCore.length === 0 &&
      latexWorkshopInstalled &&
      (anyKey || auth.authenticated);

    return {
      summary: ready
        ? 'Setup verification: ready to go'
        : `Setup verification: ${missingCore.length > 0 ? missingCore.length + ' missing tools' : 'gaps remain'}`,
      output: lines.join('\n'),
    };
  }
}
