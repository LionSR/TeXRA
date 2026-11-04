/**
 * Constants and configuration for progress view formatters.
 */

// Local imports
import { getBasename, type LogLevel } from '@texra-ai/harness/schemas';
import type { IconName } from '@ui/wa/iconNames';

/**
 * Font Awesome icon name per log level, rendered via `waIcon`. Replaces
 * the former emoji map so log levels use the same icon set as the rest of the
 * UI; per-level color is applied through the `log-level-icon--{level}` classes
 * in logEntryStyles.
 */
export const ICON_BY_LEVEL: Record<LogLevel, IconName> = {
  error: 'circle-exclamation',
  warn: 'triangle-exclamation',
  info: 'circle-info',
  debug: 'magnifying-glass',
};

// ============================================================================
// Tool Categories for Specialized Formatting
// ============================================================================
//
// The edit/read/write display-kind classification (which tools show an
// old/new diff, a file link, or a file link + content) lives in
// `@shared/tools/toolKind` — the single source of truth shared with the CLI chat
// TUI's `toolRenderers.tsx` (see issue #7120). Use `toolDisplayKind()` from
// that module instead of adding tool-name lists here. Friendly header labels
// live next to it in `@shared/tools/toolDisplayName`.

/**
 * Tools whose input AND output are code that benefits from syntax highlighting.
 * Maps tool name to default language hint for output.
 * Use 'bash' for shell commands, 'plaintext' for tools with variable output.
 */
export const TOOL_OUTPUT_LANGUAGES = new Map<string, string>([
  ['bash', 'bash'],
  ['execute', 'plaintext'], // Could be any language - don't guess
  ['run', 'plaintext'], // Could be any language - don't guess
]);

/**
 * Map file extensions that don't match highlight.js language names.
 * Focused on LaTeX research context. Unknown extensions try the extension directly.
 */
const EXTENSION_ALIASES = new Map<string, string>([
  // LaTeX ecosystem
  ['tex', 'latex'],
  ['sty', 'latex'],
  ['cls', 'latex'],
  ['dtx', 'latex'],
  ['tikz', 'latex'],
  ['bib', 'bibtex'],
  ['bst', 'latex'],
  // Scientific computing
  ['py', 'python'],
  ['jl', 'julia'],
  ['wl', 'mathematica'],
  ['m', 'mathematica'],
  ['f90', 'fortran'],
  ['f95', 'fortran'],
  ['ipynb', 'json'],
  // Config/docs
  ['yml', 'yaml'],
  ['md', 'markdown'],
  ['sh', 'bash'],
]);

/** Get highlight.js language from file path based on extension. Uses alias map for non-standard extensions, otherwise tries the extension directly. */
export function getLanguageFromPath(filePath: string): string {
  if (!filePath) return 'plaintext';
  const fileName = getBasename(filePath) || filePath;
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName === 'dockerfile') return 'dockerfile';
  if (lowerFileName === 'makefile') return 'makefile';
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === fileName.length - 1) return 'plaintext';
  const extension = fileName.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ALIASES.get(extension) ?? extension;
}

// Threshold constants for diff detection heuristics
export const DIFF_DETECTION_LINE_LIMIT = 20;
export const DIFF_MARKER_THRESHOLD = 2;

/**
 * Upper bound on the inline word diff, which runs synchronously inside Lit's
 * render on the webview's main thread over LLM-authored edit text.
 *
 * Deliberately far below `unifiedDiff`'s 5s Node-side bound rather than shared
 * with it: this budget is the frame the user is waiting on, so the two are
 * different policies for different threads, not one value written twice.
 */
export const INLINE_DIFF_TIMEOUT_MS = 250;
