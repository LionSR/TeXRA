// Third-party imports
import { z } from 'zod';

// Local imports
import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';

// Local file imports
import { executed } from '@tools/core/result';
import { defineTool } from '../core/define';
import { getSetupPlatform, setupSecrets } from './platform';
import { collectCoreSetupStatus, locateTool } from './toolProbing';

const VerifySetupInputSchema = z.strictObject({
  tool: z
    .string()
    .nullish()
    .describe(
      'If provided, verifies just this one tool (e.g. "pdflatex"). Otherwise runs a full core-dependency check.',
    ),
});

type VerifySetupInput = z.infer<typeof VerifySetupInputSchema>;

export class VerifySetupTool extends defineTool({
  name: 'verify_setup',
  description: `Verify installation status. With no input, runs a full check of TeXRA's core LaTeX dependencies (pdflatex, latexmk, latexindent, perl, gs, gm or magick, texcount, latexdiff) and the LaTeX Workshop extension, returning a short plain-text report. With {"tool": "<name>"}, checks only that tool (falls back to a PATH search for names that don't have a known --version command). Use after running an install command to confirm it worked, or as the final step of a setup session.`,
  schema: VerifySetupInputSchema,
}) {
  protected async execute(input: VerifySetupInput): Promise<ToolResult> {
    const platform = getSetupPlatform();

    if (input.tool != null) {
      const name = input.tool.trim();
      if (!name) {
        throw new ToolError(
          'tool must be a non-empty command name (e.g. "pdflatex"). Call verify_setup with no arguments for a full check.',
        );
      }
      // Accept `gm/magick` as an alias since that's how the full-check path
      // reports a missing image tool; the agent naturally reuses that token.
      if (name === 'gm/magick') {
        const [gm, magick] = await Promise.all([
          locateTool('gm'),
          locateTool('magick'),
        ]);
        const ok = gm.installed || magick.installed;
        return executed(
          ok
            ? `Verified: ${gm.installed ? '"gm"' : '"magick"'} is installed and on PATH.`
            : `Not found: neither "gm" nor "magick" is on PATH. The install may not have completed, or the shell PATH needs to be refreshed.`,
          `Verify gm/magick: ${ok ? 'ok' : 'missing'}`,
        );
      }
      // First char must be alphanumeric — rejects punctuation-only
      // tokens like `"."` or `".."`, which would otherwise path-join
      // through BinaryResolver to existing directories (e.g.
      // `/usr/bin/.`) and produce a false "ok" verification result.
      if (!/^[A-Za-z0-9][A-Za-z0-9._+\-]*$/.test(name)) {
        throw new ToolError(
          `Invalid tool name "${name}". Must start with an alphanumeric character; only \`A-Za-z0-9._+-\` are allowed thereafter (or the alias "gm/magick").`,
        );
      }
      const { installed: ok } = await locateTool(name);
      return executed(
        ok
          ? `Verified: "${name}" is installed and on PATH.`
          : `Not found: "${name}" is still missing. The install may not have completed, or the shell PATH needs to be refreshed.`,
        `Verify ${name}: ${ok ? 'ok' : 'missing'}`,
      );
    }

    // Authentication verifies a configured relay token and primes the shared
    // status cache. Credential readiness must read that settled state.
    const [core, hasUsableCredential] = await Promise.all([
      collectCoreSetupStatus(platform),
      setupSecrets.anyUsableCredentialExists(),
    ]);

    const { auth, missingCore, latexWorkshopInstalled } = core;

    const lines: string[] = [];
    if (missingCore.length === 0) {
      lines.push('Core LaTeX tools: all present.');
    } else {
      lines.push(`Core LaTeX tools MISSING: ${missingCore.join(', ')}.`);
    }
    lines.push(
      latexWorkshopInstalled === undefined
        ? 'LaTeX Workshop extension: not applicable outside VS Code.'
        : `LaTeX Workshop extension: ${latexWorkshopInstalled ? 'installed' : 'NOT installed'}.`,
    );
    // A usable model credential can be a direct provider key, ChatGPT
    // subscription, or a signed-in account with included access on. A bare
    // auth.authenticated without usable server-side keys is NOT a working
    // credential, so we don't let it count toward "ready".
    let credSummary: string;
    if (hasUsableCredential) {
      credSummary = 'usable model credential available';
    } else if (auth.authenticated) {
      credSummary = `signed in but ${INCLUDED_ACCESS.inline} is off. Turn it back on or add an API key`;
    } else {
      credSummary = 'NONE: need an API key or sign-in';
    }
    lines.push(`Credentials: ${credSummary}.`);

    const ready =
      missingCore.length === 0 &&
      (latexWorkshopInstalled === undefined || latexWorkshopInstalled) &&
      hasUsableCredential;

    let verificationSummary: string;
    if (ready) {
      verificationSummary = 'Setup verification: ready to go';
    } else if (missingCore.length > 0) {
      verificationSummary = `Setup verification: ${missingCore.length} missing tools`;
    } else {
      verificationSummary = 'Setup verification: gaps remain';
    }

    return executed(lines.join('\n'), verificationSummary);
  }
}
