// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  IMAGE_LATEX_TOOLS,
  IMAGE_TOOL_LABEL,
  LATEX_WORKSHOP_EXT_ID,
  PROBED_LATEX_TOOLS,
} from '@shared/constants/latexToolchain';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { findToolInCommonPaths } from '@utils/system/binaryResolver';

import { getSetupAuthStatus, type SetupPlatformShape } from './platform';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** Installation status of one probed tool, with its path when discoverable. */
interface ToolStatus {
  name: string;
  installed: boolean;
  path?: string;
}

const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(IMAGE_LATEX_TOOLS);

/**
 * Resolve a tool as installed by (1) the known-tool check which spawns
 * `<tool> --version`, or (2) a PATH search for tools without a config entry
 * (e.g. `node`, `git`, or an arbitrary binary the user asks about). The PATH
 * search also supplies the absolute path presented alongside the flag.
 */
export const locateTool = Effect.fn('locateTool')(function* (
  name: string,
): Effect.fn.Return<ToolStatus, never, ChildProcessSpawner> {
  // With `showError` false the probe reports a missing tool as `false` and
  // has no failure of its own, so the read carries no error channel.
  // Interruption reaches the spawned `<tool> --version`, so interrupting a
  // probe kills the processes — several at once, since the core tools are
  // probed concurrently — instead of leaving them to run out their timeout.
  const knownInstalled = yield* checkToolInstalled(name, false);
  const resolvedPath = yield* findToolInCommonPaths(name);
  return {
    name,
    installed: knownInstalled || resolvedPath !== null,
    path: resolvedPath ?? undefined,
  };
});

/**
 * Names of the missing core dependencies, given statuses for the whole of
 * {@link PROBED_LATEX_TOOLS}. Either image tool satisfies the image
 * requirement, so both absent report a single {@link IMAGE_TOOL_LABEL} entry.
 */
function missingCoreTools(statuses: readonly ToolStatus[]): string[] {
  const missing = statuses
    .filter((tool) => !tool.installed && !IMAGE_TOOL_NAMES.has(tool.name))
    .map((tool) => tool.name);
  const hasImageTool = statuses.some(
    (tool) => IMAGE_TOOL_NAMES.has(tool.name) && tool.installed,
  );
  if (!hasImageTool) missing.push(IMAGE_TOOL_LABEL);
  return missing;
}

/**
 * The core-setup status shared by `probe_environment` and `verify_setup`:
 * auth status, core-tool probing results, and LaTeX Workshop extension
 * presence. One definition so the two tools can't drift on what "core setup"
 * means. Each tool's divergent credential/optional-tool handling stays in the
 * tool.
 */
export const collectCoreSetupStatus = Effect.fn('collectCoreSetupStatus')(
  function* (platform: SetupPlatformShape) {
    const auth = yield* getSetupAuthStatus();
    const coreTools = yield* Effect.all(
      PROBED_LATEX_TOOLS.map((name) => locateTool(name)),
      { concurrency: 'unbounded' },
    );
    const missingCore = missingCoreTools(coreTools);
    const latexWorkshopInstalled = platform.extensions?.isInstalled(
      LATEX_WORKSHOP_EXT_ID,
    );
    return { auth, coreTools, missingCore, latexWorkshopInstalled };
  },
);
