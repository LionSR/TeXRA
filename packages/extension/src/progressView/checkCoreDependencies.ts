// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { MissingTool } from '@texra/shared/session/hostSnapshot';
import {
  CORE_DEPENDENCY_TOOLS,
  DEPENDENCY_USE,
  IMAGE_LATEX_TOOLS,
  LATEX_TOOL_ENTRIES,
  missingLatexTools,
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
  const probed = yield* Effect.all(
    [...CORE_DEPENDENCY_TOOLS, ...IMAGE_LATEX_TOOLS].map((id) =>
      Effect.map(probeTool(id), (installed) => [id, installed] as const),
    ),
    { concurrency: 'unbounded' },
  );
  return missingLatexTools(probed).map(({ name, interchangeable }) =>
    missingTool(name, interchangeable),
  );
});
