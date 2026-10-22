// Third-party imports
import { Effect } from 'effect';

// Local imports
import { findCommand } from '@texra-ai/harness/node';
import {
  IMAGE_LATEX_TOOLS,
  IMAGE_TOOL_LABEL,
} from '@texra/shared/constants/latexToolchain';
import { checkToolInstalled } from '@texra/utils/system/toolChecks';

import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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
  // Fresh: a setup probe follows an install, so a recent miss is searched
  // for again.
  const found = yield* findCommand(name, { fresh: true });
  return {
    name,
    installed: knownInstalled || found !== null,
    path: found?.resolvedPath,
  };
});

/**
 * Names of the missing core dependencies, given statuses for the whole of
 * `PROBED_LATEX_TOOLS`. Either image tool satisfies the image
 * requirement, so both absent report a single {@link IMAGE_TOOL_LABEL} entry.
 */
export function missingCoreTools(statuses: readonly ToolStatus[]): string[] {
  const missing = statuses
    .filter((tool) => !tool.installed && !IMAGE_TOOL_NAMES.has(tool.name))
    .map((tool) => tool.name);
  const hasImageTool = statuses.some(
    (tool) => IMAGE_TOOL_NAMES.has(tool.name) && tool.installed,
  );
  if (!hasImageTool) missing.push(IMAGE_TOOL_LABEL);
  return missing;
}
