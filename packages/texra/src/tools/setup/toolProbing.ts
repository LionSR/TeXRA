// Third-party imports
import { Effect } from 'effect';

// Local imports
import { probeLatexTools } from '@latex/latexToolchain';
import { findCommand } from '@texra/utils/system/binaryResolver';
import {
  LATEX_TOOL_ENTRIES,
  type LatexToolName,
} from '@texra/shared/constants/latexToolchain';

import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** Installation status of one probed tool, with its path when discoverable. */
interface ToolStatus {
  readonly name: string;
  readonly installed: boolean;
  readonly path: string | undefined;
}

/**
 * Whether one tool is installed: a catalog tool as the toolchain probe
 * reports it, any other binary (`node`, `python3`, one the user asks about)
 * by a PATH search, which also supplies the path presented beside the flag.
 */
export const locateTool = Effect.fn('locateTool')(function* (
  name: string,
): Effect.fn.Return<ToolStatus, never, ChildProcessSpawner> {
  if (Object.hasOwn(LATEX_TOOL_ENTRIES, name)) {
    // cast: `hasOwn` just found `name` among the catalog's keys.
    const { tools } = yield* probeLatexTools([name as LatexToolName]);
    return tools[0];
  }
  const found = yield* findCommand(name);
  return { name, installed: found !== null, path: found?.resolvedPath };
});
