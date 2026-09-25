// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { MissingTool } from '@shared/schemas';
import {
  CORE_DEPENDENCY_TOOLS,
  DEPENDENCY_USE,
  IMAGE_LATEX_TOOLS,
} from '@shared/constants/latexToolchain';

// Local file imports
import {
  checkToolInstalled,
  detectImageTool,
  reportMissingImageTools,
  toolLabel,
} from './toolUtils';

function missingTool(
  id: keyof typeof DEPENDENCY_USE,
  interchangeable: boolean,
): MissingTool {
  const usedFor = DEPENDENCY_USE[id];
  return { id, label: toolLabel(id), interchangeable, usedFor };
}

/**
 * Check core dependencies required by TeXRA features (latexindent, Perl,
 * Ghostscript, GraphicsMagick/ImageMagick). Every probe answers `false`
 * rather than failing, so this has no failure of its own to mask.
 * @param showError Whether to show error messages for missing tools
 * @returns The missing dependency entries.
 */
export const checkCoreDependencies = Effect.fn(
  'toolUtils.checkCoreDependencies',
)(function* (showError: boolean = true): Effect.fn.Return<MissingTool[]> {
  const probes = yield* Effect.all(
    // The catalog's core set, not a second list beside it.
    CORE_DEPENDENCY_TOOLS.map((tool) => checkToolInstalled(tool, showError)),
    { concurrency: 'unbounded' },
  );
  const missing: MissingTool[] = CORE_DEPENDENCY_TOOLS.filter(
    (_, i) => !probes[i],
  ).map((id) => missingTool(id, false));

  // Report both image tools as interchangeable only if neither is installed.
  if (!(yield* detectImageTool())) {
    missing.push(...IMAGE_LATEX_TOOLS.map((id) => missingTool(id, true)));
    if (showError) yield* reportMissingImageTools();
  }

  return missing;
});
