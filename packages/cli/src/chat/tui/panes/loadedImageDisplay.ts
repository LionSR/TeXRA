// Local imports - shared formatting
import { POINTER } from '@cli/tui/ui/glyphs';
import { collapseWhitespace, formatBytes } from '@utils/text/stringUtils';

// Local imports - CLI TUI rendering
import {
  safeTerminalText,
  textDisplayWidth,
  truncateSummaryToWidth,
  truncateToWidth,
} from '../render/terminalText';

// Local imports - CLI TUI glyphs
import type { LoadedImage } from '../state/cliState';

/** The one terminal-text representation of an image prepared as context media. */
function loadedImageDisplayBody(
  image: LoadedImage,
  maxColumns?: number,
): string {
  const prefix = '[image] ';
  const suffix = ` (${formatBytes(image.sizeBytes)})`;
  const safePath = collapseWhitespace(safeTerminalText(image.path));
  const body = `${prefix}${safePath}${suffix}`;
  if (maxColumns === undefined || textDisplayWidth(body) <= maxColumns) {
    return body;
  }

  const pathColumns =
    maxColumns - textDisplayWidth(prefix) - textDisplayWidth(suffix);
  if (pathColumns > 0) {
    return `${prefix}${truncateSummaryToWidth(safePath, pathColumns)}${suffix}`;
  }
  return truncateToWidth(body, Math.max(1, maxColumns));
}

export function loadedImageDisplayLines(
  images: readonly LoadedImage[],
  maxColumns?: number,
): readonly string[] {
  const pointer = `${POINTER} `;
  const bodyColumns =
    maxColumns === undefined
      ? undefined
      : Math.max(1, maxColumns - textDisplayWidth(pointer));
  return images.map((image) => {
    const line = `${pointer}${loadedImageDisplayBody(image, bodyColumns)}`;
    return maxColumns === undefined
      ? line
      : truncateToWidth(line, Math.max(1, maxColumns));
  });
}
