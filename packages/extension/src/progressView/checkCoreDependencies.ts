// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { MissingTool } from '@texra/shared/session/hostSnapshot';
import {
  CORE_DEPENDENCY_TOOLS,
  DEPENDENCY_USE,
  IMAGE_LATEX_TOOLS,
  LATEX_TOOL_ENTRIES,
} from '@texra/shared/constants/latexToolchain';

// Local file imports
import { probeTool } from '@texra/utils/system/toolChecks';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

function missingTool(
  id: keyof typeof DEPENDENCY_USE,
  interchangeable: boolean,
): MissingTool {
  const usedFor = DEPENDENCY_USE[id];
  const label = LATEX_TOOL_ENTRIES[id].label ?? id;
  return { label, interchangeable, usedFor };
}

/**
 * Check core dependencies required by TeXRA features (latexindent, Perl,
 * Ghostscript, GraphicsMagick/ImageMagick). Every probe answers `false`
 * rather than failing, so this has no failure of its own to mask. The banner
 * that reads the result is what tells the user.
 * @returns The missing dependency entries.
 */
export const checkCoreDependencies = Effect.fn(
  'toolUtils.checkCoreDependencies',
)(function* (): Effect.fn.Return<MissingTool[], never, ChildProcessSpawner> {
  // Both groups probe at once: the catalog's core set (not a second list
  // beside it) and the image tools.
  const [probes, imageTools] = yield* Effect.all(
    [
      Effect.all(CORE_DEPENDENCY_TOOLS.map(probeTool), {
        concurrency: 'unbounded',
      }),
      Effect.all(IMAGE_LATEX_TOOLS.map(probeTool), {
        concurrency: 'unbounded',
      }),
    ],
    { concurrency: 'unbounded' },
  );
  const missing: MissingTool[] = CORE_DEPENDENCY_TOOLS.filter(
    (_, i) => !probes[i],
  ).map((id) => missingTool(id, false));

  // Report both image tools as interchangeable only if neither is installed.
  if (!imageTools.some(Boolean)) {
    missing.push(...IMAGE_LATEX_TOOLS.map((id) => missingTool(id, true)));
  }

  return missing;
});
