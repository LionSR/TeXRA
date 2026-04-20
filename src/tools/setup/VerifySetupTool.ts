// Third-party imports
import { z } from 'zod';

// Local imports
import { type ToolResult } from '@tools/result';
import {
  checkCoreDependencies,
  checkToolInstalled,
} from '@utils/system/toolUtils';

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

const LATEX_WORKSHOP_EXT_ID = 'James-Yu.latex-workshop';

export class VerifySetupTool extends defineTool({
  name: 'verify_setup',
  description: `Verify installation status. With no input, runs a full check of TeXRA's core LaTeX dependencies (pdflatex/latexmk, latexindent, perl, gs, gm/magick, texcount, latexdiff) and the LaTeX Workshop extension, returning a short plain-text report. With {"tool": "<name>"}, checks only that tool. Use after running an install command to confirm it worked, or as the final step of a setup session.`,
  schema: VerifySetupInputSchema,
}) {
  protected async execute(input: VerifySetupInput): Promise<ToolResult> {
    const platform = getSetupPlatform();

    if (input.tool) {
      const name = input.tool.trim();
      const ok = await checkToolInstalled(name, false);
      return {
        summary: `Verify ${name}: ${ok ? 'ok' : 'missing'}`,
        output: ok
          ? `Verified: "${name}" is installed and on PATH.`
          : `Not found: "${name}" is still missing. The install may not have completed, or the shell PATH needs to be refreshed.`,
      };
    }

    const missingCore = await checkCoreDependencies(false);
    const latexWorkshopInstalled =
      platform.extensions.isInstalled(LATEX_WORKSHOP_EXT_ID);
    const anyKey = await platform.secrets.anyApiKeyExists();
    const auth = await platform.auth.getStatus().catch(() => ({
      authenticated: false as const,
    }));

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
