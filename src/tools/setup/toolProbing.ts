// Local imports
import {
  CORE_LATEX_TOOLS,
  IMAGE_TOOLS,
  LATEX_WORKSHOP_EXT_ID,
} from '@shared/constants/latexToolchain';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { BinaryResolver } from '@utils/system/binaryResolver';

import { getSetupAuthStatus, type SetupPlatform } from './platform';

/** Installation status of one probed tool, with its path when discoverable. */
interface ToolStatus {
  name: string;
  installed: boolean;
  path?: string;
}

/**
 * Core dependencies probed by `probe_environment` and `verify_setup`: the
 * LaTeX toolchain plus both image-tool candidates. The image requirement is
 * satisfied by either candidate — see {@link missingCoreTools}.
 */
export const PROBED_CORE_TOOLS = [...CORE_LATEX_TOOLS, ...IMAGE_TOOLS] as const;

const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(IMAGE_TOOLS);

/**
 * Resolve a tool as installed by (1) the known-tool check which spawns
 * `<tool> --version`, or (2) a PATH search for tools without a config entry
 * (e.g. `node`, `git`, or an arbitrary binary the user asks about). The PATH
 * search also supplies the absolute path presented alongside the flag.
 */
export async function locateTool(name: string): Promise<ToolStatus> {
  const knownInstalled = await checkToolInstalled(name, false);
  const resolvedPath = BinaryResolver.findPath(name);
  return {
    name,
    installed: knownInstalled || resolvedPath !== null,
    path: resolvedPath ?? undefined,
  };
}

/**
 * Names of the missing core dependencies, given statuses for the whole of
 * {@link PROBED_CORE_TOOLS}. Either image tool satisfies the image
 * requirement, so both absent report a single `gm/magick` entry.
 */
export function missingCoreTools(statuses: readonly ToolStatus[]): string[] {
  const missing = statuses
    .filter((tool) => !tool.installed && !IMAGE_TOOL_NAMES.has(tool.name))
    .map((tool) => tool.name);
  const hasImageTool = statuses.some(
    (tool) => IMAGE_TOOL_NAMES.has(tool.name) && tool.installed,
  );
  if (!hasImageTool) missing.push('gm/magick');
  return missing;
}

/**
 * The core-setup status shared by `probe_environment` and `verify_setup`:
 * auth status, core-tool probing results, and LaTeX Workshop extension
 * presence. One definition so the two tools can't drift on what "core setup"
 * means. Each tool's divergent credential/optional-tool handling stays in the
 * tool.
 */
export async function collectCoreSetupStatus(platform: SetupPlatform) {
  const auth = await getSetupAuthStatus().catch(() => ({
    authenticated: false as const,
  }));
  const coreTools = await Promise.all(
    PROBED_CORE_TOOLS.map((name) => locateTool(name)),
  );
  const missingCore = missingCoreTools(coreTools);
  const latexWorkshopInstalled = platform.extensions?.isInstalled(
    LATEX_WORKSHOP_EXT_ID,
  );
  return { auth, coreTools, missingCore, latexWorkshopInstalled };
}
