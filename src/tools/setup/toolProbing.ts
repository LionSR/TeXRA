// Local imports
import { checkToolInstalled } from '@utils/system/toolUtils';
import { BinaryResolver } from '@utils/system/binaryResolver';

/**
 * Single source of truth for the core LaTeX toolchain the setup assistant
 * probes and verifies. `pdflatex, latexmk, latexindent, latexdiff, texcount,
 * perl, gs` are checked directly; the image tool is satisfied by *either*
 * `gm` or `magick` (reported as `gm/magick` in user-facing output), so it
 * lives in its own constant.
 *
 * Keep both the tool descriptions (ProbeEnvironmentTool / VerifySetupTool)
 * aligned with these lists — they appear verbatim in the LLM prompt.
 */
export const CORE_LATEX_TOOLS = Object.freeze([
  'pdflatex',
  'latexmk',
  'latexindent',
  'latexdiff',
  'texcount',
  'perl',
  'gs',
] as const);

export const IMAGE_TOOLS = Object.freeze(['gm', 'magick'] as const);

/**
 * Resolve a tool as installed by (1) the known-tool check which spawns
 * `<tool> --version`, or (2) a PATH search for tools without a config entry
 * (e.g. `node`, `git`, or an arbitrary binary the user asks about).
 */
export async function isToolPresent(name: string): Promise<boolean> {
  if (await checkToolInstalled(name, false)) return true;
  return BinaryResolver.findPath(name) !== null;
}

/**
 * Resolve the tool and its absolute path, if any. Used by
 * `probe_environment` to present the agent with location context alongside
 * the installed flag.
 */
export async function locateTool(
  name: string,
): Promise<{ installed: boolean; path?: string }> {
  const knownInstalled = await checkToolInstalled(name, false);
  const resolvedPath = BinaryResolver.findPath(name);
  return {
    installed: knownInstalled || resolvedPath !== null,
    path: resolvedPath ?? undefined,
  };
}
